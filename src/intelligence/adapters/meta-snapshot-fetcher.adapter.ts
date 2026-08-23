import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CompaniesService } from '../../companies/companies.service';
import {
  Campaign,
  CampaignDocument,
} from '../../campaigns/schemas/campaign.schema';
import {
  IntelligenceBrief,
  IntelligenceBriefDocument,
} from '../../pipeline/schemas/intelligence-brief.schema';
import { buildProductResolver } from '../../campaigns/meta-ads/product-resolver.util';
import { getRefundFactor } from '../../common/conversion-value.util';
import { MetaSnapshotFetcher } from '../snapshot/meta-snapshot-fetcher.interface';
import {
  RawMetaAd,
  RawMetaAdSet,
  RawMetaBundle,
  RawMetaCampaign,
} from '../snapshot/snapshot.types';

/**
 * Real MetaSnapshotFetcher.
 *
 * [CONSOLIDATED 2026-07-23] Was 3 live Meta API calls per campaign per cycle
 * (MetaMetricsService.fetchFullMetrics + enrichCampaign + enrichAds — see
 * git history for the prior implementation). campaign-sync.service.ts
 * (10-min cadence) is now the sole Meta fetcher; this reads its persisted
 * output (Campaign.metaAdSets) instead. Zero Meta calls happen here now.
 *
 * Two things this fixes as a side effect, not just a dedup:
 *   1. reach/cpm/effective_status (what the old enrichCampaign() existed
 *      solely to fetch) are already on the persisted Campaign doc — nothing
 *      supplemental needed.
 *   2. Adset/ad-level revenue used to be SYNTHESIZED as conversions ×
 *      conversionValue (MetaMetricsService never returned real per-adset/ad
 *      action_values). campaign-sync's persisted data has real per-adset/ad
 *      revenue from Meta's actual pixel values.
 *
 * Refund haircut: SnapshotBuilder.computeRevenue() unconditionally applies
 * its own haircut from `products[0].refundRatePercent` (see
 * snapshot-builder.service.ts) — that contract is unchanged. But
 * campaign-sync's persisted revenue is already NET (Phase 0 fix, haircut by
 * THIS campaign's actual resolved product via buildProductResolver, which
 * can differ from the cascade's coarser `products[0]` for multi-product
 * tenants). Feeding already-net revenue into a builder that haircuts again
 * would double-discount it. So this reverses this campaign's own haircut
 * (divides back to gross) before handing off, preserving the exact
 * gross-in/builder-haircuts contract the old adapter also used — for
 * single-product tenants (the common case) this round-trips exactly;
 * for multi-product tenants it's no less precise than before (the old
 * adapter's synthesized revenue used the same `products[0]`-style
 * resolution via pickProduct()).
 */
@Injectable()
export class MetaSnapshotFetcherAdapter implements MetaSnapshotFetcher {
  private readonly log = new Logger(MetaSnapshotFetcherAdapter.name);
  constructor(
    private readonly companies: CompaniesService,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(IntelligenceBrief.name)
    private readonly briefModel: Model<IntelligenceBriefDocument>,
  ) {}

