import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentType } from '../../claude/claude.types';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { ActionLoggerService } from '../../common/action-logger/action-logger.service';
import { CampaignsService } from '../campaigns.service';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CreativeBrief, CreativeBriefDocument } from '../../pipeline/schemas/creative-brief.schema';
import { CreativePackageDocument } from '../../creative/schemas/creative-package.schema';
import { SafetyChecks } from './safety-checks';
import { CampaignReviewTeamService, CampaignReviewOutput } from '../../teams/campaign-review-team.service';
import { MetaAdsService } from '../meta-ads/meta-ads.service';
import { SlackService } from '../../delivery/slack.service';
import { CompaniesService } from '../../companies/companies.service';
import { applyAudienceTargeting } from './audience-targeting-resolver';
import { clampAgeRanges, enforceGeoLanguageCoherence, checkAdSetOverlap } from './targeting-validator';
import { getGrossConversionValue } from '../../common/conversion-value.util';
import axios from 'axios';

@Injectable()
export class CampaignCreatorService {
  private readonly logger = new Logger(CampaignCreatorService.name);

  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly companiesService: CompaniesService,
    private readonly actionLogger: ActionLoggerService,
    private readonly campaignReviewTeam: CampaignReviewTeamService,
    private readonly metaAdsService: MetaAdsService,
    private readonly slackService: SlackService,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBriefDocument>,
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

