import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CompaniesService } from '../../companies/companies.service';
import {
  Campaign,
  CampaignDocument,
  CampaignSource,
  isManagedCampaignSource,
} from '../../campaigns/schemas/campaign.schema';
import {
  IntelligenceBrief,
  IntelligenceBriefDocument,
} from '../../pipeline/schemas/intelligence-brief.schema';
import { buildProductResolver } from '../../campaigns/meta-ads/product-resolver.util';
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
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(IntelligenceBrief.name)
    private readonly briefModel: Model<IntelligenceBriefDocument>,
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

    const metaCampaignIds = campaigns
      .filter((campaign) => campaign.metaCampaignId)
      .map((campaign) => campaign.metaCampaignId);
    const resolveProduct = await buildProductResolver(
      this.campaignModel,
      this.briefModel,
      tenantId,
      metaCampaignIds,
      company.products,
    );

    return campaigns
      .filter((c) => c.metaCampaignId && isManagedCampaignSource(c.source))
      .map((c) => {
        const resolvedProduct = resolveProduct(c.metaCampaignId);
        return {
          campaignId: String((c as { _id: unknown })._id),
          metaCampaignId: c.metaCampaignId,
          // SnapshotBuilder historically reads products[0]. Passing the
          // tenant's entire catalogue here therefore applied an unrelated
          // product's conversion value/refund rate to multi-product
          // campaigns. Resolve once per campaign and pass exactly one; an
          // ambiguous legacy campaign receives no product so downstream
          // economics can fail closed instead of fabricating attribution.
          products: resolvedProduct
            ? this.buildProducts([resolvedProduct])
            : [],
        };
      });
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
    return (
      raw
        // `active` controls whether a product can be selected for a new launch.
        // It must not erase the economics of a historical campaign that has an
        // explicit/uniquely resolved product after that product is deactivated.
        .filter((p) => p.name)
        .map((p) => ({
          name: p.name as string,
          conversionValue: p.conversionValue,
          contributionMargin: p.contributionMargin,
          refundRatePercent: p.refundRatePercent,
        }))
    );
  }
}
