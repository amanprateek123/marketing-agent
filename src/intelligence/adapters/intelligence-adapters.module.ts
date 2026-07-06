import { Global, Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CompaniesModule } from '../../companies/companies.module';
import { CampaignsModule } from '../../campaigns/campaigns.module';
import {
  Campaign,
  CampaignSchema,
} from '../../campaigns/schemas/campaign.schema';
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
 *   - MongooseModule.forFeature([Campaign]) — TenantCampaignsAdapter reads campaigns
 *   - CompaniesModule                      — for CompaniesService (product info)
 *   - CampaignsModule                      — exports MetaMetricsService (Meta fetch)
 *
 * forwardRef on both is defensive against future circular dependencies
 * — Companies + Campaigns already forward-ref each other.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Campaign.name, schema: CampaignSchema }]),
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
