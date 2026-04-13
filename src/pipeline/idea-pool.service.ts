import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { IntelligenceBrief, IntelligenceBriefDocument } from './schemas/intelligence-brief.schema';
import { CreativeBrief, CreativeBriefDocument } from './schemas/creative-brief.schema';
import { CoordinatorResult } from './coordinator.service';
import { StructuredResearch } from './schemas/research-output.schema';
import { MetaAdsLibraryInsights } from './schemas/meta-ads-library-output.schema';

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

    const generateMessage = this.buildGeneratePrompt(
      coordinatorResult,
      competitorResearch,
      marketResearch,
      adLibraryInsights,
      company,
      ideasPerRun,
    );

    const generated = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.IDEA_POOL,
      systemPrompt: company.prompts?.ideaPool ?? '',
      liveContext,
      userMessage: generateMessage,
      maxTurns: 8,
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
      const resolved = fuzzyMatch ?? (company.products ?? []).find((p) => p.active) ?? (company.products ?? [])[0];
      if (resolved && !exactMatch) {
        this.logger.warn(`Idea pool product mismatch: "${b.product}" → resolved to "${resolved.name}"`);
      }
      b.product = resolved?.name ?? b.product;
    });

    // ── Rule-based winner selection ───────────────────────────────────────────
    const winner = this.selectWinner(briefs, coordinatorResult);
    const briefId = winner.briefId;

    // ── Persist ───────────────────────────────────────────────────────────────
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
${topSignals || coordinator.content.slice(0, 2000)}

FULL COORDINATOR SYNTHESIS:
${coordinator.content}

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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
      "format": "reel|carousel|video|single_image|collection",
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
      "selectionReason": "one sentence on why this idea matters now"
    }
  ]
}
\`\`\`

Rules:
- Read ALL sources above — coordinator signals, competitor insights, market insights, Meta Ads Library
- Generate ideas from ANY source. A competitor vulnerability is just as valid as a trending signal. A seasonal market window is just as valid as a viral trend. Best ideas win.
- You CAN combine sources — e.g. a trending signal + a competitor gap = a stronger idea. But standalone ideas from any single source are equally valid.
- Generate ~${generationTarget} raw ideas total, rank by priorityScore, return the top ${ideasPerRun}
- signalRank: 1/2/3/etc for coordinator signal ideas, null for competitor/market/meta_ads_gap ideas
- urgent: true only if this idea must be executed THIS WEEK
- priorityScore: your honest 1-10 rating — rank by this to pick the top ${ideasPerRun}
    `.trim();
  }

  // ── Rule-based winner selection ─────────────────────────────────────────────
  // Priority order:
  // 1. Urgent competitor gap or meta ads gap (someone is vulnerable RIGHT NOW)
  // 2. Idea tied to Signal 1 (highest coordinator signal)
  // 3. Urgent market insight
  // 4. Idea tied to Signal 2
  // 5. Fallback: highest priorityScore
  private selectWinner(briefs: any[], coordinator: CoordinatorResult): any {
    // 1. Urgent competitor gap or meta ads gap
    const urgentGap = briefs.find((b) => (b.ideaSource === 'competitor_gap' || b.ideaSource === 'meta_ads_gap') && b.urgent === true);
    if (urgentGap) {
      urgentGap.selectionReason = urgentGap.selectionReason ?? 'Urgent competitive gap — act this week';
      return urgentGap;
    }

    // 2. Signal 1 idea
    const signal1 = briefs.find((b) => b.signalRank === 1);
    if (signal1) {
      const topSignal = coordinator.topSignals[0];
      signal1.selectionReason = signal1.selectionReason ??
        `Tied to top coordinator signal "${topSignal?.topic ?? 'Signal 1'}" (score: ${topSignal?.compositeScore ?? 'N/A'})`;
      return signal1;
    }

    // 3. Urgent market insight
    const urgentMarket = briefs.find((b) => b.ideaSource === 'market_insight' && b.urgent === true);
    if (urgentMarket) {
      urgentMarket.selectionReason = urgentMarket.selectionReason ?? 'Urgent market insight — seasonal window closing';
      return urgentMarket;
    }

    // 4. Signal 2 idea
    const signal2 = briefs.find((b) => b.signalRank === 2);
    if (signal2) {
      signal2.selectionReason = signal2.selectionReason ?? 'Tied to Signal 2 — no Signal 1 idea generated';
      return signal2;
    }

    // 5. Fallback: highest priorityScore
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
