import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { CampaignCreatorService } from './campaign-creator/campaign-creator.service';
import { CompaniesService } from '../companies/companies.service';

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly campaignCreator: CampaignCreatorService,
    private readonly companiesService: CompaniesService,
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
   * Human approves a pending campaign → launches on Meta Ads.
   */
  @Post(':tenantId/:campaignId/approve')
  async approve(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    try {
      const company = await this.companiesService.findByTenantId(tenantId);
      const campaign = await this.campaignCreator.launch(campaignId, company);
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
    return campaign;
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/pending-actions
   * List pending audit actions for a campaign.
   */
  @Get(':tenantId/:campaignId/pending-actions')
  async getPendingActions(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    return (campaign as any).pendingActions?.filter((a: any) => a.status === 'pending') ?? [];
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
}
