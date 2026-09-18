import { ProductForRevenue } from '../snapshot/snapshot.types';

/**
 * What each processor needs to know per tenant to iterate over
 * campaigns. Real impl (added when we wire the CampaignsModule
 * adapter) queries the campaigns collection for status='active'
 * and hydrates products from the tenant's Company doc.
 *
 * Injection token: TENANT_CAMPAIGNS_PROVIDER
 */
export interface SnapshotTarget {
  campaignId: string;
  metaCampaignId: string;
  products: ProductForRevenue[];
}

export interface TenantCampaignsProvider {
  listActiveCampaigns(tenantId: string): Promise<SnapshotTarget[]>;
}

export const TENANT_CAMPAIGNS_PROVIDER = 'TENANT_CAMPAIGNS_PROVIDER';
