import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { extractConversions, extractActionValue } from './conversion-extractor.util';

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;
const RETRYABLE_ERROR_CODES = [2, 17, 341, 368];

export interface CampaignMetrics {
  campaignId: string;
  campaignName: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: number;
  cpa: number;
  roas: number;
  frequency: number;
}

export interface AdSetMetrics {
  adSetId: string;
  adSetName: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: number;
  cpa: number;
  frequency: number;
  reach: number;
}

export interface AdMetrics {
  adId: string;
  adName: string;
  adSetId: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: number;
}

export interface FullCampaignMetrics {
  campaign: CampaignMetrics;
  adSets: (AdSetMetrics & { ads: AdMetrics[] })[];
}

/**
 * Meta Metrics Service — fetches campaign, ad set, and ad level metrics
 * directly from Meta Graph API. No Claude/LLM involved.
 *
 * Used by CampaignAuditorService every 6 hours.
 */
@Injectable()
export class MetaMetricsService {
  private readonly logger = new Logger(MetaMetricsService.name);

  /**
   * Fetch full metrics hierarchy: campaign → ad sets → ads.
   */
  async fetchFullMetrics(
    campaignId: string,
    accessToken: string,
    conversionValue: number,
    conversionEvent?: string,
    /**
     * Custom Conversion ID — when provided, `offsite_conversion.custom.<id>`
     * is added to the conversionTypes Set so events tracked via the custom
     * conversion get counted. Without this, products using only custom
     * conversions (e.g. Nadi Leaf with 1534101314938858) report 0 conversions
     * across the entire audit + metrics chain.
     */
    customConversionId?: string,
  ): Promise<FullCampaignMetrics> {
    const [campaign, adSets] = await Promise.all([
      this.fetchCampaignMetrics(campaignId, accessToken, conversionValue, conversionEvent, customConversionId),
      this.fetchAdSetMetrics(campaignId, accessToken, conversionEvent, customConversionId),
    ]);

    // Fetch per-ad metrics for each ad set in parallel
    const adSetsWithAds = await Promise.all(
      adSets.map(async (adSet) => {
        const ads = await this.fetchAdMetrics(adSet.adSetId, accessToken, conversionEvent, customConversionId);
        return { ...adSet, ads };
      }),
    );

    return { campaign, adSets: adSetsWithAds };
  }

  /**
   * Campaign-level metrics.
   */
  async fetchCampaignMetrics(
    campaignId: string,
    accessToken: string,
    conversionValue: number,
    conversionEvent?: string,
    customConversionId?: string,
  ): Promise<CampaignMetrics> {
    this.logger.log(`Fetching campaign metrics: ${campaignId}`);

    const [insightsRes, campaignRes] = await Promise.all([
      this.metaApiGet(
        `${META_API_BASE}/${campaignId}/insights`,
        {
          fields: 'impressions,clicks,spend,ctr,cpc,actions,action_values,frequency',
          date_preset: 'maximum',
          // Pin attribution windows so audit-time ROAS is reproducible regardless of
          // the account's UI default. 7d-click + 1d-view = Meta's modern default for
          // DR campaigns; matches what the auditor expects when judging Day-3 profitability.
          action_attribution_windows: JSON.stringify(['7d_click', '1d_view']),
          access_token: accessToken,
        },
      ),
      this.metaApiGet(
        `${META_API_BASE}/${campaignId}`,
        {
          fields: 'name,status',
          access_token: accessToken,
        },
      ),
    ]);

    const data = insightsRes.data?.data?.[0] ?? {};
    // extractConversions accepts an optional Set<string>. The old code passed
    // `conversionEvent` (a bare string like "CustomEvent" or "Purchase") which
    // failed the `.size > 0` check inside extractConversions and silently
    // returned 0 conversions for every campaign using a Custom Conversion.
    // Hit on 2026-06-10: Nadi Leaf had 5 conversions, audit reported 0.
    const conversionTypes = this.buildConversionTypesSet(conversionEvent);
    if (customConversionId) {
      conversionTypes.add(`offsite_conversion.custom.${customConversionId}`);
    }
    const conversions = extractConversions(data.actions, conversionTypes);
    const spend = parseFloat(data.spend ?? '0');
    // Real ROAS from Meta's action_values (sum of pixel event `value` params).
    // Fall back to (conversions × conversionValue) when action_values is empty
    // — which happens for products where the pixel doesn't fire with a value.
    const actionValue = extractActionValue(data.action_values, conversionTypes);
    const roas = spend > 0
      ? (actionValue > 0
          ? actionValue / spend
          : (conversions > 0 && conversionValue > 0 ? (conversions * conversionValue) / spend : 0))
      : 0;

    return {
      campaignId,
      campaignName: campaignRes.data?.name ?? '',
      status: campaignRes.data?.status ?? 'UNKNOWN',
      spend,
      impressions: parseInt(data.impressions ?? '0', 10),
      clicks: parseInt(data.clicks ?? '0', 10),
      conversions,
      ctr: parseFloat(data.ctr ?? '0'),
      cpc: parseFloat(data.cpc ?? '0'),
      cpa: conversions > 0 ? spend / conversions : 0,
      roas,
      frequency: parseFloat(data.frequency ?? '0'),
    };
  }

