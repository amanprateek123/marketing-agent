import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CompaniesService } from '../../companies/companies.service';
import {
  Campaign,
  CampaignSource,
  isManagedCampaignSource,
} from '../../campaigns/schemas/campaign.schema';
import {
  SnapshotTarget,
  TenantCampaignsProvider,
} from '../scheduler/tenant-campaigns.provider.interface';
import { ProductForRevenue } from '../snapshot/snapshot.types';

const MANAGED_CAMPAIGN_SOURCES: CampaignSource[] = ['agent', 'human'];

/**
 * Real TenantCampaignsProvider implementation. Feeds the two BullMQ
 * processors (SnapshotProcessor, CycleProcessor) the list of active
 * Meta-linked campaigns for a tenant + the tenant's active products.
 */
@Injectable()
export class TenantCampaignsAdapter implements TenantCampaignsProvider {
  private readonly logger = new Logger(TenantCampaignsAdapter.name);

  constructor(
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<Campaign>,
    private readonly companies: CompaniesService,
  ) {}

  async listActiveCampaigns(tenantId: string): Promise<SnapshotTarget[]> {
    const [campaigns, company] = await Promise.all([
      this.campaignModel
        .find({
          tenantId,
          status: 'active',
          metaCampaignId: { $ne: '' },
          source: { $in: MANAGED_CAMPAIGN_SOURCES },
        })
        .lean()
        .exec(),
      this.companies.findByTenantId(tenantId).catch(() => null),
    ]);

    if (!company) {
      this.logger.warn(`tenant ${tenantId} not found; returning 0 campaigns`);
      return [];
    }

    const products = this.buildProducts(company.products ?? []);

    return campaigns
      .filter((c) => c.metaCampaignId && isManagedCampaignSource(c.source))
      .map((c) => ({
        campaignId: String((c as { _id: unknown })._id),
        metaCampaignId: c.metaCampaignId,
        products,
      }));
  }

  /**
   * Reduce the raw Product[] on Company to only the fields
   * SnapshotBuilder needs for revenue derivation.
   */
  private buildProducts(
    raw: Array<{
      name?: string;
      active?: boolean;
      conversionValue?: number;
      contributionMargin?: number;
      refundRatePercent?: number;
    }>,
  ): ProductForRevenue[] {
    return raw
      .filter((p) => p.active !== false && p.name)
      .map((p) => ({
        name: p.name as string,
        conversionValue: p.conversionValue,
        contributionMargin: p.contributionMargin,
        refundRatePercent: p.refundRatePercent,
      }));
  }
}
