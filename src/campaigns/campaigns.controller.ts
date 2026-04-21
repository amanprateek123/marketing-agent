import {
  Controller,
  Get,
  Post,
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
import { CompaniesService } from '../companies/companies.service';
import { MetaAdsService } from './meta-ads/meta-ads.service';
import { CampaignSyncService } from './meta-ads/campaign-sync.service';
import { AuditSnapshot, AuditSnapshotDocument } from './schemas/audit-snapshot.schema';

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly campaignCreator: CampaignCreatorService,
    private readonly companiesService: CompaniesService,
    private readonly metaAdsService: MetaAdsService,
    private readonly campaignSyncService: CampaignSyncService,
    @InjectModel(AuditSnapshot.name)
    private readonly snapshotModel: Model<AuditSnapshotDocument>,
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
      const result = await this.campaignsService.executeAction(tenantId, campaignId, actionId);
      return { success: true, ...result };
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
}
