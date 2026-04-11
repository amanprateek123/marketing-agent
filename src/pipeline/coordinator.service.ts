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

    // Load industry signals + scout outputs (for viral trends)
    const [signals, scoutOutputs] = await Promise.all([
      this.scoutSignalModel.find({ tenantId, runId }).lean().exec(),
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

    const topSignals = this.extractTopSignals(result.content);

    const saved = await this.coordinatorOutputModel.create({
      tenantId,
      runId,
      content: result.content,
      topSignals,
    });

    this.logger.log(
      `Coordinator done: tenantId=${tenantId} runId=${runId} signals=${topSignals.length}`,
    );

    return {
      coordinatorOutputId: (saved as any)._id.toString(),
      content: result.content,
      topSignals,
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

COORDINATOR SYNTHESIS:
${coordinatorContent}

Company competitors to analyse: ${company.competitors.join(', ')}

NOTE: We have a separate Meta Ads Library agent that already scrapes competitor active Meta ad creatives.
DO NOT focus on ad creatives here. Instead, find what the Ads Library cannot surface:
- Pricing changes, new product launches, or promotions competitors just announced
- Customer complaints, bad reviews, or refund demands — these are attack angles for our ads
- Positioning shifts — if a competitor is moving upmarket or downmarket, there's a gap to exploit
- Seasonal campaigns or discount events competitors are running (to counter or out-price them)
- Press coverage or controversies that make their audience receptive to switching

Use web_search to find recent competitor news, reviews (G2, Trustpilot, Google Reviews), pricing pages, and social mentions.

Return ONLY a JSON object in this exact format — no markdown, no explanation:
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
- implication must be a specific Meta ad tactic — audience, hook angle, or offer to run
- urgency "high" = act this week, "medium" = this month, "low" = general awareness
    `.trim();

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.COMPETITOR_RESEARCH,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 15,
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

COORDINATOR SYNTHESIS:
${coordinatorContent}

Industry: ${company.industry}
Target audience: ${company.targetAudience}

Use web_search to find signals that translate into paid ad opportunities — NOT generic trend articles.
Focus on:
- Urgency triggers: festivals, salary cycles, exam seasons, weather shifts, tax deadlines — anything creating a "buy now" window
- Consumer pain points with purchase intent: complaints, unmet needs, price sensitivity signals from forums, reviews, Reddit
- Demand spikes: search trend data, news coverage showing a category moment (e.g. "anxiety at all-time high" → sell wellness product)
- Seasonal conversion windows: when does this audience's wallet open? What are they willing to spend on right now?

Each insight must pass the "can I run a profitable Meta ad against this right now?" test.
Skip macro trends with no clear commercial hook (e.g. "Gen Z values authenticity" — too vague to run an ad against).

Return ONLY a JSON object in this exact format — no markdown, no explanation:
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
      maxTurns: 6,
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
          .slice(0, 5)
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
1. From industry signals — identify topics appearing across multiple platforms (cross-platform momentum)
2. From viral trends — identify trends strong enough to tie into the brand, with a clear brand_tie_in
3. Combine both into a single ranked list (topSignals) scored 0–10
4. A viral trend with a strong brand tie-in can outscore a weak industry signal
5. Produce a synthesis brief that the intelligence and idea pool agents can use


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
  ]
}
\`\`\`

Include 5–10 top signals. Use exactly these field names: topic, platforms, compositeScore, rationale.
    `.trim();
  }

  private extractTopSignals(content: string): CoordinatorResult['topSignals'] {
    // Try JSON block first
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        const signals = parsed.topSignals ?? parsed.top_signals ?? parsed.signals ?? parsed.topics ?? [];
        if (Array.isArray(signals) && signals.length > 0) {
          return signals.slice(0, 10).map((s: any) => ({
            topic: String(s.topic ?? s.title ?? s.id ?? ''),
            platforms: Array.isArray(s.platforms) ? s.platforms
              : Array.isArray(s.platformPresence) ? s.platformPresence
              : [],
            compositeScore: Number(s.compositeScore ?? s.composite_score ?? 0),
            rationale: String(s.rationale ?? s.urgency ?? (Array.isArray(s.primaryAngles) ? s.primaryAngles[0] : '') ?? ''),
          }));
        }
      } catch (err: any) {
        this.logger.warn(`extractTopSignals JSON parse failed: ${err.message}`);
      }
    }

    // Fallback: extract signals from plain text by looking for numbered topics
    this.logger.warn('extractTopSignals: no JSON block found — attempting text extraction');
    const textSignals: CoordinatorResult['topSignals'] = [];
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*\d+[\.\)]\s+(.{10,80})/);
      if (match) {
        textSignals.push({
          topic: match[1].replace(/\*\*/g, '').trim(),
          platforms: [],
          compositeScore: 5,
          rationale: '',
        });
        if (textSignals.length >= 7) break;
      }
    }

    if (textSignals.length > 0) {
      this.logger.warn(`extractTopSignals: recovered ${textSignals.length} signals from plain text`);
      return textSignals;
    }

    // Hard fail — pipeline should not continue with 0 signals
    throw new Error('Coordinator returned no parseable signals — cannot proceed with pipeline');
  }
}