  async fetch(input: {
    tenantId: string;
    campaignId: string;
    metaCampaignId: string;
  }): Promise<RawMetaBundle> {
    const campaign = await this.campaignModel
      .findOne({ tenantId: input.tenantId, _id: input.campaignId })
      .lean()
      .exec();
    if (!campaign) {
      throw new Error(
        `campaign not found: tenantId=${input.tenantId} campaignId=${input.campaignId}`,
      );
    }
    const company = await this.companies.findByTenantId(input.tenantId);
    if (!company) {
      throw new Error(`tenant not found: ${input.tenantId}`);
    }

    // Reverse THIS campaign's refund haircut (see class doc) so
    // SnapshotBuilder's own haircut — driven by the cascade's coarser
    // products[0] — lands on the right gross figure instead of discounting
    // already-net revenue a second time.
    const productByCampaign = await buildProductResolver(
      this.campaignModel,
      this.briefModel,
      input.tenantId,
      [input.metaCampaignId],
      company.products,
    );
    const refundFactor = getRefundFactor(
      productByCampaign(input.metaCampaignId),
    );
    const toGross = (netRevenue: number) => netRevenue / refundFactor;

    const c = campaign as any;
    const now = new Date();
    // campaign.syncedAt is when campaign-sync last actually wrote this doc —
    // a real freshness signal (SnapshotValidator's freshness score was
    // previously always ~1.0 because the old adapter synthesized "now" as
    // the window end regardless of how stale the underlying fetch was).
    const syncedAtCandidate = c.syncedAt ? new Date(c.syncedAt) : undefined;
    const sourceMetricsSyncedAt =
      syncedAtCandidate && Number.isFinite(syncedAtCandidate.getTime())
        ? syncedAtCandidate
        : null;
    const metaWindowEnd = sourceMetricsSyncedAt ?? now;
    // campaign-level insights are lifetime ('maximum' date_preset in
    // campaign-sync) — windowStart is best-effort, matching the old
    // adapter's own 90-day proxy since launchedAt isn't always set.
    const metaWindowStart = c.launchedAt
      ? new Date(c.launchedAt)
      : new Date(metaWindowEnd.getTime() - 90 * 86400 * 1000);

    const campaignInsights = this.toRawInsights({
      spend: c.spend ?? 0,
      impressions: c.impressions ?? 0,
      reach: c.reach ?? 0,
      clicks: c.clicks ?? 0,
      ctr: c.ctr ?? 0,
      cpc: c.cpc ?? 0,
      cpm: c.cpm ?? 0,
      frequency: c.frequency ?? 0,
      conversions: c.conversions ?? 0,
      revenue: toGross(c.revenue ?? 0),
    });

    // Campaign-level learning stage: the WORST stage across ad sets, because
    // one ad set stuck in LEARNING_LIMITED holds back the whole campaign's
    // delivery. Sync already stores this per ad set (campaign-sync pulls
    // learning_stage_info), but it was never rolled up onto rawCampaign — so
    // `learning_stage` arrived undefined and LifecycleEngine's two
    // learning-phase branches could never fire, dropping campaigns through to
    // stage 'unknown', which blocks every action with a '*' gate.
    const adSetStages: string[] = ((c.metaAdSets ?? []) as any[])
      .map((as) => as?.learningStage)
      .filter(Boolean);
    const stagePriority = [
      'NOT_DELIVERING',
      'LEARNING_LIMITED',
      'LEARNING',
      'ACTIVE',
    ];
    const learningStage =
      stagePriority.find((p) => adSetStages.includes(p)) ?? adSetStages[0];

    const rawCampaign: RawMetaCampaign = {
      id: input.metaCampaignId,
      name: c.name ?? '',
      objective: c.objective || undefined,
      status: (c.effectiveStatus || c.status || '').toString().toUpperCase(),
      effective_status: c.effectiveStatus || '',
      account_id: c.metaAccountId ?? '',
      learning_stage: learningStage,
      insights: campaignInsights,
    };

    const rawAdSets: Record<string, RawMetaAdSet> = {};
    const rawAds: Record<string, RawMetaAd> = {};
    for (const as of (c.metaAdSets ?? []) as any[]) {
      if (!as.id) continue;
      rawAdSets[as.id] = {
        id: as.id,
        name: as.name ?? '',
        audienceType: as.audienceType,
        insights: this.toRawInsights({
          spend: as.spend ?? 0,
          impressions: as.impressions ?? 0,
          reach: as.reach ?? 0,
          clicks: as.clicks ?? 0,
          ctr: as.ctr ?? 0,
          cpc: as.cpc ?? 0,
          cpm: as.cpm ?? 0,
          frequency: as.frequency ?? 0,
          conversions: as.conversions ?? 0,
          revenue: toGross(as.revenue ?? 0),
        }),
      };

      for (const ad of (as.ads ?? []) as any[]) {
        if (!ad.id) continue;
        rawAds[ad.id] = {
          id: ad.id,
          name: ad.name ?? '',
          hookStyle: ad.hookStyle,
          format: ad.format,
          quality_ranking: ad.qualityRanking,
          engagement_ranking: ad.engagementRanking,
          conversion_ranking: ad.conversionRanking,
          insights: {
            ...this.toRawInsights({
              spend: ad.spend ?? 0,
              impressions: ad.impressions ?? 0,
              reach: ad.reach ?? 0,
              clicks: ad.clicks ?? 0,
              ctr: ad.ctr ?? 0,
              cpc: ad.cpc ?? 0,
              cpm: ad.cpm ?? 0,
              frequency: ad.frequency ?? 0,
              conversions: ad.conversions ?? 0,
              revenue: toGross(ad.revenue ?? 0),
            }),
            video_p25_watched_actions: [{ value: ad.videoP25 ?? 0 }],
            video_p50_watched_actions: [{ value: ad.videoP50 ?? 0 }],
            video_p75_watched_actions: [{ value: ad.videoP75 ?? 0 }],
            video_p100_watched_actions: [{ value: ad.videoP100 ?? 0 }],
          },
        };
      }
    }

    return {
      campaign: rawCampaign,
      adSets: rawAdSets,
      ads: rawAds,
      metaWindowStart,
      metaWindowEnd,
      sourceMetricsSyncedAt,
      metricScope: 'lifetime',
    };
  }

