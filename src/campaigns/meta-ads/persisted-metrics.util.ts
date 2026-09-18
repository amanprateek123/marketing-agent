import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import {
  FullCampaignMetrics,
  CampaignMetrics,
  AdSetMetrics,
  AdMetrics,
} from './meta-metrics.service';

// Accepts either a hydrated Mongoose document or a .lean() plain object —
// callers use both (campaign-auditor holds a live document; shadow-action/
// action-outcome read with .lean() for a lighter one-off metrics snapshot).
// Every field is read via `as any` below regardless, so this only needs to
// describe the shape, not the Document machinery.
type PersistedCampaignLike = CampaignDocument | (Partial<Campaign> & Record<string, any>);

/**
 * Assembles the same FullCampaignMetrics shape MetaMetricsService.fetchFullMetrics
 * used to produce via a live Meta call, but from campaign-sync's already-
 * persisted data (Campaign top-level fields + metaAdSets, refreshed every
 * 10 min) instead. campaign-sync.service.ts is now the sole Meta fetcher for
 * active campaigns — see the data-consolidation plan; the old audit loop and
 * shadow-action/action-outcome services read this instead of re-fetching.
 *
 * `status` is populated from the real persisted status (campaign-sync maps
 * Meta's raw status through META_TO_INTERNAL_STATUS) rather than the old
 * live-fetch's hardcoded 'ACTIVE' (a byproduct of Meta's /insights endpoint
 * only returning rows for active/recently-active entities) — verified unused
 * downstream (grepped campaign-auditor/signal-detector/audit-agent), so this
 * is a strictly more correct value with no behavior change.
 *
 * cpa is recomputed client-side (spend/conversions) — Meta never returns cpa
 * directly, the old live fetch computed it the same way.
 */
export function buildFullMetricsFromPersisted(
  campaign: PersistedCampaignLike,
): FullCampaignMetrics {
  const c = campaign as any;
  const conversions = c.conversions ?? 0;
  const spend = c.spend ?? 0;

  const campaignMetrics: CampaignMetrics = {
    campaignId: c.metaCampaignId ?? '',
    campaignName: c.name ?? '',
    status: (c.effectiveStatus || c.status || 'UNKNOWN').toString().toUpperCase(),
    spend,
    impressions: c.impressions ?? 0,
    clicks: c.clicks ?? 0,
    conversions,
    ctr: c.ctr ?? 0,
    cpc: c.cpc ?? 0,
    cpa: conversions > 0 ? spend / conversions : 0,
    roas: c.roas ?? 0,
    frequency: c.frequency ?? 0,
    dataAsOf: c.dataAsOf ?? null,
  };

  const adSets: (AdSetMetrics & { ads: AdMetrics[] })[] = (c.metaAdSets ?? []).map(
    (as: any) => {
      const asConversions = as.conversions ?? 0;
      const asSpend = as.spend ?? 0;
      return {
        adSetId: as.id ?? '',
        adSetName: as.name ?? '',
        status: (as.effectiveStatus || as.status || 'UNKNOWN').toString().toUpperCase(),
        spend: asSpend,
        impressions: as.impressions ?? 0,
        clicks: as.clicks ?? 0,
        conversions: asConversions,
        ctr: as.ctr ?? 0,
        cpc: as.cpc ?? 0,
        cpa: asConversions > 0 ? asSpend / asConversions : 0,
        frequency: as.frequency ?? 0,
        reach: as.reach ?? 0,
        ads: (as.ads ?? []).map((ad: any) => ({
          adId: ad.id ?? '',
          adName: ad.name ?? '',
          adSetId: as.id ?? '',
          status: (ad.effectiveStatus || ad.status || 'UNKNOWN').toString().toUpperCase(),
          spend: ad.spend ?? 0,
          impressions: ad.impressions ?? 0,
          clicks: ad.clicks ?? 0,
          conversions: ad.conversions ?? 0,
          ctr: ad.ctr ?? 0,
          cpc: ad.cpc ?? 0,
        })),
      };
    },
  );

  return { campaign: campaignMetrics, adSets };
}
