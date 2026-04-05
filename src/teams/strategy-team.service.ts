import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { runTeamViaCli, CliResult } from './team-cli.util';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../pipeline/schemas/intelligence-brief.schema';
import { CreativeBrief, CreativeBriefDocument } from '../pipeline/schemas/creative-brief.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { CoordinatorResult } from '../pipeline/coordinator.service';
import { IdeaPoolResult } from '../pipeline/idea-pool.service';

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
    competitorResearch: string,
    marketResearch: string,
  ): Promise<IdeaPoolResult> {
    const tenantId = company.tenantId;
    const ideasPerRun = company.pipelineConfig?.ideasPerRun ?? 5;

    this.logger.log(`Strategy Team starting | tenant: ${tenantId} | run: ${runId}`);

    const prompt = this.buildPrompt(
      company, runId, coordinatorResult, competitorResearch, marketResearch, ideasPerRun,
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
    briefs.forEach((b: any) => { b.briefId = uuidv4(); });

    const winnerId = briefs.find((b: any) => b.selected)?.briefId ?? briefs[0]?.briefId ?? '';
    const winner = briefs.find((b: any) => b.briefId === winnerId);

    if (!winner) {
      throw new Error(`Strategy Team returned no usable ideas for run ${runId}`);
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

  private buildPrompt(
    company: CompanyDocument,
    runId: string,
    coordinator: CoordinatorResult,
    competitorResearch: string,
    marketResearch: string,
    ideasPerRun: number,
  ): string {
    const liveContext = this.liveContextBuilder.build(company);
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
- Causal insights: ${learnings.causalInsights?.slice(0, 3).map(c => c.finding).join('; ') || 'none yet'}
` : '';

    return `
You ARE the Strategist. You will debate with a Contrarian to decide the best ${ideasPerRun} campaign ideas for ${company.name}.

STEP 1: Call TeamCreate with team_name "strategy-${runId}"

STEP 2: Spawn the Contrarian via Agent tool with these EXACT parameters:
  - name: "contrarian"
  - team_name: "strategy-${runId}"
  - run_in_background: true
  - mode: "bypassPermissions"
  - prompt: "You are the Contrarian on the Strategy Team for ${company.name}. Your job is to challenge weak ideas and push for better ones.

DEBATE PROTOCOL:
- You will receive ideas from the Strategist via SendMessage.
- For each idea: CHALLENGE it (why it's weak/saturated/risky) or ENDORSE it (why it's strong).
- Be tough but fair. Give specific reasons, not vague criticism.
- When the Strategist pushes back on your challenges, EITHER concede if their argument is strong OR double down with a stronger counterpoint.
- Keep debating until you reach genuine agreement. Don't cave easily — but don't be stubborn for no reason either.
- When you and the Strategist agree on the winner, send a final message: {type: 'consensus', winner: 'topic name', reason: 'why we agreed'}.
- MAX 5 rounds of back-and-forth. If no consensus by round 5, send your final ranking and let the Strategist decide.
- Send all messages to 'team-lead'. Respond IMMEDIATELY when you receive a message."

STEP 3: Propose ${ideasPerRun} campaign ideas based on the data below. EVERY idea MUST sell a specific product from the catalog. Match trends to products using their trendKeywords. Send them to the Contrarian via SendMessage(to: "contrarian"). Label this as "ROUND 1".

STEP 4: The Contrarian will challenge or endorse each idea. When you receive their response:
  - If you AGREE with a challenge → kill or weaken that idea
  - If you DISAGREE → push back with a counter-argument: "I hear you, but here's why this still works..."
  - Send your response back to the Contrarian via SendMessage(to: "contrarian"). Label it "ROUND 2".

STEP 5: Continue the debate. The Contrarian may concede, double down, or propose alternatives.
  - Keep going until one of these happens:
    a) You both agree on the winner (consensus)
    b) You've done 5 rounds — make your final call
  - Each round: read their message, respond with counter-arguments or agreements

STEP 6: Once debate is settled, call TeamDelete to clean up. If TeamDelete fails, SKIP IT — do not retry. Cleanup will be handled automatically. Proceed directly to the output.

STEP 7: Return ONLY this JSON (no markdown, no explanation):
{
  "briefs": [
    {
      "topic": "...",
      "angle": "...",
      "product": "Nadi Report",
      "productPrice": 999,
      "targetSegment": "career_anxious",
      "platform": "instagram|youtube|twitter|reddit",
      "format": "reel|carousel|thread|video|image",
      "audience": "full audience description",
      "hook": "opening line or visual hook",
      "keyMessage": "what the audience should believe after seeing this",
      "conversionBridge": "how this leads to buying the specific product",
      "suggestedBudget": 0,
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

Mark exactly 1 brief as "selected": true — the winner.

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

COMPETITOR RESEARCH:
${competitorResearch}

MARKET RESEARCH:
${marketResearch}

${learningsContext}

${liveContext}

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
- At least 1 idea must exploit a competitor vulnerability
- At least 1 idea must be tied to the #1 coordinator signal
- Prefer products with higher confidence performance data — proven products get priority over hypothesis-stage products
- The Contrarian MUST see all ideas before you pick a winner
- Do NOT pick the winner before the debate — let it emerge from the argument
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
