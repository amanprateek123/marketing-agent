import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { ActionLoggerService } from '../../common/action-logger/action-logger.service';
import { CampaignsService } from '../campaigns.service';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CreativeBriefDocument } from '../../pipeline/schemas/creative-brief.schema';
import { CreativePackageDocument } from '../../creative/schemas/creative-package.schema';
import { SafetyChecks } from './safety-checks';
import { CampaignReviewTeamService, CampaignReviewOutput } from '../../teams/campaign-review-team.service';
import { SlackService } from '../../delivery/slack.service';

const CAMPAIGN_CREATOR_FALLBACK_PROMPT = `You are a Meta Ads campaign specialist.
Your job is to create and launch Meta Ads campaigns using the Meta Ads MCP tools.
Always use 70/30 audience split: 70% proven/lookalike audience, 30% broad test audience.
Follow exact naming conventions provided. Never exceed the specified budget.`;

@Injectable()
export class CampaignCreatorService {
  private readonly logger = new Logger(CampaignCreatorService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly campaignsService: CampaignsService,
    private readonly liveContextBuilder: LiveContextBuilder,
    private readonly actionLogger: ActionLoggerService,
    private readonly campaignReviewTeam: CampaignReviewTeamService,
    private readonly slackService: SlackService,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
  ) {}

