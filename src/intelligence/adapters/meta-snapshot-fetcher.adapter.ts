import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { CompaniesService } from '../../companies/companies.service';
import { MetaMetricsService } from '../../campaigns/meta-ads/meta-metrics.service';
import { MetaSnapshotFetcher } from '../snapshot/meta-snapshot-fetcher.interface';
import {
  RawMetaAd,
  RawMetaAdSet,
  RawMetaBundle,
  RawMetaCampaign,
} from '../snapshot/snapshot.types';

const META_API_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Real MetaSnapshotFetcher. Delegates to the existing MetaMetricsService
 * (retry, backoff, action-value extraction, custom-conversion mapping
 * all preserved) and reshapes its output into RawMetaBundle so
 * SnapshotBuilder can normalize + derive.
 *
 * Refund haircut is NOT applied here: we pass refundRatePercent=0 to
 * MetaMetricsService so the returned ROAS is GROSS. SnapshotBuilder
 * then applies the haircut per the product config.
 */
@Injectable()
export class MetaSnapshotFetcherAdapter implements MetaSnapshotFetcher {
  private readonly log = new Logger(MetaSnapshotFetcherAdapter.name);
  constructor(
    private readonly metrics: MetaMetricsService,
    private readonly companies: CompaniesService,
  ) {}

  async fetch(input: {
    tenantId: string;
    campaignId: string;
    metaCampaignId: string;
  }): Promise<RawMetaBundle> {
    const company = await this.companies.findByTenantId(input.tenantId);
    if (!company) {
      throw new Error(`tenant not found: ${input.tenantId}`);
    }
    const accessToken = (company as { meta?: { accessToken?: string } }).meta
      ?.accessToken;
    if (!accessToken) {
      throw new Error(
        `tenant ${input.tenantId} has no meta.accessToken configured`,
      );
    }

    const product = this.pickProduct(company);
    const conversionValue = product?.conversionValue ?? 0;
    const conversionEvent = product?.conversionEvent;
    const customConversionId = product?.customConversionId;

    const full = await this.metrics.fetchFullMetrics(
      input.metaCampaignId,
      accessToken,
      conversionValue,
      conversionEvent,
      customConversionId,
      0, // refundRatePercent=0 — SnapshotBuilder applies the haircut instead
    );

    const now = new Date();
    // Meta's "maximum" preset means campaign-lifetime. windowStart is
    // effectively the launch date; if we don't have that, best proxy is
    // 90 days back.
    const metaWindowStart = new Date(now.getTime() - 90 * 86400 * 1000);
    const metaWindowEnd = now;

    const campaignInsights = this.toRawInsights({
      spend: full.campaign.spend,
      impressions: full.campaign.impressions,
      clicks: full.campaign.clicks,
      ctr: full.campaign.ctr,
      cpc: full.campaign.cpc,
      frequency: full.campaign.frequency,
      conversions: full.campaign.conversions,
      revenue: full.campaign.roas * full.campaign.spend,
    });

    const rawCampaign: RawMetaCampaign = {
      id: input.metaCampaignId,
      name: full.campaign.campaignName,
      objective: undefined,
      status: full.campaign.status,
      effective_status: full.campaign.status,
      account_id:
        (company as { meta?: { accountId?: string } }).meta?.accountId ?? '',
      insights: campaignInsights,
    };

    // Adset + ad revenue is synthesized as conversions × conversionValue.
    // MetaMetricsService doesn't return per-adset/ad action_values,
    // so this is our best proxy until we extend the fetcher upstream.
    const adSetRevenue = (conversions: number) => conversions * conversionValue;

    const rawAdSets: Record<string, RawMetaAdSet> = {};
    for (const as of full.adSets ?? []) {
      rawAdSets[as.adSetId] = {
        id: as.adSetId,
        name: as.adSetName,
        insights: this.toRawInsights({
          spend: as.spend,
          impressions: as.impressions,
          clicks: as.clicks,
          ctr: as.ctr,
          cpc: as.cpc,
          frequency: as.frequency ?? 0,
          conversions: as.conversions,
          revenue: adSetRevenue(as.conversions),
        }),
      };
    }

    const rawAds: Record<string, RawMetaAd> = {};
    for (const as of full.adSets ?? []) {
      for (const ad of (
        as as unknown as { ads?: Array<Record<string, unknown>> }
      ).ads ?? []) {
        const adId = String(ad.adId ?? ad.id ?? '');
        if (!adId) continue;
        const conversions = Number(ad.conversions ?? 0);
        rawAds[adId] = {
          id: adId,
          name: String(ad.adName ?? ad.name ?? ''),
          insights: this.toRawInsights({
            spend: Number(ad.spend ?? 0),
            impressions: Number(ad.impressions ?? 0),
            clicks: Number(ad.clicks ?? 0),
            ctr: Number(ad.ctr ?? 0),
            cpc: Number(ad.cpc ?? 0),
            frequency: Number(ad.frequency ?? 0),
            conversions,
            revenue: adSetRevenue(conversions),
          }),
        };
      }
    }

    // Supplemental enrichment — fetch fields MetaMetricsService doesn't return.
    // All GETs; nothing mutates. Non-fatal on failure.
    await this.enrichCampaign(
      rawCampaign,
      input.metaCampaignId,
      accessToken,
    ).catch((e) =>
      this.log.warn(`campaign enrichment failed for ${input.metaCampaignId}: ${(e as Error).message}`),
    );
    await this.enrichAds(
      rawAds,
      input.metaCampaignId,
      accessToken,
    ).catch((e) =>
      this.log.warn(`ad enrichment failed for ${input.metaCampaignId}: ${(e as Error).message}`),
    );

    return {
      campaign: rawCampaign,
      adSets: rawAdSets,
      ads: rawAds,
      metaWindowStart,
      metaWindowEnd,
    };
  }

