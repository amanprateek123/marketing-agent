import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { CompaniesService } from '../companies/companies.service';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { PromptGeneratorService } from '../companies/prompt-generator/prompt-generator.service';
import { ActionLoggerService } from '../common/action-logger/action-logger.service';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../pipeline/schemas/intelligence-brief.schema';
import { Campaign, CampaignDocument } from '../campaigns/schemas/campaign.schema';
import { CreativePackage, CreativePackageDocument } from '../creative/schemas/creative-package.schema';
import { LearningRun, LearningRunDocument } from './schemas/learning-run.schema';
import { CampaignLearnings, CausalInsight, OfferAudienceFitIssue } from '../companies/schemas/company.types';
import { parseRobustJson } from '../common/llm/robust-json-parser.util';

const MIN_CAMPAIGNS = 3;

const CAMPAIGN_LEARNING_PROMPT = `You are a campaign performance analyst specialising in causal attribution. Your job is to understand WHY campaigns succeed or fail — not just report that they did.

METHODOLOGY — CAUSAL ISOLATION:
For each underperforming campaign, identify the most likely root cause by holding other variables constant:

ROOT CAUSE TYPES:
- creative_issue: hook/copy drove low CTR before audience even had a chance to convert
  Evidence: low CTR (<1%) despite good audience, or CTR dropped after first 2 days
- audience_mismatch: right message, wrong people
  Evidence: high CTR but very low conversion rate (people clicked but didn't buy)
- format_mismatch: right content, wrong placement
  Evidence: same hook style performed differently on Reels vs Feed
- topic_exhaustion: audience has seen this angle too many times
  Evidence: frequency > 3 with declining CTR over time
- timing_issue: external factor beyond creative/audience control
  Evidence: sudden drop aligned with competitor campaign or season
- budget_issue: too low to exit Meta learning phase
  Evidence: campaign never scaled, conversions always 0, spend < ₹500/day

ISOLATION RULE:
Only tag a variable as the cause if you can find 2+ campaigns where ONLY that variable changed and the result also changed. Do NOT conclude causation from a single campaign.

CONFIDENCE SCORING:
- 3 campaigns with isolated variable: max 0.60
- 5 campaigns: max 0.85
- 10+ campaigns: max 1.00
- Only include patterns with confidence >= 0.50

COMPANY THRESHOLDS — use these to define winning vs losing:
(These are injected in the user message — read them carefully)

OUTPUT — return only valid JSON:
{
  "campaign": {
    "audienceScores": { "audience_segment_name": 0.0-1.0 },
    "platformROAS": { "instagram": 0.0, "facebook": 0.0 },
    "budgetInsights": ["string observations about budget effectiveness"],
    "timingInsights": ["string observations about timing patterns"],
    "objectiveInsights": ["string observations about objective effectiveness"]
  },
  "topicScores": { "topic_name": 0.0-1.0 },
  "causalInsights": [
    {
      "finding": "Reels convert 3x better than Feed for this brand",
      "isolatedVariable": "format",
      "controlledFor": ["same topic", "same audience segment", "same hook style"],
      "rootCause": "format_mismatch",
      "confidence": 0.72,
      "dataPoints": 4
    }
  ]
}`;

@Injectable()
export class CampaignLearningService {
  private readonly logger = new Logger(CampaignLearningService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly companiesService: CompaniesService,
    private readonly liveContextBuilder: LiveContextBuilder,
    private readonly promptGenerator: PromptGeneratorService,
    private readonly actionLogger: ActionLoggerService,
    @InjectModel(IntelligenceBrief.name)
    private readonly briefModel: Model<IntelligenceBriefDocument>,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
    @InjectModel(LearningRun.name)
    private readonly learningRunModel: Model<LearningRunDocument>,
  ) {}