    // ── Auto-create pixel-based audiences if missing ─────────────────────────
    try {
      await this.ensurePixelAudiences(company);
    } catch (err: any) {
      this.logger.warn(`Audience auto-creation failed (proceeding without): ${err.message}`);
    }

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
            // Without `product`, the review team's `(brief as any).product` resolved
            // to undefined — productBlock, audience segments, conversionEvent, and
            // landing-URL lookup all fell through to defaults on every campaign.
            product: brief.product ?? '',
            audienceStage: (brief as any).audienceStage ?? 'cold',
            // Exploit-winner marker — when set, Campaign Review skips the
            // cold-start 50-60% cut and defaults to the source winner's
            // budgetTier. Additionally TS-enforces a floor below (cannot be
            // overridden by LLM).
            winnerCloneOf: (brief as any).winnerCloneOf,
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
          try {
            await this.slackService.sendMessage(
              slackWebhook,
              company.tenantId,
              `❌ *Campaign Rejected by Review Team*\n\n*Topic:* ${brief.topic}\n*Budget:* ₹${brief.suggestedBudget}\n\n*Reason:* ${review.debateRationale}\n\n*Debate Log:*\n${review.debateLog?.map(d => `• R${d.round} [${d.from}]: ${d.summary}`).join('\n') ?? 'No debate log'}`,
            );
          } catch (slackErr: any) {
            this.logger.error(`Slack rejection notification failed: ${slackErr.message}`);
          }
        }

        throw new Error(`Campaign rejected by review team: ${review.debateRationale}`);
      }

      if (review?.adjustments?.budgetAdjusted) {
        finalBudget = review.adjustments.recommendedBudget;
        this.logger.log(`Budget adjusted: ₹${brief.suggestedBudget} → ₹${finalBudget}`);
      }

      // Use campaign config budget if available
      if (review?.campaign?.budget) {
        finalBudget = review.campaign.budget;
      }

      // ── Winner-clone floor (TS-enforced — LLM cannot override) ──────────────
      // When this brief was tagged as a clone of a proven winner, the Review
      // Team prompt is told to default to the source winner's budgetTier.
      // If the LLM still cuts the budget below that floor (e.g. via the
      // generic "be conservative" prior), restore it here. The whole point
      // of the exploit-winner arm is that the budget tier was already proven —
      // cutting it back to cold-start sizes defeats the propagation loop.
      const winnerCloneOf = (brief as any).winnerCloneOf;
      if (winnerCloneOf?.budgetTier && finalBudget < winnerCloneOf.budgetTier) {
        this.logger.warn(
          `Winner-clone budget floor: review cut ₹${finalBudget} below source winner tier ₹${winnerCloneOf.budgetTier} — restoring to source tier`,
        );
        finalBudget = winnerCloneOf.budgetTier;
      }

      // Re-validate adjusted budget against safety caps — review team cannot override TypeScript limits
      if (finalBudget > company.maxBudgetPerCampaign) {
        this.logger.warn(`Review team budget ₹${finalBudget} exceeds cap ₹${company.maxBudgetPerCampaign} — clamping`);
        finalBudget = company.maxBudgetPerCampaign;
      }
      await SafetyChecks.checkWeeklyBudget(company.tenantId, finalBudget, company, this.campaignsService);

      // ── audienceStage guard: warm/hot MUST use custom-audience retargeting ──
      // Funnel-stage taxonomy (industry-standard):
      //   cold = lookalikes / interests / advantage_plus / broad (no brand engagement)
      //   warm = custom retargeting (site visitors / engagers / video viewers)
      //   hot  = cart abandoners / initiate_checkout / 30d engaged
      // Lookalikes are NEVER warm — being a lookalike of a buyer is still
      // prospecting because that person has not engaged with our brand.
      // For warm/hot briefs, ONLY custom/retarget audience types are valid;
      // lookalike/advantage_plus/interest are category errors → reject.
      const briefStage = (brief as any).audienceStage as 'cold' | 'warm' | 'hot' | undefined;
      if (briefStage === 'warm' || briefStage === 'hot') {
        const PROSPECTING_TYPES = new Set(['advantage_plus', 'broad', 'lookalike', 'interest']);
        const offenders = ((review.campaign?.adSets ?? []) as any[])
          .filter(as => PROSPECTING_TYPES.has(as.audienceType))
          .map(as => `${as.name} (${as.audienceType})`);
        if (offenders.length > 0) {
          throw new Error(
            `Campaign rejected: ${briefStage} brief requires retargeting custom audiences (audienceType "custom" or "retarget"), but ${offenders.length} ad set(s) used cold-prospecting types: ${offenders.join(', ')}. Lookalike/advantage_plus/interest are NEVER warm — they reach people who have not engaged with our brand. Review the brief: either retag as cold, or supply a real custom-audience metaAudienceId.`,
          );
        }

        // ── Second guard: warm/hot + retarget/custom MUST have a metaAudienceId ──
        // The May 14 KAAL_SARPA campaign exposed this gap: Review Team picked
        // audienceType="retarget" (correct) but omitted metaAudienceId. At Meta
        // launch, meta-ads.service.ts:531 requires both to attach custom_audiences;
        // missing metaAudienceId silently fell through to Advantage+ broad
        // delivery — warm copy ("Aapki kundli wait kar rahi hai") got served
        // to cold audience. Throw early so the operator picks an audience.
        const RETARGET_TYPES = new Set(['retarget', 'custom']);
        const adSetsWithoutAudience = ((review.campaign?.adSets ?? []) as any[])
          .filter(as => RETARGET_TYPES.has(as.audienceType) && !as.metaAudienceId)
          .map(as => as.name);
        if (adSetsWithoutAudience.length > 0) {
          throw new Error(
            `Campaign rejected: ${briefStage} brief has ${adSetsWithoutAudience.length} ad set(s) with audienceType=retarget/custom but no metaAudienceId set: ${adSetsWithoutAudience.join(', ')}. Without metaAudienceId, Meta launches with no custom_audiences attached → defaults to Advantage+ broad delivery (cold prospecting traffic gets warm copy). Set metaAudienceId to a real custom audience ID from product.metaAudiences.`,
          );
        }
      }

      this.logger.log(`Campaign Review Team approved | rounds: ${review.debateRounds} | adSets: ${review.campaign?.adSets?.length ?? 0}`);
    } else {
      // ── Deterministic fallback ─────────────────────────────────────────────
      // Was: throw + save FAILED_* row → the brief's angle was lost entirely
      // (see FAILED_ASTROTALK_TRUST_FLIGHT, 91astrology 2026-05-23 — strong
      // competitor-displacement angle killed because Campaign Review's two
      // attempts both returned unparseable JSON).
      //
      // Now: when the Review Team fails, build a conservative TypeScript-only
      // config from the brief + product defaults, mark it pending_approval
      // with a clear `used_deterministic_fallback` note in reviewNotes so the
      // operator can sanity-check before approving. Strong-angle briefs no
      // longer die from formatting bugs.
      this.logger.warn(
        `Campaign Review Team failed after 2 attempts — falling back to deterministic config for brief ${brief.briefId}`,
      );
      review = this.buildFallbackReview(brief, company);
      finalBudget = review.campaign.budget;
    }

    // ── Idempotency: don't create duplicate campaigns for same brief ──────────
    // Superseded campaigns are explicitly retired (regenerate flow) — ignore them
    // so the regenerate endpoint can produce a fresh pending_approval campaign.
    const existingCampaign = await this.campaignModel.findOne({
      tenantId: company.tenantId,
      runId,
      briefId: brief.briefId,
      status: { $ne: 'superseded' },
    }).exec();
    if (existingCampaign) {
      this.logger.warn(`Campaign already exists for briefId=${brief.briefId} runId=${runId} — returning existing`);
      return existingCampaign;
    }

    // ── Save as pending_approval — do NOT launch yet ─────────────────────────
    // AGENT_ prefix lets the marketing team distinguish autonomous-agent campaigns
    // from human-created ones in the Meta Ads Manager list view.
    const topicSlug = brief.topic.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 30);
    const campaignName = `AGENT_${topicSlug}_${new Date().toISOString().split('T')[0]}`;

    const campaign = await this.campaignModel.create({
      tenantId: company.tenantId,
      runId,
      briefId: brief.briefId,
      name: campaignName,
      topic: brief.topic ?? '',
      angle: brief.angle ?? '',
      creativePackageId: creativePackage?._id?.toString() ?? '',
      metaCampaignId: '',
      status: 'pending_approval',
      budget: finalBudget,
      objective: company.primaryObjective,
      reviewNotes: review?.debateRationale ?? '',
      reviewAdjustments: review?.adjustments ?? undefined,
      reviewDebateLog: review?.debateLog ?? [],
      campaignConfig: review?.campaign ?? undefined,
      // Stamp prompt version so we can later answer "did campaigns generated
      // under v(N) outperform v(N+1)?" before deciding to roll back prompts.
      promptsVersion: (company as any).promptsVersion ?? 1,
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
      try {
        await this.slackService.sendMessage(
          slackWebhook,
          company.tenantId,
          this.buildApprovalMessage(brief, finalBudget, review, (campaign as any)._id.toString(), company.tenantId),
        );
      } catch (slackErr: any) {
        this.logger.error(`Slack approval notification failed — campaign saved as pending_approval: ${slackErr.message}`);
      }
    }

    this.logger.log(
      `Campaign pending approval: tenantId=${company.tenantId} budget=₹${finalBudget} | Slack notification sent`,
    );

    return campaign;
  }

  /**
   * Landing-page A/B test launcher (operator-triggered, via CreativeController).
   * Builds ONE campaign with TWO ad sets that are identical in audience and
   * creatives and differ ONLY by destination URL (landingUrlOverride). Meta's
   * per-ad-set reporting then isolates which landing page converts better.
   *
   * Deterministic — bypasses the Campaign Review Team (the structure is fixed:
   * two 50/50 URL-split ad sets). Creative is produced upstream by the caller
   * and passed in held-constant. Saves as pending_approval; the operator
   * launches via the normal /approve endpoint. Report-only: the winner is
   * surfaced by the audit loop, never auto-promoted to product.landingUrl.
   */
  async createLandingPageTest(opts: {
    tenantId: string;
    briefId: string;
    runId: string;
    briefData: {
      topic: string; angle: string; platform: string; format: string; audience: string;
      hook: string; keyMessage: string; conversionBridge: string;
      targetSegment?: string; targetLanguage?: string; audienceStage?: 'cold' | 'warm' | 'hot';
    };
    creativePackage: CreativePackageDocument;
    company: CompanyDocument;
    productName: string;
    controlUrl: string;
    variantUrl: string;
    budget: number;
    audienceType?: string;
    metaAudienceId?: string;
  }): Promise<CampaignDocument> {
    const { tenantId, briefId, runId, briefData, creativePackage, company, productName, controlUrl, variantUrl, budget } = opts;

    const product = (company.products ?? []).find(p => p.name === productName);
    if (!product) throw new Error(`Product "${productName}" not found for tenant ${tenantId}`);
    if (!controlUrl) throw new Error(`Product "${productName}" has no landingUrl (the control page). Set it before running a landing-page test.`);
    if (!variantUrl) throw new Error(`variantUrl (the challenger landing page) is required.`);
    if (controlUrl === variantUrl) throw new Error(`variantUrl must differ from the product's current landingUrl (control).`);

    // Guard: don't stack a second test on the same product while one runs.
    if (product.landingPageTest?.status === 'running') {
      throw new Error(`A landing-page test is already running for "${productName}" (campaign ${product.landingPageTest.campaignId}). Conclude it before starting another.`);
    }

    // Budget safety — same TypeScript caps every campaign honours.
    SafetyChecks.checkCampaignBudget(budget, company);
    await SafetyChecks.checkWeeklyBudget(tenantId, budget, company, this.campaignsService);

    // Resolve the held-constant audience: explicit > tightest buyer-lookalike >
    // advantage_plus broad (the merge that would collapse the two ad sets is
    // skipped in launch() because campaignConfig.isLandingPageTest is set).
    let audienceType = opts.audienceType;
    let metaAudienceId = opts.metaAudienceId;
    if (!metaAudienceId) {
      const lookalike = (product.metaAudiences ?? [])
        .filter(a => a.type === 'lookalike')
        .sort((a, b) => (a.lookalikePercent ?? 99) - (b.lookalikePercent ?? 99))[0];
      if (lookalike) {
        audienceType = 'lookalike';
        metaAudienceId = lookalike.id;
      }
    }
    if (!audienceType) audienceType = 'advantage_plus';

    // Variant indices that actually rendered an image — these creatives ship
    // IDENTICALLY in both ad sets so the URL is the only difference.
    const availableVariants = ((creativePackage as any).images ?? [])
      .filter((im: any) => im.imageUrl)
      .map((im: any) => im.variantIndex)
      .sort((a: number, b: number) => a - b);
    if (availableVariants.length === 0) {
      throw new Error(`Creative package ${(creativePackage as any)._id} has no rendered images — cannot launch a landing-page test.`);
    }

    const optimizationGoal = product.metaOptimizationGoal || 'OFFSITE_CONVERSIONS';
    const conversionEvent = product.customEventName || product.conversionEvent || 'Purchase';
    const conversionValue = getGrossConversionValue(product);
    const objective = company.primaryObjective ?? 'OUTCOME_SALES';
    const dateTag = new Date().toISOString().split('T')[0];

    const baseAdSet = {
      budgetPercent: 50,
      audienceType,
      metaAudienceId,
      optimizationGoal,
      ads: availableVariants,
      creativeFormat: 'image' as const,
    };
    const campaignConfig = {
      // Marks this as an LP test so launch() skips the advantage_plus merge that
      // would otherwise collapse the two URL-split ad sets into one.
      isLandingPageTest: true,
      budget,
      objective,
      conversionEvent,
      conversionValue,
      adSets: [
        { ...baseAdSet, name: `LP_A_CONTROL_${dateTag}`, landingUrlOverride: controlUrl },
        { ...baseAdSet, name: `LP_B_VARIANT_${dateTag}`, landingUrlOverride: variantUrl },
      ],
      scaleRules: '',
      pauseRules: '',
    };

    // Persist a CreativeBrief so launch() resolves product context and the audit
    // loop can attribute the test by briefId.
    await this.creativeBriefModel.updateOne(
      { tenantId, briefId },
      {
        $set: {
          tenantId, briefId, runId, product: productName,
          topic: briefData.topic, angle: briefData.angle, platform: briefData.platform,
          format: briefData.format, audience: briefData.audience, hook: briefData.hook,
          keyMessage: briefData.keyMessage, conversionBridge: briefData.conversionBridge,
          audienceStage: briefData.audienceStage ?? 'cold',
          targetSegment: briefData.targetSegment ?? '', targetLanguage: briefData.targetLanguage ?? '',
          suggestedBudget: budget,
        },
      },
      { upsert: true },
    );

    const campaign = await this.campaignModel.create({
      tenantId,
      runId,
      briefId,
      name: `LP_TEST_${productName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 24)}_${dateTag}`,
      topic: briefData.topic,
      angle: briefData.angle,
      creativePackageId: (creativePackage as any)._id?.toString() ?? '',
      metaCampaignId: '',
      status: 'pending_approval',
      budget,
      objective,
      source: 'agent',
      reviewNotes: `Landing-page A/B test (deterministic — no Review Team). Ad set A → control ${controlUrl}; ad set B → variant ${variantUrl}. Same audience (${audienceType}) + same creatives in both; URL is the only variable.`,
      campaignConfig,
      promptsVersion: (company as any).promptsVersion ?? 1,
    });

    // Mark the test running on the product (direct write — NOT via the DTO path,
    // whose whitelist would strip landingPageTest).
    await this.companiesService.setProductLandingPageTest(tenantId, productName, {
      controlUrl,
      variantUrl,
      audienceType,
      metaAudienceId,
      status: 'running',
      campaignId: (campaign as any)._id.toString(),
      startedAt: new Date(),
    });

    await this.actionLogger.log({
      tenantId,
      runId,
      agent: AgentType.CAMPAIGN_CREATOR,
      action: 'landing_page_test_created',
      reason: `Landing-page A/B test for ${productName}: control vs ${variantUrl}`,
      outcome: `Campaign saved as pending_approval — approve to launch`,
      metadata: { briefId, campaignId: (campaign as any)._id.toString(), controlUrl, variantUrl },
    });

    this.logger.log(`Landing-page test created: tenant=${tenantId} product=${productName} campaign=${(campaign as any)._id} budget=₹${budget} audience=${audienceType}`);
    return campaign;
  }

  /**
   * Phase G Step 2: Human approved → launch on Meta Ads.
   * Called via POST /campaigns/:tenantId/:campaignId/approve
   */
  async launch(
    campaignId: string,
    company: CompanyDocument,
    accountId: string,
  ): Promise<CampaignDocument> {
    // ── Atomic claim — prevents /approve double-launch race ──────────────────
    // Was: findOne → check status → check metaCampaignId → later update.
    // Race: two concurrent /approve calls both pass the read-then-check, both
    // proceed into 60-90s of Meta API calls, both create live Meta campaigns,
    // only one gets tracked in DB → orphan live campaign spending money. The
    // single biggest production-time bug per the SRE review.
    //
    // Now: atomic findOneAndUpdate gates on (status=pending_approval AND
    // metaCampaignId='') and immediately flips to 'launching'. If null
    // returned, another /approve call already won the race — throw. Rollback
    // path resets status to 'pending_approval' on launch failure.
    const campaign = await this.campaignModel.findOneAndUpdate(
      {
        _id: campaignId,
        tenantId: company.tenantId,
        status: 'pending_approval',
        $or: [{ metaCampaignId: '' }, { metaCampaignId: { $exists: false } }],
      },
      { $set: { status: 'launching' } },
      { new: true },
    ).exec();
    if (!campaign) {
      // Distinguish "not found" from "already launching/launched" for clearer error
      const existing = await this.campaignModel.findOne({ _id: campaignId, tenantId: company.tenantId }).select('status metaCampaignId').lean().exec();
      if (!existing) throw new Error(`Campaign ${campaignId} not found for tenant ${company.tenantId}`);
      if (existing.metaCampaignId) {
        throw new Error(`Campaign ${campaignId} already launched (metaCampaignId: ${existing.metaCampaignId})`);
      }
      throw new Error(`Campaign ${campaignId} cannot be launched (status: ${existing.status} — must be pending_approval)`);
    }

    // Load creative brief early — needed by the audience-expiry fallback path
    // (line ~330) so warm/hot stages can be detected before the audience
    // validator decides whether to fall back to advantage_plus or another LAL.
    const creativeBrief = campaign.briefId
      ? await this.campaignsService.findCreativeBrief(company.tenantId, campaign.briefId)
      : null;

    if (!company.meta?.accessToken) {
      throw new Error(`Meta Ads access token not configured for tenant ${company.tenantId}.`);
    }

    if (!company.meta?.pageId) {
      throw new Error(`Meta Page ID not configured for tenant ${company.tenantId}. Set company.meta.pageId — required for ad creative creation.`);
    }

    const config = (campaign as any).campaignConfig;
    if (!config || !config.adSets || config.adSets.length === 0) {
      throw new Error(`No structured campaign config found for campaign ${campaignId}. Campaign Review Team output may be incomplete.`);
    }

    // Landing-page A/B test campaigns are built with TWO deliberately-separate
    // ad sets that differ ONLY by destination URL (landingUrlOverride). The
    // advantage_plus consolidation below would merge them into one — collapsing
    // the test and keeping only the first ad set's URL. Skip that merge for LP
    // tests so the two URL-split ad sets ship intact.
    const isLandingPageTest = !!config.isLandingPageTest;

    // Load creative package for copy variants + image
    const creativePackage = campaign.creativePackageId
      ? await this.campaignsService.findCreativePackage(campaign.creativePackageId)
      : null;

    const copyVariants = creativePackage?.copyVariants ?? [];
    const images = (creativePackage as any)?.images ?? [];
    const video = (creativePackage as any)?.video ?? null;
    const videoUrl = video?.videoUrl ?? '';

    // Pre-launch: validate the audience IDs we actually use, one by one.
    // Previous approach (GET /customaudiences?limit=200) silently truncated
    // when accounts had >200 audiences — valid IDs beyond the cutoff got
    // flagged as "unavailable" and stripped, sabotaging good launches. Now we
    // ask Meta directly per ID: GET /{audienceId} returns 200 if usable, 404
    // (or 100/2604) if deleted/missing, and the response's delivery_status
    // surfaces "below-min-size" / "policy-suspended" / etc. Bounded to the few
    // IDs we actually care about (typically 2-6 per launch).
    const validAudienceIds = new Set<string>();
    const audienceIdsToCheck = new Set<string>();
    for (const adSet of (config.adSets ?? []) as any[]) {
      if (adSet.metaAudienceId) audienceIdsToCheck.add(adSet.metaAudienceId);
      for (const id of (adSet.excludeAudienceIds ?? [])) audienceIdsToCheck.add(id);
    }
    if (audienceIdsToCheck.size > 0) {
      try {
        const results = await Promise.allSettled(
          [...audienceIdsToCheck].map(async (id) => {
            const res = await axios.get(`https://graph.facebook.com/v21.0/${id}`, {
              params: {
                fields: 'id,delivery_status,operation_status,approximate_count_lower_bound',
                access_token: company.meta!.accessToken,
              },
              timeout: 10000,
            });
            const data = res.data ?? {};
            // delivery_status.code 200 = ready; 300 = warning; 400 = error/below-min-size.
            // operation_status.code 200 = no issues; 300 = audience being computed; 400 = error.
            const deliveryCode = data.delivery_status?.code;
            const operationCode = data.operation_status?.code;
            const isUsable =
              data.id === id
              && (deliveryCode === undefined || deliveryCode < 400)
              && (operationCode === undefined || operationCode < 400);
            if (!isUsable) {
              this.logger.warn(`Audience ${id} unusable: delivery_status=${JSON.stringify(data.delivery_status)} operation_status=${JSON.stringify(data.operation_status)}`);
            }
            return { id, isUsable };
          }),
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.isUsable) {
            validAudienceIds.add(r.value.id);
          } else if (r.status === 'rejected') {
            const errMsg = (r.reason as any)?.response?.data?.error?.message ?? (r.reason as any)?.message ?? 'unknown';
            this.logger.warn(`Audience validation failed for one ID: ${errMsg}`);
          }
        }
        this.logger.log(`Pre-launch audience check (per-ID): ${validAudienceIds.size}/${audienceIdsToCheck.size} usable`);
      } catch (err: any) {
        // Total failure (network etc.) — proceed without check rather than block launch.
        this.logger.warn(`Audience validation failed (proceeding without check): ${err.message}`);
      }
    }

    // For warm/hot briefs, expired-audience fallback must NOT degrade to
    // advantage_plus (that's cold prospecting). Try another live lookalike
    // from the product's metaAudiences first; if none exist, throw.
    const launchProduct = creativeBrief
      ? (company.products ?? []).find(p => p.name === ((creativeBrief as any).product ?? ''))
      : null;

    // ── optimization_goal normalization ──────────────────────────────────────
    // The Campaign Review LLM occasionally outputs invalid Meta enum values
    // (e.g. "CONVERSIONS" instead of "OFFSITE_CONVERSIONS") or overrides the
    // operator's explicit per-product choice. Two-layer normalization:
    //   1. If product.metaOptimizationGoal is set, operator wins — force-use it.
    //      Rationale: operator opted into VBB after pre-launch verification gate;
    //      LLM's "wait for 50 conversions before VBB" judgment is general-case
    //      advice that doesn't override a specific operator decision.
    //   2. Else: validate against Meta's valid-goal whitelist for OUTCOME_SALES
    //      campaigns. Invalid → default to OFFSITE_CONVERSIONS with warn.
    // Normalized value is persisted back to campaignConfig so audit/UI see truth.
    const VALID_OPTIMIZATION_GOALS = new Set([
      'OFFSITE_CONVERSIONS', 'VALUE', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS',
      'IMPRESSIONS', 'REACH', 'THRUPLAY', 'POST_ENGAGEMENT', 'PAGE_LIKES',
      'AD_RECALL_LIFT', 'LEAD_GENERATION', 'QUALITY_LEAD', 'QUALITY_CALL',
    ]);
    const productOptGoal = launchProduct?.metaOptimizationGoal;
    let optGoalNormalized = false;
    for (const adSet of config.adSets as any[]) {
      const llmValue = adSet.optimizationGoal;
      let resolved: string;
      if (productOptGoal) {
        resolved = productOptGoal;
        if (llmValue !== productOptGoal) {
          this.logger.warn(`Ad set "${adSet.name}": LLM output optimizationGoal="${llmValue}" overridden by product.metaOptimizationGoal="${productOptGoal}" (operator choice wins).`);
          optGoalNormalized = true;
        }
      } else if (llmValue && VALID_OPTIMIZATION_GOALS.has(llmValue)) {
        resolved = llmValue;
      } else {
        this.logger.warn(`Ad set "${adSet.name}": invalid optimizationGoal="${llmValue}" from LLM — defaulting to OFFSITE_CONVERSIONS.`);
        resolved = 'OFFSITE_CONVERSIONS';
        optGoalNormalized = true;
      }
      adSet.optimizationGoal = resolved;
    }
    if (optGoalNormalized) {
      // Persist normalized config so the audit / dashboard / re-launch path
      // all see the value Meta actually receives — not the LLM's broken output.
      await this.campaignModel.updateOne(
        { _id: campaignId },
        { $set: { 'campaignConfig.adSets': config.adSets } },
      );
    }
    const liveLookalikes = (launchProduct?.metaAudiences ?? [])
      .filter((a: any) => a.type === 'lookalike' && validAudienceIds.has(a.id));
    const briefStageForLaunch = (creativeBrief as any)?.audienceStage as 'cold' | 'warm' | 'hot' | undefined;

    if (validAudienceIds.size > 0) {
      for (const adSet of config.adSets as any[]) {
        if (adSet.metaAudienceId && !validAudienceIds.has(adSet.metaAudienceId)) {
          // Warm/hot stages require custom-audience retargeting. Lookalike is
          // cold-prospecting under the new taxonomy — falling back from an
          // expired retargeting audience to a lookalike would change funnel
          // stage entirely. Fail loudly instead so a human can swap the audience.
          if (briefStageForLaunch === 'warm' || briefStageForLaunch === 'hot') {
            throw new Error(
              `Ad set "${adSet.name}": custom audience ${adSet.metaAudienceId} expired and no replacement custom/retarget audience available for ${briefStageForLaunch} brief. Cannot fall back to lookalike (that's cold prospecting). Refresh the custom audience and re-run.`,
            );
          }
          this.logger.warn(`Ad set "${adSet.name}": audience ${adSet.metaAudienceId} expired — converting to advantage_plus`);
          delete adSet.metaAudienceId;
          adSet.audienceType = 'advantage_plus';
        }
        if (adSet.excludeAudienceIds?.length) {
          const before = adSet.excludeAudienceIds.length;
          adSet.excludeAudienceIds = adSet.excludeAudienceIds.filter((id: string) => validAudienceIds.has(id));
          const removed = before - adSet.excludeAudienceIds.length;
          if (removed > 0) {
            this.logger.warn(`Ad set "${adSet.name}": removed ${removed} expired exclude audience(s)`);
          }
        }
      }
    }

    // Consolidate: if multiple ad sets ended up as advantage_plus (same targeting),
    // merge them into one ad set with all unique variant indices and full budget
    const advantagePlusAdSets = (config.adSets as any[]).filter((as: any) => as.audienceType === 'advantage_plus');
    const otherAdSets = (config.adSets as any[]).filter((as: any) => as.audienceType !== 'advantage_plus');

    if (advantagePlusAdSets.length > 1 && !isLandingPageTest) {
      // Merge all advantage_plus ad sets into one
      const allVariants = [...new Set(advantagePlusAdSets.flatMap((as: any) => as.ads))].sort();
      const totalBudgetPercent = advantagePlusAdSets.reduce((s: number, as: any) => s + (as.budgetPercent ?? 0), 0);
      // Format precedence: mixed > both > video > image. 'mixed' (1 video + N image)
      // is preferred when any source ad set wanted that — keeps creative diversity in
      // the consolidated bucket without duplicating the single video across N variants.
      const mergedCreativeFormat = advantagePlusAdSets.some((as: any) => as.creativeFormat === 'mixed') ? 'mixed'
        : advantagePlusAdSets.some((as: any) => as.creativeFormat === 'both') ? 'both'
        : advantagePlusAdSets.some((as: any) => as.creativeFormat === 'video') ? 'video' : 'image';

      const merged = {
        ...advantagePlusAdSets[0],
        name: `ADVANTAGE_PLUS_${new Date().toISOString().split('T')[0]}`,
        ads: allVariants,
        budgetPercent: totalBudgetPercent,
        creativeFormat: mergedCreativeFormat,
        audienceType: 'advantage_plus',
      };
      delete merged.metaAudienceId;
      delete merged.excludeAudienceIds;

      config.adSets = [...otherAdSets, merged];
      this.logger.log(`Consolidated ${advantagePlusAdSets.length} advantage_plus ad sets into 1 (budget: ${totalBudgetPercent}%, variants: ${allVariants.join(',')})`);
    }

    // If only one ad set remains, give it 100% budget
    if (config.adSets.length === 1) {
      (config.adSets as any[])[0].budgetPercent = 100;
    }

    // ── 'mixed' → split into 2 sibling ad sets ─────────────────────────────────
    // Meta's intra-ad-set auction skews to lowest-CPM creative (~always video),
    // so 1 video + N image in one bucket → video wins 90%+ of impressions and
    // the image variants get no statistical signal. Split-format-by-ad-set is
    // Meta's recommended pattern for clean per-format attribution: one ad set
    // ships the video (selected variant only), a sibling ships all OTHER copy
    // variants as image ads. Each ad set has its own learning phase + bid logic.
    // Skip splitting when total daily budget is too low to fund 2 ad sets'
    // learning phases — degrade to image-only to keep all signal in one bucket.
    const SPLIT_MIN_DAILY = 6000;        // ₹6k/day total → ~₹2k video + ₹4k image, both above the per-ad-set learning floor
    const VIDEO_BUDGET_FRACTION = 0.30;  // video ad set takes 30% of original budgetPercent (1 ad vs 3 ads)
    const splitAdSets: any[] = [];
    const selectedCopyIndexForSplit = (creativePackage as any)?.selectedCopyIndex ?? 0;
    for (const adSet of config.adSets as any[]) {
      if (adSet.creativeFormat !== 'mixed') {
        splitAdSets.push(adSet);
        continue;
      }
      const dailyForAdSet = (campaign.budget * (adSet.budgetPercent ?? 0)) / 100;
      const otherVariants = (adSet.ads ?? []).filter((idx: number) => idx !== selectedCopyIndexForSplit);
      if (!videoUrl || dailyForAdSet < SPLIT_MIN_DAILY || otherVariants.length === 0) {
        // ALWAYS downgrade to image-only at this point. Was: kept creativeFormat='mixed'
        // when videoUrl existed even though we couldn't afford to split → the in-ad-set
        // mixed logic in meta-ads.service runs → packs 1 video + N image into ONE ad
        // set → Meta intra-bucket auction skews to the video → image variants get no
        // signal. The exact problem split was meant to fix. At sub-₹6k budgets we
        // keep the campaign single-ad-set AND ship image-only to avoid the skew.
        const reason = !videoUrl ? 'no video'
                     : dailyForAdSet < SPLIT_MIN_DAILY ? `daily ₹${Math.round(dailyForAdSet)} below ₹${SPLIT_MIN_DAILY} split floor (per-sibling would be <₹3k learning floor)`
                     : 'no other variants';
        this.logger.log(
          `Ad set "${adSet.name}": mixed → image-only (${reason})`,
        );
        splitAdSets.push({ ...adSet, creativeFormat: 'image' });
        continue;
      }
      const videoPct = Math.round((adSet.budgetPercent ?? 0) * VIDEO_BUDGET_FRACTION);
      const imagePct = (adSet.budgetPercent ?? 0) - videoPct;
      splitAdSets.push({
        ...adSet,
        name: `${adSet.name}_VIDEO`,
        creativeFormat: 'video',
        ads: [selectedCopyIndexForSplit],
        budgetPercent: videoPct,
      });
      splitAdSets.push({
        ...adSet,
        name: `${adSet.name}_IMAGE`,
        creativeFormat: 'image',
        ads: otherVariants,
        budgetPercent: imagePct,
      });
      this.logger.log(
        `Ad set "${adSet.name}": split mixed → ${adSet.name}_VIDEO (${videoPct}%, [${selectedCopyIndexForSplit}]) + ${adSet.name}_IMAGE (${imagePct}%, [${otherVariants.join(',')}])`,
      );
    }
    config.adSets = splitAdSets;

    // ── Auto-exclude past purchasers from prospecting ad sets ──────────────────
    // Without this, prospecting (advantage_plus / lookalike / broad / interest)
    // budget burns retargeting people who already bought the product. Industry
    // baseline: 5-15% of prospecting spend leaks into past buyers without an
    // explicit exclusion. The Campaign Review Team prompt asks the LLM to set
    // this, but relying on the LLM is unreliable — enforce in TS so it can't be
    // forgotten. Skip for retargeting/custom ad sets which DO want to reach
    // existing audiences.
    const purchasersAudId = (company.products ?? [])
      .flatMap((p: any) => p.metaAudiences ?? [])
      .find((a: any) => /Purchasers?_/i.test(a?.name ?? ''))?.id;
    if (purchasersAudId) {
      const PROSPECTING_TYPES = new Set(['advantage_plus', 'lookalike', 'broad', 'interest']);
      let injected = 0;
      for (const adSet of config.adSets as any[]) {
        if (!PROSPECTING_TYPES.has(adSet.audienceType)) continue;
        const existing = new Set(adSet.excludeAudienceIds ?? []);
        if (!existing.has(purchasersAudId)) {
          existing.add(purchasersAudId);
          adSet.excludeAudienceIds = Array.from(existing);
          injected++;
        }
      }
      if (injected > 0) {
        this.logger.log(`Auto-excluded purchasers audience ${purchasersAudId} from ${injected} prospecting ad set(s)`);
      }
    } else {
      this.logger.warn(`No Purchasers audience found in product.metaAudiences — prospecting ad sets will reach past buyers (5-15% wasted spend baseline)`);
    }

    // Enforce per-format variant rules:
    //   video  → MUST be only the selected variant (video was generated for that one only)
    //   image  → MUST include EVERY variant that has an image available
    //   mixed  → handled upstream by the split logic; pass through here
    //
    // The Campaign Review Team prompt instructs the LLM to set ads=[0,1,2,3] for
    // image ad sets, but it has historically narrowed to a single variant
    // (e.g. May 2026 KAAL_SARPA campaign launched with ads=[1] only → 1 ad on
    // Meta instead of 4, wasted 75% of generated creative). Enforce in TS so
    // LLM drift can't kill variant diversity.
    const selectedCopyIndex = (creativePackage as any)?.selectedCopyIndex ?? 0;
    const availableImageVariants: number[] = ((creativePackage as any)?.images ?? [])
      .map((img: any) => img?.variantIndex)
      .filter((idx: any) => typeof idx === 'number' && idx >= 0)
      .sort((a: number, b: number) => a - b);
    const allImageVariants = availableImageVariants.length > 0
      ? availableImageVariants
      : (copyVariants ?? []).map((_: any, i: number) => i);

    for (const adSet of config.adSets as any[]) {
      if (adSet.creativeFormat === 'video' && videoUrl) {
        if (adSet.ads.length > 1 || !adSet.ads.includes(selectedCopyIndex)) {
          this.logger.warn(`Ad set "${adSet.name}": video format restricted to variant ${selectedCopyIndex} (was: [${adSet.ads}])`);
          adSet.ads = [selectedCopyIndex];
        }
      } else if (adSet.creativeFormat === 'image' && allImageVariants.length > 0) {
        const proposed = (adSet.ads ?? []).filter((v: number) => allImageVariants.includes(v));
        // LLM narrowed below available — expand back to all available image variants.
        if (proposed.length < allImageVariants.length) {
          this.logger.warn(
            `Ad set "${adSet.name}": image format had ads=[${adSet.ads}] — expanding to all available image variants [${allImageVariants.join(',')}] (${allImageVariants.length - proposed.length} variant(s) would otherwise be dropped)`,
          );
          adSet.ads = [...allImageVariants];
        }
      }
    }

    // ── Field-name normalization (LLM-vs-schema drift) ────────────────────────
    // The Campaign Review Team has historically emitted `excludedAudiences`
    // instead of the schema's `excludeAudienceIds`, causing silent drop of
    // past-purchaser exclusions at launch. Normalize both → schema name.
    for (const adSet of config.adSets as any[]) {
      if (adSet.excludedAudiences && !adSet.excludeAudienceIds) {
        adSet.excludeAudienceIds = adSet.excludedAudiences;
      }
    }

    // ── Bid-cap injection for cold prospecting ────────────────────────────────
    // Broad cold audiences (advantage_plus, lookalike, interest) on
    // LOWEST_COST_WITHOUT_CAP get delivered to the cheapest placements →
    // ₹6 CPC junk traffic with sub-0.1% CVR (May 2026 agent campaign).
    // Anchor to the product's historical CPA so Meta uses bid_strategy=COST_CAP
    // and stops chasing junk clicks. Custom/retarget audiences keep
    // LOWEST_COST_WITHOUT_CAP (the audience itself is the quality gate).
    const briefProductForBid = (creativeBrief as any)?.product;
    const productForBid = (company.products ?? []).find((p: any) => p.name === briefProductForBid)
      ?? (company.products ?? []).find((p: any) => p.active)
      ?? (company.products ?? [])[0];
    const histCPA = productForBid?.performance?.avgCPA;
    if (typeof histCPA === 'number' && histCPA > 0) {
      const COLD_PROSPECTING_TYPES = new Set(['advantage_plus', 'lookalike', 'broad', 'interest']);
      let bidCapped = 0;
      for (const adSet of config.adSets as any[]) {
        if (!COLD_PROSPECTING_TYPES.has(adSet.audienceType)) continue;
        if (typeof adSet.bidAmountInr === 'number' && adSet.bidAmountInr > 0) continue;
        adSet.bidAmountInr = Math.round(histCPA);
        bidCapped++;
      }
      if (bidCapped > 0) {
        this.logger.log(`Applied COST_CAP bid_amount=₹${Math.round(histCPA)} (= product avgCPA) to ${bidCapped} cold prospecting ad set(s)`);
      }
    }

    // ── Deterministic targeting resolver ──────────────────────────────────────
    // Fills age/gender/interests/geoStates on ad sets that the Campaign Review
    // Team didn't populate. Reads brief.targetSegment + product.audienceSegments
    // and India-default top states. This is the fix for "agent ships
    // country=IN, no age, no gender, no interests, no states" → high CPA waste.
    // Doesn't override ad sets that already have explicit targeting.
    //
    // Null-brief guard: if creativeBrief is null (manual campaigns, missing
    // briefId, or upstream brief deletion), skip the resolver entirely. Was:
    // ran with undefined targetSegment + undefined product → still patched
    // geoStates from India defaults but no segment match → silent partial
    // mis-targeting. Now: explicit warning + skip → operator must manually
    // set targeting OR the LLM-emitted ad-set fields stand as-is.
    if (!creativeBrief) {
      this.logger.warn(
        `Targeting resolver SKIPPED for campaign ${campaignId}: no creativeBrief found (briefId=${campaign.briefId || 'empty'}). Ad sets ship with whatever targeting the Campaign Review Team produced. No automatic age/gender/interests/states injection.`,
      );
    } else {
      const briefForTargeting = creativeBrief as any;
      let productForTargeting = (company.products ?? []).find(
        (p) => p.name === briefForTargeting?.product,
      );
      // Product-name guard: a brief naming a product that doesn't exist used
      // to silently degrade to all-defaults targeting (whole-country geo,
      // 18-65, all genders, no interests) — exactly the "random targeting"
      // failure mode. Retry case-insensitively (idea-pool normalizes casing,
      // but manual /produce paths and product renames don't), then fail loud.
      if (!productForTargeting && briefForTargeting?.product) {
        productForTargeting = (company.products ?? []).find(
          (p) => p.name?.toLowerCase() === String(briefForTargeting.product).toLowerCase(),
        );
        if (productForTargeting) {
          this.logger.warn(`Targeting product casing mismatch: brief says "${briefForTargeting.product}", resolved to "${productForTargeting.name}"`);
        } else {
          throw new Error(
            `Brief product "${briefForTargeting.product}" not found in company.products ` +
            `(have: ${(company.products ?? []).map(p => p.name).join(', ')}). ` +
            `Refusing to launch with default broad targeting — fix the brief's product name or add the product first.`,
          );
        }
      }
      const targetingResult = applyAudienceTargeting({
        adSets: config.adSets as any[],
        productSegments: productForTargeting?.audienceSegments as any,
        briefTargetSegment: briefForTargeting?.targetSegment,
        briefAudienceStage: briefForTargeting?.audienceStage,
        geography: company.geography,
        productLanguages: productForTargeting?.languages,
      });
      this.logger.log(
        `Targeting resolver: segment=${targetingResult.segmentUsed ?? 'none'}, patches=${targetingResult.patches}, matched=${targetingResult.segmentMatched}, locales=[${targetingResult.localesApplied.join(',')}]`,
      );

      // Live-resolve languages without a verified Meta locale ID. Only Marathi
      // was ever manually verified — Hindi/Tamil/etc. silently shipped with NO
      // locale targeting. Now /search?type=adlocale resolves them at launch
      // time and the resolver-eligible ad sets get the verified IDs.
      if (targetingResult.unresolvedLanguages.length > 0) {
        const liveIds: number[] = [];
        for (const lang of targetingResult.unresolvedLanguages) {
          const id = await this.metaAdsService.lookupLocaleId(lang, company.meta.accessToken);
          if (id !== null) liveIds.push(id);
        }
        if (liveIds.length > 0) {
          for (const idx of targetingResult.localeTargetIndices) {
            const adSet = (config.adSets as any[])[idx];
            adSet.locales = [...new Set([...(adSet.locales ?? []), ...liveIds])];
          }
          this.logger.log(`Live locale resolution: [${targetingResult.unresolvedLanguages.join(', ')}] → [${liveIds.join(', ')}] applied to ${targetingResult.localeTargetIndices.length} ad set(s)`);
        }
      }
    }

    // ── Targeting sanity layer ────────────────────────────────────────────────
    // Validates the COMBINED result (LLM output + resolver patches) before any
    // Meta write. Age clamping and geo-language coherence are deterministic;
    // interest IDs are checked against Meta's live catalog.
    const ageCorrections = clampAgeRanges(config.adSets as any[]);
    for (const c of ageCorrections) this.logger.warn(`Age range corrected: ${c}`);

    const geoCorrections = enforceGeoLanguageCoherence(
      config.adSets as any[],
      (creativeBrief as any)?.targetLanguage,
    );
    for (const c of geoCorrections) this.logger.warn(`Geo-language coherence: ${c}`);

    const overlapWarnings = checkAdSetOverlap(config.adSets as any[]);
    for (const w of overlapWarnings) this.logger.warn(`Ad set overlap: ${w}`);

    // Interest IDs: validate the union across ad sets in ONE Meta call, then
    // strip invalid ones per ad set. Partial success beats mid-launch failure —
    // an ad set keeps its valid interests instead of dying on one bad ID.
    const allInterestIds = [...new Set((config.adSets as any[]).flatMap(as => as.interests ?? []).map(String))];
    if (allInterestIds.length > 0) {
      const { invalid } = await this.metaAdsService.validateInterestIds(allInterestIds, company.meta.accessToken);
      if (invalid.length > 0) {
        const invalidSet = new Set(invalid);
        for (const adSet of config.adSets as any[]) {
          if (!Array.isArray(adSet.interests) || adSet.interests.length === 0) continue;
          const before = adSet.interests.length;
          adSet.interests = adSet.interests.filter((id: any) => !invalidSet.has(String(id)));
          if (adSet.interests.length < before) {
            this.logger.warn(
              `Ad set "${adSet.name}": dropped ${before - adSet.interests.length} invalid Meta interest ID(s) [${invalid.join(', ')}] — remaining ${adSet.interests.length}. Interest-type ad sets with ZERO remaining interests become broad targeting.`,
            );
          }
        }
      }
    }

    // Validate ad sets before touching Meta API
    for (const [i, adSet] of (config.adSets as any[]).entries()) {
      if (!adSet.ads || adSet.ads.length === 0) {
        throw new Error(`Ad set ${i} (${adSet.name}) has no ads configured`);
      }
      for (const variantIdx of adSet.ads) {
        if (!copyVariants[variantIdx]) {
          throw new Error(`Ad set ${i} references copy variant ${variantIdx} which does not exist (only ${copyVariants.length} variants available)`);
        }
      }
      if ((adSet.creativeFormat === 'video' || adSet.creativeFormat === 'both') && !videoUrl) {
        const hasAnyImage = images.some((img: any) => img.imageUrl);
        this.logger.warn(`Ad set ${i} (${adSet.name}) requires video but videoUrl is empty — falling back to image`);
        adSet.creativeFormat = hasAnyImage ? 'image' : undefined;
      }
      // 'mixed' degrades gracefully: no video → all variants ship as image (still 4-way A/B)
      if (adSet.creativeFormat === 'mixed' && !videoUrl) {
        this.logger.warn(`Ad set ${i} (${adSet.name}) is 'mixed' but videoUrl is empty — degrading to 'image' (all variants ship as image ads)`);
        adSet.creativeFormat = 'image';
      }
      if ((adSet.creativeFormat === 'image' || adSet.creativeFormat === 'mixed' || !adSet.creativeFormat)) {
        const variantImages = adSet.ads.map((idx: number) => images.find((img: any) => img.variantIndex === idx));
        const missingImages = variantImages.filter((img: any) => !img?.imageUrl);
        if (missingImages.length === adSet.ads.length) {
          throw new Error(`Ad set ${i} (${adSet.name}) requires images but none are available for variants ${adSet.ads.join(', ')}`);
        }
      }
    }

    // Find the product for landing URL — match by brief.product name first, fallback to conversionEvent
    // creativeBrief was loaded earlier (top of launch) for the audience-expiry guard.
    const briefProduct = creativeBrief ? ((creativeBrief as any).product ?? '') : '';
    const product = (company.products ?? []).find(p =>
      briefProduct ? p.name === briefProduct : p.conversionEvent === config.conversionEvent,
    ) ?? (company.products ?? [])[0];
    const landingUrl = product?.landingUrl ?? '';

    const topicSlug = ((campaign as any).topic ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 30);
    const campaignName = `AGENT_${topicSlug || 'CAMPAIGN'}_${new Date().toISOString().split('T')[0]}`;

    // Upload one image per variant to Meta
    const imageHashes: Record<number, string> = {};
    for (const img of images) {
      if (img.imageUrl) {
        try {
          const hash = await this.metaAdsService.uploadImage(img.imageUrl, accountId, company.meta.accessToken);
          imageHashes[img.variantIndex] = hash;
          this.logger.log(`Image uploaded for variant ${img.variantIndex}: hash=${hash}`);
        } catch (err: any) {
          this.logger.warn(`Image upload failed for variant ${img.variantIndex}: ${err.message}`);
        }
      }
    }
    this.logger.log(`imageHashes: ${JSON.stringify(Object.keys(imageHashes).map(k => `v${k}=${imageHashes[Number(k)].slice(0, 8)}...`))}`);

    // Carousel path — if any ad set is creativeFormat=carousel, upload each
    // card image and build the carouselCards payload Meta needs at ad-creation
    // time. Cards live on the creativePackage.carouselCards array (populated
    // by the Creative Team when brief.format === 'carousel').
    const carouselCardsFromPackage = ((creativePackage as any)?.carouselCards ?? []) as Array<any>;
    const needsCarousel = (config.adSets as any[]).some((as: any) => as.creativeFormat === 'carousel');
    let resolvedCarouselCards: any[] = [];
    if (needsCarousel) {
      if (carouselCardsFromPackage.length < 2) {
        // Carousel was requested but package didn't produce cards — degrade
        // to image format using the existing variants. Fail loud in logs so the
        // operator sees the missing creative orchestration.
        this.logger.warn(`Carousel format requested but creativePackage.carouselCards has ${carouselCardsFromPackage.length} cards (need ≥2). Degrading all carousel ad sets to image-format.`);
        for (const adSet of config.adSets as any[]) {
          if (adSet.creativeFormat === 'carousel') adSet.creativeFormat = 'image';
        }
      } else {
        resolvedCarouselCards = [];
        for (const card of carouselCardsFromPackage) {
          if (!card.imageUrl) continue;
          try {
            const hash = await this.metaAdsService.uploadImage(card.imageUrl, accountId, company.meta.accessToken);
            resolvedCarouselCards.push({
              imageHash: hash,
              headline: card.headline,
              description: card.description,
              cardLink: card.cardLink,
            });
            this.logger.log(`Carousel card ${card.slotIndex} image uploaded: hash=${hash}`);
          } catch (err: any) {
            this.logger.warn(`Carousel card ${card.slotIndex} image upload failed: ${err.message}`);
          }
        }
        if (resolvedCarouselCards.length < 2) {
          this.logger.warn(`Only ${resolvedCarouselCards.length}/${carouselCardsFromPackage.length} carousel cards uploaded successfully. Need ≥2 — degrading carousel ad sets to image.`);
          for (const adSet of config.adSets as any[]) {
            if (adSet.creativeFormat === 'carousel') adSet.creativeFormat = 'image';
          }
          resolvedCarouselCards = [];
        }
      }
    }

    // Upload video to Meta if available and any ad set needs it
    const needsVideo = (config.adSets ?? []).some(
      (as: any) => as.creativeFormat === 'video' || as.creativeFormat === 'both',
    );
    let videoId: string | undefined;
    let videoThumbnailHash: string | undefined;
    if (needsVideo && videoUrl) {
      try {
        videoId = await this.metaAdsService.uploadVideo(
          videoUrl, accountId, company.meta.accessToken,
        );
        this.logger.log(`Video uploaded to Meta: videoId=${videoId}`);
        // Get thumbnail from video — required for video ad creatives
        videoThumbnailHash = await this.metaAdsService.getVideoThumbnailHash(
          videoId, accountId, company.meta.accessToken,
        );
        this.logger.log(`Video thumbnail hash: ${videoThumbnailHash ?? 'NONE — will use imageHash'}`);
      } catch (err: any) {
        this.logger.warn(`Video upload failed (proceeding without video): ${err.message}`);
      }
    }

    // Launch: campaign → ad sets → ads via Meta Graph API.
    // Wrapped in try/catch so failures reset status from 'launching' back to
    // 'pending_approval', allowing retry. Without this, an exception during
    // Meta API calls leaves the campaign stuck in 'launching' forever and
    // the atomic claim above blocks all future /approve attempts.
    let launchResult;
    try {
      launchResult = await this.metaAdsService.launchCampaign({
        accountId: accountId,
        accessToken: company.meta.accessToken,
        pageId: company.meta.pageId,
        pixelId: product?.pixelId ?? company.meta.pixelId,
        campaignName,
        budget: campaign.budget,
        objective: config.objective ?? 'OUTCOME_SALES',
        conversionEvent: config.conversionEvent ?? 'Purchase',
        customEventName: product?.customEventName,
        customConversionId: product?.customConversionId,
        adSets: config.adSets,
        copyVariants: copyVariants.length > 0 ? copyVariants : [
          { primaryText: 'Check out our latest offer', headline: 'Learn More', cta: 'Learn More' },
        ],
        imageHashes,
        videoThumbnailHash,
        videoId,
        selectedCopyIndex,
        landingUrl,
        declaredSpecialAdCategories: company.meta?.specialAdCategories ?? [],
        carouselCards: resolvedCarouselCards.length >= 2 ? resolvedCarouselCards : undefined,
      });
    } catch (err: any) {
      // Reset claim so /approve can be retried
      await this.campaignModel.updateOne(
        { _id: campaignId, status: 'launching' },
        { $set: { status: 'pending_approval' } },
      );
      this.logger.error(`Meta launch failed for campaign ${campaignId}, claim released for retry: ${err.message}`);
      throw err;
    }

    // Only activate if all expected ads were created
    const totalAdsCreated = launchResult.adSets.reduce((s, a) => s + a.ads.length, 0);
    const expectedAds = config.adSets.reduce((s: number, a: any) => s + (a.ads?.length ?? 0), 0);
    const fullyLaunched = totalAdsCreated >= expectedAds && totalAdsCreated > 0;

    if (fullyLaunched) {
      await this.metaAdsService.activateCampaign(
        launchResult.campaignId, company.meta.accessToken, launchResult,
      );
      this.logger.log(`Campaign activated: ${totalAdsCreated}/${expectedAds} ads created`);
    } else {
      this.logger.warn(
        `Campaign NOT activated: only ${totalAdsCreated}/${expectedAds} ads created — saved as draft`,
      );
    }

    // Save all Meta IDs to MongoDB
    await this.campaignModel.updateOne(
      { _id: campaignId },
      {
        status: fullyLaunched ? 'active' : 'paused',
        metaCampaignId: launchResult.campaignId,
        metaAccountId: accountId,
        launchedAt: new Date(),
        approvedAt: new Date(),
        adSets: launchResult.adSets.map(as => ({
          metaAdSetId: as.adSetId,
          name: as.name,
          budgetPercent: config.adSets.find((c: any) => c.name === as.name)?.budgetPercent ?? 0,
          audienceType: config.adSets.find((c: any) => c.name === as.name)?.audienceType ?? '',
          // Record which destination URL this ad set served — empty for normal
          // campaigns (all ad sets share product.landingUrl), set for the
          // landing-page A/B test so the audit loop can attribute per-URL.
          landingUrl: config.adSets.find((c: any) => c.name === as.name)?.landingUrlOverride ?? '',
          status: 'active',
          ads: as.ads.map(ad => ({
            metaAdId: ad.adId,
            copyVariantIndex: ad.copyVariantIndex,
            hookStyle: copyVariants[ad.copyVariantIndex]?.hookStyle ?? '',
            format: ad.format,    // 'video' | 'image' — required to attribute mixed-format performance
            status: 'active',
          })),
        })),
      },
    );

    await this.actionLogger.log({
      tenantId: company.tenantId,
      runId: campaign.runId,
      agent: AgentType.CAMPAIGN_CREATOR,
      action: 'campaign_launched',
      reason: `Human approved → launched on Meta with budget ₹${campaign.budget}`,
      outcome: `Meta campaign ID: ${launchResult.campaignId} | adSets: ${launchResult.adSets.length} | ads: ${launchResult.adSets.reduce((s, a) => s + a.ads.length, 0)}`,
      metadata: { campaignId, briefId: campaign.briefId },
    });

    this.logger.log(
      `Campaign LAUNCHED: tenantId=${company.tenantId} metaCampaignId=${launchResult.campaignId} budget=₹${campaign.budget} adSets=${launchResult.adSets.length}`,
    );

    return (await this.campaignModel.findOne({ _id: campaignId, tenantId: company.tenantId }).lean().exec()) as any;
  }

  /**
   * Auto-create pixel-based audiences if they don't exist on Meta.
   * Creates: purchasers (180d), website visitors (30d), lookalike 1%.
   * Stores IDs in product.metaAudiences.
   */
  private async ensurePixelAudiences(company: CompanyDocument): Promise<void> {
    const accessToken = company.meta?.accessToken;
    const pixelId = company.meta?.pixelId;
    if (!accessToken || !pixelId) return;

    const product = (company.products ?? []).find((p: any) => p.active);
    if (!product) return;

    const normalizeId = (id: string) => id.startsWith('act_') ? id : `act_${id}`;
    const accountId = normalizeId(
      (company.meta!.accountIds?.length ?? 0) > 0
        ? company.meta!.accountIds![0]
        : company.meta!.accountId!,
    );

    // Fetch existing audiences from Meta
    let existingAudiences: { id: string; name: string; subtype: string }[] = [];
    try {
      const res = await axios.get(`https://graph.facebook.com/v21.0/${accountId}/customaudiences`, {
        params: { fields: 'id,name,subtype', limit: '200', access_token: accessToken },
        timeout: 15000,
      });
      existingAudiences = res.data?.data ?? [];
    } catch {
      return; // Can't check — skip
    }

    const existsByName = (name: string) => existingAudiences.some(a => a.name === name);
    const conversionEvent = product.conversionEvent ?? 'Purchase';
    const brandPrefix = company.name?.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20) ?? 'brand';
    const newAudiences: { id: string; name: string; type: 'custom' | 'lookalike'; lookalikePercent?: number }[] = [];

    // 1. Purchasers (180 days)
    const purchasersName = `${brandPrefix}_Purchasers_180d`;
    let purchasersId = existingAudiences.find(a => a.name === purchasersName)?.id;
    if (!purchasersId && !existsByName(purchasersName)) {
      try {
        purchasersId = await this.metaAdsService.createPixelAudience(
          accountId, accessToken, purchasersName, pixelId,
          { event: conversionEvent, retentionDays: 180 },
        );
        newAudiences.push({ id: purchasersId, name: purchasersName, type: 'custom' });
      } catch (err: any) {
        this.logger.warn(`Failed to create purchasers audience: ${err.message}`);
      }
    }

    // 2. Website visitors (30 days)
    const visitorsName = `${brandPrefix}_Visitors_30d`;
    if (!existsByName(visitorsName)) {
      try {
        const visitorsId = await this.metaAdsService.createPixelAudience(
          accountId, accessToken, visitorsName, pixelId,
          { event: 'PageView', retentionDays: 30 },
        );
        newAudiences.push({ id: visitorsId, name: visitorsName, type: 'custom' });
      } catch (err: any) {
        this.logger.warn(`Failed to create visitors audience: ${err.message}`);
      }
    }

    // 3. Lookalike 1% from purchasers
    const lookalikeSource = purchasersId ?? existingAudiences.find(a => a.name === purchasersName)?.id;
    const lookalikeName = `${brandPrefix}_Lookalike_1pct`;
    if (lookalikeSource && !existsByName(lookalikeName)) {
      try {
        const lookalikeId = await this.metaAdsService.createLookalikeAudience(
          accountId, accessToken, lookalikeName, lookalikeSource, 'IN', 0.01,
        );
        newAudiences.push({ id: lookalikeId, name: lookalikeName, type: 'lookalike', lookalikePercent: 1 });
      } catch (err: any) {
        this.logger.warn(`Failed to create lookalike audience: ${err.message}`);
      }
    }

    // Update product.metaAudiences with new audiences (merge, don't replace)
    if (newAudiences.length > 0) {
      const existing = product.metaAudiences ?? [];
      const merged = [...existing];
      for (const newAud of newAudiences) {
        if (!merged.some(a => a.id === newAud.id)) {
          merged.push(newAud);
        }
      }
      await this.companiesService.updateProductAudiences(company.tenantId, product.name, merged);
      this.logger.log(`Auto-created ${newAudiences.length} audience(s): ${newAudiences.map(a => a.name).join(', ')}`);
    } else {
      this.logger.log('All pixel audiences already exist on Meta');
    }
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

    const adSetSummary = review?.campaign?.adSets?.map(
      a => `  • ${a.name} (${a.budgetPercent}% — ${a.audienceType})`
    ).join('\n') ?? '';

    const reviewBlock = review
      ? `
*Campaign Review Team (${review.debateRounds} rounds):*
${review.debateRationale}

*Ad Sets:*
${adSetSummary || '  No ad sets configured'}
*Scale Rules:* ${review.campaign?.scaleRules ?? 'not set'}
*Pause Rules:* ${review.campaign?.pauseRules ?? 'not set'}`
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

  /**
   * Build a deterministic, conservative campaign config when the Review Team
   * fails to produce parseable output (after retry-with-feedback already
   * burned). Goal: preserve the brief's angle and let the operator approve
   * a safe-default config rather than discarding the work entirely.
   *
   * Conservatism choices:
   *  - One advantage_plus ad set (no audience splitting — Meta optimizes)
   *  - Daily budget = min(brief.suggestedBudget, weeklyCap/7, maxBudget × 0.4)
   *  - All available variants assigned (Meta picks the winner)
   *  - Pause rules anchored to product price (CPA > price → pause)
   *  - Scale rules anchored to scaleIfROASAbove
   *
   * The campaign is marked pending_approval with reviewNotes:'used_deterministic_fallback'
   * so the operator sees clearly that no LLM review happened on this one.
   */
  private buildFallbackReview(
    brief: CreativeBriefDocument,
    company: CompanyDocument,
  ): CampaignReviewOutput {
    const product = (company.products ?? []).find(p => p.name === brief.product)
      ?? (company.products ?? []).find(p => p.active);
    const weeklyCap = company.weeklyBudgetCap ?? 50000;
    const maxBudget = company.maxBudgetPerCampaign ?? 20000;
    const proposed = brief.suggestedBudget > 0 ? brief.suggestedBudget : Math.round(weeklyCap * 0.2);
    const fallbackBudget = Math.max(
      500,
      Math.min(proposed, Math.floor(weeklyCap / 7), Math.floor(maxBudget * 0.4)),
    );
    const breakevenCPA = product?.price ?? 1799;
    const pauseROAS = company.pauseIfROASBelow ?? 0.8;
    const pauseCTR = company.pauseIfCTRBelow ?? 0.5;
    const scaleROAS = company.scaleIfROASAbove ?? 1.5;
    const conversionEvent = product?.conversionEvent ?? 'Purchase';
    // Falsy-zero-safe: a conversionValue of 0 falls back to price, otherwise the
    // launched campaign bakes conversionValue=0 into its config and the auditor
    // goes blind (data_gap) on it forever — the Nadi Leaf failure mode.
    const conversionValue = getGrossConversionValue(product);
    const optimizationGoal = product?.metaOptimizationGoal ?? 'OFFSITE_CONVERSIONS';
    // Honor brief.format=carousel in the deterministic fallback too — if Strategy
    // Team picked carousel and creative production succeeded, downgrading to
    // image in fallback would waste the multi-card creative work.
    const briefRequestedCarousel = (brief as any).format === 'carousel';
    const fallbackCreativeFormat = briefRequestedCarousel ? 'carousel' as const : 'mixed' as const;

    // Funnel-stage-aware fallback: warm/hot briefs need a custom/retarget
    // audience — advantage_plus would be rejected by the downstream
    // audienceStage guard. If a custom audience is available on the product,
    // use it; otherwise the audienceStage guard correctly throws later.
    const briefStage = (brief as any).audienceStage as 'cold' | 'warm' | 'hot' | undefined;
    const isWarmOrHot = briefStage === 'warm' || briefStage === 'hot';

    // Derived per-ad-set floor — matches the math in Review Team prompts so
    // both LLM-success and fallback paths converge on the same structure.
    const productCpaForFloor = product?.performance?.avgCPA
      ?? (product?.price ? Math.round(product.price * 0.3) : 2000);
    const derivedFloor = Math.max(1000, Math.round((50 / 7) * productCpaForFloor * 1.5 / 100) * 100);

    // Confidence detection: hypothesis-stage products (zero own data) should
    // ship measurement campaigns, not single-set safety bets. This is the
    // structural decision the LLM keeps getting wrong on first-time products —
    // making the fallback do the right thing means even an LLM crash produces
    // a useful campaign.
    const productConfidence = product?.performance?.confidenceLevel ?? 'none';
    const isHypothesisStage = !product?.performance?.totalConversions
      || productConfidence === 'hypothesis'
      || productConfidence === 'none'
      || productConfidence === 'low';

    // Pool eligible audience-A/B partners. We want a 1% lookalike of an
    // existing buyer audience from same tenant (cross-product lookalike is
    // explicitly the hypothesis we want to test — does buyer profile transfer).
    // Match by name pattern (Lookalike 1% on a buyer/customer source).
    const buyerLookalike1Pct = (product?.metaAudiences ?? []).find(
      (a: any) => a.type === 'lookalike'
        && (a.lookalikePercent === 1 || /lookalike\s*1\s*%|lal[_\s-]*1\s*%|1\s*%[^0-9]/i.test(a.name))
        && /buyer|customer|purchase/i.test(a.name),
    );
    const pastPurchaserExcludes = (product?.metaAudiences ?? [])
      .filter((a: any) => a.type === 'custom' && /buyer|customer|purchase/i.test(a.name))
      .map((a: any) => a.id);

    // Can we afford a measurement A/B? Need budget ≥ 2× derived floor for both
    // ad sets to clear the learning threshold.
    const canAffordMeasurementAB = fallbackBudget >= derivedFloor * 2;
    const shouldSplitMeasurement = !isWarmOrHot
      && isHypothesisStage
      && canAffordMeasurementAB
      && !!buyerLookalike1Pct;

    const customAudience = isWarmOrHot
      ? (product?.metaAudiences ?? []).find(a => a.type === 'custom')
      : undefined;
    const geoLocations = [company.geography === 'India' ? 'IN' : (company.geography ?? 'IN').slice(0, 2).toUpperCase()];

    let fallbackAdSets: any[];
    let fallbackDebateSummary: string;
    let fallbackRationale: string;

    if (isWarmOrHot && customAudience) {
      // Warm/hot: single custom-audience retargeting set (unchanged from before).
      fallbackAdSets = [{
        name: `META_CONVERSIONS_${customAudience.name.toUpperCase().slice(0, 20)}_FALLBACK_${new Date().toISOString().split('T')[0]}`,
        budgetPercent: 100,
        audienceType: 'custom' as const,
        metaAudienceId: customAudience.id,
        geoLocations,
        optimizationGoal,
        ads: [0, 1, 2, 3],
        creativeFormat: fallbackCreativeFormat,
        excludedAudienceIds: [],
      }];
      fallbackDebateSummary = 'Review Team unparseable — fallback: 1 custom-audience retargeting set (warm/hot stage).';
      fallbackRationale = `DETERMINISTIC FALLBACK (warm/hot): ₹${fallbackBudget}/day, 1 custom-audience ad set (${customAudience.name}), all variants, optimizationGoal=${optimizationGoal}.`;
    } else if (shouldSplitMeasurement) {
      // Hypothesis-stage cold campaign with available buyer lookalike: ship the
      // 2-ad-set measurement A/B. This is the structural decision the LLM keeps
      // getting wrong — make the fallback do it right.
      const dateTag = new Date().toISOString().split('T')[0];
      fallbackAdSets = [
        {
          name: `META_CONVERSIONS_ADV-PLUS_BROAD_FALLBACK_${dateTag}`,
          budgetPercent: 50,
          audienceType: 'advantage_plus' as const,
          geoLocations,
          optimizationGoal,
          ads: [0, 1, 2, 3],
          creativeFormat: fallbackCreativeFormat,
          excludedAudienceIds: pastPurchaserExcludes,
        },
        {
          name: `META_CONVERSIONS_LAL-1PCT-BUYERS_FALLBACK_${dateTag}`,
          budgetPercent: 50,
          audienceType: 'lookalike' as const,
          metaAudienceId: buyerLookalike1Pct.id,
          geoLocations,
          optimizationGoal,
          ads: [0, 1, 2, 3],
          creativeFormat: fallbackCreativeFormat,
          excludedAudienceIds: pastPurchaserExcludes,
        },
      ];
      fallbackDebateSummary = `Review Team unparseable — fallback: 2-ad-set measurement A/B (advantage_plus + 1% lookalike of buyers, 50/50 at ₹${fallbackBudget}/day, exclude past purchasers). Hypothesis-stage product; audience-fit is the primary unknown.`;
      fallbackRationale = `DETERMINISTIC FALLBACK (measurement-run): hypothesis-stage product (confidence=${productConfidence}). Built 2-ad-set audience-A/B at ₹${fallbackBudget}/day: advantage_plus broad (50%, ₹${Math.round(fallbackBudget * 0.5)}/day) + 1% lookalike of ${buyerLookalike1Pct.name} (50%, ₹${Math.round(fallbackBudget * 0.5)}/day). Both clear derived floor ₹${derivedFloor}/day. Same creative variants in both — isolates audience as the variable. Excludes past purchasers from both. Tests whether the existing buyer profile transfers to this product. Operator should review before approving.`;
    } else {
      // Single advantage_plus (budget too tight for A/B, OR proven-confidence
      // product, OR no buyer lookalike available to seed the second set).
      const reasonSingle = !canAffordMeasurementAB
        ? `budget ₹${fallbackBudget}/day below 2× derived floor (₹${derivedFloor * 2}/day)`
        : !isHypothesisStage
          ? `proven-confidence product (confidence=${productConfidence}) — consolidation fine`
          : 'no buyer-seeded lookalike audience available to test against';
      fallbackAdSets = [{
        name: `META_CONVERSIONS_ADV-PLUS_FALLBACK_${new Date().toISOString().split('T')[0]}`,
        budgetPercent: 100,
        audienceType: 'advantage_plus' as const,
        geoLocations,
        optimizationGoal,
        ads: [0, 1, 2, 3],
        creativeFormat: fallbackCreativeFormat,
        excludedAudienceIds: pastPurchaserExcludes,
      }];
      fallbackDebateSummary = `Review Team unparseable — fallback: 1 advantage_plus ad set. Reason single-set vs measurement A/B: ${reasonSingle}.`;
      fallbackRationale = `DETERMINISTIC FALLBACK (single-set): ₹${fallbackBudget}/day on advantage_plus broad, all variants, pause at CPA > ₹${breakevenCPA}, scale at ROAS > ${scaleROAS}x with ≥10 conv. Reason single-set: ${reasonSingle}. Operator should review before approving.`;
    }

    return {
      approved: true,
      campaign: {
        budget: fallbackBudget,
        objective: 'OUTCOME_SALES',
        conversionEvent,
        conversionValue,
        adSets: fallbackAdSets,
        scaleRules: `After 7 days per ad set: if ROAS > ${scaleROAS}x AND conversions >= 10 → scale 20% (single step, max 40% cumulative). Manual approval required for scale.${fallbackAdSets.length > 1 ? ' Scale the better-performing audience first; if both <breakeven after week 1, pause both and re-strategize.' : ''}`,
        pauseRules: `Per ad: CTR < ${pauseCTR}% after ₹${Math.round(breakevenCPA * 2)} spent → pause ad. Per ad set: ROAS < ${pauseROAS} after 7 days → pause. CPA > ₹${breakevenCPA} (product price) after ₹${Math.round(breakevenCPA * 3)} spend → pause and flag.${fallbackAdSets.length > 1 ? ' Day-7 checkpoint: pause whichever audience has worse blended CPA if no improvement after another 7 days.' : ''}`,
      },
      adjustments: {
        budgetAdjusted: fallbackBudget !== brief.suggestedBudget,
        originalBudget: brief.suggestedBudget,
        recommendedBudget: fallbackBudget,
      },
      debateRounds: 0,
      debateLog: [
        { round: 0, from: 'system', summary: fallbackDebateSummary },
      ],
      debateRationale: fallbackRationale,
    };
  }

}
