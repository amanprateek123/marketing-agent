import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { runTeamViaCli } from './team-cli.util';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../pipeline/schemas/intelligence-brief.schema';
import { CreativeBrief, CreativeBriefDocument } from '../pipeline/schemas/creative-brief.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { CoordinatorResult } from '../pipeline/coordinator.service';
import { StructuredResearch } from '../pipeline/schemas/research-output.schema';
import { MetaAdsLibraryInsights } from '../pipeline/schemas/meta-ads-library-output.schema';
import { IdeaPoolResult } from '../pipeline/idea-pool.service';
import { MetaLearningImporterService } from '../campaigns/meta-ads/meta-learning-importer.service';

/**
 * Strategy Team — 2-agent debate (Strategist + Contrarian) via CLI.
 *
 * Replaces the single-agent Idea Pool + rule-based winner selection.
 * Both agents receive the FULL context (coordinator signals, competitor
 * research, market research, company learnings) and debate which ideas
 * to pursue and which one should win.
 *
 * Uses `claude -p` CLI because agent teams require tmux + InboxPoller.
 */
@Injectable()
export class StrategyTeamService {
  private readonly logger = new Logger(StrategyTeamService.name);

  constructor(
    private readonly liveContextBuilder: LiveContextBuilder,
    private readonly metaLearningImporter: MetaLearningImporterService,
    @InjectModel(IntelligenceBrief.name)
    private readonly intelligenceBriefModel: Model<IntelligenceBriefDocument>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBriefDocument>,
    @InjectModel(UsageLog.name)
    private readonly usageLogModel: Model<UsageLog>,
  ) {}