  // [SUPERSEDED 2026-07-23] enrichCampaign/enrichAds/pickProduct/numOrUndef —
  // supplemental live Meta calls + product resolution the old fetch() used.
  // reach/cpm/effective_status now come straight off the persisted Campaign
  // doc (Phase 0 added them there); rankings/video quartiles are already in
  // metaAdSets[].ads[] (campaign-sync has fetched them since before this
  // consolidation). Kept here, commented, for reference.
  //
  // private async enrichCampaign(rawCampaign: RawMetaCampaign, metaCampaignId: string, accessToken: string): Promise<void> {
  //   const insightsUrl = `${META_API_BASE}/${metaCampaignId}/insights`;
  //   const insightsRes = await axios.get(insightsUrl, {
  //     params: { fields: 'reach,cpm,cpp,actions,action_values,frequency,purchase_roas', date_preset: 'maximum', action_attribution_windows: JSON.stringify(['7d_click', '1d_view']), access_token: accessToken },
  //     timeout: 15000,
  //   });
  //   const row = insightsRes.data?.data?.[0] ?? {};
  //   if (rawCampaign.insights) {
  //     const enriched = { ...rawCampaign.insights } as Record<string, unknown>;
  //     if (row.reach) enriched.reach = row.reach;
  //     if (row.cpm) enriched.cpm = row.cpm;
  //     const extraActions = (row.actions ?? []).filter((a: { action_type: string }) =>
  //       ['add_to_cart', 'initiate_checkout', 'offsite_conversion.fb_pixel_add_to_cart', 'offsite_conversion.fb_pixel_initiate_checkout'].includes(a.action_type));
  //     if (extraActions.length > 0) {
  //       const currentActions = (enriched.actions ?? []) as Array<{ action_type: string; value: number }>;
  //       const merged = [...currentActions];
  //       for (const a of extraActions) if (!merged.find((m) => m.action_type === a.action_type)) merged.push(a);
  //       enriched.actions = merged;
  //     }
  //     rawCampaign.insights = enriched as RawMetaCampaign['insights'];
  //   }
  //   try {
  //     const campaignFieldsRes = await axios.get(`${META_API_BASE}/${metaCampaignId}`, {
  //       params: { fields: 'effective_status,configured_status,objective,special_ad_categories', access_token: accessToken },
  //       timeout: 10000,
  //     });
  //     const d = campaignFieldsRes.data ?? {};
  //     if (d.effective_status) rawCampaign.effective_status = d.effective_status;
  //     if (d.objective) rawCampaign.objective = d.objective;
  //   } catch { /* non-critical */ }
  // }
  //
  // private async enrichAds(rawAds: Record<string, RawMetaAd>, metaCampaignId: string, accessToken: string): Promise<void> {
  //   if (Object.keys(rawAds).length === 0) return;
  //   const insightsUrl = `${META_API_BASE}/${metaCampaignId}/insights`;
  //   const res = await axios.get(insightsUrl, {
  //     params: { fields: 'ad_id,ad_name,quality_ranking,engagement_rate_ranking,conversion_rate_ranking,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions', level: 'ad', date_preset: 'last_7d', limit: 200, access_token: accessToken },
  //     timeout: 20000,
  //   });
  //   const rows = (res.data?.data ?? []) as Array<{ ad_id?: string; ad_name?: string; quality_ranking?: string; engagement_rate_ranking?: string; conversion_rate_ranking?: string; video_p25_watched_actions?: Array<{ value: number | string }>; video_p50_watched_actions?: Array<{ value: number | string }>; video_p75_watched_actions?: Array<{ value: number | string }>; video_p100_watched_actions?: Array<{ value: number | string }> }>;
  //   for (const row of rows) {
  //     const adId = row.ad_id;
  //     if (!adId || !rawAds[adId]) continue;
  //     const ad = rawAds[adId];
  //     if (row.ad_name && !ad.name) ad.name = row.ad_name;
  //     if (row.quality_ranking) ad.quality_ranking = row.quality_ranking;
  //     if (row.engagement_rate_ranking) ad.engagement_ranking = row.engagement_rate_ranking;
  //     if (row.conversion_rate_ranking) ad.conversion_ranking = row.conversion_rate_ranking;
  //     if (row.video_p25_watched_actions || row.video_p50_watched_actions || row.video_p75_watched_actions || row.video_p100_watched_actions) {
  //       ad.insights = { ...(ad.insights ?? {}), video_p25_watched_actions: row.video_p25_watched_actions, video_p50_watched_actions: row.video_p50_watched_actions, video_p75_watched_actions: row.video_p75_watched_actions, video_p100_watched_actions: row.video_p100_watched_actions } as RawMetaAd['insights'];
  //     }
  //   }
  // }
  //
  // private pickProduct(company: unknown): { conversionValue?: number; conversionEvent?: string; customConversionId?: string; refundRatePercent?: number } | undefined {
  //   const products = ((company as { products?: Array<Record<string, unknown>> }).products ?? []) as Array<Record<string, unknown>>;
  //   const active = products.find((p) => p.active !== false) ?? products[0];
  //   if (!active) return undefined;
  //   return {
  //     conversionValue: this.numOrUndef(active.conversionValue),
  //     conversionEvent: typeof active.conversionEvent === 'string' ? active.conversionEvent : undefined,
  //     customConversionId: typeof active.customConversionId === 'string' ? active.customConversionId : undefined,
  //     refundRatePercent: this.numOrUndef(active.refundRatePercent),
  //   };
  // }
  //
  // private numOrUndef(v: unknown): number | undefined {
  //   return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  // }

  private toRawInsights(m: {
    spend: number;
    impressions: number;
    reach: number;
    clicks: number;
    ctr: number;
    cpc: number;
    cpm: number;
    frequency: number;
    conversions: number;
    revenue: number;
  }): NonNullable<RawMetaCampaign['insights']> {
    return {
      spend: String(m.spend),
      impressions: String(m.impressions),
      reach: String(m.reach),
      clicks: String(m.clicks),
      ctr: String(m.ctr),
      cpc: String(m.cpc),
      cpm: String(m.cpm),
      frequency: String(m.frequency),
      actions: [{ action_type: 'purchase', value: m.conversions }],
      action_values: [{ action_type: 'purchase', value: m.revenue }],
    };
  }
}
