import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';

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
  ): Promise<FullCampaignMetrics> {
    const [campaign, adSets] = await Promise.all([
      this.fetchCampaignMetrics(campaignId, accessToken, conversionValue, conversionEvent),
      this.fetchAdSetMetrics(campaignId, accessToken, conversionEvent),
    ]);

    // Fetch per-ad metrics for each ad set in parallel
    const adSetsWithAds = await Promise.all(
      adSets.map(async (adSet) => {
        const ads = await this.fetchAdMetrics(adSet.adSetId, accessToken, conversionEvent);
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
  ): Promise<CampaignMetrics> {
    this.logger.log(`Fetching campaign metrics: ${campaignId}`);

    const [insightsRes, campaignRes] = await Promise.all([
      this.metaApiGet(
        `${META_API_BASE}/${campaignId}/insights`,
        {
          fields: 'impressions,clicks,spend,ctr,cpc,actions,frequency',
          date_preset: 'maximum',
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
    const conversions = this.extractConversions(data.actions, conversionEvent);
    const spend = parseFloat(data.spend ?? '0');

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
      roas: conversions > 0 ? (conversions * conversionValue) / spend : 0,
      frequency: parseFloat(data.frequency ?? '0'),
    };
  }

  /**
   * Ad set level metrics for a campaign.
   */
  async fetchAdSetMetrics(
    campaignId: string,
    accessToken: string,
    conversionEvent?: string,
  ): Promise<AdSetMetrics[]> {
    this.logger.log(`Fetching ad set metrics: campaign=${campaignId}`);

    const response = await this.metaApiGet(
      `${META_API_BASE}/${campaignId}/insights`,
      {
        fields: 'adset_id,adset_name,impressions,clicks,spend,ctr,cpc,actions,frequency,reach',
        level: 'adset',
        date_preset: 'maximum',
        access_token: accessToken,
      },
    );

    const adSets: AdSetMetrics[] = (response.data?.data ?? []).map((d: any) => {
      const spend = parseFloat(d.spend ?? '0');
      const conversions = this.extractConversions(d.actions, conversionEvent);
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
   */
  async fetchAdMetrics(
    adSetId: string,
    accessToken: string,
    conversionEvent?: string,
  ): Promise<AdMetrics[]> {
    const response = await this.metaApiGet(
      `${META_API_BASE}/${adSetId}/insights`,
      {
        fields: 'ad_id,ad_name,impressions,clicks,spend,ctr,cpc,actions',
        level: 'ad',
        date_preset: 'maximum',
        access_token: accessToken,
      },
    );

    return (response.data?.data ?? []).map((d: any) => {
      const conversions = this.extractConversions(d.actions, conversionEvent);
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
      ?? [conversionEvent?.toLowerCase() ?? 'purchase', 'offsite_conversion'];

    const match = actions.find((a: any) =>
      patterns.some(p => a.action_type === p || a.action_type?.includes(p)),
    );

    // Fallback: if no match for specific event, try generic offsite_conversion
    if (!match) {
      const generic = actions.find((a: any) => a.action_type === 'offsite_conversion');
      return parseInt(generic?.value ?? '0', 10);
    }

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