  /**
   * Supplemental campaign-level fetch — grabs the fields that
   * MetaMetricsService doesn't return: reach, cpm, add_to_cart,
   * initiate_checkout counts, effective_status, learning_stage.
   *
   * All Graph API GETs. Zero writes.
   */
  private async enrichCampaign(
    rawCampaign: RawMetaCampaign,
    metaCampaignId: string,
    accessToken: string,
  ): Promise<void> {
    // Extra insight fields
    const insightsUrl = `${META_API_BASE}/${metaCampaignId}/insights`;
    const insightsRes = await axios.get(insightsUrl, {
      params: {
        fields: 'reach,cpm,cpp,actions,action_values,frequency,purchase_roas',
        date_preset: 'maximum',
        action_attribution_windows: JSON.stringify(['7d_click', '1d_view']),
        access_token: accessToken,
      },
      timeout: 15000,
    });
    const row = insightsRes.data?.data?.[0] ?? {};
    if (rawCampaign.insights) {
      // Merge without overwriting the already-set fields.
      const enriched = { ...rawCampaign.insights } as Record<string, unknown>;
      if (row.reach) enriched.reach = row.reach;
      if (row.cpm) enriched.cpm = row.cpm;
      // Enrich actions/action_values with add_to_cart + initiate_checkout counts.
      const extraActions = (row.actions ?? []).filter((a: { action_type: string }) =>
        ['add_to_cart', 'initiate_checkout', 'offsite_conversion.fb_pixel_add_to_cart', 'offsite_conversion.fb_pixel_initiate_checkout'].includes(
          a.action_type,
        ),
      );
      if (extraActions.length > 0) {
        const currentActions = (enriched.actions ?? []) as Array<{ action_type: string; value: number }>;
        const merged = [...currentActions];
        for (const a of extraActions) {
          if (!merged.find((m) => m.action_type === a.action_type)) merged.push(a);
        }
        enriched.actions = merged;
      }
      rawCampaign.insights = enriched as RawMetaCampaign['insights'];
    }

    // Campaign delivery + learning stage
    try {
      const campaignFieldsRes = await axios.get(`${META_API_BASE}/${metaCampaignId}`, {
        params: {
          fields: 'effective_status,configured_status,objective,special_ad_categories',
          access_token: accessToken,
        },
        timeout: 10000,
      });
      const d = campaignFieldsRes.data ?? {};
      if (d.effective_status) rawCampaign.effective_status = d.effective_status;
      if (d.objective) rawCampaign.objective = d.objective;
    } catch {
      /* non-critical */
    }
  }

