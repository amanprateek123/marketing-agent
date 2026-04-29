import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentType } from '../../claude/claude.types';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { ActionLoggerService } from '../../common/action-logger/action-logger.service';
import { CampaignsService } from '../campaigns.service';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CreativeBriefDocument } from '../../pipeline/schemas/creative-brief.schema';
import { CreativePackageDocument } from '../../creative/schemas/creative-package.schema';
import { SafetyChecks } from './safety-checks';
import { CampaignReviewTeamService, CampaignReviewOutput } from '../../teams/campaign-review-team.service';
import { MetaAdsService } from '../meta-ads/meta-ads.service';
import { SlackService } from '../../delivery/slack.service';
import { CompaniesService } from '../../companies/companies.service';
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

      // Re-validate adjusted budget against safety caps — review team cannot override TypeScript limits
      if (finalBudget > company.maxBudgetPerCampaign) {
        this.logger.warn(`Review team budget ₹${finalBudget} exceeds cap ₹${company.maxBudgetPerCampaign} — clamping`);
        finalBudget = company.maxBudgetPerCampaign;
      }
      await SafetyChecks.checkWeeklyBudget(company.tenantId, finalBudget, company, this.campaignsService);

      this.logger.log(`Campaign Review Team approved | rounds: ${review.debateRounds} | adSets: ${review.campaign?.adSets?.length ?? 0}`);
    } else {
      this.logger.error(`Campaign Review Team failed after 2 attempts — saving campaign as failed`);
      await this.campaignModel.create({
        tenantId: company.tenantId,
        runId,
        briefId: brief.briefId,
        name: `FAILED_${brief.topic.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 30)}`,
        topic: brief.topic ?? '',
        angle: brief.angle ?? '',
        creativePackageId: creativePackage?._id?.toString() ?? '',
        metaCampaignId: '',
        status: 'failed',
        budget: 0,
        objective: company.primaryObjective,
        reviewNotes: 'Campaign Review Team failed after 2 attempts — no valid config produced',
      });
      throw new Error(`Campaign Review Team failed after 2 attempts for brief ${brief.briefId} — campaign saved as failed`);
    }

    // ── Idempotency: don't create duplicate campaigns for same brief ──────────
    const existingCampaign = await this.campaignModel.findOne({
      tenantId: company.tenantId,
      runId,
      briefId: brief.briefId,
    }).exec();
    if (existingCampaign) {
      this.logger.warn(`Campaign already exists for briefId=${brief.briefId} runId=${runId} — returning existing`);
      return existingCampaign;
    }

    // ── Save as pending_approval — do NOT launch yet ─────────────────────────
    const topicSlug = brief.topic.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 30);
    const campaignName = `${topicSlug}_${new Date().toISOString().split('T')[0]}`;

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
   * Phase G Step 2: Human approved → launch on Meta Ads.
   * Called via POST /campaigns/:tenantId/:campaignId/approve
   */
  async launch(
    campaignId: string,
    company: CompanyDocument,
    accountId: string,
  ): Promise<CampaignDocument> {
    const campaign = await this.campaignModel.findOne({
      _id: campaignId,
      tenantId: company.tenantId,
    }).exec();
    if (!campaign) throw new Error(`Campaign ${campaignId} not found for tenant ${company.tenantId}`);
    if (campaign.status !== 'pending_approval') {
      throw new Error(`Campaign ${campaignId} is not pending approval (status: ${campaign.status})`);
    }

    // Idempotency: prevent double-launch on duplicate /approve calls
    if (campaign.metaCampaignId) {
      throw new Error(`Campaign ${campaignId} already launched (metaCampaignId: ${campaign.metaCampaignId})`);
    }

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

    // Load creative package for copy variants + image
    const creativePackage = campaign.creativePackageId
      ? await this.campaignsService.findCreativePackage(campaign.creativePackageId)
      : null;

    const copyVariants = creativePackage?.copyVariants ?? [];
    const images = (creativePackage as any)?.images ?? [];
    const video = (creativePackage as any)?.video ?? null;
    const videoUrl = video?.videoUrl ?? '';

    // Pre-launch: fetch live audiences from Meta and strip any expired IDs from ad sets
    const validAudienceIds = new Set<string>();
    try {
      const normalizeId = (id: string) => id.startsWith('act_') ? id : `act_${id}`;
      const accountIds = ((company.meta!.accountIds?.length ?? 0) > 0
        ? company.meta!.accountIds!
        : [company.meta!.accountId]
      ).map(normalizeId);

      for (const acctId of accountIds) {
        const res = await axios.get(`https://graph.facebook.com/v21.0/${acctId}/customaudiences`, {
          params: { fields: 'id', limit: '200', access_token: company.meta!.accessToken },
          timeout: 15000,
        }).catch(() => ({ data: { data: [] } }));
        for (const a of res.data?.data ?? []) {
          validAudienceIds.add(a.id);
        }
      }
      this.logger.log(`Pre-launch audience check: ${validAudienceIds.size} valid audiences on Meta`);
    } catch (err: any) {
      this.logger.warn(`Audience validation failed (proceeding without check): ${err.message}`);
    }

    if (validAudienceIds.size > 0) {
      for (const adSet of config.adSets as any[]) {
        if (adSet.metaAudienceId && !validAudienceIds.has(adSet.metaAudienceId)) {
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

    if (advantagePlusAdSets.length > 1) {
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

    // Enforce video-variant restriction: video was only generated for the selected variant.
    // Applies ONLY to 'video' format (single-format video ad set) — 'mixed' is the path
    // that intentionally pairs the selected variant's video with image ads for the rest,
    // so don't collapse 'mixed' down to a single variant here.
    const selectedCopyIndex = (creativePackage as any)?.selectedCopyIndex ?? 0;
    for (const adSet of config.adSets as any[]) {
      if (adSet.creativeFormat === 'video' && videoUrl) {
        // Video-only ad sets MUST use only the selected variant
        if (adSet.ads.length > 1 || !adSet.ads.includes(selectedCopyIndex)) {
          this.logger.warn(`Ad set "${adSet.name}": video format restricted to variant ${selectedCopyIndex} (was: [${adSet.ads}])`);
          adSet.ads = [selectedCopyIndex];
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
    const creativeBrief = campaign.briefId
      ? await this.campaignsService.findCreativeBrief(company.tenantId, campaign.briefId)
      : null;
    const briefProduct = creativeBrief ? ((creativeBrief as any).product ?? '') : '';
    const product = (company.products ?? []).find(p =>
      briefProduct ? p.name === briefProduct : p.conversionEvent === config.conversionEvent,
    ) ?? (company.products ?? [])[0];
    const landingUrl = product?.landingUrl ?? '';

    const topicSlug = ((campaign as any).topic ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 30);
    const campaignName = `${topicSlug || 'CAMPAIGN'}_${new Date().toISOString().split('T')[0]}`;

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

    // Launch: campaign → ad sets → ads via Meta Graph API
    const launchResult = await this.metaAdsService.launchCampaign({
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
    });

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

}