  /**
   * Phase G Step 1: Safety checks → Campaign Review Team → save as pending_approval → Slack notification.
   * Does NOT launch on Meta. Waits for human approval via /approve endpoint.
   */
  async create(
    brief: CreativeBriefDocument,
    creativePackage: CreativePackageDocument,
    company: CompanyDocument,
    runId: string,
  ): Promise<CampaignDocument> {
    // ── ALL SAFETY CHECKS — TypeScript level, Claude cannot override ──────────
    SafetyChecks.checkForbiddenTopics(brief, company);
    SafetyChecks.checkCampaignBudget(brief.suggestedBudget, company);
    await SafetyChecks.checkWeeklyBudget(company.tenantId, brief.suggestedBudget, company, this.campaignsService);
    await SafetyChecks.checkCampaignsPerRun(company.tenantId, runId, company, this.campaignsService);

    this.logger.log(
      `Safety checks passed — running campaign review: tenantId=${company.tenantId} briefId=${brief.briefId}`,
    );

    // ── Campaign Review Team — debate before launch (retry + fallback) ─────
    let finalBudget = brief.suggestedBudget;
    let review: CampaignReviewOutput | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        this.logger.log(`Campaign Review Team attempt ${attempt}/2 | tenant: ${company.tenantId}`);
        review = await this.campaignReviewTeam.review(
          {
            topic: brief.topic,
            angle: brief.angle,
            platform: brief.platform,
            format: brief.format,
            audience: brief.audience,
            hook: brief.hook,
            keyMessage: brief.keyMessage,
            conversionBridge: brief.conversionBridge,
            suggestedBudget: brief.suggestedBudget,
          },
          creativePackage,
          company,
          runId,
        );

        // Validate: did a real review happen?
        if (review && review.debateRounds > 0) {
          break; // valid review
        }

        this.logger.warn(`Campaign Review returned invalid result on attempt ${attempt}`);
        review = null;
      } catch (err: any) {
        this.logger.warn(`Campaign Review attempt ${attempt} failed: ${err.message}`);
        review = null;
      }
    }

    if (review) {
      if (!review.approved) {
        this.logger.warn(`Campaign Review Team rejected campaign: ${review.debateRationale}`);

        const slackWebhook = company.delivery?.slackWebhook;
        if (slackWebhook) {
          await this.slackService.sendMessage(
            slackWebhook,
            company.tenantId,
            `❌ *Campaign Rejected by Review Team*\n\n*Topic:* ${brief.topic}\n*Budget:* ₹${brief.suggestedBudget}\n\n*Reason:* ${review.debateRationale}\n\n*Debate Log:*\n${review.debateLog?.map(d => `• R${d.round} [${d.from}]: ${d.summary}`).join('\n') ?? 'No debate log'}`,
          );
        }

        throw new Error(`Campaign rejected by review team: ${review.debateRationale}`);
      }

      if (review?.adjustments?.budgetAdjusted) {
        finalBudget = review.adjustments.recommendedBudget;
        this.logger.log(`Budget adjusted: ₹${brief.suggestedBudget} → ₹${finalBudget}`);
      }

      this.logger.log(`Campaign Review Team approved | rounds: ${review.debateRounds}`);
    } else {
      this.logger.warn(`Campaign Review Team failed after 2 attempts — proceeding with original budget ₹${finalBudget}`);
    }

    // ── Save as pending_approval — do NOT launch yet ─────────────────────────
    const campaignName = `META_${company.primaryObjective.toUpperCase()}_${brief.audience}_${brief.topic}_${new Date().toISOString().split('T')[0]}`;

    const campaign = await this.campaignModel.create({
      tenantId: company.tenantId,
      runId,
      briefId: brief.briefId,
      creativePackageId: creativePackage?._id?.toString() ?? '',
      metaCampaignId: '',
      status: 'pending_approval',
      budget: finalBudget,
      objective: company.primaryObjective,
      reviewNotes: review?.debateRationale ?? '',
      reviewAdjustments: review?.adjustments ?? undefined,
      reviewDebateLog: review?.debateLog ?? [],
    });

    await this.actionLogger.log({
      tenantId: company.tenantId,
      runId,
      agent: AgentType.CAMPAIGN_CREATOR,
      action: 'campaign_pending_approval',
      reason: `Campaign reviewed and awaiting human approval | budget: ₹${finalBudget}${review ? ` (${review.debateRationale})` : ''}`,
      outcome: `Campaign saved as pending_approval`,
      metadata: { briefId: brief.briefId, campaignName },
    });

    // ── Send approval request to Slack ───────────────────────────────────────
    const slackWebhook = company.delivery?.slackWebhook;
    if (slackWebhook) {
      await this.slackService.sendMessage(
        slackWebhook,
        company.tenantId,
        this.buildApprovalMessage(brief, finalBudget, review, (campaign as any)._id.toString(), company.tenantId),
      );
    }

    this.logger.log(
      `Campaign pending approval: tenantId=${company.tenantId} budget=₹${finalBudget} | Slack notification sent`,
    );

    return campaign;
  }

  /**
   * Phase G Step 2: Human approved → launch on Meta Ads.
   * Called via POST /campaigns/:tenantId/:campaignId/approve
   */
  async launch(
    campaignId: string,
    company: CompanyDocument,
  ): Promise<CampaignDocument> {
    const campaign = await this.campaignModel.findOne({
      _id: campaignId,
      tenantId: company.tenantId,
    }).exec();
    if (!campaign) throw new Error(`Campaign ${campaignId} not found for tenant ${company.tenantId}`);
    if (campaign.status !== 'pending_approval') {
      throw new Error(`Campaign ${campaignId} is not pending approval (status: ${campaign.status})`);
    }

    if (!company.meta?.accessToken || !company.meta?.accountId) {
      throw new Error(`Meta Ads credentials not configured for tenant ${company.tenantId}. Set company.meta.accessToken and company.meta.accountId.`);
    }

    const systemPrompt = company.prompts?.campaignCreator ?? CAMPAIGN_CREATOR_FALLBACK_PROMPT;

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      agentType: AgentType.CAMPAIGN_CREATOR,
      systemPrompt,
      liveContext: this.liveContextBuilder.build(company),
      userMessage: `Create and launch a Meta Ads campaign with the following details:

META ADS CREDENTIALS (use these for this tenant):
  Access Token: ${company.meta.accessToken}
  Account ID: ${company.meta.accountId}
  ${company.meta.pixelId ? `Pixel ID: ${company.meta.pixelId}` : ''}
  ${company.meta.pageId ? `Page ID: ${company.meta.pageId}` : ''}

Campaign Name: META_${company.primaryObjective.toUpperCase()}_${campaign.objective}_${new Date().toISOString().split('T')[0]}
Budget: ₹${campaign.budget}
Objective: ${campaign.objective}
Geography: ${company.geography}
Brief ID: ${campaign.briefId}

Review Notes: ${(campaign as any).reviewNotes ?? 'None'}
Targeting: ${(campaign as any).reviewAdjustments?.targetingNotes ?? 'Default'}
Scale Rules: ${(campaign as any).reviewAdjustments?.scaleRules ?? 'None set'}
Pause Rules: ${(campaign as any).reviewAdjustments?.pauseRules ?? 'None set'}

Use 70/30 split: 70% proven/lookalike audience, 30% broad test audience.
After creating the campaign, return the Meta campaign ID in this format:
META_CAMPAIGN_ID: <id>`,
      maxTurns: 15,
      runId: campaign.runId,
    });

    const metaCampaignId = this.extractMetaCampaignId(result.content) ?? `mock_${Date.now()}`;

    await this.campaignModel.updateOne(
      { _id: campaignId },
      {
        status: 'active',
        metaCampaignId,
        launchedAt: new Date(),
        approvedAt: new Date(),
      },
    );

    await this.actionLogger.log({
      tenantId: company.tenantId,
      runId: campaign.runId,
      agent: AgentType.CAMPAIGN_CREATOR,
      action: 'campaign_launched',
      reason: `Human approved → launched on Meta with budget ₹${campaign.budget}`,
      outcome: `Meta campaign ID: ${metaCampaignId}`,
      metadata: { campaignId, briefId: campaign.briefId },
    });

    this.logger.log(
      `Campaign LAUNCHED: tenantId=${company.tenantId} metaCampaignId=${metaCampaignId} budget=₹${campaign.budget}`,
    );

    return (await this.campaignModel.findOne({ _id: campaignId, tenantId: company.tenantId }).lean().exec()) as any;
  }

  private buildApprovalMessage(
    brief: CreativeBriefDocument,
    finalBudget: number,
    review: CampaignReviewOutput | null,
    campaignId: string,
    tenantId: string,
  ): string {
    const budgetLine = review?.adjustments?.budgetAdjusted
      ? `*Budget:* ₹${finalBudget} (adjusted from ₹${review.adjustments.originalBudget} by Campaign Review Team)`
      : `*Budget:* ₹${finalBudget}`;

    const reviewBlock = review
      ? `
*Campaign Review Team (${review.debateRounds} rounds):*
${review.debateRationale}

*Targeting:* ${review.adjustments.targetingNotes}
*Scale Rules:* ${review.adjustments.scaleRules}
*Pause Rules:* ${review.adjustments.pauseRules}
*Timing:* ${review.adjustments.timingNotes}`
      : '_No review team data — using original config._';

    return `🚀 *Campaign Ready for Approval*

*Topic:* ${brief.topic}
*Platform:* ${brief.platform} | *Format:* ${brief.format}
*Audience:* ${brief.audience}
${budgetLine}

${reviewBlock}

To launch this campaign, call:
\`POST /api/v1/campaigns/${tenantId}/${campaignId}/approve\`

Or reply here to discuss changes.`;
  }

  private extractMetaCampaignId(content: string): string | null {
    const match = content.match(/META_CAMPAIGN_ID:\s*([^\s\n]+)/);
    return match ? match[1] : null;
  }
}