  async run(
    company: CompanyDocument,
    runId: string,
    coordinatorResult: CoordinatorResult,
    competitorResearch: StructuredResearch,
    marketResearch: StructuredResearch,
    adLibraryInsights: MetaAdsLibraryInsights,
  ): Promise<IdeaPoolResult> {
    const tenantId = company.tenantId;
    const ideasPerRun = company.pipelineConfig?.ideasPerRun ?? 10;

    this.logger.log(`Strategy Team starting | tenant: ${tenantId} | run: ${runId}`);

    const prompt = await this.buildPrompt(
      company, runId, coordinatorResult, competitorResearch, marketResearch, adLibraryInsights, ideasPerRun,
    );

    const teamName = `strategy-${runId}`;
    const cliResult = await runTeamViaCli(prompt, teamName, 'Strategy');

    // Log usage
    await this.usageLogModel.create({
      tenantId,
      runId,
      agent: AgentType.STRATEGY_TEAM_LEAD,
      claudeModel: 'claude-sonnet-4-6',
      inputTokens: cliResult.usage?.input_tokens ?? 0,
      outputTokens: cliResult.usage?.output_tokens ?? 0,
      costUSD: cliResult.total_cost_usd ?? 0,
      timestamp: new Date(),
    });

    this.logger.log(
      `Strategy Team completed | tenant: ${tenantId} | run: ${runId} | turns: ${cliResult.num_turns} | cost: $${cliResult.total_cost_usd?.toFixed(4)}`,
    );

    const parsed = this.parseOutput(cliResult.result);

    // Assign briefIds
    const briefs = parsed.briefs ?? [];
    if (briefs.length === 0) {
      throw new Error(`Strategy Team returned 0 ideas for run ${runId} — debate may have failed to produce output`);
    }
    briefs.forEach((b: any) => {
      b.briefId = uuidv4();
      // Validate product name — LLM may output slightly wrong casing or name
      // Find exact match first, then case-insensitive, then first active product
      const exactMatch = (company.products ?? []).find(p => p.name === b.product);
      const fuzzyMatch = exactMatch ?? (company.products ?? []).find(
        p => p.name?.toLowerCase() === b.product?.toLowerCase(),
      );
      const resolved = fuzzyMatch ?? (company.products ?? []).find(p => p.active) ?? (company.products ?? [])[0];
      if (resolved && !exactMatch) {
        this.logger.warn(`Strategy Team product mismatch: "${b.product}" → resolved to "${resolved.name}"`);
      }
      b.product = resolved?.name ?? b.product;
    });

    const winnerId = briefs.find((b: any) => b.selected)?.briefId ?? briefs[0].briefId;
    const winner = briefs.find((b: any) => b.briefId === winnerId);

    if (!winner) {
      throw new Error(`Strategy Team winner not found in briefs for run ${runId} — this is a bug`);
    }

    // Persist intelligence briefs
    await this.intelligenceBriefModel.insertMany(
      briefs.map((b: any) => ({
        tenantId,
        runId,
        briefId: b.briefId,
        topic: b.topic,
        angle: b.angle,
        platform: b.platform,
        format: b.format,
        audience: b.audience,
        hook: b.hook ?? '',
        keyMessage: b.keyMessage ?? '',
        conversionBridge: b.conversionBridge ?? '',
        confidenceScore: 0,
        urgencyScore: b.urgent ? 10 : 5,
        finalScore: b.priorityScore ?? 0,
        sourcePlatforms: b.sourcePlatforms ?? [],
        suggestedBudget: b.suggestedBudget ?? 0,
        selected: b.briefId === winnerId,
      })),
    );

    // Persist winning creative brief with debate history
    await this.creativeBriefModel.create({
      tenantId,
      runId,
      briefId: winnerId,
      topic: winner.topic,
      angle: winner.angle,
      platform: winner.platform,
      format: winner.format,
      audience: winner.audience,
      hook: winner.hook,
      keyMessage: winner.keyMessage,
      conversionBridge: winner.conversionBridge,
      suggestedBudget: winner.suggestedBudget ?? 0,
      finalScore: winner.priorityScore ?? 0,
      selected: true,
      selectionReason: winner.selectionReason ?? parsed.debateRationale ?? '',
      debateRounds: parsed.debateRounds ?? null,
      debateLog: parsed.debateLog ?? null,
      debateRationale: parsed.debateRationale ?? null,
    });

    this.logger.log(
      `Strategy Team persisted: ${briefs.length} briefs, winner=${winnerId} | run: ${runId}`,
    );

    return {
      briefs: briefs.map((b: any) => ({
        briefId: b.briefId,
        product: b.product ?? '',
        targetSegment: b.targetSegment ?? '',
        topic: b.topic,
        angle: b.angle,
        platform: b.platform,
        format: b.format,
        audience: b.audience,
        hook: b.hook ?? '',
        keyMessage: b.keyMessage ?? '',
        conversionBridge: b.conversionBridge ?? '',
        suggestedBudget: b.suggestedBudget ?? 0,
        finalScore: b.priorityScore ?? 0,
      })),
      selectedBriefId: winnerId,
      selectionReason: winner.selectionReason ?? parsed.debateRationale ?? '',
    };
  }