  /**
   * Per-ad enrichment — quality_ranking, engagement_ranking,
   * conversion_ranking, video quartile watched counts, and ad name.
   *
   * Uses the campaign-level ads endpoint filtered to active ads with a
   * bulk insights request when possible.
   */
  private async enrichAds(
    rawAds: Record<string, RawMetaAd>,
    metaCampaignId: string,
    accessToken: string,
  ): Promise<void> {
    if (Object.keys(rawAds).length === 0) return;

    // Fetch per-ad ranking + video insights in one bulk call.
    //
    // Two Meta-specific quirks encoded here:
    //   1. Field names are `engagement_rate_ranking` + `conversion_rate_ranking`
    //      (with "_rate_"). The shorter names used previously return HTTP 400
    //      "Invalid parameter" — that's why every intelligence cycle warned
    //      "ad enrichment failed for X: 400". Meta silently returns zero rows
    //      but still 400s on the field-validation pass.
    //   2. Rankings are only computed over a rolling 7-day window. Any other
    //      date range (including 'maximum') returns UNKNOWN even for ads with
    //      500+ impressions. `date_preset=last_7d` is required.
    const insightsUrl = `${META_API_BASE}/${metaCampaignId}/insights`;
    const res = await axios.get(insightsUrl, {
      params: {
        fields:
          'ad_id,ad_name,quality_ranking,engagement_rate_ranking,conversion_rate_ranking,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions',
        level: 'ad',
        date_preset: 'last_7d',
        limit: 200,
        access_token: accessToken,
      },
      timeout: 20000,
    });
    const rows = (res.data?.data ?? []) as Array<{
      ad_id?: string;
      ad_name?: string;
      quality_ranking?: string;
      engagement_rate_ranking?: string;
      conversion_rate_ranking?: string;
      video_p25_watched_actions?: Array<{ value: number | string }>;
      video_p50_watched_actions?: Array<{ value: number | string }>;
      video_p75_watched_actions?: Array<{ value: number | string }>;
      video_p100_watched_actions?: Array<{ value: number | string }>;
    }>;

    for (const row of rows) {
      const adId = row.ad_id;
      if (!adId || !rawAds[adId]) continue;
      const ad = rawAds[adId];
      if (row.ad_name && !ad.name) ad.name = row.ad_name;
      if (row.quality_ranking) ad.quality_ranking = row.quality_ranking;
      if (row.engagement_rate_ranking) ad.engagement_ranking = row.engagement_rate_ranking;
      if (row.conversion_rate_ranking) ad.conversion_ranking = row.conversion_rate_ranking;
      // Copy video quartile fields into the ad's insights so the builder picks them up.
      if (row.video_p25_watched_actions || row.video_p50_watched_actions || row.video_p75_watched_actions || row.video_p100_watched_actions) {
        ad.insights = {
          ...(ad.insights ?? {}),
          video_p25_watched_actions: row.video_p25_watched_actions,
          video_p50_watched_actions: row.video_p50_watched_actions,
          video_p75_watched_actions: row.video_p75_watched_actions,
          video_p100_watched_actions: row.video_p100_watched_actions,
        } as RawMetaAd['insights'];
      }
    }
  }

  /**
   * Pick the first active product; fall back to whatever is available.
   * The Snapshot Engine guide §5 notes we use products[0] today —
   * multi-product allocation is a future extension.
   */
  private pickProduct(company: unknown):
    | {
        conversionValue?: number;
        conversionEvent?: string;
        customConversionId?: string;
        refundRatePercent?: number;
      }
    | undefined {
    const products = ((company as { products?: Array<Record<string, unknown>> })
      .products ?? []) as Array<Record<string, unknown>>;
    const active = products.find((p) => p.active !== false) ?? products[0];
    if (!active) return undefined;
    return {
      conversionValue: this.numOrUndef(active.conversionValue),
      conversionEvent:
        typeof active.conversionEvent === 'string'
          ? active.conversionEvent
          : undefined,
      customConversionId:
        typeof active.customConversionId === 'string'
          ? active.customConversionId
          : undefined,
      refundRatePercent: this.numOrUndef(active.refundRatePercent),
    };
  }

  private numOrUndef(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  private toRawInsights(m: {
    spend: number;
    impressions: number;
    clicks: number;
    ctr: number;
    cpc: number;
    frequency: number;
    conversions: number;
    revenue: number;
  }): NonNullable<RawMetaCampaign['insights']> {
    return {
      spend: String(m.spend),
      impressions: String(m.impressions),
      clicks: String(m.clicks),
      ctr: String(m.ctr),
      cpc: String(m.cpc),
      frequency: String(m.frequency),
      actions: [{ action_type: 'purchase', value: m.conversions }],
      action_values: [{ action_type: 'purchase', value: m.revenue }],
    };
  }
}
