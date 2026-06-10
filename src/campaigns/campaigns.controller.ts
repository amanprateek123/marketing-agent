import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CampaignsService } from './campaigns.service';
import { CampaignCreatorService } from './campaign-creator/campaign-creator.service';
import { CampaignAuditorService } from './campaign-auditor/campaign-auditor.service';
import { CompaniesService } from '../companies/companies.service';
import { MetaAdsService } from './meta-ads/meta-ads.service';
import { CampaignSyncService } from './meta-ads/campaign-sync.service';
import { AudienceOrchestrationService } from './audience-orchestration/audience-orchestration.service';
import { AuditSnapshot, AuditSnapshotDocument } from './schemas/audit-snapshot.schema';
import { Campaign, CampaignDocument } from './schemas/campaign.schema';
import { ShadowAction, ShadowActionDocument } from '../learning/schemas/shadow-action.schema';
import { CreativeBrief, CreativeBriefDocument } from '../pipeline/schemas/creative-brief.schema';
import { CreativePackage, CreativePackageDocument } from '../creative/schemas/creative-package.schema';
import { SafetyChecks } from './campaign-creator/safety-checks';

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly campaignCreator: CampaignCreatorService,
    private readonly campaignAuditorService: CampaignAuditorService,
    private readonly companiesService: CompaniesService,
    private readonly metaAdsService: MetaAdsService,
    private readonly campaignSyncService: CampaignSyncService,
    private readonly audienceOrchestration: AudienceOrchestrationService,
    @InjectModel(AuditSnapshot.name)
    private readonly snapshotModel: Model<AuditSnapshotDocument>,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(ShadowAction.name)
    private readonly shadowActionModel: Model<ShadowActionDocument>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBriefDocument>,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
  ) {}

  @Get(':tenantId')
  async findAll(@Param('tenantId') tenantId: string) {
    return this.campaignsService.findAll(tenantId);
  }

  @Get(':tenantId/:campaignId')
  async findOne(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/approve
   * Body: { accountId: "act_123456" } — must be one of company.meta.accountIds
   * Human approves a pending campaign → launches on Meta Ads.
   */
  @Post(':tenantId/:campaignId/approve')
  async approve(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('accountId') accountId: string,
  ) {
    try {
      const company = await this.companiesService.findByTenantId(tenantId);

      // Validate accountId is in the tenant's allowed list
      const allowedIds = company.meta?.accountIds ?? (company.meta?.accountId ? [company.meta.accountId] : []);
      if (!accountId) {
        throw new Error(`accountId is required. Available accounts: ${allowedIds.join(', ')}`);
      }
      if (!accountId.startsWith('act_')) {
        throw new Error(`accountId must start with "act_" (e.g. act_549390260260950). Got: "${accountId}"`);
      }
      if (!allowedIds.includes(accountId.substring(4))) {
        throw new Error(`accountId "${accountId}" is not in your Meta account list. Available: ${allowedIds.join(', ')}`);
      }

      const campaign = await this.campaignCreator.launch(campaignId, company, accountId);
      return { success: true, metaCampaignId: campaign.metaCampaignId, status: campaign.status };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/patch-audience
   * Body: { customAudienceId: "120242..." }   — must exist in product.metaAudiences
   *        OR { audienceName: "91Astrology_Visitors_30d" } — resolved by name
   *
   * Use case: agent campaigns launched before the warm/hot guard (pre 2026-05-15)
   * shipped audienceType="retarget" with no metaAudienceId → Meta defaulted to
   * Advantage+ broad delivery. This endpoint attaches a real custom audience to
   * every live ad set on the campaign and disables Advantage+ audience expansion.
   *
   * Symptom in Meta UI:  "Audience: Advantage+ on" + "Custom audiences: None"
   * After running:        "Custom audiences: <name>" with broad expansion off
   */
  @Post(':tenantId/:campaignId/patch-audience')
  async patchAudience(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('customAudienceId') customAudienceId: string,
    @Body('audienceName') audienceName: string,
  ) {
    const campaign: any = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.metaCampaignId) throw new BadRequestException('Campaign was never launched on Meta');

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company?.meta?.accessToken) throw new BadRequestException('No Meta access token configured');

    // Resolve audience: prefer explicit ID, else look up by name in product config
    const allAudiences = (company.products ?? []).flatMap((p: any) => p.metaAudiences ?? []);
    let resolvedId = customAudienceId;
    if (!resolvedId && audienceName) {
      const match = allAudiences.find((a: any) => a.name === audienceName);
      if (!match) {
        throw new BadRequestException(
          `Audience name "${audienceName}" not found on any product. Available: ${allAudiences.map((a: any) => a.name).join(', ') || 'none configured'}`,
        );
      }
      resolvedId = match.id;
    }
    if (!resolvedId) {
      throw new BadRequestException(
        `Provide either customAudienceId or audienceName. Available custom audiences on this tenant: ${allAudiences.filter((a: any) => a.type === 'custom').map((a: any) => `${a.name} (${a.id})`).join(', ') || 'none'}`,
      );
    }

    // Verify the audience exists in product config — guard against typo'd IDs
    const auditMatch = allAudiences.find((a: any) => a.id === resolvedId);
    if (!auditMatch) {
      throw new BadRequestException(
        `customAudienceId "${resolvedId}" not found in any product.metaAudiences. Cannot verify it's a valid audience for this tenant — refusing to patch.`,
      );
    }

    const results: Array<{ adSetId: string; status: 'patched' | 'failed'; error?: string }> = [];
    for (const liveAdSet of (campaign.metaAdSets ?? [])) {
      try {
        await this.metaAdsService.patchAdSetAudience(liveAdSet.id, company.meta.accessToken, resolvedId);
        results.push({ adSetId: liveAdSet.id, status: 'patched' });
      } catch (err: any) {
        results.push({ adSetId: liveAdSet.id, status: 'failed', error: err.message });
      }
    }

    // Persist the chosen audience back to campaignConfig so future syncs / audits see it
    try {
      const cfg = (campaign as any).campaignConfig;
      if (cfg?.adSets) {
        for (const as of cfg.adSets) {
          if (['retarget', 'custom'].includes(as.audienceType)) {
            as.metaAudienceId = resolvedId;
          }
        }
        await this.campaignModel.updateOne({ _id: campaign._id }, { $set: { campaignConfig: cfg } });
      }
    } catch {
      // best-effort persist
    }

    return {
      campaignId,
      patchedAudience: { id: resolvedId, name: auditMatch.name, type: auditMatch.type },
      patched: results.filter(r => r.status === 'patched').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    };
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/backfill-variants
   *
   * Top up a launched campaign with copy/image variants that exist in the
   * creative_package but never made it onto Meta. Use case: pre-2026-05-14
   * campaigns where the Campaign Review Team narrowed image ad sets to one
   * variant index, leaving 3/4 of generated creative on the floor. Adds the
   * missing variants to each existing live ad set as PAUSED → ACTIVE ads.
   *
   * Idempotent: skips variants whose name already exists on the ad set.
   */
  @Post(':tenantId/:campaignId/backfill-variants')
  async backfillVariants(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const campaign: any = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.metaCampaignId) throw new BadRequestException('Campaign was never launched on Meta — backfill not applicable');

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company?.meta?.accessToken) throw new BadRequestException('No Meta access token configured for tenant');
    if (!company.meta.pageId) throw new BadRequestException('company.meta.pageId is required for ad creative creation');

    const pkg: any = await this.campaignsService.findCreativePackage(campaign.creativePackageId);
    if (!pkg) throw new BadRequestException(`creativePackage ${campaign.creativePackageId} not found`);

    const copyVariants = pkg.copyVariants ?? [];
    const images = pkg.images ?? [];
    if (copyVariants.length === 0 || images.length === 0) {
      throw new BadRequestException('Creative package has no variants or images');
    }

    // Resolve product → landing URL. Prefer brief.product if creativeBrief present;
    // fall back to active product.
    const briefId = campaign.briefId;
    let product: any = null;
    if (briefId) {
      const brief = await this.creativeBriefModel.findOne({ tenantId, briefId }).lean().exec();
      if (brief?.product) {
        product = (company.products ?? []).find((p: any) => p.name === brief.product);
      }
    }
    if (!product) {
      product = (company.products ?? []).find((p: any) => p.active) ?? (company.products ?? [])[0];
    }
    const landingUrl = product?.landingUrl;
    if (!landingUrl) throw new BadRequestException(`No landingUrl on product "${product?.name ?? 'unknown'}" — cannot create ads`);

    const results: Array<{ adSetId: string; variantIndex: number; status: 'created' | 'skipped' | 'failed'; adId?: string; error?: string }> = [];

    for (const liveAdSet of (campaign.metaAdSets ?? [])) {
      const liveAds = liveAdSet.ads ?? [];
      // Variants already on this ad set — keyed by hookStyle since the ad name
      // includes "Variant N (hookStyle)" but variant index isn't directly stored
      // on the live ad. Use hookStyle as the dedupe key (each variant has a
      // distinct hookStyle in a single creative package).
      const existingHookStyles = new Set(liveAds.map((ad: any) => (ad.hookStyle ?? '').toLowerCase()).filter(Boolean));

      for (let variantIdx = 0; variantIdx < copyVariants.length; variantIdx++) {
        const variant = copyVariants[variantIdx];
        const image = images.find((img: any) => img.variantIndex === variantIdx);
        if (!image?.imageUrl) {
          results.push({ adSetId: liveAdSet.id, variantIndex: variantIdx, status: 'failed', error: 'no image generated for this variant' });
          continue;
        }
        const hs = (variant.hookStyle ?? '').toLowerCase();
        if (hs && existingHookStyles.has(hs)) {
          results.push({ adSetId: liveAdSet.id, variantIndex: variantIdx, status: 'skipped' });
          continue;
        }

        const adName = `${liveAdSet.name} — Variant ${variantIdx + 1} (${variant.hookStyle ?? 'unknown'})`;
        try {
          const r = await this.metaAdsService.createAdInAdSet(
            liveAdSet.id,
            company.meta.accessToken,
            adName,
            { primaryText: variant.primaryText, headline: variant.headline, cta: variant.cta },
            image.imageUrl,
            company.meta.pageId,
            landingUrl,
            company.meta.specialAdCategories,
          );
          results.push({ adSetId: liveAdSet.id, variantIndex: variantIdx, status: 'created', adId: r.adId });
        } catch (err: any) {
          results.push({ adSetId: liveAdSet.id, variantIndex: variantIdx, status: 'failed', error: err.message });
        }
      }
    }

    // Trigger a sync of all active campaigns so the new ads appear in
    // metaAdSets[].ads on the next read. Don't fail the response on sync error.
    try {
      await this.campaignSyncService.syncActiveCampaigns(company);
    } catch {
      // best-effort
    }

    return {
      campaignId,
      created: results.filter(r => r.status === 'created').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    };
  }

  @Post(':tenantId/:campaignId/pause')
  async pause(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('reason') reason: string,
  ) {
    if (!reason) throw new BadRequestException('reason is required');
    const campaign = await this.campaignsService.pause(tenantId, campaignId, reason);
    if (!campaign) throw new NotFoundException('Campaign not found');

    // Also pause on Meta if campaign was launched
    const metaCampaignId = (campaign as any).metaCampaignId;
    if (metaCampaignId) {
      const company = await this.companiesService.findByTenantId(tenantId);
      if (company?.meta?.accessToken) {
        await this.metaAdsService.pauseCampaign(metaCampaignId, company.meta.accessToken);
      }
    }

    return campaign;
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/actions
   * List audit actions for a campaign. Optional ?status=pending|executed|overridden filter.
   */
  @Get(':tenantId/:campaignId/actions')
  async getActions(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Query('status') status?: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    const actions = (campaign as any).pendingActions ?? [];
    const filtered = status
      ? actions.filter((a: any) => a.status === status)
      : actions;
    return filtered.map((a: any) => ({
      actionId: a.actionId,
      type: a.type,
      targetId: a.targetId,
      targetName: a.targetName,
      reason: a.reason,
      status: a.status,
      recommendedAt: a.recommendedAt,
      executeAt: a.executeAt,
      executedAt: a.executedAt,
      metrics: a.metrics,
      replacementStatus: a.replacementStatus ?? null,
    }));
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/pending-actions
   * Backward-compatible alias — returns only pending actions.
   */
  @Get(':tenantId/:campaignId/pending-actions')
  async getPendingActions(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    return this.getActions(tenantId, campaignId, 'pending');
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/approve
   * Approve a pending audit action — executes immediately.
   */
  @Post(':tenantId/:campaignId/actions/:actionId/approve')
  async approveAction(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Param('actionId') actionId: string,
  ) {
    try {
      // 1. Flip status in DB
      const result = await this.campaignsService.executeAction(tenantId, campaignId, actionId);

      // 2. Execute on Meta immediately (don't wait for next audit cycle)
      const company = await this.companiesService.findByTenantId(tenantId);
      const campaign = await this.campaignsService.findById(tenantId, campaignId);
      if (campaign && company) {
        await this.campaignAuditorService.executeApprovedAction(campaign, company, actionId);
      }

      return { success: true, ...result, executedImmediately: true };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/reject
   * Reject a pending campaign — marks it as failed without launching.
   */
  @Post(':tenantId/:campaignId/reject')
  async reject(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('reason') reason: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    if ((campaign as any).status !== 'pending_approval') {
      throw new BadRequestException('Only pending_approval campaigns can be rejected');
    }
    await this.campaignsService.reject(tenantId, campaignId, reason ?? 'Rejected by tenant');
    return { success: true, message: 'Campaign rejected' };
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/regenerate
   * Re-runs Phase G (Campaign Review Team → campaign creation) for an existing
   * pending_approval campaign. Reuses the original brief + creative package —
   * no scout/research/creative-production rerun. Marks the old campaign as
   * 'superseded' and returns the freshly-created pending_approval campaign.
   *
   * Use when: review team produced a config that needs a re-debate (e.g. wrong
   * budget shape, stale prompt) but the underlying creatives are still good.
   */
  @Post(':tenantId/:campaignId/regenerate')
  async regenerate(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('reason') reason?: string,
  ) {
    try {
      const oldCampaign = await this.campaignModel.findOne({ _id: campaignId, tenantId }).exec();
      if (!oldCampaign) throw new NotFoundException('Campaign not found');
      if (oldCampaign.status !== 'pending_approval') {
        throw new BadRequestException(
          `Only pending_approval campaigns can be regenerated (current: ${oldCampaign.status})`,
        );
      }
      if (!oldCampaign.briefId) {
        throw new BadRequestException('Campaign has no briefId — cannot reload original brief');
      }

      const brief = await this.creativeBriefModel
        .findOne({ tenantId, briefId: oldCampaign.briefId })
        .exec();
      if (!brief) throw new NotFoundException(`Brief ${oldCampaign.briefId} not found`);

      const creativePackage = await this.creativePackageModel
        .findOne({ tenantId, briefId: oldCampaign.briefId, status: 'completed' })
        .exec();
      if (!creativePackage) {
        throw new NotFoundException(`No completed creative package found for brief ${oldCampaign.briefId}`);
      }

      const company = await this.companiesService.findByTenantId(tenantId);

      // Mark old campaign superseded BEFORE creating new — idempotency check on
      // create() filters out superseded so the new one will save cleanly.
      await this.campaignModel.updateOne(
        { _id: campaignId, tenantId },
        {
          $set: {
            status: 'superseded',
            pauseReason: reason ?? 'Regenerated via /regenerate endpoint',
            pausedAt: new Date(),
          },
        },
      );

      let newCampaign;
      try {
        newCampaign = await this.campaignCreator.create(brief, creativePackage, company, oldCampaign.runId);
      } catch (err: any) {
        // Restore old campaign if regenerate fails — don't leave the tenant
        // with no pending campaign at all.
        await this.campaignModel.updateOne(
          { _id: campaignId, tenantId },
          { $set: { status: 'pending_approval' }, $unset: { pauseReason: '', pausedAt: '' } },
        );
        throw err;
      }

      return {
        success: true,
        oldCampaignId: campaignId,
        newCampaignId: (newCampaign as any)._id.toString(),
        newCampaignName: newCampaign.name,
        newBudget: newCampaign.budget,
        message: `Old campaign superseded — new pending_approval campaign created`,
      };
    } catch (err: any) {
      if (err instanceof NotFoundException || err instanceof BadRequestException) throw err;
      throw new BadRequestException(err.message);
    }
  }

  /**
   * PATCH /api/v1/campaigns/:tenantId/:campaignId/budget
   * Edit a pending_approval campaign's daily budget. Re-runs the same TS-level
   * budget validation (per-campaign cap + weekly cap) that initial creation ran,
   * so the LLM/operator can't override safety here either. Used by the
   * Approvals Inbox "✏️ Edit Budget" button.
   */
  @Patch(':tenantId/:campaignId/budget')
  async editBudget(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('budget') budget: number,
  ) {
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
      throw new BadRequestException('budget must be a positive number');
    }
    const campaign = await this.campaignModel.findOne({ _id: campaignId, tenantId }).exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.status !== 'pending_approval') {
      throw new BadRequestException(`Only pending_approval campaigns can edit budget (current: ${campaign.status})`);
    }

    const company = await this.companiesService.findByTenantId(tenantId);

    // Same gates that ran at create time — TS-level safety, never overridable.
    SafetyChecks.checkCampaignBudget(budget, company);
    await SafetyChecks.checkWeeklyBudget(tenantId, budget, company, this.campaignsService);

    await this.campaignModel.updateOne(
      { _id: campaignId, tenantId },
      { $set: { budget } },
    );

    return {
      campaignId,
      budget,
      status: campaign.status,
      message: `Budget updated to ₹${budget}/day`,
    };
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/shadow-actions
   * Returns the LLM-proposed-but-blocked actions for this campaign with their
   * regretLabel (correct_block / missed_signal / inconclusive — set by the
   * shadow-eval cron 72h after the block). Lets the dashboard show whether
   * the safety guards were correctly tuned.
   */
  @Get(':tenantId/:campaignId/shadow-actions')
  async getShadowActions(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const campaign = await this.campaignModel.findOne({ _id: campaignId, tenantId }).select('_id').lean().exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    return this.shadowActionModel
      .find({ tenantId, campaignId })
      .sort({ blockedAt: -1 })
      .limit(50)
      .lean()
      .exec();
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/audit-snapshots
   * Returns audit history for a campaign — last 30 snapshots sorted newest first.
   * Each entry has: auditedAt, metrics, verdict (verdict/urgency/contextInsight/recommendedActions), adSets[]
   */
  @Get(':tenantId/:campaignId/audit-snapshots')
  async getAuditSnapshots(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');

    const snapshots = await this.snapshotModel
      .find({ tenantId, campaignId })
      .sort({ auditedAt: -1 })
      .limit(30)
      .lean()
      .exec();

    return snapshots.map(s => ({
      auditedAt: s.auditedAt,
      metrics: s.metrics,
      adSets: s.adSets,
      verdict: s.verdict,
    }));
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/override
   * Override (skip) a pending audit action — it won't auto-execute.
   */
  @Post(':tenantId/:campaignId/actions/:actionId/override')
  async overrideAction(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Param('actionId') actionId: string,
  ) {
    try {
      await this.campaignsService.overrideAction(tenantId, campaignId, actionId);
      return { success: true, message: 'Action overridden — will not execute' };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/sync
   * Manually trigger a Meta campaign sync for a tenant.
   */
  @Post(':tenantId/sync')
  async syncCampaigns(@Param('tenantId') tenantId: string) {
    try {
      const company = await this.companiesService.findByTenantId(tenantId);
      const result = await this.campaignSyncService.syncActiveCampaigns(company);
      return { success: true, ...result };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/audit
   * Manually trigger a campaign audit pass for a tenant — runs the same logic
   * as the 6h cron job (safety rails → signals → verdict → snapshot).
   */
  @Post(':tenantId/audit')
  async triggerAudit(@Param('tenantId') tenantId: string) {
    try {
      const result = await this.campaignAuditorService.audit(tenantId);
      return { success: true, ...result };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/audit
   * Manually trigger an audit for a single campaign — same flow as the tenant-wide
   * audit, scoped to one campaign. Useful for the dashboard "Run Audit" button and
   * for re-evaluating one campaign after a config change without touching the rest.
   */
  @Post(':tenantId/:campaignId/audit')
  async triggerAuditOne(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    try {
      const result = await this.campaignAuditorService.auditOne(tenantId, campaignId);
      return { success: true, campaignId, ...result };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/audiences/setup
   * Body: { productName?: string }
   *
   * Provision the standard retargeting cohort stack on Meta for this tenant
   * (page visitors at 30/90d, booking-initiated, purchasers, 1% / 2% lookalikes
   * of purchasers). Idempotent — cohorts that already exist by name are skipped.
   * Returns per-cohort status (created / exists / failed / skipped).
   *
   * Today: manual trigger. Future: scheduled weekly refresh in scheduler module.
   */
  @Post(':tenantId/audiences/setup')
  async setupStandardAudiences(
    @Param('tenantId') tenantId: string,
    @Body() body: { productName?: string } = {},
  ) {
    try {
      const results = await this.audienceOrchestration.createStandardStack(tenantId, body.productName);
      const summary = {
        created: results.filter((r) => r.status === 'created').length,
        exists: results.filter((r) => r.status === 'exists').length,
        failed: results.filter((r) => r.status === 'failed').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
      };
      return { tenantId, summary, cohorts: results };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * GET /api/v1/campaigns/:tenantId/audiences/status?productName=X
   * Read-only view of which standard cohorts exist for this tenant.
   */
  @Get(':tenantId/audiences/status')
  async getAudienceStatus(
    @Param('tenantId') tenantId: string,
    @Query('productName') productName?: string,
  ) {
    return this.audienceOrchestration.listCohortStatus(tenantId, productName);
  }
}