  private async buildPrompt(
    company: CompanyDocument,
    runId: string,
    coordinator: CoordinatorResult,
    competitorResearch: StructuredResearch,
    marketResearch: StructuredResearch,
    adLibraryInsights: MetaAdsLibraryInsights,
    ideasPerRun: number,
  ): Promise<string> {
    const liveContext = this.liveContextBuilder.build(company);

    // Get relevant case studies from past campaigns
    let caseStudyContext = '';
    try {
      const caseStudies = await this.metaLearningImporter.getRelevantCaseStudies(
        company.tenantId,
        { limit: 12 },
      );
      if (caseStudies.length > 0) {
        const recentStudies = caseStudies.slice(0, 12);
        const currentMonth = new Date().getMonth();
        const seasonalStudies = caseStudies.filter(cs => {
          if (!cs.dateRange) return false;
          try {
            // dateRange can be "Jan 2025 - Mar 2025" or "2025-01-01 - 2025-03-01"
            const firstPart = cs.dateRange.split(/\s*[-–]\s*/)[0].trim();
            const parsed = new Date(firstPart);
            if (isNaN(parsed.getTime())) return false;
            return parsed.getMonth() === currentMonth;
          } catch { return false; }
        }).slice(0, 3);

        // Combine: recent + seasonal, deduplicate
        const allStudies = [...recentStudies];
        for (const ss of seasonalStudies) {
          if (!allStudies.find(s => s.campaignName === ss.campaignName)) {
            allStudies.push(ss);
          }
        }

        caseStudyContext = `
PAST CAMPAIGN CASE STUDIES (from ${allStudies.length} campaigns):
${allStudies.slice(0, 15).map((cs, i) => `
  Case ${i + 1}: ${cs.campaignName} (${cs.dateRange})
    Product: ${cs.product} | Spend: ₹${cs.totalSpend} | Conversions: ${cs.totalConversions}
    What worked: ${cs.whatWorked?.hooks?.join(', ') || 'unknown'} hooks, ${cs.whatWorked?.audiences?.join(', ') || 'unknown'} audiences, best CPA ₹${cs.whatWorked?.bestCPA || 'N/A'}
    What failed: ${cs.whatFailed?.reason || 'nothing notable'}
    Lesson: ${cs.lesson}
`).join('')}`;
      }
    } catch (err: any) {
      this.logger.warn(`Case studies unavailable for ${company.tenantId}: ${err.message}`);
    }
    const learnings = company.learnings;

    const topSignals = coordinator.topSignals
      .slice(0, 7)
      .map((s, i) =>
        `Signal ${i + 1} (score: ${s.compositeScore}) — "${s.topic}" | Platforms: ${s.platforms.join(', ')} | ${s.rationale}`,
      )
      .join('\n');

    const activeProducts = (company.products ?? []).filter(p => p.active);
    const productCatalog = activeProducts.map(p => {
      const segments = (p.audienceSegments ?? []).map(s =>
        `    - ${s.name} (${s.confidence}${s.conversions ? `, ${s.conversions} conversions, CPA ₹${s.avgCPA}` : ''}): ${s.description}`
      ).join('\n');
      const metaAud = (p.metaAudiences ?? []).map(a =>
        `    - [${a.type}${a.lookalikePercent ? ` ${a.lookalikePercent}%` : ''}] ${a.name}`
      ).join('\n');
      const perf = p.performance;
      const perfLine = perf?.totalConversions
        ? `Performance: ${perf.totalConversions} conversions, CPA ₹${perf.avgCPA}, ROAS ${perf.avgROAS}x (${perf.confidenceLevel})`
        : 'Performance: no data yet';

      return `  ${p.name} — ₹${p.price} ${p.currency}
    ${p.description}
    Landing: ${p.landingUrl ?? 'not set'}
    Languages: ${(p.languages ?? []).join(', ') || 'not set'}
    Trend keywords: ${(p.trendKeywords ?? []).join(', ')}
    Differentiators: ${(p.differentiators ?? []).join(' | ')}
    ${perfLine}
    Audience segments:
${segments || '    none defined'}
    Meta audiences:
${metaAud || '    none linked'}`;
    }).join('\n\n');

    const learningsContext = learnings ? `
PAST LEARNINGS (what worked and what didn't):
- Winning hooks: ${learnings.creative?.winningHooks?.join(', ') || 'none yet'}
- Losing hooks: ${learnings.creative?.losingHooks?.join(', ') || 'none yet'}
- Winning formats: ${learnings.creative?.winningFormats?.join(', ') || 'none yet'}
- Top audience scores: ${learnings.campaign?.audienceScores ? Object.entries(learnings.campaign.audienceScores).sort(([,a],[,b]) => b - a).slice(0, 3).map(([k,v]) => `${k}: ${v}`).join(', ') : 'none yet'}
- Budget insights: ${learnings.campaign?.budgetInsights?.join('; ') || 'none yet'}
- Timing insights: ${learnings.campaign?.timingInsights?.join('; ') || 'none yet'}
- Causal insights: ${learnings.causalInsights?.slice(0, 3).map(c => c.finding).join('; ') || 'none yet'}
` : '';

    return `
You ARE the Strategist. You will generate a large pool of ideas then debate with a Contrarian to find the best ${ideasPerRun} for ${company.name}.

STEP 1: Call TeamCreate with team_name "strategy-${runId}"

STEP 2: Spawn the Contrarian via Agent tool with these EXACT parameters:
  - name: "contrarian"
  - team_name: "strategy-${runId}"
  - run_in_background: true
  - mode: "bypassPermissions"
  - prompt: "You are the Contrarian on the Strategy Team for ${company.name}. Your job is to eliminate weak ideas fast and push for the strongest ${ideasPerRun}.

DEBATE PROTOCOL:
ROUND 1 — Quick elimination pass:
- You receive 20-25 raw ideas from the Strategist.
- For each idea give a quick verdict: KEEP (strong, has real conversion potential) or CUT (weak, saturated, no clear product tie-in).
- Be ruthless. Cut at least 8-10 ideas. Give one-line reasons only in this round.
- Send your verdict list back to the Strategist as 'ROUND 1 VERDICT'.

ROUND 2-3 — Deep debate on survivors:
- The Strategist will push back on your cuts and defend survivors.
- For each kept idea: challenge the hook, the audience fit, the conversion bridge. Force them to be specific.
- When the Strategist defends an idea well — concede. When they can't — cut it.
- Goal: converge on the strongest ${ideasPerRun} ideas with 1 clear winner.

FINAL — When you agree on the top ${ideasPerRun}:
- Send {type: 'consensus', topIdeas: ['topic1', 'topic2', ...], winner: 'winning topic', reason: 'why'}.
- MAX 5 rounds total. If no consensus by round 5, send your final top ${ideasPerRun} ranking.
- Send all messages to 'team-lead'. Respond IMMEDIATELY when you receive a message."

STEP 3: Generate 20-25 raw campaign ideas drawing freely from ALL sources below — no fixed quotas per source. The best ideas win regardless of where they come from. EVERY idea MUST sell a specific product from the catalog. Send ALL ideas to the Contrarian via SendMessage(to: "contrarian"). Label this as "ROUND 1 — RAW IDEAS".
CRITICAL: After SendMessage, do NOT output any text. Immediately call TaskCreate with name "round-1-pending" and body "waiting for contrarian response". This keeps you active so their reply can arrive. Do not produce any output until you receive their message.

STEP 4: When you receive the Contrarian's ROUND 1 VERDICT:
  - Accept cuts of clearly weak ideas immediately — don't waste rounds defending bad ideas
  - Push back ONLY on cuts you genuinely disagree with — give specific data from the signals to defend
  - SendMessage(to: "contrarian") with your response labeled "ROUND 2", then call TaskCreate(name: "round-2-pending") — do NOT output text.
  PATIENCE: The Contrarian runs in the background and takes several minutes to respond. Do NOT give up or produce output on your own. Keep waiting via TaskCreate until their message arrives. Only nudge once (via SendMessage) if you have called TaskCreate 4+ times with no reply.

STEP 5: Continue the debate. Each round: receive their message → respond via SendMessage → call TaskCreate to wait again.
  - Keep going until:
    a) You both agree on the top ${ideasPerRun} and 1 winner (consensus — Contrarian sends {type: "consensus"})
    b) You've done 5 rounds — make your final call
  - Never produce output mid-debate. Always use TaskCreate to stay alive between rounds.

STEP 6: Once debate is settled:
  1. SendMessage(to: "contrarian", message: {type: "shutdown_request"})
  2. Call TaskCreate(name: "shutdown-pending", body: "waiting for shutdown confirmation") — do NOT call TeamDelete yet.
  3. Wait for the shutdown confirmation to arrive as an incoming message.
  4. Only after receiving confirmation: call TeamDelete.
  If TeamDelete fails after receiving confirmation, SKIP IT — cleanup is automatic. Proceed to output.

STEP 7: Return ONLY this JSON (no markdown, no explanation):
{
  "briefs": [
    {
      "topic": "...",
      "angle": "...",
      "product": "Nadi Report",
      "productPrice": 999,
      "targetSegment": "career_anxious",
      "platform": "instagram|facebook|youtube|reddit",
      "format": "reel|carousel|video|single_image|collection",
      "audience": "full audience description",
      "hook": "opening line or visual hook",
      "keyMessage": "what the audience should believe after seeing this",
      "conversionBridge": "how this leads to buying the specific product",
      "suggestedBudget": 1500,   ← DAILY budget in ₹/day. Use past CPA data + audience size to estimate. Conservative first-run = ₹1000-2000/day. Proven audience = ₹2000-5000/day. Never exceed ₹${company.maxBudgetPerCampaign ?? 10000}/day.
      "ideaSource": "scout_signal|viral_trend|competitor_gap|market_insight",
      "sourcePlatforms": ["instagram", "youtube"],
      "urgent": false,
      "priorityScore": 8.5,
      "selected": true/false,
      "selectionReason": "why this idea won or lost the debate",
      "contrariansVerdict": "what the contrarian said about this idea"
    }
  ],
  "debateRounds": 3,
  "debateLog": [
    {"round": 1, "from": "strategist", "summary": "proposed 5 ideas"},
    {"round": 1, "from": "contrarian", "summary": "challenged #3 and #5, endorsed #1"},
    {"round": 2, "from": "strategist", "summary": "defended #3 with new data, conceded #5"},
    {"round": 2, "from": "contrarian", "summary": "accepted #3 defense, agreed #1 is winner"},
    {"round": 3, "from": "both", "summary": "consensus reached on #1"}
  ],
  "debateRationale": "2-3 sentence summary of the full debate — what was argued, who pushed back on what, and why the winner won"
}

Return exactly ${ideasPerRun} briefs — the survivors after the debate. Mark exactly 1 as "selected": true — the winner.

═══════════════════════════════════════════════════════
PRODUCT CATALOG — every idea MUST sell one of these
═══════════════════════════════════════════════════════

${productCatalog || 'No products configured.'}

═══════════════════════════════════════════════════════
TRENDING SIGNALS (from scouts + coordinator)
═══════════════════════════════════════════════════════

COORDINATOR SIGNALS (cross-validated from 4 platforms):
${topSignals || coordinator.content.slice(0, 2000)}

FULL COORDINATOR SYNTHESIS:
${coordinator.content}

COMPETITOR INSIGHTS (ranked by opportunity score):
${competitorResearch.insights.map((i, idx) =>
  `${idx + 1}. [score:${i.score} | urgency:${i.urgency}] ${i.insight}\n   → ${i.implication}${i.source ? `\n   source: ${i.source}` : ''}`
).join('\n')}
Summary: ${competitorResearch.rawSummary}

MARKET INSIGHTS (ranked by opportunity score):
${marketResearch.insights.map((i, idx) =>
  `${idx + 1}. [score:${i.score} | urgency:${i.urgency}] ${i.insight}\n   → ${i.implication}${i.source ? `\n   source: ${i.source}` : ''}`
).join('\n')}
Summary: ${marketResearch.rawSummary}

META ADS LIBRARY — WHAT COMPETITORS ARE RUNNING RIGHT NOW:
${adLibraryInsights.competitorAds.length > 0
  ? adLibraryInsights.competitorAds.map((a, idx) =>
    `${idx + 1}. [score:${a.score}] ${a.competitor} — "${a.hook}" | angle: ${a.angle} | format: ${a.format} | CTA: ${a.cta} | running ~${a.estimatedDaysRunning}d`
  ).join('\n')
  : '  No competitor ad data available.'}

META ADS GAPS — WHAT NOBODY IS DOING (your opportunities):
${adLibraryInsights.gaps.length > 0
  ? adLibraryInsights.gaps.map((g, idx) =>
    `${idx + 1}. [score:${g.score} | ${g.urgency}] ${g.gap}\n   → ${g.opportunity}`
  ).join('\n')
  : '  No gap data available.'}
Dominant format in category: ${adLibraryInsights.dominantFormat}
${adLibraryInsights.rawSummary ? `Summary: ${adLibraryInsights.rawSummary}` : ''}

${learningsContext}

${liveContext}

${caseStudyContext}

CAMPAIGN STRATEGY MODE: ${company.pipelineConfig?.campaignStrategy ?? 'balanced'}
${(() => {
  const strategy = company.pipelineConfig?.campaignStrategy ?? 'balanced';
  if (strategy === 'conservative') return `- CONSERVATIVE MODE: Only use proven winners. Every idea must use a hook style, audience segment, or format with past performance data (confidence: medium or high). No untested ideas. Prioritize lowest CPA over highest reach.`;
  if (strategy === 'experimental') return `- EXPERIMENTAL MODE: Prioritize new ideas and untested angles. At least 3 of ${ideasPerRun} ideas should use new hook styles, new audience segments, or new formats. Accept higher risk for higher potential. Test budget should be 30-40% of total.`;
  return `- BALANCED MODE: Mix proven winners with new tests. At least 2 ideas should use proven hooks/audiences/formats. At least 1 idea should test something new (new hook style, new audience, or new angle). This is the default — steady ROAS + continuous learning.`;
})()}

RULES:
- EVERY idea must sell a specific product from the catalog above
- Match trends to products using their trendKeywords — if a trend doesn't connect to any product, skip it
- The "product" and "targetSegment" fields are REQUIRED for every brief
- The "conversionBridge" must mention the product name, price, and how the trend connects to buying it
- Draw from ALL sources — coordinator signals, competitor insights, market insights, Meta Ads Library gaps, past learnings. No fixed quotas. The best ideas from any source make the final cut.
- In your raw 20-25 ideas, make sure you have attempted at least 2 ideas from competitor/Meta Ads Library sources and 2 from market insights — so no source is completely ignored before the debate culls them
- Prefer products with higher confidence performance data — proven products get priority over hypothesis-stage products
- The Contrarian MUST see all raw ideas before you pick a winner
- Do NOT pick the winner before the debate — let it emerge from the argument
- BUDGET RULE: suggestedBudget = DAILY budget in ₹/day (NOT total, NOT weekly). Base it on:
  * No past data → ₹${Math.round((company.weeklyBudgetCap ?? 20000) * 0.15)} (15% of weekly cap as a safe first-run test)
  * Some past data (1-3 campaigns) → ₹${Math.round((company.weeklyBudgetCap ?? 20000) * 0.20)}
  * Strong past data + proven audience → ₹${Math.round((company.weeklyBudgetCap ?? 20000) * 0.30)}
  * Hard cap: NEVER suggest above ₹${company.maxBudgetPerCampaign ?? 10000}/day
  * Weekly estimate = suggestedBudget × 7 — must fit within ₹${company.weeklyBudgetCap ?? 20000} weekly cap
  * NEVER output suggestedBudget as 0
    `.trim();
  }

  private parseOutput(content: string): any {
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      const jsonStr = fenceMatch
        ? fenceMatch[1].trim()
        : content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
      return JSON.parse(jsonStr);
    } catch {
      this.logger.error('Strategy Team output parse failed');
      throw new Error('Strategy Team returned invalid JSON');
    }
  }
}
