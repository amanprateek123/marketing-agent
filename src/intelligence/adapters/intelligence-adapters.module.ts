import { Global, Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CompaniesModule } from '../../companies/companies.module';
import { CampaignsModule } from '../../campaigns/campaigns.module';
import {
  Campaign,
  CampaignSchema,
} from '../../campaigns/schemas/campaign.schema';
import {
  IntelligenceBrief,
  IntelligenceBriefSchema,
} from '../../pipeline/schemas/intelligence-brief.schema';
import { META_SNAPSHOT_FETCHER } from '../snapshot/meta-snapshot-fetcher.interface';
import { TENANT_CAMPAIGNS_PROVIDER } from '../scheduler/tenant-campaigns.provider.interface';
import { MetaSnapshotFetcherAdapter } from './meta-snapshot-fetcher.adapter';
import { TenantCampaignsAdapter } from './tenant-campaigns.adapter';

/**
 * Wires the two live adapters that replace the placeholder providers
 * on the intelligence pipeline:
 *   - META_SNAPSHOT_FETCHER  → MetaSnapshotFetcherAdapter
 *   - TENANT_CAMPAIGNS_PROVIDER → TenantCampaignsAdapter
 *
 * Both adapters are exported under their DI tokens so callers
 * (SnapshotEngine, SnapshotProcessor, CycleProcessor) resolve them
 * transparently.
 *
 * Imports:
 *   - MongooseModule.forFeature([Campaign, IntelligenceBrief]) —
 *     MetaSnapshotFetcherAdapter reads campaign-sync's persisted data
 *     directly (see product-resolver.util.ts for why IntelligenceBrief is
 *     needed: per-campaign product resolution for the refund-haircut
 *     reversal) instead of live-fetching Meta; TenantCampaignsAdapter reads
 *     campaigns.
 *   - CompaniesModule                      — for CompaniesService (product info)
 *   - CampaignsModule                      — forwardRef only, no longer used
 *     for a live Meta fetch (MetaSnapshotFetcherAdapter reads Mongo).
 *
 * forwardRef on both is defensive against future circular dependencies
 * — Companies + Campaigns already forward-ref each other.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
    ]),
    forwardRef(() => CompaniesModule),
    forwardRef(() => CampaignsModule),
  ],
  providers: [
    MetaSnapshotFetcherAdapter,
    TenantCampaignsAdapter,
    { provide: META_SNAPSHOT_FETCHER, useExisting: MetaSnapshotFetcherAdapter },
    { provide: TENANT_CAMPAIGNS_PROVIDER, useExisting: TenantCampaignsAdapter },
  ],
  exports: [META_SNAPSHOT_FETCHER, TENANT_CAMPAIGNS_PROVIDER],
})
export class IntelligenceAdaptersModule {}
