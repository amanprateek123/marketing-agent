import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { ScoutSignal, ScoutSignalDocument } from './schemas/scout-signal.schema';
import { ScoutOutput, ScoutOutputDocument } from './schemas/scout-output.schema';
import { CoordinatorOutput, CoordinatorOutputDocument } from './schemas/coordinator-output.schema';
import { ResearchOutput, ResearchOutputDocument, StructuredResearch, ResearchInsight } from './schemas/research-output.schema';

export interface CoordinatorResult {
  coordinatorOutputId: string;
  content: string;
  topSignals: {
    topic: string;
    platforms: string[];
    compositeScore: number;
    rationale: string;
  }[];
  viralTrends: {
    trend: string;
    platforms: string[];
    brandTieIn: string;
    compositeScore: number;
    urgent: boolean;
  }[];
}

@Injectable()
export class CoordinatorService {
  private readonly logger = new Logger(CoordinatorService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(ScoutSignal.name)
    private readonly scoutSignalModel: Model<ScoutSignalDocument>,
    @InjectModel(ScoutOutput.name)
    private readonly scoutOutputModel: Model<ScoutOutputDocument>,
    @InjectModel(CoordinatorOutput.name)
    private readonly coordinatorOutputModel: Model<CoordinatorOutputDocument>,
    @InjectModel(ResearchOutput.name)
    private readonly researchOutputModel: Model<ResearchOutputDocument>,
  ) {}

