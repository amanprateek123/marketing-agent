import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { buildSkillBlock, skillsForAgent } from '../common/skills/agent-skill-map';
import { IntelligenceBrief, IntelligenceBriefDocument } from './schemas/intelligence-brief.schema';
import { CreativeBrief, CreativeBriefDocument } from './schemas/creative-brief.schema';
import { CoordinatorResult } from './coordinator.service';
import { StructuredResearch } from './schemas/research-output.schema';
import { MetaAdsLibraryInsights } from './schemas/meta-ads-library-output.schema';
import { MetaLearningImporterService } from '../campaigns/meta-ads/meta-learning-importer.service';

export interface IdeaPoolResult {
  briefs: Array<{
    briefId: string;
    product: string;
    targetSegment: string;
    topic: string;
    angle: string;
    platform: string;
    format: string;
    audience: string;
    hook: string;
    keyMessage: string;
    conversionBridge: string;
    suggestedBudget: number;
    finalScore: number;
  }>;
  selectedBriefId: string;
  selectionReason: string;
}

@Injectable()
export class IdeaPoolService {
  private readonly logger = new Logger(IdeaPoolService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    private readonly metaLearningImporter: MetaLearningImporterService,
    @InjectModel(IntelligenceBrief.name)
    private readonly intelligenceBriefModel: Model<IntelligenceBriefDocument>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBriefDocument>,
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
    const liveContext = this.liveContextBuilder.build(company);
    const ideasPerRun = company.pipelineConfig?.ideasPerRun ?? 10;

    // ── Case studies ──────────────────────────────────────────────────────────
    let caseStudyContext = '';
    try {
      const caseStudies = await this.metaLearningImporter.getRelevantCaseStudies(
        tenantId,
        { limit: 10 },
      );
      if (caseStudies.length > 0) {
        caseStudyContext = `\nPAST CAMPAIGN CASE STUDIES (${caseStudies.length} most recent — learn from what worked and what failed):
${caseStudies.map((cs, i) => `  Case ${i + 1}: ${cs.campaignName} (${cs.dateRange})
    Product: ${cs.product} | Spend: ₹${cs.totalSpend} | Conversions: ${cs.totalConversions}
    What worked: ${cs.whatWorked?.hooks?.join(', ') || 'unknown'} hooks, ${cs.whatWorked?.audiences?.join(', ') || 'unknown'} audiences, best CPA ₹${cs.whatWorked?.bestCPA || 'N/A'}
    What failed: ${cs.whatFailed?.reason || 'nothing notable'}
    Lesson: ${cs.lesson}`).join('\n')}`;
      }
    } catch (err: any) {
      this.logger.warn(`Case studies unavailable for ${tenantId}: ${err.message}`);
    }

    const generateMessage = this.buildGeneratePrompt(
      coordinatorResult,
      competitorResearch,
      marketResearch,
      adLibraryInsights,
      company,
      ideasPerRun,
      caseStudyContext,
      coordinatorResult.viralTrends ?? [],
    );

    const generated = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.IDEA_POOL,
      // Skill directive prepended so the IdeaPool fallback (used when Strategy
      // Team errors) reasons via paid-ads + product-marketing-context +
      // marketing-psychology rather than freestyle generation.
      systemPrompt: buildSkillBlock('IDEA_POOL') + (company.prompts?.ideaPool ?? ''),
      liveContext,
      userMessage: generateMessage,
      maxTurns: 8,
      skills: skillsForAgent('IDEA_POOL'),   // paid-ads + product-marketing-context + marketing-psychology + customer-research
    });

    const briefs = this.parseBriefs(generated.content);

    if (briefs.length === 0) {
      throw new Error(`Idea pool returned no parseable briefs for tenantId=${tenantId} runId=${runId}`);
    }

    // ── Assign a unique briefId + resolve product name against company schema ──
    briefs.forEach((b) => {
      b.briefId = uuidv4();
      const exactMatch = (company.products ?? []).find((p) => p.name === b.product);
      const fuzzyMatch = exactMatch ?? (company.products ?? []).find(
        (p) => p.name?.toLowerCase() === b.product?.toLowerCase(),
      );
      if (fuzzyMatch) {
        if (!exactMatch) {
          this.logger.warn(`Idea pool product casing mismatch: "${b.product}" → resolved to "${fuzzyMatch.name}"`);
        }
        b.product = fuzzyMatch.name;
      } else {
        this.logger.error(`Idea pool hallucinated product "${b.product}" — no match found. Dropping brief "${b.topic}".`);
        b._invalid = true;
      }
    });

    // Remove briefs with hallucinated products
    const invalidCount = briefs.filter((b) => b._invalid).length;
    if (invalidCount > 0) {
      this.logger.warn(`Idea pool: dropped ${invalidCount} briefs with invalid products`);
    }
    const validBriefs = briefs.filter((b) => !b._invalid);
    if (validBriefs.length === 0) {
      throw new Error(`Idea pool: all ${briefs.length} briefs had invalid products`);
    }
    validBriefs.forEach((b) => delete b._invalid);
    briefs.length = 0;
    briefs.push(...validBriefs);

    // ── Rule-based winner selection ───────────────────────────────────────────
    const winner = this.selectWinner(briefs, coordinatorResult);
    const briefId = winner.briefId;

    // ── Persist — delete any existing briefs from a prior attempt to avoid duplicates on resume
    await this.intelligenceBriefModel.deleteMany({ tenantId, runId });
    await this.intelligenceBriefModel.insertMany(
      briefs.map((b) => ({
        tenantId,
        runId,
        briefId: b.briefId,
        product: b.product ?? '',
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
        selected: b.briefId === briefId,
      })),
    );

    await this.creativeBriefModel.create({
      tenantId,
      runId,
      briefId,
      product: winner.product ?? '',
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
      selectionReason: winner.selectionReason,
    });

    this.logger.log(
      `Idea pool done: tenantId=${tenantId} runId=${runId} briefs=${briefs.length} selected=${briefId} source=${winner.ideaSource}`,
    );

    return {
      briefs: briefs.map((b) => ({
        briefId: b.briefId ?? '',
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
      selectedBriefId: briefId,
      selectionReason: winner.selectionReason,
    };
  }

  private buildGeneratePrompt(
    coordinator: CoordinatorResult,
    competitorResearch: StructuredResearch,
    marketResearch: StructuredResearch,
    adLibraryInsights: MetaAdsLibraryInsights,
    company: CompanyDocument,
    ideasPerRun: number,
    caseStudyContext: string = '',
    viralTrends: CoordinatorResult['viralTrends'] = [],
  ): string {
    const generationTarget = Math.max(20, ideasPerRun * 2);
    const activeProducts = (company.products ?? []).filter(p => p.active);
    const productList = activeProducts.map(p => `  - "${p.name}" (₹${p.price}) — ${p.description?.slice(0, 80)}`).join('\n');

    const topSignals = coordinator.topSignals
      .map((s, i) =>
        `Signal ${i + 1} (score: ${s.compositeScore}) — "${s.topic}" | Platforms: ${s.platforms.join(', ')} | ${s.rationale}`,
      )
      .join('\n');

    return `
Generate ~${generationTarget} raw Meta ad campaign ideas for ${company.name}, then rank and return the top ${ideasPerRun}.

AVAILABLE PRODUCTS (each idea MUST be tied to one of these):
${productList || '  No active products defined'}
Use the exact product name in the "product" field of each brief.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ALL INTELLIGENCE — generate ideas from ANY of these sources
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COORDINATOR SIGNALS (cross-validated from 4 platforms, ranked by score):
${topSignals || 'No ranked signals this run.'}

COMPETITOR INSIGHTS (may have standalone opportunities the scouts didn't catch):
${competitorResearch.insights.map((i, idx) =>
  `${idx + 1}. [score:${i.score} | ${i.urgency}] ${i.insight}\n   → ${i.implication}`
).join('\n')}
Summary: ${competitorResearch.rawSummary}

MARKET INSIGHTS (may have standalone opportunities — seasonal windows, purchase-intent signals):
${marketResearch.insights.map((i, idx) =>
  `${idx + 1}. [score:${i.score} | ${i.urgency}] ${i.insight}\n   → ${i.implication}`
).join('\n')}
Summary: ${marketResearch.rawSummary}

META ADS LIBRARY — COMPETITOR ADS + GAPS:
${adLibraryInsights.competitorAds.length > 0
  ? `Competitor ads running now:\n${adLibraryInsights.competitorAds.map((a, idx) =>
    `  ${idx + 1}. ${a.competitor}: "${a.hook}" | ${a.format} | ${a.angle} | ~${a.estimatedDaysRunning}d running`
  ).join('\n')}`
  : '  No competitor ad data.'}
${adLibraryInsights.gaps.length > 0
  ? `\nGaps nobody is exploiting:\n${adLibraryInsights.gaps.map((g, idx) =>
    `  ${idx + 1}. [${g.urgency}] ${g.gap} → ${g.opportunity}`
  ).join('\n')}`
  : ''}

VIRAL TRENDS & MEME OPPORTUNITIES (trend-jacking for paid ads):
${viralTrends.length > 0
  ? viralTrends.map((v, idx) =>
    `  ${idx + 1}. [Score ${v.compositeScore}${v.urgent ? ' | URGENT — dies in <7 days' : ''}] "${v.trend}" on ${v.platforms.join(', ')}\n     Brand tie-in: ${v.brandTieIn}`
  ).join('\n')
  : '  No viral trends this run.'}

${caseStudyContext ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PAST PERFORMANCE (avoid repeating failures, double down on what worked)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${caseStudyContext}

` : ''}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generate ~${generationTarget} ideas internally, rank by priorityScore, return only the top ${ideasPerRun}. For each idea provide:

\`\`\`json
{
  "briefs": [
    {
      "topic": "...",
      "angle": "...",
      "product": "exact product name from the list above",
      "platform": "instagram|facebook|youtube|reddit",
      "format": "reel|carousel|video|single_image|collection|meme",
      "audience": "...",
      "hook": "opening line or visual hook — for a PAID META AD, not organic content",
      "keyMessage": "what the audience should believe after seeing this ad",
      "conversionBridge": "how this paid ad leads directly to buying the product",
      "suggestedBudget": 0,
      "ideaSource": "scout_signal|viral_trend|competitor_gap|market_insight|meta_ads_gap",
      "sourcePlatforms": ["instagram", "youtube"],
      "signalRank": 1,
      "urgent": false,
      "priorityScore": 8.5,
      "selectionReason": "one sentence on why this idea matters now",
      "trendJackingNote": "only for viral_trend ideas — explain how the meme/trend is adapted for this ad"
    }
  ]
}
\`\`\`

Rules:
- Read ALL sources above — coordinator signals, competitor insights, market insights, Meta Ads Library, AND viral trends
- Generate ideas from ANY source. A competitor vulnerability is just as valid as a trending signal. A viral meme with strong brand tie-in is just as valid as a market insight. Best ideas win.
- You CAN combine sources — e.g. a trending signal + a competitor gap = a stronger idea. But standalone ideas from any single source are equally valid.
- For VIRAL TRENDS: generate trend-jacking ad ideas. Adapt the meme/cultural moment to naturally feature the product. Use format: "meme" and ideaSource: "viral_trend". These are time-sensitive — mark urgent: true if the trend dies in <7 days. Fill in trendJackingNote explaining the adaptation.
- Generate ~${generationTarget} raw ideas total, rank by priorityScore, return the top ${ideasPerRun}
- signalRank: 1/2/3/etc for coordinator signal ideas, null for competitor/market/meta_ads_gap ideas
- urgent: true only if this idea must be executed THIS WEEK
- priorityScore: your honest 1-10 rating — rank by this to pick the top ${ideasPerRun}
- suggestedBudget: DAILY in ₹/day. NEVER output 0. Minimum ₹${Math.round((company.weeklyBudgetCap ?? 20000) * 0.10)}/day, max ₹${company.maxBudgetPerCampaign ?? 10000}/day
    `.trim();
  }

  // ── Rule-based winner selection ─────────────────────────────────────────────
  // Priority order:
  // 1. Urgent competitor gap or meta ads gap (someone is vulnerable RIGHT NOW)
  // 2. Urgent viral trend (meme window closes in <7 days)
  // 3. Idea tied to Signal 1 (highest coordinator signal)
  // 4. Urgent market insight
  // 5. Idea tied to Signal 2
  // 6. Fallback: highest priorityScore
  private selectWinner(briefs: any[], coordinator: CoordinatorResult): any {
    // 1. Urgent competitor gap or meta ads gap
    const urgentGap = briefs.find((b) => (b.ideaSource === 'competitor_gap' || b.ideaSource === 'meta_ads_gap') && b.urgent === true);
    if (urgentGap) {
      urgentGap.selectionReason = urgentGap.selectionReason ?? 'Urgent competitive gap — act this week';
      return urgentGap;
    }

    // 2. Urgent viral trend — memes are time-sensitive, window closes in days
    const urgentViral = briefs.find((b) => b.ideaSource === 'viral_trend' && b.urgent === true);
    if (urgentViral) {
      urgentViral.selectionReason = urgentViral.selectionReason ?? 'Urgent viral trend — meme window closes in <7 days, act now';
      return urgentViral;
    }

    // 3. Signal 1 idea
    const signal1 = briefs.find((b) => b.signalRank === 1);
    if (signal1) {
      const topSignal = coordinator.topSignals[0];
      signal1.selectionReason = signal1.selectionReason ??
        `Tied to top coordinator signal "${topSignal?.topic ?? 'Signal 1'}" (score: ${topSignal?.compositeScore ?? 'N/A'})`;
      return signal1;
    }

    // 4. Urgent market insight
    const urgentMarket = briefs.find((b) => b.ideaSource === 'market_insight' && b.urgent === true);
    if (urgentMarket) {
      urgentMarket.selectionReason = urgentMarket.selectionReason ?? 'Urgent market insight — seasonal window closing';
      return urgentMarket;
    }

    // 5. Signal 2 idea
    const signal2 = briefs.find((b) => b.signalRank === 2);
    if (signal2) {
      signal2.selectionReason = signal2.selectionReason ?? 'Tied to Signal 2 — no Signal 1 idea generated';
      return signal2;
    }

    // 6. Fallback: highest priorityScore
    const fallback = briefs.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))[0];
    fallback.selectionReason = fallback.selectionReason ?? 'Highest priority score among generated ideas';
    return fallback;
  }

  private parseBriefs(content: string): any[] {
    const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      try {
        const parsed = JSON.parse(fenceMatch[1].trim());
        return Array.isArray(parsed.briefs) ? parsed.briefs.map((b: any) => ({ ...b, briefId: '' })) : [];
      } catch {
        return [];
      }
    }

    // Fallback: find outermost { }
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1) return [];
    try {
      const parsed = JSON.parse(content.slice(start, end + 1));
      return Array.isArray(parsed.briefs) ? parsed.briefs.map((b: any) => ({ ...b, briefId: '' })) : [];
    } catch {
      return [];
    }
  }
}