  /**
   * Translate a single conversionEvent string (the per-product config field)
   * into the Set<string> shape that extractConversions / extractActionValue
   * expect. Handles: standard events (Purchase, Lead, etc), CustomEvent flag,
   * and bare custom conversion IDs.
   *
   * This is a temporary bridge until all callers pass the resolved product
   * directly. For now it accepts the same loose strings the existing API uses.
   */
  private buildConversionTypesSet(conversionEvent?: string): Set<string> {
    const set = new Set<string>([
      'purchase', 'offsite_conversion.fb_pixel_purchase',
      'lead', 'offsite_conversion.fb_pixel_lead',
      'complete_registration',
    ]);
    if (!conversionEvent) return set;
    const lower = conversionEvent.toLowerCase();
    // Standard event → already covered by base set above.
    if (['purchase', 'lead', 'completeregistration', 'subscribe'].includes(lower)) return set;
    // Custom event name (e.g. NADI_REPORT_PURCHASE_COMPLETED) — add as-is.
    if (conversionEvent !== 'CustomEvent') set.add(conversionEvent);
    // The Custom Conversion ID path is handled by passing the resolved Set in
    // from the caller (audit-side wrapper builds it from product.customConversionId).
    return set;
  }

  /**
   * Ad set level metrics for a campaign.
   *
   * customConversionId threading mirrors fetchCampaignMetrics — without it,
   * products using only a Custom Conversion (Nadi Leaf) report 0 conversions
   * per ad set, so the auditor can't tell which audience is converting.
   */
  async fetchAdSetMetrics(
    campaignId: string,
    accessToken: string,
    conversionEvent?: string,
    customConversionId?: string,
  ): Promise<AdSetMetrics[]> {
    this.logger.log(`Fetching ad set metrics: campaign=${campaignId}`);

    const response = await this.metaApiGet(
      `${META_API_BASE}/${campaignId}/insights`,
      {
        fields: 'adset_id,adset_name,impressions,clicks,spend,ctr,cpc,actions,action_values,frequency,reach',
        level: 'adset',
        date_preset: 'maximum',
        action_attribution_windows: JSON.stringify(['7d_click', '1d_view']),
        access_token: accessToken,
      },
    );

    const conversionTypes = this.buildConversionTypesSet(conversionEvent);
    if (customConversionId) {
      conversionTypes.add(`offsite_conversion.custom.${customConversionId}`);
    }

    const adSets: AdSetMetrics[] = (response.data?.data ?? []).map((d: any) => {
      const spend = parseFloat(d.spend ?? '0');
      const conversions = extractConversions(d.actions, conversionTypes);
      return {
        adSetId: d.adset_id,
        adSetName: d.adset_name ?? '',
        status: 'ACTIVE', // insights only return for active/recently active
        spend,
        impressions: parseInt(d.impressions ?? '0', 10),
        clicks: parseInt(d.clicks ?? '0', 10),
        conversions,
        ctr: parseFloat(d.ctr ?? '0'),
        cpc: parseFloat(d.cpc ?? '0'),
        cpa: conversions > 0 ? spend / conversions : 0,
        frequency: parseFloat(d.frequency ?? '0'),
        reach: parseInt(d.reach ?? '0', 10),
      };
    });

    this.logger.log(`Ad set metrics: ${adSets.length} ad sets for campaign ${campaignId}`);
    return adSets;
  }