  async run(
    company: CompanyDocument,
    runId: string,
  ): Promise<CoordinatorResult> {
    const tenantId = company.tenantId;

    // Load industry signals (excluding viral — those come from scoutOutputs separately)
    const [signals, scoutOutputs] = await Promise.all([
      this.scoutSignalModel.find({ tenantId, runId, signalType: { $ne: 'viral' } }).lean().exec(),
      this.scoutOutputModel.find({ tenantId, runId }).lean().exec(),
    ]);

    if (signals.length === 0) {
      this.logger.warn(`No signals found for tenantId=${tenantId} runId=${runId}`);
    }

    const viralTrendsCount = scoutOutputs.reduce(
      (sum, o) => sum + (o.data?.viral_trends?.length ?? 0), 0,
    );
    this.logger.log(
      `Coordinator input: ${signals.length} industry signals + ${viralTrendsCount} viral trends`,
    );

    const systemPrompt = company.prompts?.coordinator ?? '';
    const liveContext = this.liveContextBuilder.build(company);

    const viralTrendInputs = scoutOutputs.map((o) => ({
      platform: o.platform,
      viral_trends: o.data?.viral_trends ?? [],
    }));

    const userMessage = this.buildCoordinatorPrompt(signals, viralTrendInputs);

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.COORDINATOR,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 5,
    });

    const { topSignals: rawTopSignals, viralTrends: rawViralTrends } = this.extractTopSignalsAndViralTrends(result.content);

    // ── Brand-relevance filter ─────────────────────────────────────────────────
    // Without this, scout output for an unrelated trend (K-pop, IPL, election)
    // can pass through the coordinator and become a campaign brief for an
    // unrelated tenant (e.g. 91astrology). Filter signals by keyword overlap
    // with company.industry + product.trendKeywords. Skip if no keywords are
    // configured (don't block tenants that haven't set keywords yet).
    const { topSignals, viralTrends } = this.applyBrandRelevanceFilter(rawTopSignals, rawViralTrends, company);
    if (rawTopSignals.length !== topSignals.length || rawViralTrends.length !== viralTrends.length) {
      this.logger.log(
        `Coordinator brand-relevance filter dropped ${rawTopSignals.length - topSignals.length}/${rawTopSignals.length} signals + ${rawViralTrends.length - viralTrends.length}/${rawViralTrends.length} viral trends`,
      );
    }

    const saved = await this.coordinatorOutputModel.create({
      tenantId,
      runId,
      content: result.content,
      topSignals,
      viralTrends,
    });

    this.logger.log(
      `Coordinator done: tenantId=${tenantId} runId=${runId} signals=${topSignals.length} viralTrends=${viralTrends.length}`,
    );

    return {
      coordinatorOutputId: (saved as any)._id.toString(),
      content: result.content,
      topSignals,
      viralTrends,
    };
  }

  async runCompetitorResearch(
    company: CompanyDocument,
    runId: string,
    coordinatorContent: string,
  ): Promise<StructuredResearch> {
    const tenantId = company.tenantId;
    const systemPrompt = company.prompts?.competitorResearch ?? '';
    const liveContext = this.liveContextBuilder.build(company);

    const userMessage = `
Based on this coordinator synthesis, perform deep competitor research focused on PAID AD OPPORTUNITIES.
Use all available search turns across 3 phases. Do NOT output JSON until Phase 3 is complete.

COORDINATOR SYNTHESIS:
${coordinatorContent}

Company competitors to analyse: ${company.competitors.join(', ')}

NOTE: We have a separate Meta Ads Library agent that already scrapes competitor active Meta ad creatives.
DO NOT focus on ad creatives here. Instead, find what the Ads Library cannot surface.

━━━ PHASE 1 — DISCOVERY (searches 1–4) ━━━
For each competitor run these searches:
- "[competitor] pricing ${new Date().getFullYear()}" — find pricing changes or promotions
- "[competitor] reviews complaints" on Trustpilot, G2, Google Reviews — find pain points their customers have
- "[competitor] news" — find recent launches, controversies, or positioning shifts
Collect candidates. Do not output JSON yet.

━━━ PHASE 2 — EVALUATE ━━━
Review everything found. For each candidate finding ask:
- Is this backed by a real URL with recent date (last 30 days preferred)?
- How exploitable is this as a Meta ad angle? Score 1–10.
- Identify your top 3 most exploitable findings that have actual evidence.

━━━ PHASE 3 — DEEP-DIVE (searches 5–8) ━━━
For each of your top 3 findings:
- Find the specific review, news article, or pricing page URL
- Pull 1-2 verbatim quotes from negative reviews if available — these become ad copy
- Verify recency — if you cannot find a date, lower the score
- Drop findings with no verifiable source URL

After Phase 3, return ONLY a JSON object in this exact format — no markdown, no explanation:
{
  "insights": [
    {
      "insight": "one clear finding about a competitor",
      "implication": "specific Meta ad angle to exploit this — e.g. 'run a price comparison ad targeting their unhappy customers with the search term [competitor name] alternative'",
      "urgency": "high | medium | low",
      "score": 8,
      "source": "https://..."
    }
  ],
  "rawSummary": "2-3 sentence summary of the overall competitive landscape and the single biggest paid ad opportunity against competitors"
}

Rules:
- Maximum 5 insights, ranked by score descending (most actionable first)
- score 8-10: competitor is vulnerable RIGHT NOW — act this week with a targeted Meta ad
- score 5-7: important pattern worth building an ad angle around this month
- score 1-4: background context, low urgency
- implication must be a specific paid ad tactic — audience, hook angle, or offer to run
- urgency "high" = act this week, "medium" = this month, "low" = general awareness
    `.trim();

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.COMPETITOR_RESEARCH,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 10,
    });

    const structured = this.parseStructuredResearch(result.content, 'competitor');

    await this.researchOutputModel.create({
      tenantId,
      runId,
      type: 'competitor',
      structured,
      content: result.content,
    });

    this.logger.log(`Competitor research done: tenantId=${tenantId} runId=${runId} | insights: ${structured.insights.length}`);
    return structured;
  }

  async runMarketResearch(
    company: CompanyDocument,
    runId: string,
    coordinatorContent: string,
  ): Promise<StructuredResearch> {
    const tenantId = company.tenantId;
    const systemPrompt = company.prompts?.marketResearch ?? '';
    const liveContext = this.liveContextBuilder.build(company);

    const userMessage = `
Based on this coordinator synthesis, find market signals with DIRECT PURCHASE INTENT that can fuel paid Meta ad campaigns.
Use all available search turns across 3 phases. Do NOT output JSON until Phase 3 is complete.

COORDINATOR SYNTHESIS:
${coordinatorContent}

Industry: ${company.industry}
Target audience: ${company.targetAudience}

━━━ PHASE 1 — DISCOVERY (searches 1–4) ━━━
Find candidate signals — NOT generic trend articles. Focus on:
- Urgency triggers: festivals, salary cycles, exam seasons, weather shifts, tax deadlines in ${company.geography} — search "[industry] seasonal buying ${company.geography} ${new Date().getFullYear()}"
- Consumer pain points: Reddit, Quora, Google Reviews complaints about this category — search "reddit ${company.industry} ${company.targetAudience} problem complaints"
- Demand spikes: news or search trend data showing a category moment right now — search "${company.industry} demand spike ${new Date().getFullYear()}"
Collect 8-10 candidate signals. Do not output JSON yet.

━━━ PHASE 2 — EVALUATE ━━━
For each candidate signal ask:
- Does it pass the "can I run a profitable Meta ad against this RIGHT NOW?" test?
- Is there a specific time window (next 7 days, this month)?
- Is there a source URL confirming the signal is real and recent?
Score each 1–10. Identify top 3 with the clearest commercial hook.

━━━ PHASE 3 — DEEP-DIVE (searches 5–8) ━━━
For each of your top 3 signals:
- Find the specific article, Reddit thread, or data source confirming the urgency/pain
- Pull exact quotes or data points that can become ad copy hooks
- Verify timing — if you cannot confirm recency, lower the score
- Drop signals with no verifiable source URL

After Phase 3, return ONLY a JSON object in this exact format — no markdown, no explanation:
{
  "insights": [
    {
      "insight": "one clear market signal with purchase intent",
      "implication": "specific Meta ad angle — e.g. 'run a limited-time offer ad in the 2 weeks before [event] targeting [audience segment] with urgency CTA'",
      "urgency": "high | medium | low",
      "score": 7,
      "source": "https://..."
    }
  ],
  "rawSummary": "2-3 sentence summary of the biggest paid ad opportunity in the market right now"
}

Rules:
- Maximum 5 insights, ranked by score descending (most actionable first)
- score 8-10: time-sensitive window closing soon — must act this week
- score 5-7: strong conversion opportunity this month
- score 1-4: background awareness only, low ad potential
- implication must be a specific paid ad tactic: audience, offer, timing, urgency mechanic
- urgency "high" = act this week, "medium" = this month, "low" = general awareness
    `.trim();

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.MARKET_RESEARCH,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 12,
    });

    const structured = this.parseStructuredResearch(result.content, 'market');

    await this.researchOutputModel.create({
      tenantId,
      runId,
      type: 'market',
      structured,
      content: result.content,
    });

    this.logger.log(`Market research done: tenantId=${tenantId} runId=${runId} | insights: ${structured.insights.length}`);
    return structured;
  }

  private parseStructuredResearch(content: string, type: string): StructuredResearch {
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonStr);

      const insights: ResearchInsight[] = (parsed.insights ?? [])
        .filter((i: any) => i.insight && i.implication && typeof i.score === 'number')
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, 5);

      return {
        insights,
        rawSummary: parsed.rawSummary ?? '',
      };
    } catch (err: any) {
      this.logger.warn(`Failed to parse structured ${type} research — falling back to summary: ${err.message}`);
      // Fallback: wrap the raw text as a single low-score insight
      return {
        insights: [{
          insight: `${type} research completed`,
          implication: content.slice(0, 500),
          urgency: 'low',
          score: 3,
        }],
        rawSummary: content.slice(0, 300),
      };
    }
  }

  private buildCoordinatorPrompt(
    signals: Array<{
      platform: string;
      topic: string;
      angle: string;
      signalScore: number;
      recency: string;
      specificity: string;
      sourceQuality: string;
      engagementProof?: { metric: string; value: number; source: string };
    }>,
    scoutOutputs: Array<{ platform: string; viral_trends: any[] }>,
  ): string {
    const grouped: Record<string, typeof signals> = {};
    for (const s of signals) {
      if (!grouped[s.platform]) grouped[s.platform] = [];
      grouped[s.platform].push(s);
    }

    const industrySections = Object.entries(grouped)
      .map(([platform, platformSignals]) => {
        const lines = platformSignals
          .sort((a, b) => b.signalScore - a.signalScore)
          .slice(0, 10)
          .map(
            (s) =>
              `  - [Score ${s.signalScore}] Topic: "${s.topic}" | Angle: "${s.angle}" | Recency: ${s.recency} | Source: ${s.engagementProof?.source ?? 'N/A'}`,
          )
          .join('\n');
        return `### ${platform.toUpperCase()} (${platformSignals.length} signals)\n${lines}`;
      })
      .join('\n\n');

    const viralSections = scoutOutputs
      .filter((o) => o.viral_trends?.length > 0)
      .map(({ platform, viral_trends }) => {
        const lines = viral_trends
          .slice(0, 10)
          .map(
            (v) =>
              `  - [Score ${v.signalScore}] Trend: "${v.trend}" | Tie-in: "${v.brand_tie_in}" | Source: ${v.source}`,
          )
          .join('\n');
        return `### ${platform.toUpperCase()} viral trends\n${lines}`;
      })
      .join('\n\n');

    return `
Synthesise the following signals from across all platforms and decide what's worth acting on.

## INDUSTRY SIGNALS (niche-specific)
${industrySections || 'No industry signals collected.'}

## VIRAL TRENDS (trend-jacking opportunities)
${viralSections || 'No viral trends collected.'}

Your job:
1. From industry signals — identify topics appearing across multiple platforms (cross-platform momentum) → goes into topSignals
2. From viral trends — identify trends strong enough to tie into the brand, with a clear brand_tie_in → goes into viralTrends (SEPARATE array)
3. Do NOT mix viral trends into topSignals. Keep them strictly separate.
4. Score topSignals 0–10 based on cross-platform momentum and commercial relevance
5. Score viralTrends 0–10 based on viral strength and brand tie-in quality
6. Produce a synthesis brief that the intelligence and idea pool agents can use


You MUST include a JSON block at the end using EXACTLY this format:

\`\`\`json
{
  "topSignals": [
    {
      "topic": "short topic name",
      "platforms": ["instagram", "twitter"],
      "compositeScore": 9.2,
      "rationale": "one sentence on why this signal matters now"
    }
  ],
  "viralTrends": [
    {
      "trend": "the meme or cultural moment name",
      "platforms": ["instagram", "reddit"],
      "brandTieIn": "how the brand can ride this trend in a paid ad",
      "compositeScore": 8.5,
      "urgent": true
    }
  ]
}
\`\`\`

Rules:
- Include 5–10 topSignals (industry signals only — NOT viral trends)
- Include up to 5 viralTrends — only genuine meme/cultural moments with clear brand tie-in potential
- Keep topSignals and viralTrends strictly separate — do NOT put viral trends in topSignals
- urgent: true if this meme will be dead within 7 days
- Use exactly these field names
    `.trim();
  }

  /**
   * Drop signals whose topic doesn't share any keyword with the tenant's industry
   * or product trendKeywords. Prevents unrelated viral trends (K-pop, IPL,
   * election-news) from becoming campaign briefs for unrelated tenants.
   * Viral trends use the same filter but get a softer pass — viral memes often
   * tie back via cultural context that doesn't match keyword strictly.
   */
  private applyBrandRelevanceFilter(
    topSignals: CoordinatorResult['topSignals'],
    viralTrends: CoordinatorResult['viralTrends'],
    company: CompanyDocument,
  ): { topSignals: CoordinatorResult['topSignals']; viralTrends: CoordinatorResult['viralTrends'] } {
    const keywords = new Set<string>();
    if (company.industry) {
      company.industry.toLowerCase().split(/[\s,/]+/).filter(w => w.length > 2).forEach(w => keywords.add(w));
    }
    for (const product of company.products ?? []) {
      for (const kw of (product as any).trendKeywords ?? []) {
        kw.toLowerCase().split(/[\s,/]+/).filter((w: string) => w.length > 2).forEach((w: string) => keywords.add(w));
      }
    }
    if (keywords.size === 0) {
      // No keywords configured — don't filter (don't block tenants that haven't set up trendKeywords)
      return { topSignals, viralTrends };
    }
    const matches = (text: string): boolean => {
      const lower = (text || '').toLowerCase();
      for (const kw of keywords) {
        if (lower.includes(kw)) return true;
      }
      return false;
    };
    const filteredTopSignals = topSignals.filter((s) =>
      matches(s.topic) || matches(s.rationale),
    );
    // Viral trends: require keyword match in trend OR brandTieIn (the LLM's
    // explanation of why the brand should ride it). brandTieIn match catches
    // legit "K-pop comeback × astrology birth-chart" type cross-cultural angles.
    const filteredViralTrends = viralTrends.filter((v) =>
      matches(v.trend) || matches(v.brandTieIn),
    );
    return { topSignals: filteredTopSignals, viralTrends: filteredViralTrends };
  }

  private extractTopSignalsAndViralTrends(content: string): {
    topSignals: CoordinatorResult['topSignals'];
    viralTrends: CoordinatorResult['viralTrends'];
  } {
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        const signals = parsed.topSignals ?? parsed.top_signals ?? parsed.signals ?? parsed.topics ?? [];
        const viral = parsed.viralTrends ?? parsed.viral_trends ?? [];

        const topSignals = Array.isArray(signals) && signals.length > 0
          ? signals.slice(0, 10).map((s: any) => ({
              topic: String(s.topic ?? s.title ?? s.id ?? ''),
              platforms: Array.isArray(s.platforms) ? s.platforms
                : Array.isArray(s.platformPresence) ? s.platformPresence
                : [],
              compositeScore: Number(s.compositeScore ?? s.composite_score ?? 0),
              rationale: String(s.rationale ?? s.urgency ?? (Array.isArray(s.primaryAngles) ? s.primaryAngles[0] : '') ?? ''),
            }))
          : [];

        const viralTrends = Array.isArray(viral)
          ? viral.slice(0, 5).map((v: any) => ({
              trend: String(v.trend ?? v.topic ?? ''),
              platforms: Array.isArray(v.platforms) ? v.platforms : [],
              brandTieIn: String(v.brandTieIn ?? v.brand_tie_in ?? v.tieIn ?? ''),
              compositeScore: Number(v.compositeScore ?? v.composite_score ?? 0),
              urgent: Boolean(v.urgent ?? false),
            }))
          : [];

        if (topSignals.length > 0) {
          this.logger.log(`Coordinator extracted: ${topSignals.length} signals, ${viralTrends.length} viral trends`);
          return { topSignals, viralTrends };
        }
      } catch (err: any) {
        this.logger.warn(`extractTopSignalsAndViralTrends JSON parse failed: ${err.message}`);
      }
    }

    // Fallback: extract signals from plain text
    this.logger.warn('extractTopSignalsAndViralTrends: no JSON block found — attempting text extraction');
    const textSignals: CoordinatorResult['topSignals'] = [];
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*\d+[\.\)]\s+(.{10,80})/);
      if (match) {
        textSignals.push({
          topic: match[1].replace(/\*\*/g, '').trim(),
          platforms: [],
          compositeScore: 8 - textSignals.length * 0.5,
          rationale: '',
        });
        if (textSignals.length >= 7) break;
      }
    }

    if (textSignals.length > 0) {
      this.logger.warn(`extractTopSignalsAndViralTrends: recovered ${textSignals.length} signals from plain text`);
      return { topSignals: textSignals, viralTrends: [] };
    }

    throw new Error('Coordinator returned no parseable signals — cannot proceed with pipeline');
  }
}
