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
  MetricProvenance,
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
 * Revenue provenance: campaign-sync stores canonical refund-net revenue but
 * that value may be either a Meta action value or a configured estimate. The
 * adapter now transports the canonical net separately from the exact raw Meta
 * gross value, so SnapshotBuilder preserves the number without relabeling an
 * estimate as action_values. Legacy documents without provenance retain the
 * old gross-transport compatibility path until they are refreshed by sync.
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

    // Product resolution remains necessary for the legacy compatibility path
    // that reverses a persisted net Meta value when row-level provenance has
    // not yet been backfilled.
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
    const c = campaign as any;
    const now = new Date();
    // campaign.syncedAt is when campaign-sync last actually wrote this doc —
    // a real freshness signal (SnapshotValidator's freshness score was
    // previously always ~1.0 because the old adapter synthesized "now" as
    // the window end regardless of how stale the underlying fetch was).
    const persistedMetricsSyncedAt =
      c.metricsSyncedAt ??
      // Legacy documents predate row-level provenance. Once the boolean is
      // present, never substitute a structure/status sync timestamp for a
      // missing metrics timestamp.
      (c.metricsRowObserved === undefined ? c.syncedAt : undefined);
    const syncedAtCandidate = persistedMetricsSyncedAt
      ? new Date(persistedMetricsSyncedAt)
      : undefined;
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

    const campaignMetricProvenance = this.toMetricProvenance(
      c,
      sourceMetricsSyncedAt,
    );
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
      actionValueGross: this.transportActionValueGross(c, refundFactor),
      goalResultInputs: campaignMetricProvenance?.goalResultInputs,
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
      productName: this.textOrUndefined(c.productName),
      objective: c.objective || undefined,
      budgetModel:
        c.budgetModel === 'abo' ||
        c.budgetModel === 'cbo' ||
        c.budgetModel === 'asc'
          ? c.budgetModel
          : undefined,
      status: this.upperTextOrUndefined(c.effectiveStatus || c.status),
      effective_status: this.textOrUndefined(c.effectiveStatus),
      account_id: c.metaAccountId ?? '',
      learning_stage: learningStage,
      metricProvenance: campaignMetricProvenance,
      insights: campaignInsights,
    };

    const rawAdSets: Record<string, RawMetaAdSet> = {};
    const rawAds: Record<string, RawMetaAd> = {};
    for (const as of (c.metaAdSets ?? []) as any[]) {
      if (!as.id) continue;
      const adSetMetricProvenance = this.toMetricProvenance(
        as,
        sourceMetricsSyncedAt,
      );
      rawAdSets[as.id] = {
        id: as.id,
        name: as.name ?? '',
        status: this.textOrUndefined(as.status),
        effectiveStatus: this.textOrUndefined(as.effectiveStatus),
        audienceType: this.textOrUndefined(as.audienceType),
        optimizationGoal: this.textOrUndefined(as.optimizationGoal),
        landingPageViews: this.numberOrUndefined(as.landingPageView),
        inlineLinkClicks: this.numberOrUndefined(as.inlineLinkClicks),
        thruplay: this.numberOrUndefined(as.thruplay),
        metricProvenance: adSetMetricProvenance,
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
          actionValueGross: this.transportActionValueGross(as, refundFactor),
          goalResultInputs: adSetMetricProvenance?.goalResultInputs,
          addToCart: this.numberOrUndefined(as.addToCart),
          initiateCheckout: this.numberOrUndefined(as.initiateCheckout),
          landingPageViews: this.numberOrUndefined(as.landingPageView),
        }),
      };

      for (const ad of (as.ads ?? []) as any[]) {
        if (!ad.id) continue;
        const adMetricProvenance = this.toMetricProvenance(
          ad,
          sourceMetricsSyncedAt,
        );
        const last7dMetricProvenance = ad.last7d
          ? this.toMetricProvenance(ad.last7d, sourceMetricsSyncedAt)
          : undefined;
        rawAds[ad.id] = {
          id: ad.id,
          name: ad.name ?? '',
          adSetId: as.id,
          status: this.textOrUndefined(ad.status),
          effectiveStatus: this.textOrUndefined(ad.effectiveStatus),
          hookStyle: ad.hookStyle,
          format: ad.format,
          copyVariantIndex: this.numberOrUndefined(ad.copyVariantIndex),
          creativeId: this.textOrUndefined(ad.creativeId),
          creativeName: this.textOrUndefined(ad.creativeName),
          creativeBody: this.textOrUndefined(ad.creativeBody),
          creativeTitle: this.textOrUndefined(ad.creativeTitle),
          creativeCta: this.textOrUndefined(ad.creativeCta),
          creativeLinkUrl: this.textOrUndefined(ad.creativeLinkUrl),
          creativeVideoId: this.textOrUndefined(ad.creativeVideoId),
          creativeImageHash: this.textOrUndefined(ad.creativeImageHash),
          thumbnailUrl: this.textOrUndefined(ad.thumbnailUrl),
          isDynamicCreative:
            typeof ad.isDynamicCreative === 'boolean'
              ? ad.isDynamicCreative
              : undefined,
          landingPageViews: this.numberOrUndefined(ad.landingPageView),
          inlineLinkClicks: this.numberOrUndefined(ad.inlineLinkClicks),
          outboundClicks: this.numberOrUndefined(ad.outboundClicks),
          video3s: this.numberOrUndefined(ad.video3s),
          thruplay: this.numberOrUndefined(ad.thruplay),
          metricProvenance: adMetricProvenance,
          last7d: ad.last7d
            ? this.toRawInsights({
                spend: this.numberOrUndefined(ad.last7d.spend),
                impressions: this.numberOrUndefined(ad.last7d.impressions),
                clicks: this.numberOrUndefined(ad.last7d.clicks),
                ctr: this.numberOrUndefined(ad.last7d.ctr),
                conversions: this.numberOrUndefined(ad.last7d.conversions),
                actionValueGross: this.transportActionValueGross(
                  ad.last7d,
                  refundFactor,
                ),
                goalResultInputs: last7dMetricProvenance?.goalResultInputs,
              })
            : undefined,
          last7dMetricProvenance,
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
              actionValueGross: this.transportActionValueGross(
                ad,
                refundFactor,
              ),
              goalResultInputs: adMetricProvenance?.goalResultInputs,
              addToCart: this.numberOrUndefined(ad.addToCart),
              initiateCheckout: this.numberOrUndefined(ad.initiateCheckout),
              landingPageViews: this.numberOrUndefined(ad.landingPageView),
            }),
            video_p25_watched_actions: this.actionArray(ad.videoP25),
            video_p50_watched_actions: this.actionArray(ad.videoP50),
            video_p75_watched_actions: this.actionArray(ad.videoP75),
            video_p100_watched_actions: this.actionArray(ad.videoP100),
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
    spend?: number;
    impressions?: number;
    reach?: number;
    clicks?: number;
    ctr?: number;
    cpc?: number;
    cpm?: number;
    frequency?: number;
    conversions?: number;
    actionValueGross?: number;
    goalResultInputs?: MetricProvenance['goalResultInputs'];
    addToCart?: number;
    initiateCheckout?: number;
    landingPageViews?: number;
  }): NonNullable<RawMetaCampaign['insights']> {
    const insights: NonNullable<RawMetaCampaign['insights']> = {};
    this.assignRawString(insights, 'spend', m.spend);
    this.assignRawString(insights, 'impressions', m.impressions);
    this.assignRawString(insights, 'reach', m.reach);
    this.assignRawString(insights, 'clicks', m.clicks);
    this.assignRawString(insights, 'ctr', m.ctr);
    this.assignRawString(insights, 'cpc', m.cpc);
    this.assignRawString(insights, 'cpm', m.cpm);
    this.assignRawString(insights, 'frequency', m.frequency);

    const actions: NonNullable<RawMetaCampaign['insights']>['actions'] = [];
    const exactCounts = m.goalResultInputs?.actionCounts;
    if (exactCounts !== undefined) {
      for (const [actionType, value] of Object.entries(exactCounts)) {
        if (Number.isFinite(value)) {
          actions.push({ action_type: actionType, value });
        }
      }
    } else {
      // Backward-compatible transport for legacy Campaign documents that do
      // not retain exact aliases. New rows use goalResultInputs and therefore
      // never relabel a lead/install/custom event as a purchase.
      if (m.conversions !== undefined) {
        actions.push({ action_type: 'purchase', value: m.conversions });
      }
      if (m.addToCart !== undefined) {
        actions.push({ action_type: 'add_to_cart', value: m.addToCart });
      }
      if (m.initiateCheckout !== undefined) {
        actions.push({
          action_type: 'initiate_checkout',
          value: m.initiateCheckout,
        });
      }
      if (m.landingPageViews !== undefined) {
        actions.push({
          action_type: 'landing_page_view',
          value: m.landingPageViews,
        });
      }
    }
    if (actions.length > 0) insights.actions = actions;
    const exactActionValues = m.goalResultInputs?.actionValuesGross;
    if (exactActionValues !== undefined) {
      const actionValues = Object.entries(exactActionValues)
        .filter(([, value]) => Number.isFinite(value))
        .map(([actionType, value]) => ({
          action_type: actionType,
          value,
        }));
      if (actionValues.length > 0) insights.action_values = actionValues;
    } else if (m.actionValueGross !== undefined) {
      insights.action_values = [
        { action_type: 'purchase', value: m.actionValueGross },
      ];
    }
    return insights;
  }

  private assignRawString(
    insights: NonNullable<RawMetaCampaign['insights']>,
    key:
      | 'spend'
      | 'impressions'
      | 'reach'
      | 'clicks'
      | 'ctr'
      | 'cpc'
      | 'cpm'
      | 'frequency',
    value: number | undefined,
  ): void {
    if (value !== undefined) insights[key] = String(value);
  }

  private actionArray(
    value: unknown,
  ): Array<{ value: number | string }> | undefined {
    const parsed = this.numberOrUndefined(value);
    return parsed === undefined ? undefined : [{ value: parsed }];
  }

  private transportActionValueGross(
    source: Record<string, unknown>,
    refundFactor: number,
  ): number | undefined {
    const exact = this.numberOrUndefined(source.rawMetaActionValueGross);
    if (exact !== undefined) return exact;
    const basis = this.textOrUndefined(source.revenueBasis);
    if (basis && basis !== 'meta_action_value') return undefined;
    const persistedNet = this.numberOrUndefined(source.revenue);
    return persistedNet === undefined ? undefined : persistedNet / refundFactor;
  }

  private toMetricProvenance(
    source: Record<string, unknown>,
    fallbackSyncedAt: Date | null,
  ): MetricProvenance | undefined {
    const metricsSyncedAt = this.dateOrUndefined(source.metricsSyncedAt);
    const metricsLastAttemptedAt = this.dateOrUndefined(
      source.metricsLastAttemptedAt,
    );
    const goalResultInputs = this.goalResultInputsOrUndefined(
      source.goalResultInputs,
    );
    const state = this.metricStateOrUndefined(source.metricsState);
    const revenueBasis = this.revenueBasisOrUndefined(source.revenueBasis);
    const revenueAttributionSource = this.revenueSourceOrUndefined(
      source.revenueAttributionSource,
    );
    const provenance: MetricProvenance = {
      rowObserved:
        typeof source.metricsRowObserved === 'boolean'
          ? source.metricsRowObserved
          : undefined,
      fetchComplete:
        typeof source.metricsFetchComplete === 'boolean'
          ? source.metricsFetchComplete
          : undefined,
      state,
      source: this.textOrUndefined(source.metricsSource),
      sourceFingerprint: this.textOrUndefined(source.metricsSourceFingerprint),
      currency: this.currencyOrUndefined(source.metricsCurrency),
      metricsSyncedAt: metricsSyncedAt ?? fallbackSyncedAt ?? undefined,
      metricsLastAttemptedAt,
      dateStart: this.textOrUndefined(
        source.metricsDateStart ?? source.dateStart,
      ),
      dateStop: this.textOrUndefined(source.metricsDateStop ?? source.dateStop),
      attributionSpec: source.attributionSpec,
      promotedObject: source.promotedObject,
      revenueBasis,
      revenueAttributionSource,
      revenueAttributionActionTypes: this.stringArrayOrUndefined(
        source.revenueAttributionActionTypes,
      ),
      canonicalConversions: this.numberOrUndefined(source.conversions),
      canonicalRevenueNet: this.numberOrUndefined(source.revenue),
      rawMetaActionValueGross: this.numberOrUndefined(
        source.rawMetaActionValueGross,
      ),
      rawMetaActionValueNet: this.numberOrUndefined(
        source.rawMetaActionValueNet,
      ),
      configuredRevenueEstimateNet: this.numberOrUndefined(
        source.configuredRevenueEstimateNet,
      ),
      goalResultInputs,
    };
    return Object.values(provenance).some((value) => value !== undefined)
      ? provenance
      : undefined;
  }

  private metricStateOrUndefined(value: unknown): MetricProvenance['state'] {
    return value === 'observed' ||
      value === 'preserved' ||
      value === 'missing' ||
      value === 'unknown'
      ? value
      : undefined;
  }

  private revenueBasisOrUndefined(
    value: unknown,
  ): MetricProvenance['revenueBasis'] {
    return value === 'meta_action_value' ||
      value === 'configured_conversion_value' ||
      value === 'no_attributed_revenue' ||
      value === 'unknown'
      ? value
      : undefined;
  }

  private revenueSourceOrUndefined(
    value: unknown,
  ): MetricProvenance['revenueAttributionSource'] {
    return value === 'custom_conversion' ||
      value === 'custom_event' ||
      value === 'standard_event' ||
      value === 'app_event' ||
      value === 'account_fallback' ||
      value === 'unresolved' ||
      value === 'unknown'
      ? value
      : undefined;
  }

  private stringArrayOrUndefined(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private goalResultInputsOrUndefined(
    value: unknown,
  ): MetricProvenance['goalResultInputs'] {
    if (!value || typeof value !== 'object') return undefined;
    const row = value as Record<string, unknown>;
    const actionCounts = this.numberRecordOrUndefined(row.actionCounts);
    const actionValuesGross = this.numberRecordOrUndefined(
      row.actionValuesGross,
    );
    return actionCounts !== undefined || actionValuesGross !== undefined
      ? { actionCounts, actionValuesGross }
      : undefined;
  }

  private numberRecordOrUndefined(
    value: unknown,
  ): Record<string, number> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, raw]): [string, number | undefined] => [
        key.trim(),
        this.numberOrUndefined(raw),
      ])
      .filter((entry): entry is [string, number] =>
        Boolean(entry[0] && entry[1] !== undefined),
      );
    return Object.fromEntries(entries);
  }

  private dateOrUndefined(value: unknown): Date | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isFinite(date.getTime()) ? date : undefined;
  }

  private currencyOrUndefined(value: unknown): string | undefined {
    const normalized = this.textOrUndefined(value)?.toUpperCase();
    return normalized && /^[A-Z]{3}$/.test(normalized) ? normalized : undefined;
  }

  private numberOrUndefined(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private textOrUndefined(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private upperTextOrUndefined(value: unknown): string | undefined {
    return this.textOrUndefined(value)?.toUpperCase();
  }
}