  /**
   * Ad level metrics for an ad set.
   * customConversionId threading mirrors fetchCampaignMetrics.
   */
  async fetchAdMetrics(
    adSetId: string,
    accessToken: string,
    conversionEvent?: string,
    customConversionId?: string,
  ): Promise<AdMetrics[]> {
    const response = await this.metaApiGet(
      `${META_API_BASE}/${adSetId}/insights`,
      {
        fields: 'ad_id,ad_name,impressions,clicks,spend,ctr,cpc,actions,action_values',
        level: 'ad',
        date_preset: 'maximum',
        action_attribution_windows: JSON.stringify(['7d_click', '1d_view']),
        access_token: accessToken,
      },
    );

    const conversionTypes = this.buildConversionTypesSet(conversionEvent);
    if (customConversionId) {
      conversionTypes.add(`offsite_conversion.custom.${customConversionId}`);
    }

    return (response.data?.data ?? []).map((d: any) => {
      const conversions = extractConversions(d.actions, conversionTypes);
      return {
        adId: d.ad_id,
        adName: d.ad_name ?? '',
        adSetId,
        status: 'ACTIVE',
        spend: parseFloat(d.spend ?? '0'),
        impressions: parseInt(d.impressions ?? '0', 10),
        clicks: parseInt(d.clicks ?? '0', 10),
        conversions,
        ctr: parseFloat(d.ctr ?? '0'),
        cpc: parseFloat(d.cpc ?? '0'),
      };
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Fetch account-level CPM / CPC / CTR trend for last 7 days vs prior 7 days.
   * Used by the auditor for two distinct purposes:
   *   1. "Notice" — render market environment in the prompt so the LLM knows about exogenous shifts.
   *   2. "Control" (DiD) — subtract the account-level CTR change from the campaign's CTR drop
   *      so creativeFatigue only fires on genuinely-campaign-specific decline, not market-wide spikes.
   */
  async fetchAccountEnvironment(
    accountId: string,
    accessToken: string,
  ): Promise<{
    last7CPM: number;
    prior7CPM: number;
    last7CPC: number;
    prior7CPC: number;
    last7CTR: number;
    prior7CTR: number;
    cpmChangePct: number;     // +ve = CPM rising (more expensive)
    cpcChangePct: number;
    ctrChangePct: number;     // -ve = account-wide CTR declining (used for DiD adjustment)
    trend: 'spiking' | 'rising' | 'stable' | 'falling';
  } | null> {
    const acctRef = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
    try {
      // Fetch last 7d and prior 7d in parallel
      const [last7, prior7] = await Promise.all([
        this.metaApiGet(`${META_API_BASE}/${acctRef}/insights`, {
          fields: 'cpm,cpc,ctr',
          date_preset: 'last_7d',
          access_token: accessToken,
        }),
        this.metaApiGet(`${META_API_BASE}/${acctRef}/insights`, {
          fields: 'cpm,cpc,ctr',
          // last_14d minus last_7d ≈ days 8-14 ago
          time_range: this.priorWeekRange(),
          access_token: accessToken,
        }),
      ]);

      const last = last7.data?.data?.[0];
      const prior = prior7.data?.data?.[0];
      if (!last || !prior) return null;

      const last7CPM = parseFloat(last.cpm ?? '0');
      const prior7CPM = parseFloat(prior.cpm ?? '0');
      const last7CPC = parseFloat(last.cpc ?? '0');
      const prior7CPC = parseFloat(prior.cpc ?? '0');
      const last7CTR = parseFloat(last.ctr ?? '0');
      const prior7CTR = parseFloat(prior.ctr ?? '0');

      const cpmChangePct = prior7CPM > 0 ? ((last7CPM - prior7CPM) / prior7CPM) * 100 : 0;
      const cpcChangePct = prior7CPC > 0 ? ((last7CPC - prior7CPC) / prior7CPC) * 100 : 0;
      const ctrChangePct = prior7CTR > 0 ? ((last7CTR - prior7CTR) / prior7CTR) * 100 : 0;

      const trend: 'spiking' | 'rising' | 'stable' | 'falling' =
        cpmChangePct > 30 ? 'spiking'
        : cpmChangePct > 10 ? 'rising'
        : cpmChangePct < -10 ? 'falling'
        : 'stable';

      return {
        last7CPM, prior7CPM, last7CPC, prior7CPC, last7CTR, prior7CTR,
        cpmChangePct, cpcChangePct, ctrChangePct, trend,
      };
    } catch (err: any) {
      this.logger.warn(`Account environment fetch failed: ${err.message} — proceeding without it`);
      return null;
    }
  }

  /** @deprecated Use fetchAccountEnvironment — kept for backward compat with any out-of-tree callers. */
  async fetchAccountCpmEnvironment(accountId: string, accessToken: string) {
    return this.fetchAccountEnvironment(accountId, accessToken);
  }

  /**
   * Per-placement breakdown of campaign performance. Used by the auditor to
   * recommend `narrow_placement` actions with real evidence (e.g. "Audience Network
   * is bleeding ₹2k with 0 conv, drop it"). Without this, the agent has to guess
   * which placement is the bleeder.
   */
  async fetchPlacementBreakdown(
    campaignId: string,
    accessToken: string,
    conversionEvent?: string,
  ): Promise<Array<{
    publisherPlatform: string;
    platformPosition: string;
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    cpa: number;
  }>> {
    try {
      const response = await this.metaApiGet(
        `${META_API_BASE}/${campaignId}/insights`,
        {
          fields: 'impressions,clicks,spend,ctr,actions',
          breakdowns: 'publisher_platform,platform_position',
          date_preset: 'maximum',
          access_token: accessToken,
        },
      );
      const rows: any[] = response.data?.data ?? [];
      return rows.map((r: any) => {
        const spend = parseFloat(r.spend ?? '0');
        const conversions = this.extractConversions(r.actions, conversionEvent);
        return {
          publisherPlatform: r.publisher_platform ?? 'unknown',
          platformPosition: r.platform_position ?? 'unknown',
          spend,
          impressions: parseInt(r.impressions ?? '0', 10),
          clicks: parseInt(r.clicks ?? '0', 10),
          conversions,
          ctr: parseFloat(r.ctr ?? '0'),
          cpa: conversions > 0 ? spend / conversions : 0,
        };
      });
    } catch (err: any) {
      this.logger.warn(`Placement breakdown fetch failed for ${campaignId}: ${err.message}`);
      return [];
    }
  }

  /**
   * Demographic + placement combined breakdown — age × gender × publisher_platform
   * × platform_position. This is the highest-resolution view Meta exposes on a
   * single insights call. Used by the demographic analyzer to surface insights
   * like "Nadi Leaf converts best for women 35-44 on Reels at ₹820 CPA vs men
   * 45-54 on Feed at ₹2,200 CPA" — the kind of granularity that the agent's
   * current aggregate audienceScores hides.
   *
   * Meta caps breakdown combinations; if the call fails with "too many
   * dimensions" the analyzer should fall back to splitting into two calls
   * (age+gender separately from publisher_platform+platform_position) and joining.
   *
   * MVP: just the fetcher. Analyzer in learning pipeline (not yet wired) will
   * consume this and write structured insights to company.learnings.
   */
  async fetchDemographicBreakdown(
    campaignId: string,
    accessToken: string,
    conversionEvent?: string,
  ): Promise<Array<{
    age: string;
    gender: string;
    publisherPlatform: string;
    platformPosition: string;
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    cpa: number;
  }>> {
    try {
      const response = await this.metaApiGet(
        `${META_API_BASE}/${campaignId}/insights`,
        {
          fields: 'impressions,clicks,spend,ctr,actions',
          breakdowns: 'age,gender,publisher_platform,platform_position',
          date_preset: 'maximum',
          access_token: accessToken,
        },
      );
      const rows: any[] = response.data?.data ?? [];
      return rows.map((r: any) => {
        const spend = parseFloat(r.spend ?? '0');
        const conversions = this.extractConversions(r.actions, conversionEvent);
        return {
          age: r.age ?? 'unknown',
          gender: r.gender ?? 'unknown',
          publisherPlatform: r.publisher_platform ?? 'unknown',
          platformPosition: r.platform_position ?? 'unknown',
          spend,
          impressions: parseInt(r.impressions ?? '0', 10),
          clicks: parseInt(r.clicks ?? '0', 10),
          conversions,
          ctr: parseFloat(r.ctr ?? '0'),
          cpa: conversions > 0 ? spend / conversions : 0,
        };
      });
    } catch (err: any) {
      this.logger.warn(`Demographic breakdown fetch failed for ${campaignId}: ${err.message} — falling back to split calls not yet implemented`);
      return [];
    }
  }

  /**
   * Day-of-week performance breakdown (last 14 days, aggregated). For verticals
   * with strong cultural day-of-week patterns (spirituality: Sunday peaks, Tuesday
   * weakness; B2B: weekday-only) the agent needs this to make dayparting recommendations
   * that match cultural reality, not just hour-of-day.
   *
   * Uses Meta's time_increment=1 (one row per day) for the last 14 days, then aggregates
   * to 7 day-of-week buckets client-side.
   */
  async fetchDayOfWeekBreakdown(
    campaignId: string,
    accessToken: string,
    conversionEvent?: string,
  ): Promise<Array<{
    dayOfWeek: number;             // 0=Sun, 6=Sat (matches Meta adset_schedule day numbering)
    dayLabel: string;              // 'Sun' | 'Mon' | ...
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    cvr: number;
    cpa: number;
  }>> {
    try {
      const response = await this.metaApiGet(
        `${META_API_BASE}/${campaignId}/insights`,
        {
          fields: 'impressions,clicks,spend,actions',
          time_increment: 1,
          date_preset: 'last_14d',
          access_token: accessToken,
        },
      );
      const rows: any[] = response.data?.data ?? [];

      // Aggregate per day-of-week (0=Sun..6=Sat).
      const buckets: { spend: number; impressions: number; clicks: number; conversions: number }[] =
        Array.from({ length: 7 }, () => ({ spend: 0, impressions: 0, clicks: 0, conversions: 0 }));

      for (const r of rows) {
        const dateStart: string = r.date_start ?? '';
        if (!dateStart) continue;
        // Parse YYYY-MM-DD as local date so getDay() returns the right DOW.
        const [y, m, d] = dateStart.split('-').map((n: string) => parseInt(n, 10));
        if (!y || !m || !d) continue;
        const dow = new Date(y, m - 1, d).getDay();
        const conversions = this.extractConversions(r.actions, conversionEvent);
        buckets[dow].spend += parseFloat(r.spend ?? '0');
        buckets[dow].impressions += parseInt(r.impressions ?? '0', 10);
        buckets[dow].clicks += parseInt(r.clicks ?? '0', 10);
        buckets[dow].conversions += conversions;
      }

      const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return buckets.map((b, i) => ({
        dayOfWeek: i,
        dayLabel: labels[i],
        spend: b.spend,
        impressions: b.impressions,
        clicks: b.clicks,
        conversions: b.conversions,
        ctr: b.impressions > 0 ? (b.clicks / b.impressions) * 100 : 0,
        cvr: b.clicks > 0 ? (b.conversions / b.clicks) * 100 : 0,
        cpa: b.conversions > 0 ? b.spend / b.conversions : 0,
      }));
    } catch (err: any) {
      this.logger.warn(`Day-of-week breakdown fetch failed for ${campaignId}: ${err.message}`);
      return [];
    }
  }

  /**
   * Hourly performance breakdown (in the ad account's timezone). Used for
   * `dayparting` recommendations. Returns one row per (hour-of-day, day-of-week)
   * combination if Meta supports the aggregation, or per hour-of-day otherwise.
   */
  async fetchHourlyBreakdown(
    campaignId: string,
    accessToken: string,
    conversionEvent?: string,
  ): Promise<Array<{
    hourOfDay: string;            // Meta returns "00:00:00 - 00:59:59" format
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    cpa: number;
  }>> {
    try {
      const response = await this.metaApiGet(
        `${META_API_BASE}/${campaignId}/insights`,
        {
          fields: 'impressions,clicks,spend,ctr,actions',
          breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone',
          date_preset: 'last_14d',
          access_token: accessToken,
        },
      );
      const rows: any[] = response.data?.data ?? [];
      return rows.map((r: any) => {
        const spend = parseFloat(r.spend ?? '0');
        const conversions = this.extractConversions(r.actions, conversionEvent);
        return {
          hourOfDay: r.hourly_stats_aggregated_by_advertiser_time_zone ?? 'unknown',
          spend,
          impressions: parseInt(r.impressions ?? '0', 10),
          clicks: parseInt(r.clicks ?? '0', 10),
          conversions,
          ctr: parseFloat(r.ctr ?? '0'),
          cpa: conversions > 0 ? spend / conversions : 0,
        };
      });
    } catch (err: any) {
      this.logger.warn(`Hourly breakdown fetch failed for ${campaignId}: ${err.message}`);
      return [];
    }
  }

  private priorWeekRange(): string {
    // Returns Meta's expected JSON-encoded time_range string for days 8-14 ago.
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const since = new Date(now.getTime() - 14 * day);
    const until = new Date(now.getTime() - 8 * day);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    return JSON.stringify({ since: fmt(since), until: fmt(until) });
  }

  private extractConversions(actions: any[] | undefined, conversionEvent?: string): number {
    if (!actions) return 0;

    // Map company conversion event to Meta action_type patterns
    const eventMap: Record<string, string[]> = {
      'Purchase': ['purchase', 'offsite_conversion.fb_pixel_purchase'],
      'Lead': ['lead', 'offsite_conversion.fb_pixel_lead'],
      'CompleteRegistration': ['complete_registration', 'offsite_conversion.fb_pixel_complete_registration'],
      'Subscribe': ['subscribe', 'offsite_conversion.fb_pixel_subscribe'],
      'AddToCart': ['add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'],
      'InitiateCheckout': ['initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'],
      'ViewContent': ['view_content', 'offsite_conversion.fb_pixel_view_content'],
    };

    const patterns = eventMap[conversionEvent ?? 'Purchase']
      ?? [conversionEvent?.toLowerCase() ?? 'purchase'];

    const match = actions.find((a: any) =>
      patterns.some(p => a.action_type === p || a.action_type?.includes(p)),
    );

    // No fallback to generic offsite_conversion — that counts ALL conversion types
    // (ViewContent + AddToCart + Purchase etc.) and inflates numbers.
    // If we can't find the specific event, report 0 rather than wrong data.
    return parseInt(match?.value ?? '0', 10);
  }

  private async metaApiGet(url: string, params: any): Promise<any> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await axios.get(url, { params, timeout: 30000 });
      } catch (err: any) {
        const metaErrorCode = (err as AxiosError<any>)?.response?.data?.error?.code;
        const isRetryable = RETRYABLE_ERROR_CODES.includes(metaErrorCode);

        if (isRetryable && attempt < 3) {
          const delay = [1000, 2000, 4000][attempt - 1];
          this.logger.warn(`Meta API error (code ${metaErrorCode}), retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        const errorMsg = (err as AxiosError<any>)?.response?.data?.error?.message ?? err.message;
        throw new Error(`Meta metrics API error: ${errorMsg}`);
      }
    }
  }
}
