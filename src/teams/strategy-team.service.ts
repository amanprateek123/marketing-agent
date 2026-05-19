import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { runTeamViaCli } from './team-cli.util';
import { AgentType } from '../claude/claude.types';
import { ClaudeService } from '../claude/claude.service';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { buildSkillBlock, skillsForAgent } from '../common/skills/agent-skill-map';
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
    private readonly claudeService: ClaudeService,
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
    const teamMode = company.pipelineConfig?.teamMode ?? 'sequential';
    this.logger.log(`Strategy Team starting | tenant: ${company.tenantId} | run: ${runId} | mode: ${teamMode}`);

    if (teamMode === 'cli') {
      return this.runViaCli(company, runId, coordinatorResult, competitorResearch, marketResearch, adLibraryInsights);
    }
    return this.runSequential(company, runId, coordinatorResult, competitorResearch, marketResearch, adLibraryInsights);
  }

  // ── CLI path (2-agent tmux debate) ─────────────────────────────────────────
  private async runViaCli(
    company: CompanyDocument,
    runId: string,
    coordinatorResult: CoordinatorResult,
    competitorResearch: StructuredResearch,
    marketResearch: StructuredResearch,
    adLibraryInsights: MetaAdsLibraryInsights,
  ): Promise<IdeaPoolResult> {
    const tenantId = company.tenantId;
    const ideasPerRun = company.pipelineConfig?.ideasPerRun ?? 10;

    const prompt = await this.buildPrompt(
      company, runId, coordinatorResult, competitorResearch, marketResearch, adLibraryInsights, ideasPerRun,
    );

    const cliResult = await runTeamViaCli(prompt, `strategy-${runId}`, 'Strategy');

    await this.usageLogModel.create({
      tenantId, runId,
      agent: AgentType.STRATEGY_TEAM_LEAD,
      claudeModel: 'claude-sonnet-4-6',
      inputTokens: cliResult.usage?.input_tokens ?? 0,
      outputTokens: cliResult.usage?.output_tokens ?? 0,
      costUSD: cliResult.total_cost_usd ?? 0,
      timestamp: new Date(),
    });

    this.logger.log(`Strategy Team (CLI) completed | tenant: ${tenantId} | run: ${runId} | turns: ${cliResult.num_turns}`);
    return this.processAndPersist(company, runId, this.parseOutput(cliResult.result));
  }

  // ── Sequential path (2 runAgent() calls) ───────────────────────────────────
  private async runSequential(
    company: CompanyDocument,
    runId: string,
    coordinatorResult: CoordinatorResult,
    competitorResearch: StructuredResearch,
    marketResearch: StructuredResearch,
    adLibraryInsights: MetaAdsLibraryInsights,
  ): Promise<IdeaPoolResult> {
    const tenantId = company.tenantId;
    const ideasPerRun = company.pipelineConfig?.ideasPerRun ?? 10;
    const poolSize = Math.max(20, ideasPerRun * 3);
    const cutTarget = Math.floor(poolSize * 0.4);

    // ── Call 1: Strategist generates pool of raw ideas ──────────────────────
    const call1Prompt = await this.buildCall1Prompt(
      company, runId, coordinatorResult, competitorResearch, marketResearch, adLibraryInsights, poolSize, ideasPerRun,
    );

    const call1 = await this.claudeService.runAgent({
      tenantId, runId,
      agentType: AgentType.STRATEGY_TEAM_LEAD,
      // strategyTeamLead isn't generated yet — ideaPool was generated with the same skills
      // (paid-ads, ad-creative, marketing-psychology, product-marketing-context, copywriting)
      // and covers exactly the same mandate: brand voice + what makes a Meta ad idea profitable.
      systemPrompt: company.prompts?.strategyTeamLead ?? company.prompts?.ideaPool ?? '',
      // liveContext is already embedded in call1Prompt via buildCall1Prompt → buildPrompt
      // passing it here would inject it twice (system prompt + user message)
      liveContext: '',
      userMessage: call1Prompt,
      maxTurns: 5,
      skills: skillsForAgent('STRATEGY_TEAM'),   // SDK preloads paid-ads + marketing-psychology + product-marketing-context + customer-research + market-research + competitor-alternatives
    });

    this.logger.log(`Strategy Team sequential — Call 1 done (${call1.content.length} chars)`);

    // ── Validate Call 1 before passing to the Contrarian ────────────────────
    let call1Parsed: any;
    try {
      call1Parsed = this.parseOutput(call1.content);
    } catch (parseErr: any) {
      throw new Error(`Strategy Team Call 1 returned unparseable output — cannot proceed to contrarian review: ${parseErr.message}`);
    }
    const call1Briefs: any[] = call1Parsed.briefs ?? [];
    if (call1Briefs.length === 0) {
      throw new Error(`Strategy Team Call 1 returned 0 ideas for run ${runId}`);
    }

    // ── Call 2: Contrarian reviews and cuts to best ideasPerRun ─────────────
    const compactIntelligence = `Top signals: ${coordinatorResult.topSignals.slice(0, 5).map(s => `"${s.topic}" (${s.compositeScore})`).join(', ')}
Competitor insights: ${competitorResearch.insights.slice(0, 3).map(i => i.insight).join('; ') || 'none'}
Market insights: ${marketResearch.insights.slice(0, 3).map(i => i.insight).join('; ') || 'none'}
Ads library gaps: ${adLibraryInsights.gaps.slice(0, 3).map(g => g.gap).join('; ') || 'none'}
Products: ${(company.products ?? []).filter(p => p.active).map(p => `${p.name} (₹${p.price})`).join(', ')}`;

    const call2UserMessage = `You are a strategic contrarian reviewing campaign ideas for ${company.name}.

INTELLIGENCE CONTEXT (what these ideas were generated from):
${compactIntelligence}

RAW IDEAS TO REVIEW (${call1Briefs.length} ideas from the strategist):
${JSON.stringify(call1Briefs, null, 2)}

YOUR JOB:
1. Cut at least ${cutTarget} weak ideas. For each cut give a one-line reason: weak conversion bridge, saturated angle, no intelligence backing, wrong product fit, or too similar to another idea.
2. For each kept idea: verify it has a specific product tie-in, a believable audience, and is backed by a real signal from the intelligence above.
3. Select 1 winner — the idea most likely to convert profitably this week.
4. Return exactly ${ideasPerRun} surviving ideas in this JSON format (no markdown, no explanation):

{
  "briefs": [ ...same fields as input... ],
  "debateRounds": 2,
  "debateLog": [
    {"round": 1, "from": "strategist", "summary": "generated ${call1Briefs.length} ideas from intelligence"},
    {"round": 2, "from": "contrarian", "summary": "cut ${call1Briefs.length - ideasPerRun} weak ideas, selected winner"}
  ],
  "debateRationale": "why the winner is the strongest idea"
}

Mark exactly 1 brief as "selected": true. All others "selected": false.`;

    const call2 = await this.claudeService.runAgent({
      tenantId, runId,
      agentType: AgentType.IDEA_POOL,
      systemPrompt: `You are a strategic contrarian for a marketing team. Your job is to cut weak campaign ideas and identify the single strongest idea that will drive profitable conversions. Be ruthless — a weak idea that reaches production wastes the entire pipeline budget.`,
      liveContext: '',
      userMessage: call2UserMessage,
      maxTurns: 3,
      skills: skillsForAgent('STRATEGY_TEAM'),   // contrarian gets same skills as strategist
    });

    this.logger.log(`Strategy Team sequential — Call 2 done | tenant: ${tenantId} | run: ${runId}`);
    return this.processAndPersist(company, runId, this.parseOutput(call2.content));
  }

  // ── Shared post-processing and DB persistence ───────────────────────────────
  private async processAndPersist(
    company: CompanyDocument,
    runId: string,
    parsed: any,
  ): Promise<IdeaPoolResult> {
    const tenantId = company.tenantId;

    const briefs = parsed.briefs ?? [];
    if (briefs.length === 0) {
      throw new Error(`Strategy Team returned 0 ideas for run ${runId}`);
    }

    briefs.forEach((b: any) => {
      b.briefId = uuidv4();
      const exactMatch = (company.products ?? []).find(p => p.name === b.product);
      const fuzzyMatch = exactMatch ?? (company.products ?? []).find(
        p => p.name?.toLowerCase() === b.product?.toLowerCase(),
      );
      if (fuzzyMatch) {
        if (!exactMatch) this.logger.warn(`Strategy Team product casing mismatch: "${b.product}" → "${fuzzyMatch.name}"`);
        b.product = fuzzyMatch.name;
      } else {
        this.logger.error(`Strategy Team hallucinated product "${b.product}" — dropping brief "${b.topic}"`);
        b._invalid = true;
      }
    });

    const validBriefs = briefs.filter((b: any) => !b._invalid);
    if (validBriefs.length === 0) {
      throw new Error(`Strategy Team: all ${briefs.length} briefs had invalid products`);
    }
    validBriefs.forEach((b: any) => delete b._invalid);

    const winnerId = validBriefs.find((b: any) => b.selected)?.briefId ?? validBriefs[0].briefId;
    const winner = validBriefs.find((b: any) => b.briefId === winnerId);
    if (!winner) throw new Error(`Strategy Team winner not found in briefs for run ${runId}`);

    // ── Exploration arm assignment (closed-loop drift mitigation) ─────────────
    // Round-N winners drive round-N+1 prompt generation drives round-N+1
    // creative drives round-N+1 winners → autoregressive bias → monoculture.
    // Force 1-of-N briefs to use a hookStyle NOT in winningHooks AND NOT in
    // losingHooks. Creative Team prompts will skip injecting winning exemplars
    // for these briefs, letting the LLM generate freely. Tagged for downstream
    // measurement of exploration vs exploitation performance over time.
    if (validBriefs.length >= 3) {
      const winningHookSet = new Set(
        (company.learnings?.creative?.winningHooks ?? [])
          .map(h => h.split(' ')[0]?.toLowerCase()) // strip "(2.34% CTR, 5 ads)" suffix
          .filter(Boolean),
      );
      const losingHookSet = new Set(
        (company.learnings?.creative?.losingHooks ?? [])
          .map(h => h.split(' ')[0]?.toLowerCase())
          .filter(Boolean),
      );
      // Pick the brief whose hookStyle is in NEITHER set (true exploration).
      // Fallback: if none qualify, pick the lowest priorityScore brief — that's
      // the one the Strategy Team itself was least confident in, which is a
      // reasonable proxy for "outside the optimal exploitation distribution."
      const explorationCandidate =
        validBriefs.find((b: any) => {
          const hs = (b.hookStyle ?? '').toLowerCase();
          return hs && !winningHookSet.has(hs) && !losingHookSet.has(hs);
        }) ?? validBriefs.slice().sort((a: any, b: any) => (a.priorityScore ?? 0) - (b.priorityScore ?? 0))[0];
      if (explorationCandidate && explorationCandidate.briefId !== winnerId) {
        explorationCandidate._explorationArm = true;
        this.logger.log(
          `Strategy Team: exploration arm assigned to brief "${explorationCandidate.topic}" (hookStyle: ${explorationCandidate.hookStyle ?? 'unknown'}, winningHooks: [${[...winningHookSet].join(',')}])`,
        );
      }
    }

    await this.intelligenceBriefModel.deleteMany({ tenantId, runId });
    await this.intelligenceBriefModel.insertMany(
      validBriefs.map((b: any) => ({
        tenantId, runId,
        briefId: b.briefId,
        product: b.product ?? '',
        topic: b.topic, angle: b.angle, platform: b.platform,
        format: b.format, audience: b.audience,
        hook: b.hook ?? '', keyMessage: b.keyMessage ?? '', conversionBridge: b.conversionBridge ?? '',
        // audienceStage from LLM output, validated against the enum. Defaults to 'cold'
        // (most first-pass briefs target prospecting). 'warm' / 'hot' only when the
        // audience description explicitly signals retargeting / cart-recovery.
        audienceStage: ['cold', 'warm', 'hot'].includes(b.audienceStage) ? b.audienceStage : 'cold',
        // targetLanguage drives ALL downstream creative (copy, image overlay,
        // VO). LLM picks based on audience description + geo. Empty/invalid →
        // resolver falls back to geo-derived → product.languages → 'hinglish'.
        // Without this field the audit-fired add_creative can't preserve language
        // across re-launches.
        targetLanguage: typeof b.targetLanguage === 'string' ? b.targetLanguage.toLowerCase().trim() : undefined,
        explorationArm: !!b._explorationArm,
        // targetSegment from LLM — should match a name in product.audienceSegments[].
        // The TS resolver in campaign-creator.launch() reads this and applies the
        // segment's age/gender/interests to ad sets. Empty string = no specific
        // segment, fallback to default targeting.
        targetSegment: b.targetSegment ?? '',
        confidenceScore: 0,
        urgencyScore: b.urgent ? 10 : 5,
        finalScore: b.priorityScore ?? 0,
        sourcePlatforms: b.sourcePlatforms ?? [],
        suggestedBudget: b.suggestedBudget ?? 0,
        selected: b.briefId === winnerId,
      })),
    );

    await this.creativeBriefModel.create({
      tenantId, runId,
      briefId: winnerId,
      product: winner.product ?? '',
      topic: winner.topic, angle: winner.angle, platform: winner.platform,
      format: winner.format, audience: winner.audience,
      hook: winner.hook, keyMessage: winner.keyMessage, conversionBridge: winner.conversionBridge,
      // Persist audienceStage on the CreativeBrief too — campaign-creator reads
      // from CreativeBriefDocument, not IntelligenceBrief, so without this the
      // field is dropped at this boundary and the Campaign Review Team always
      // sees undefined → falls back to cold prospecting regardless of brief intent.
      audienceStage: ['cold', 'warm', 'hot'].includes(winner.audienceStage) ? winner.audienceStage : 'cold',
      targetLanguage: typeof winner.targetLanguage === 'string' ? winner.targetLanguage.toLowerCase().trim() : undefined,
      explorationArm: !!winner._explorationArm,
      targetSegment: winner.targetSegment ?? '',
      suggestedBudget: winner.suggestedBudget ?? 0,
      finalScore: winner.priorityScore ?? 0,
      selected: true,
      selectionReason: winner.selectionReason ?? parsed.debateRationale ?? '',
      debateRounds: parsed.debateRounds ?? null,
      debateLog: parsed.debateLog ?? null,
      debateRationale: parsed.debateRationale ?? null,
    });

    this.logger.log(`Strategy Team persisted: ${validBriefs.length} briefs, winner=${winnerId} | run: ${runId}`);

    return {
      briefs: validBriefs.map((b: any) => ({
        briefId: b.briefId, product: b.product ?? '', targetSegment: b.targetSegment ?? '',
        topic: b.topic, angle: b.angle, platform: b.platform, format: b.format,
        audience: b.audience, hook: b.hook ?? '', keyMessage: b.keyMessage ?? '',
        conversionBridge: b.conversionBridge ?? '', suggestedBudget: b.suggestedBudget ?? 0,
        finalScore: b.priorityScore ?? 0,
        audienceStage: ['cold', 'warm', 'hot'].includes(b.audienceStage) ? b.audienceStage : 'cold',
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
    const poolSize = Math.max(20, ideasPerRun * 3);
    const cutTarget = Math.floor(poolSize * 0.4);

    // ── Case studies (recent only — no fragile seasonal matching) ─────────────
    let caseStudyContext = '';
    try {
      const caseStudies = await this.metaLearningImporter.getRelevantCaseStudies(
        company.tenantId,
        { limit: 12 },
      );
      if (caseStudies.length > 0) {
        caseStudyContext = `
PAST CAMPAIGN CASE STUDIES (${caseStudies.length} most recent):
${caseStudies.slice(0, 12).map((cs, i) => `  Case ${i + 1}: ${cs.campaignName} (${cs.dateRange})
    Product: ${cs.product} | Spend: ₹${cs.totalSpend} | Conversions: ${cs.totalConversions}
    What worked: ${cs.whatWorked?.hooks?.join(', ') || 'unknown'} hooks, ${cs.whatWorked?.audiences?.join(', ') || 'unknown'} audiences, best CPA ₹${cs.whatWorked?.bestCPA || 'N/A'}
    What failed: ${cs.whatFailed?.reason || 'nothing notable'}
    Lesson: ${cs.lesson}`).join('\n')}`;
      }
    } catch (err: any) {
      this.logger.warn(`Case studies unavailable for ${company.tenantId}: ${err.message}`);
    }

    // ── Top signals (structured, no full synthesis duplication) ───────────────
    const topSignals = coordinator.topSignals
      .slice(0, 7)
      .map((s, i) =>
        `Signal ${i + 1} (score: ${s.compositeScore}) — "${s.topic}" | Platforms: ${s.platforms.join(', ')} | ${s.rationale}`,
      )
      .join('\n');

    // ── Product catalog ──────────────────────────────────────────────────────
    const activeProducts = (company.products ?? []).filter(p => p.active);
    const productCatalog = activeProducts.map(p => {
      const segments = (p.audienceSegments ?? []).map(s =>
        `    - ${s.name} (${s.confidence}${s.conversions ? `, ${s.conversions} conversions, CPA ₹${s.avgCPA}` : ''}): ${s.description}`
      ).join('\n');
      // Sort lookalikes tightest-first (1% > 1-2% > 2-3%) so the briefer sees
      // the highest-quality audience at the top of the list. Loose lookalikes
      // delivered ₹6 junk-traffic CPC + 0.10% CVR in May 2026; tight lookalikes
      // have ~3x the buyer signal density.
      const metaAud = [...(p.metaAudiences ?? [])]
        .sort((a, b) => {
          const aIsLal = a.type === 'lookalike';
          const bIsLal = b.type === 'lookalike';
          if (aIsLal && bIsLal) return (a.lookalikePercent ?? 99) - (b.lookalikePercent ?? 99);
          if (aIsLal) return -1;
          if (bIsLal) return 1;
          return 0;
        })
        .map(a =>
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

    // ── Intelligence sections (with empty state handling) ────────────────────
    const competitorSection = competitorResearch.insights.length > 0
      ? `COMPETITOR INSIGHTS:
${competitorResearch.insights.map((i, idx) =>
  `${idx + 1}. [score:${i.score} | urgency:${i.urgency}] ${i.insight}\n   → ${i.implication}${i.source ? `\n   source: ${i.source}` : ''}`
).join('\n')}
Summary: ${competitorResearch.rawSummary}`
      : 'COMPETITOR INSIGHTS: No actionable competitor data this run.';

    const marketSection = marketResearch.insights.length > 0
      ? `MARKET INSIGHTS:
${marketResearch.insights.map((i, idx) =>
  `${idx + 1}. [score:${i.score} | urgency:${i.urgency}] ${i.insight}\n   → ${i.implication}${i.source ? `\n   source: ${i.source}` : ''}`
).join('\n')}
Summary: ${marketResearch.rawSummary}`
      : 'MARKET INSIGHTS: No actionable market signals this run.';

    const adsLibrarySection = adLibraryInsights.competitorAds.length > 0 || adLibraryInsights.gaps.length > 0
      ? `META ADS LIBRARY:
${adLibraryInsights.competitorAds.length > 0
  ? `Competitor ads running now:\n${adLibraryInsights.competitorAds.map((a, idx) =>
    `  ${idx + 1}. [score:${a.score}] ${a.competitor} — "${a.hook}" | angle: ${a.angle} | format: ${a.format} | CTA: ${a.cta} | running ~${a.estimatedDaysRunning}d`
  ).join('\n')}`
  : '  No competitor ads found.'}
${adLibraryInsights.gaps.length > 0
  ? `Gaps nobody is exploiting:\n${adLibraryInsights.gaps.map((g, idx) =>
    `  ${idx + 1}. [score:${g.score} | ${g.urgency}] ${g.gap}\n   → ${g.opportunity}`
  ).join('\n')}`
  : ''}
Dominant format: ${adLibraryInsights.dominantFormat}${adLibraryInsights.rawSummary ? `\nSummary: ${adLibraryInsights.rawSummary}` : ''}`
      : 'META ADS LIBRARY: No ads library data this run.';

    // ── Strategy mode ────────────────────────────────────────────────────────
    const strategy = company.pipelineConfig?.campaignStrategy ?? 'balanced';
    const strategyMode = strategy === 'conservative'
      ? `CONSERVATIVE MODE: Only use proven winners. Every idea must use a hook style, audience segment, or format with past performance data (confidence: medium or high). No untested ideas. Prioritize lowest CPA over highest reach.`
      : strategy === 'experimental'
        ? `EXPERIMENTAL MODE: Prioritize new ideas and untested angles. At least 3 of ${ideasPerRun} ideas should use new hook styles, new audience segments, or new formats. Accept higher risk for higher potential.`
        : `BALANCED MODE: Mix proven winners with new tests. At least 2 ideas should use proven hooks/audiences/formats. At least 1 idea should test something new. Steady ROAS + continuous learning.`;

    // ── Compact context brief for the Contrarian ─────────────────────────────
    const productSummary = activeProducts.map(p =>
      `${p.name} (₹${p.price}) — ${p.performance?.totalConversions ?? 0} conversions, CPA ₹${p.performance?.avgCPA ?? 'N/A'}`
    ).join('; ');

    // ═════════════════════════════════════════════════════════════════════════
    // PROMPT: Data first → Rules → Steps
    // ═════════════════════════════════════════════════════════════════════════
    return `
${buildSkillBlock('STRATEGY_TEAM')}
You ARE the Strategist for ${company.name}. You will generate ~${poolSize} raw campaign ideas from ALL intelligence below, then debate with a Contrarian to find the best ${ideasPerRun}.

═══════════════════════════════════════════════════════
PRODUCT CATALOG — every idea MUST sell one of these
═══════════════════════════════════════════════════════

${productCatalog || 'No products configured.'}

═══════════════════════════════════════════════════════
ALL INTELLIGENCE — generate ideas from ANY of these
═══════════════════════════════════════════════════════

COORDINATOR SIGNALS (cross-validated from 4 platforms, ranked by score):
${topSignals || 'No ranked signals this run.'}

${competitorSection}

${marketSection}

${adsLibrarySection}

${liveContext}

${caseStudyContext}

CAMPAIGN STRATEGY: ${strategyMode}

═══════════════════════════════════════════════════════
RULES
═══════════════════════════════════════════════════════

- EVERY idea must sell a specific product from the catalog above
- Match trends to products using their trendKeywords — if a trend doesn't connect to any product, skip it
- The "product" field is REQUIRED. "targetSegment" should match a segment from the product's audience segments if any are defined, otherwise use "general".
- The "conversionBridge" must mention the product name, price, and how the trend connects to buying it
- Generate ideas from ANY source. A competitor vulnerability, a market seasonal window, or an ads library gap is just as valid as a coordinator signal. Best ideas win regardless of source.
- You CAN combine sources (e.g. trending signal + competitor gap = stronger idea). Standalone ideas from any single source are equally valid.
- Prefer products with higher confidence performance data — proven products get priority over hypothesis-stage products
- The Contrarian MUST see all raw ideas before you pick a winner — do NOT pick the winner before the debate
- BUDGET: suggestedBudget = DAILY in ₹/day (NOT total, NOT weekly).
  * No past data → ₹${Math.round((company.weeklyBudgetCap ?? 20000) * 0.15)}
  * Some past data (1-3 campaigns) → ₹${Math.round((company.weeklyBudgetCap ?? 20000) * 0.20)}
  * Strong past data + proven audience → ₹${Math.round((company.weeklyBudgetCap ?? 20000) * 0.30)}
  * Hard cap: never above ₹${company.maxBudgetPerCampaign ?? 10000}/day
  * Weekly: suggestedBudget × 7 must fit within ₹${company.weeklyBudgetCap ?? 20000}
  * NEVER output suggestedBudget as 0

═══════════════════════════════════════════════════════
STEPS
═══════════════════════════════════════════════════════

STEP 1: Call TeamCreate with team_name "strategy-${runId}"

STEP 2: Generate ~${poolSize} raw campaign ideas from ALL intelligence above. EVERY idea MUST sell a specific product from the catalog.
Do this BEFORE spawning the Contrarian so they receive ideas immediately after spawning with no waiting time.

STEP 3: Spawn the Contrarian via Agent tool with these EXACT parameters:
  - name: "contrarian"
  - team_name: "strategy-${runId}"
  - run_in_background: true
  - mode: "bypassPermissions"
  - prompt: "You are the Contrarian on the Strategy Team for ${company.name}. Your job is to eliminate weak ideas fast and push for the strongest ${ideasPerRun}.

FIRST ACTION (do this immediately before anything else):
Call TaskCreate(name: 'waiting-for-ideas', body: 'waiting for Strategist to send Round 1 ideas'). Stay alive and keep waiting until the Strategist's message arrives. Do NOT produce any output until you receive their message.

DEBATE PROTOCOL:
ROUND 1 — Quick elimination pass:
- You receive ~${poolSize} raw ideas from the Strategist, along with a CONTEXT BRIEF containing the key data.
- Use the context brief to challenge ideas against real data — not just surface-level quality.
- For each idea give a quick verdict: KEEP (strong, real conversion potential, backed by data) or CUT (weak, saturated, no clear product tie-in, or contradicts the data).
- Be ruthless. Cut at least ${cutTarget} ideas. Give one-line reasons only in this round.
- Send your verdict list back to the Strategist via SendMessage(to: 'team-lead') labeled 'ROUND 1 VERDICT'.
- After sending, call TaskCreate(name: 'waiting-round-2') and wait for the Strategist's response.

ROUND 2-3 — Deep debate on survivors:
- The Strategist will push back on your cuts and defend survivors.
- For each kept idea: challenge the hook, the audience fit, the conversion bridge. Force them to be specific.
- When the Strategist defends an idea well — concede. When they can't — cut it.
- After each response, call TaskCreate to wait for the next message.
- Goal: converge on the strongest ${ideasPerRun} ideas with 1 clear winner.

FINAL — When you agree on the top ${ideasPerRun}:
- Send {type: 'consensus', topIdeas: ['topic1', 'topic2', ...], winner: 'winning topic', reason: 'why'} via SendMessage(to: 'team-lead').
- MAX 5 rounds total. If no consensus by round 5, send your final top ${ideasPerRun} ranking.
- When you receive a shutdown_request: reply with {type: 'shutdown_confirmed'} via SendMessage(to: 'team-lead') then stop."

STEP 4: Immediately after spawning, send all ideas to the Contrarian via SendMessage(to: "contrarian").

When sending ideas to the Contrarian via SendMessage(to: "contrarian"), include a CONTEXT BRIEF at the top of your message:
---CONTEXT BRIEF---
Top signals: ${coordinator.topSignals.slice(0, 5).map(s => `"${s.topic}" (${s.compositeScore})`).join(', ') || 'none'}
Competitor insights: ${competitorResearch.insights.slice(0, 3).map(i => i.insight).join('; ') || 'none'}
Market insights: ${marketResearch.insights.slice(0, 3).map(i => i.insight).join('; ') || 'none'}
Ads library gaps: ${adLibraryInsights.gaps.slice(0, 3).map(g => g.gap).join('; ') || 'none'}
Products: ${productSummary || 'see catalog'}
---END CONTEXT BRIEF---
Then list all ideas. Label as "ROUND 1 — RAW IDEAS".

CRITICAL: After SendMessage, do NOT output any text. Immediately call TaskCreate with name "round-1-pending" and body "waiting for contrarian response". Do not produce any output until you receive their message.

STEP 5: When you receive the Contrarian's ROUND 1 VERDICT:
  - Accept cuts of clearly weak ideas immediately — don't waste rounds defending bad ideas
  - Push back ONLY on cuts you genuinely disagree with — give specific data from the intelligence to defend
  - SendMessage(to: "contrarian") with your response labeled "ROUND 2", then call TaskCreate(name: "round-2-pending") — do NOT output text.
  PATIENCE: The Contrarian runs in the background and takes several minutes to respond. Do NOT give up or produce output on your own. Keep waiting via TaskCreate until their message arrives. Only nudge once (via SendMessage) if you have called TaskCreate 4+ times with no reply.

STEP 6: Continue the debate. Each round: receive their message → respond via SendMessage → call TaskCreate to wait again.
  - Keep going until:
    a) You both agree on the top ${ideasPerRun} and 1 winner (consensus — Contrarian sends {type: "consensus"})
    b) You've done 5 rounds — make your final call
  - Never produce output mid-debate. Always use TaskCreate to stay alive between rounds.

STEP 7: Once debate is settled:
  1. SendMessage(to: "contrarian", message: {type: "shutdown_request"})
  2. Call TaskCreate(name: "shutdown-pending", body: "waiting for shutdown confirmation") — do NOT call TeamDelete yet.
  3. Wait for the shutdown confirmation to arrive as an incoming message.
  4. Only after receiving confirmation: call TeamDelete.
  If TeamDelete fails after receiving confirmation, SKIP IT — cleanup is automatic. Proceed to output.

STEP 8: Return ONLY this JSON (no markdown, no explanation):
{
  "briefs": [
    {
      "topic": "short topic name",
      "angle": "specific angle for this ad",
      "product": "exact product name from the catalog",
      "targetSegment": "audience segment name if defined, or general",
      "platform": "instagram|facebook|youtube|reddit",
      "format": "reel|carousel|video|single_image|collection",
      "audience": "full audience description",
      "audienceStage": "cold|warm|hot — STRICT funnel definition (industry-standard, no exceptions): cold = ANY audience that has NOT engaged with our brand (lookalikes, interests, broad/advantage_plus, 1%-10% lookalikes-of-buyers ALL count as cold — these are still NEW people who never visited our site). warm = retargeting custom audiences of people who DID engage (site visitors, IG/FB engagers, video viewers, page followers). hot = high-intent retargeting (cart abandoners, initiate-checkout, 30d engaged without purchase). Lookalikes are NEVER warm — being a lookalike of a buyer ≠ engaging with our brand. Default to cold unless brief explicitly references retargeting a custom audience.",
      "targetLanguage": "hinglish|hindi|marathi|tamil|telugu|bengali|gujarati|punjabi|kannada|malayalam|english — language ALL downstream creative is produced in (copy, image overlays, video VO). Pick based on the AUDIENCE description and any geo signals. If audience explicitly names a language (\"Marathi-speaking\", \"Tamil audience\", \"Hindi-belt\") use that. If audience targets a single state/region with a dominant language (Maharashtra → marathi, Tamil Nadu → tamil, West Bengal → bengali, Karnataka → kannada, Hindi belt: UP/MP/Delhi/Bihar/Rajasthan/Haryana → hindi), use that. Default 'hinglish' for all-India broad audiences. Do NOT default to a regional language without a clear audience or geo signal — Hinglish reaches the widest Indian DTC audience.",
      "hook": "opening line or visual hook",
      "keyMessage": "what the audience should believe after seeing this",
      "conversionBridge": "how this leads to buying the specific product",
      "suggestedBudget": 1500,
      "ideaSource": "scout_signal|viral_trend|competitor_gap|market_insight|meta_ads_gap",
      "sourcePlatforms": ["instagram", "youtube"],
      "urgent": false,
      "priorityScore": 8.5,
      "selected": false,
      "selectionReason": "why this idea won or lost the debate",
      "contrariansVerdict": "what the contrarian said about this idea"
    }
  ],
  "debateRounds": 3,
  "debateLog": [
    {"round": 1, "from": "strategist", "summary": "proposed ideas from signals, competitor gaps, and market insights"},
    {"round": 1, "from": "contrarian", "summary": "cut weak ideas, challenged audience fit on #3"},
    {"round": 2, "from": "strategist", "summary": "defended #3 with CPA data, conceded #5"},
    {"round": 2, "from": "contrarian", "summary": "accepted #3, agreed #1 is winner"}
  ],
  "debateRationale": "2-3 sentence summary of the full debate — what was argued, who pushed back on what, and why the winner won"
}

Return exactly ${ideasPerRun} briefs — the survivors after the debate. Mark exactly 1 as "selected": true — the winner.
    `.trim();
  }

  private async buildCall1Prompt(
    company: CompanyDocument,
    runId: string,
    coordinator: CoordinatorResult,
    competitorResearch: StructuredResearch,
    marketResearch: StructuredResearch,
    adLibraryInsights: MetaAdsLibraryInsights,
    poolSize: number,
    ideasPerRun: number,
  ): Promise<string> {
    const liveContext = this.liveContextBuilder.build(company);

    // ── Case studies ──────────────────────────────────────────────────────────
    let caseStudyContext = '';
    try {
      const caseStudies = await this.metaLearningImporter.getRelevantCaseStudies(
        company.tenantId,
        { limit: 12 },
      );
      if (caseStudies.length > 0) {
        caseStudyContext = `
PAST CAMPAIGN CASE STUDIES (${caseStudies.length} most recent):
${caseStudies.slice(0, 12).map((cs, i) => `  Case ${i + 1}: ${cs.campaignName} (${cs.dateRange})
    Product: ${cs.product} | Spend: ₹${cs.totalSpend} | Conversions: ${cs.totalConversions}
    What worked: ${cs.whatWorked?.hooks?.join(', ') || 'unknown'} hooks, ${cs.whatWorked?.audiences?.join(', ') || 'unknown'} audiences, best CPA ₹${cs.whatWorked?.bestCPA || 'N/A'}
    What failed: ${cs.whatFailed?.reason || 'nothing notable'}
    Lesson: ${cs.lesson}`).join('\n')}`;
      }
    } catch (err: any) {
      this.logger.warn(`Case studies unavailable for ${company.tenantId}: ${err.message}`);
    }

    // ── Top signals ───────────────────────────────────────────────────────────
    const topSignals = coordinator.topSignals
      .slice(0, 7)
      .map((s, i) =>
        `Signal ${i + 1} (score: ${s.compositeScore}) — "${s.topic}" | Platforms: ${s.platforms.join(', ')} | ${s.rationale}`,
      )
      .join('\n');

    // ── Product catalog ───────────────────────────────────────────────────────
    const activeProducts = (company.products ?? []).filter(p => p.active);
    const productCatalog = activeProducts.map(p => {
      const segments = (p.audienceSegments ?? []).map(s =>
        `    - ${s.name} (${s.confidence}${s.conversions ? `, ${s.conversions} conversions, CPA ₹${s.avgCPA}` : ''}): ${s.description}`
      ).join('\n');
      // Sort lookalikes tightest-first (1% > 1-2% > 2-3%) so the briefer sees
      // the highest-quality audience at the top of the list. Loose lookalikes
      // delivered ₹6 junk-traffic CPC + 0.10% CVR in May 2026; tight lookalikes
      // have ~3x the buyer signal density.
      const metaAud = [...(p.metaAudiences ?? [])]
        .sort((a, b) => {
          const aIsLal = a.type === 'lookalike';
          const bIsLal = b.type === 'lookalike';
          if (aIsLal && bIsLal) return (a.lookalikePercent ?? 99) - (b.lookalikePercent ?? 99);
          if (aIsLal) return -1;
          if (bIsLal) return 1;
          return 0;
        })
        .map(a =>
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

    // ── Intelligence sections ─────────────────────────────────────────────────
    const competitorSection = competitorResearch.insights.length > 0
      ? `COMPETITOR INSIGHTS:
${competitorResearch.insights.map((i, idx) =>
  `${idx + 1}. [score:${i.score} | urgency:${i.urgency}] ${i.insight}\n   → ${i.implication}${i.source ? `\n   source: ${i.source}` : ''}`
).join('\n')}
Summary: ${competitorResearch.rawSummary}`
      : 'COMPETITOR INSIGHTS: No actionable competitor data this run.';

    const marketSection = marketResearch.insights.length > 0
      ? `MARKET INSIGHTS:
${marketResearch.insights.map((i, idx) =>
  `${idx + 1}. [score:${i.score} | urgency:${i.urgency}] ${i.insight}\n   → ${i.implication}${i.source ? `\n   source: ${i.source}` : ''}`
).join('\n')}
Summary: ${marketResearch.rawSummary}`
      : 'MARKET INSIGHTS: No actionable market signals this run.';

    const adsLibrarySection = adLibraryInsights.competitorAds.length > 0 || adLibraryInsights.gaps.length > 0
      ? `META ADS LIBRARY:
${adLibraryInsights.competitorAds.length > 0
  ? `Competitor ads running now:\n${adLibraryInsights.competitorAds.map((a, idx) =>
    `  ${idx + 1}. [score:${a.score}] ${a.competitor} — "${a.hook}" | angle: ${a.angle} | format: ${a.format} | CTA: ${a.cta} | running ~${a.estimatedDaysRunning}d`
  ).join('\n')}`
  : '  No competitor ads found.'}
${adLibraryInsights.gaps.length > 0
  ? `Gaps nobody is exploiting:\n${adLibraryInsights.gaps.map((g, idx) =>
    `  ${idx + 1}. [score:${g.score} | ${g.urgency}] ${g.gap}\n   → ${g.opportunity}`
  ).join('\n')}`
  : ''}
Dominant format: ${adLibraryInsights.dominantFormat}${adLibraryInsights.rawSummary ? `\nSummary: ${adLibraryInsights.rawSummary}` : ''}`
      : 'META ADS LIBRARY: No ads library data this run.';

    // ── Strategy mode ─────────────────────────────────────────────────────────
    const strategy = company.pipelineConfig?.campaignStrategy ?? 'balanced';
    const strategyMode = strategy === 'conservative'
      ? `CONSERVATIVE MODE: Only use proven winners. Every idea must use a hook style, audience segment, or format with past performance data (confidence: medium or high). No untested ideas. Prioritize lowest CPA over highest reach.`
      : strategy === 'experimental'
        ? `EXPERIMENTAL MODE: Prioritize new ideas and untested angles. At least 3 of ${ideasPerRun} ideas should use new hook styles, new audience segments, or new formats. Accept higher risk for higher potential.`
        : `BALANCED MODE: Mix proven winners with new tests. At least 2 ideas should use proven hooks/audiences/formats. At least 1 idea should test something new. Steady ROAS + continuous learning.`;

    return `
${buildSkillBlock('STRATEGY_TEAM')}
You are the Strategist for ${company.name}. Generate exactly ${poolSize} raw campaign ideas from ALL intelligence below.

This is Phase 1 of a 2-phase review. You generate ideas here; a separate Contrarian will review and cut them.
Do NOT pick a winner. Do NOT add debate notes. Just generate the best ${poolSize} ideas you can from the intelligence.

═══════════════════════════════════════════════════════
PRODUCT CATALOG — every idea MUST sell one of these
═══════════════════════════════════════════════════════

${productCatalog || 'No products configured.'}

═══════════════════════════════════════════════════════
ALL INTELLIGENCE — generate ideas from ANY of these
═══════════════════════════════════════════════════════

COORDINATOR SIGNALS (cross-validated from 4 platforms, ranked by score):
${topSignals || 'No ranked signals this run.'}

${competitorSection}

${marketSection}

${adsLibrarySection}

${liveContext}

${caseStudyContext}

CAMPAIGN STRATEGY: ${strategyMode}

═══════════════════════════════════════════════════════
RULES
═══════════════════════════════════════════════════════

- EVERY idea must sell a specific product from the catalog above
- Match trends to products using their trendKeywords — if a trend doesn't connect to any product, skip it
- The "product" field is REQUIRED. "targetSegment" should match a segment from the product's audience segments if any are defined, otherwise use "general".
- The "conversionBridge" must mention the product name, price, and how the trend connects to buying it
- Generate ideas from ANY source. A competitor vulnerability, a market seasonal window, or an ads library gap is just as valid as a coordinator signal.
- You CAN combine sources (e.g. trending signal + competitor gap = stronger idea).
- Prefer products with higher confidence performance data
- BUDGET: suggestedBudget = DAILY in ₹/day (NOT total, NOT weekly).
  * No past data → ₹${Math.round((company.weeklyBudgetCap ?? 20000) * 0.15)}
  * Some past data (1-3 campaigns) → ₹${Math.round((company.weeklyBudgetCap ?? 20000) * 0.20)}
  * Strong past data + proven audience → ₹${Math.round((company.weeklyBudgetCap ?? 20000) * 0.30)}
  * Hard cap: never above ₹${company.maxBudgetPerCampaign ?? 10000}/day
  * Weekly: suggestedBudget × 7 must fit within ₹${company.weeklyBudgetCap ?? 20000}
  * NEVER output suggestedBudget as 0

═══════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════

Return ONLY a JSON array of exactly ${poolSize} brief objects (no markdown, no explanation):

[
  {
    "topic": "short topic name",
    "angle": "specific angle for this ad",
    "product": "exact product name from the catalog",
    "targetSegment": "audience segment name if defined, or general",
    "platform": "instagram|facebook|youtube|reddit",
    "format": "reel|carousel|video|single_image|collection",
    "audience": "full audience description",
    "audienceStage": "cold|warm|hot — STRICT: cold = lookalikes/interests/broad/advantage_plus (anyone who hasn't engaged with our brand, INCLUDING lookalikes-of-buyers). warm = custom-audience retargeting (site visitors, IG/FB engagers, video viewers). hot = cart-abandoners / initiate-checkout / 30d engaged. Default cold unless brief explicitly retargets a custom audience.",
    "hook": "opening line or visual hook",
    "keyMessage": "what the audience should believe after seeing this",
    "conversionBridge": "how this leads to buying the specific product",
    "suggestedBudget": 1500,
    "ideaSource": "scout_signal|viral_trend|competitor_gap|market_insight|meta_ads_gap",
    "sourcePlatforms": ["instagram", "youtube"],
    "urgent": false,
    "priorityScore": 8.5,
    "selected": false,
    "selectionReason": "",
    "contrariansVerdict": ""
  }
]

All ${poolSize} ideas. No winner selected here — the Contrarian will decide.
    `.trim();
  }

  private parseOutput(content: string): any {
    let jsonStr = '';
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
      } else {
        // Try object first, then array
        const objStart = content.indexOf('{');
        const arrStart = content.indexOf('[');
        if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
          jsonStr = content.slice(objStart, content.lastIndexOf('}') + 1);
        } else {
          jsonStr = content.slice(arrStart, content.lastIndexOf(']') + 1);
        }
      }
      const parsed = JSON.parse(jsonStr);
      // Normalise: if it's a raw array (Call 1 returns array, Call 2 wraps in object)
      if (Array.isArray(parsed)) {
        return { briefs: parsed };
      }
      return parsed;
    } catch (err: any) {
      this.logger.error(`Strategy Team output parse failed: ${err.message} | content snippet: ${content.slice(0, 300)}`);
      throw new Error(`Strategy Team returned invalid JSON: ${err.message}`);
    }
  }
}
