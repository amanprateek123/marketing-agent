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
import { CampaignLearnings, CausalInsight } from '../companies/schemas/company.types';

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
${JSON.stringify(campaignData, null, 2)}

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

    await this.companiesService.updateLearnings(tenantId, {
      version: newVersion,
      updatedAt: new Date(),
      topicScores,
      creative: company.learnings?.creative ?? this.emptyCreativeLearnings(),
      campaign,
      causalInsights,
    });

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

Output ONLY a single JSON object.`;

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
      const raw = result.content.slice(result.content.indexOf('{'), result.content.lastIndexOf('}') + 1);
      const insight: CausalInsight = JSON.parse(raw);

      const existing = company.learnings;
      await this.companiesService.updateLearnings(tenantId, {
        version: (existing?.version ?? 0) + 1,
        updatedAt: new Date(),
        topicScores: existing?.topicScores ?? {},
        creative: existing?.creative ?? this.emptyCreativeLearnings(),
        campaign: existing?.campaign ?? this.emptyCampaignLearnings(),
        causalInsights: [...(existing?.causalInsights ?? []), insight],
      });

      this.logger.log(
        `Root cause identified: tenantId=${tenantId} cause=${insight.rootCause} confidence=${insight.confidence}`,
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

  private parseCampaignLearnings(content: string): {
    campaign: CampaignLearnings;
    topicScores: Record<string, number>;
    causalInsights: CausalInsight[];
  } {
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      const raw = fenceMatch
        ? JSON.parse(fenceMatch[1].trim())
        : JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));

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