  // Triggered after Day 30 writeback — full causal analysis + prompt regen
  async runDeepRun(tenantId: string): Promise<void> {
    this.logger.log(`Campaign deep learning run: tenantId=${tenantId}`);
    const company = await this.companiesService.findByTenantId(tenantId);

    const campaignData = await this.buildCampaignDataset(tenantId);

    if (campaignData.length < MIN_CAMPAIGNS) {
      this.logger.log(
        `Campaign deep run skipped: tenantId=${tenantId} — only ${campaignData.length}/${MIN_CAMPAIGNS} campaigns with Day 30 data`,
      );
      await this.learningRunModel.create({
        tenantId,
        status: 'skipped',
        version: company.learnings?.version ?? 0,
        briefsAnalyzed: campaignData.length,
        instinctsExtracted: 0,
        promptsRegenerated: false,
        skipReason: `Need ${MIN_CAMPAIGNS}+ campaigns with Day 30 data`,
        runAt: new Date(),
      });
      return;
    }

    // Pre-construct matched pairs in TypeScript so the LLM only describes
    // controlled comparisons rather than discovers them. Without this the LLM
    // routinely confabulated `controlledFor: ["same audience"]` because the
    // raw JSON dump is too noisy to confound-detect from. Matched pairs are
    // strictly stronger evidence than unstructured rows.
    const matchedPairs = this.buildMatchedPairs(campaignData);
    const matchedPairsBlock = matchedPairs.length > 0
      ? `\n\nPRE-COMPUTED MATCHED PAIRS (use these for causalInsights — each pair holds all variables constant except ONE):\n${JSON.stringify(matchedPairs, null, 2)}`
      : `\n\n(No matched pairs found in the data — emit causalInsights only if you can describe a single-variable comparison; otherwise leave the array empty.)`;

    let result;
    try {
      result = await this.claudeService.runAgent({
        tenantId,
        agentType: AgentType.CAMPAIGN_LEARNING_AGENT,
        systemPrompt: CAMPAIGN_LEARNING_PROMPT,
        liveContext: this.liveContextBuilder.build(company),
        userMessage: `Analyze these ${campaignData.length} campaigns and extract causal patterns.

Company thresholds (use these to define winning vs losing):
  targetROAS: ${company.targetROAS ?? 'not set'}
  pauseIfROASBelow: ${company.pauseIfROASBelow ?? 'not set'}
  pauseIfCTRBelow: ${company.pauseIfCTRBelow ?? 'not set'}
  scaleIfROASAbove: ${company.scaleIfROASAbove ?? 'not set'}
  primaryObjective: ${company.primaryObjective}
  weeklyBudgetCap: ${company.weeklyBudgetCap}

Campaign data (brief + creative + performance):
${JSON.stringify(campaignData, null, 2)}${matchedPairsBlock}

Previous campaign learnings (v${company.learnings?.version ?? 0}):
${JSON.stringify(company.learnings?.campaign ?? null, null, 2)}

Previous causal insights:
${JSON.stringify(company.learnings?.causalInsights ?? [], null, 2)}

Return ONLY the JSON object described in your instructions.`,
        model: 'claude-sonnet-4-6',
        maxTurns: 5,
      });
    } catch (err: any) {
      this.logger.error(`Campaign learning agent failed: ${err.message}`);
      await this.learningRunModel.create({
        tenantId, status: 'failed',
        version: company.learnings?.version ?? 0,
        briefsAnalyzed: campaignData.length,
        instinctsExtracted: 0,
        promptsRegenerated: false,
        skipReason: err.message,
        runAt: new Date(),
      });
      return;
    }

    const { campaign, topicScores, causalInsights } = this.parseCampaignLearnings(result.content);
    const newVersion = (company.learnings?.version ?? 0) + 1;

    // Enrich audienceScores with sample size (N) computed from the campaignData
    // that fed the agent. The agent emits a bare ROAS per audience; the wrapper
    // wraps it in { roas, n, updatedAt } so readers know whether to trust it.
    // N < 5 entries are rendered as "low confidence" in LiveContext and the
    // Campaign Review Team is forbidden from overriding the strategist's
    // audience choice citing a low-N entry alone.
    const audienceCounts = campaignData.reduce<Record<string, number>>((acc, row) => {
      const aud = row?.audience ?? row?.campaign?.audienceType ?? null;
      if (!aud) return acc;
      const key = String(aud);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const now = new Date();
    const enrichedAudienceScores: Record<string, { roas: number; n: number; updatedAt: Date }> = {};
    for (const [aud, roasRaw] of Object.entries(campaign.audienceScores)) {
      const roas = typeof roasRaw === 'number' ? roasRaw : (roasRaw as any)?.roas ?? 0;
      enrichedAudienceScores[aud] = {
        roas,
        n: audienceCounts[aud] ?? 0,
        updatedAt: now,
      };
    }
    const enrichedCampaign: CampaignLearnings = {
      ...campaign,
      audienceScores: enrichedAudienceScores,
    };

    // Race-safe: per-slice dot-path writes. Was: whole-tree replace → clobbered
    // concurrent creative-learning writes from a parallel Day-7 quick scan or
    // Meta importer pass. Now each writer owns its leaf fields.
    // causalInsights is replaced wholesale here (deep run rebuilds the list);
    // for incremental appends use companiesService.appendCausalInsight.
    await this.companiesService.setCampaignLearningSlice(tenantId, enrichedCampaign);
    await this.companiesService.setTopicScores(tenantId, topicScores);
    await this.companiesService.replaceCausalInsights(tenantId, causalInsights);

    // Deep run regenerates prompts — campaign creator, auditor, coordinator
    await this.promptGenerator.generate(tenantId);

    const instinctsExtracted =
      Object.keys(topicScores).length +
      Object.keys(campaign.audienceScores).length +
      campaign.budgetInsights.length +
      campaign.timingInsights.length +
      causalInsights.length;

    await this.actionLogger.log({
      tenantId,
      agent: AgentType.CAMPAIGN_LEARNING_AGENT,
      action: 'campaign_learnings_updated',
      reason: `Deep run — analyzed ${campaignData.length} campaigns with Day 30 data`,
      outcome: `Campaign learnings updated to v${newVersion}. ${instinctsExtracted} instincts. ${causalInsights.length} causal insights. Prompts regenerated.`,
    });

    await this.learningRunModel.create({
      tenantId,
      status: 'completed',
      version: newVersion,
      briefsAnalyzed: campaignData.length,
      instinctsExtracted,
      promptsRegenerated: true,
      runAt: new Date(),
      costUSD: result.costUSD,
    });

    this.logger.log(
      `Campaign deep run complete: tenantId=${tenantId} v${newVersion} instincts=${instinctsExtracted} causal=${causalInsights.length}`,
    );
  }

  // Triggered when a campaign is paused — immediate root cause analysis
  async runRootCauseAnalysis(tenantId: string, campaignId: string): Promise<void> {
    this.logger.log(`Root cause analysis: tenantId=${tenantId} campaignId=${campaignId}`);
    const company = await this.companiesService.findByTenantId(tenantId);

    const campaign = await this.campaignModel.findOne({ tenantId, _id: campaignId }).lean().exec();
    if (!campaign) return;

    const brief = await this.briefModel.findOne({ tenantId, briefId: campaign.briefId }).lean().exec();
    const creative = await this.creativePackageModel.findOne({ tenantId, briefId: campaign.briefId }).lean().exec();

    const ageMs = Date.now() - new Date(campaign.launchedAt!).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Anti-rut guard: if the agent has been emitting the same rootCause N times
    // in a row at low confidence, force it to argue against that default first.
    // Without this, runRootCauseAnalysis converged on "audience_mismatch / post_click_
    // conversion_rate / confidence 0.45" six campaigns in a row, hiding offer-fit
    // and lander-friction causes under the same label.
    const recentInsights: CausalInsight[] = (company.learnings?.causalInsights ?? []) as any;
    const lastSix = recentInsights.slice(-6);
    const counts = lastSix.reduce<Record<string, number>>((acc, i) => {
      acc[i.rootCause] = (acc[i.rootCause] ?? 0) + 1;
      return acc;
    }, {});
    const dominant = Object.entries(counts).sort(([, a], [, b]) => b - a)[0];
    const ruttedRootCause = dominant && dominant[1] >= 5 ? dominant[0] : null;

    const antiRutPrefix = ruttedRootCause
      ? `\n\nANTI-RUT GUARD — IMPORTANT:
The system has diagnosed "${ruttedRootCause}" in ${dominant![1]} of the last ${lastSix.length} insights.
That is statistically suspicious for a single-campaign diagnostic. Before defaulting to "${ruttedRootCause}":
  1. Argue AGAINST that diagnosis given the specific metrics of THIS campaign — what evidence contradicts it?
  2. Consider at least two alternative root causes (especially lander/offer friction, attribution lag, learning-phase starvation, or topic_exhaustion).
  3. Only return "${ruttedRootCause}" if the contradictory evidence is genuinely weaker than the supporting evidence.
The goal is to break the loop, not to avoid the diagnosis if it really fits.\n`
      : '';

    const ROOT_CAUSE_PROMPT = `You are a performance marketing analyst diagnosing why a single campaign was paused.

Unlike multi-campaign analysis, you have only ONE data point. You CANNOT isolate variables across campaigns.
Instead, use the campaign's own metrics + brief + creative to identify the most likely root cause.

ROOT CAUSE TYPES:
- creative_issue: low CTR suggests the hook/copy didn't resonate (CTR < 0.5% after ₹1000+ spend)
- audience_mismatch: decent CTR but zero/very low conversions (people clicked but didn't buy)
- format_mismatch: campaign underperformed vs similar campaigns on a different format
- topic_exhaustion: high frequency + declining CTR over time
- timing_issue: sudden drop aligned with external events, not gradual decline
- budget_issue: spend too low to exit Meta learning phase (< ₹500/day or < 50 conversions/week)

CONFIDENCE RULES for single-campaign diagnosis:
- Max confidence: 0.50 (you cannot be highly confident from one data point)
- If metrics clearly point to one cause: 0.40-0.50
- If ambiguous between two causes: 0.20-0.30

Output ONLY a single JSON object.${antiRutPrefix}`;

    let result;
    try {
      result = await this.claudeService.runAgent({
        tenantId,
        agentType: AgentType.CAMPAIGN_LEARNING_AGENT,
        systemPrompt: ROOT_CAUSE_PROMPT,
        liveContext: '',
        userMessage: `A campaign was just paused. Diagnose the root cause.

Campaign details:
  Pause reason: ${campaign.pauseReason}
  Age at pause: ${Math.round(ageDays)} days
  Budget: ₹${campaign.budget}/day
  Objective: ${campaign.objective}
  Metrics at pause: ROAS=${campaign.roas} CTR=${campaign.ctr}% CPC=₹${campaign.cpc} Conversions=${campaign.conversions} Spend=₹${campaign.spend}

Brief:
  Topic: ${brief?.topic} | Angle: ${brief?.angle} | Platform: ${brief?.platform}
  Format: ${brief?.format} | Audience: ${brief?.audience}
  Hook: ${brief?.hook}

Creative (selected variant):
${JSON.stringify(creative?.copyVariants?.[creative?.selectedCopyIndex ?? 0] ?? {}, null, 2)}

Company thresholds:
  targetROAS: ${company.targetROAS ?? 'not set'}
  pauseIfROASBelow: ${company.pauseIfROASBelow ?? 'not set'}
  pauseIfCTRBelow: ${company.pauseIfCTRBelow ?? 'not set'}

Based on this data, return a single causal insight JSON object identifying:
- the most likely root cause
- what variable was the problem
- confidence in that diagnosis
- what to do differently next time

Return as a single causal insight JSON:
{
  "finding": "...",
  "isolatedVariable": "...",
  "controlledFor": [],
  "rootCause": "creative_issue|audience_mismatch|format_mismatch|topic_exhaustion|timing_issue|budget_issue",
  "confidence": 0.0,
  "dataPoints": 1
}`,
        model: 'claude-sonnet-4-6',
        maxTurns: 3,
      });
    } catch (err: any) {
      this.logger.error(`Root cause analysis failed: ${err.message}`);
      return;
    }

    try {
      const insight: CausalInsight = parseRobustJson<CausalInsight>(result.content);

      // Decorate with product + audience for cluster keying. The single-campaign
      // diagnostic prompt doesn't know to emit productName, so we attach it here.
      const productName = (brief as any)?.productName ?? (campaign as any)?.productName ?? undefined;
      const dominantAudience = (() => {
        const adSets = ((campaign as any)?.adSets ?? []) as any[];
        if (!adSets.length) return undefined;
        const sorted = adSets.slice().sort((a, b) => (Number(b.spend) || 0) - (Number(a.spend) || 0));
        return sorted[0]?.audienceType ?? undefined;
      })();
      const enriched: CausalInsight = {
        ...insight,
        productName,
        audienceType: dominantAudience,
        dataPoints: insight.dataPoints ?? 1,
      };

      // Disambiguate offer × audience fit from raw audience quality.
      // Without this fork, every "high CTR, collapsed conv" finding tanks
      // audienceScores[audienceType] and the audience gets permanently exiled
      // even when the real fix is offer/lander/price. See OfferAudienceFitIssue.
      const ctrPct = Number((campaign as any).ctr) || 0;
      const ctrPauseFloor = Number(company.pauseIfCTRBelow ?? 0.5);
      const ctrHealthy = ctrPct >= ctrPauseFloor * 1.5;
      const convCollapsed = (Number((campaign as any).conversions) || 0) <= 2;
      const isOfferFitMiss =
        enriched.rootCause === 'audience_mismatch' &&
        ctrHealthy &&
        convCollapsed &&
        !!dominantAudience &&
        !!productName;

      if (isOfferFitMiss) {
        const fit: OfferAudienceFitIssue = {
          audienceType: dominantAudience!,
          productName: productName!,
          issue: enriched.finding,
          dataPoints: 1,
          lastUpdated: new Date(),
        };
        await this.companiesService.upsertOfferAudienceFitIssue(tenantId, fit);
      }

      // Consolidate near-duplicate findings into one growing-confidence entry
      // instead of accumulating N=1 lookalikes. Cap at 25 entries.
      await this.companiesService.appendOrConsolidateCausalInsight(tenantId, enriched, 25);

      this.logger.log(
        `Root cause identified: tenantId=${tenantId} cause=${enriched.rootCause} confidence=${enriched.confidence}${isOfferFitMiss ? ' [offer-fit reroute applied]' : ''}`,
      );
    } catch (err: any) {
      this.logger.error(`Failed to parse root cause insight: ${err.message}`);
    }
  }

  private async buildCampaignDataset(tenantId: string): Promise<any[]> {
    const briefs = await this.briefModel
      .find({ tenantId, selected: true, 'performanceWritten.day30': true })
      .lean()
      .exec();

    const briefIds = briefs.map(b => b.briefId).filter(Boolean);

    const [campaigns, creatives] = await Promise.all([
      this.campaignModel.find({ tenantId, briefId: { $in: briefIds } }).lean().exec(),
      this.creativePackageModel.find({ tenantId, briefId: { $in: briefIds } }).lean().exec(),
    ]);

    const campaignMap = new Map(campaigns.map(c => [c.briefId, c]));
    const creativeMap = new Map(creatives.map(c => [c.briefId, c]));

    return briefs.map((brief) => {
      const campaign = campaignMap.get(brief.briefId);
      const creative = creativeMap.get(brief.briefId);
      const selectedVariant = creative?.copyVariants?.[creative?.selectedCopyIndex ?? 0];

      return {
        briefId: brief.briefId,
        topic: brief.topic,
        angle: brief.angle,
        platform: brief.platform,
        format: brief.format,
        audience: brief.audience,
        hook: brief.hook,
        creative: selectedVariant
          ? {
              headline: selectedVariant.headline,
              hookStyle: selectedVariant.hookStyle,
              cta: selectedVariant.cta,
            }
          : null,
        performance: {
          day7: brief.day7Performance,
          day14: brief.day14Performance,
          day30: brief.day30Performance,
        },
        campaign: campaign
          ? {
              budget: campaign.budget,
              objective: campaign.objective,
              status: campaign.status,
              pauseReason: campaign.pauseReason,
              spend: campaign.spend,
              roas: campaign.roas,
              ctr: campaign.ctr,
              cpc: campaign.cpc,
              conversions: campaign.conversions,
            }
          : null,
      };
    });
  }

  /**
   * Group campaigns into matched pairs that hold all variables constant except
   * one, so the LLM can describe a controlled comparison instead of guessing
   * what was controlled. Group key = (product, audienceType, monthBucket).
   * Within a group, emit a pair iff exactly one of {format, hookStyle,
   * budget-band} differs between the two campaigns. Strictly stronger evidence
   * than the raw row dump and short enough to fit in prompt budget.
   */
  private buildMatchedPairs(campaignData: any[]): Array<{
    isolated: 'format' | 'hookStyle' | 'budget_band';
    held_constant: { product: string; audienceType: string; monthBucket: string };
    a: { briefId: string; format: string; hookStyle: string; budget: number; roas: number; ctr: number };
    b: { briefId: string; format: string; hookStyle: string; budget: number; roas: number; ctr: number };
  }> {
    const monthBucket = (d: any) =>
      d ? new Date(d).toISOString().slice(0, 7) : 'unknown';
    const budgetBand = (b: number) =>
      b < 1000 ? 'low' : b < 5000 ? 'mid' : b < 15000 ? 'high' : 'top';

    type Row = {
      briefId: string;
      product: string;
      audienceType: string;
      monthBucket: string;
      format: string;
      hookStyle: string;
      budget: number;
      budget_band: string;
      roas: number;
      ctr: number;
    };
    const rows: Row[] = campaignData
      .filter((c) => c.campaign?.roas != null && c.campaign?.status !== 'paused')
      .map((c) => ({
        briefId: c.briefId,
        product: c.product ?? 'unknown',
        audienceType: c.audience ?? 'unknown',
        monthBucket: monthBucket((c as any).launchedAt ?? (c as any).createdAt),
        format: c.format ?? 'unknown',
        hookStyle: c.creative?.hookStyle ?? 'unknown',
        budget: c.campaign?.budget ?? 0,
        budget_band: budgetBand(c.campaign?.budget ?? 0),
        roas: c.campaign.roas,
        ctr: c.campaign?.ctr ?? 0,
      }));

    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const k = `${r.product}|${r.audienceType}|${r.monthBucket}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }

    const pairs: ReturnType<typeof this.buildMatchedPairs> = [];
    for (const [, group] of groups) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          const diffs: Array<'format' | 'hookStyle' | 'budget_band'> = [];
          if (a.format !== b.format) diffs.push('format');
          if (a.hookStyle !== b.hookStyle) diffs.push('hookStyle');
          if (a.budget_band !== b.budget_band) diffs.push('budget_band');
          if (diffs.length !== 1) continue;   // we want EXACTLY one variable to differ
          pairs.push({
            isolated: diffs[0],
            held_constant: { product: a.product, audienceType: a.audienceType, monthBucket: a.monthBucket },
            a: { briefId: a.briefId, format: a.format, hookStyle: a.hookStyle, budget: a.budget, roas: a.roas, ctr: a.ctr },
            b: { briefId: b.briefId, format: b.format, hookStyle: b.hookStyle, budget: b.budget, roas: b.roas, ctr: b.ctr },
          });
        }
      }
    }
    // Cap to keep prompt size bounded.
    return pairs.slice(0, 20);
  }

  private parseCampaignLearnings(content: string): {
    campaign: CampaignLearnings;
    topicScores: Record<string, number>;
    causalInsights: CausalInsight[];
  } {
    try {
      const raw: any = parseRobustJson(content);

      return {
        campaign: {
          audienceScores: raw.campaign?.audienceScores ?? {},
          platformROAS: raw.campaign?.platformROAS ?? {},
          budgetInsights: raw.campaign?.budgetInsights ?? [],
          timingInsights: raw.campaign?.timingInsights ?? [],
          objectiveInsights: raw.campaign?.objectiveInsights ?? [],
        },
        topicScores: raw.topicScores ?? {},
        causalInsights: raw.causalInsights ?? [],
      };
    } catch (err: any) {
      this.logger.error(`Failed to parse campaign learnings: ${err.message}`);
      throw new Error(`Campaign Learning Agent returned invalid JSON: ${err.message}`);
    }
  }

  private emptyCreativeLearnings() {
    return {
      winningHooks: [], losingHooks: [],
      winningFormats: [], losingFormats: [],
      ctaInsights: [], copyToneInsights: [], visualInsights: [],
    };
  }

  private emptyCampaignLearnings(): CampaignLearnings {
    return {
      audienceScores: {}, platformROAS: {},
      budgetInsights: [], timingInsights: [], objectiveInsights: [],
    };
  }
}
