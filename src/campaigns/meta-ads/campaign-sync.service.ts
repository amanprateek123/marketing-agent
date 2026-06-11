import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { extractConversions, extractActionValue } from './conversion-extractor.util';
import {
  inferHookStyleFromCopy,
  inferAudienceType as sharedInferAudienceType,
  inferFormatFromCreative as sharedInferFormatFromCreative,
} from '../../common/creative/hook-inference.util';

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

const META_TO_INTERNAL_STATUS: Record<string, string> = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'completed',
  COMPLETED: 'completed',
  DELETED: 'completed',
  CAMPAIGN_PAUSED: 'paused',
  PENDING_REVIEW: 'pending_approval',
  DISAPPROVED: 'failed',
};

/**
 * CampaignSyncService — two-way sync between Meta and our campaigns collection.
 *
 * - Campaigns launched by our agent: source='agent', already in DB, gets metrics updated
 * - Campaigns created manually by tenant: source='manual', upserted from Meta data
 *
 * Called from:
 * 1. finalizeImport() — sync all 1yr historical campaigns after learning import
 * 2. Cron every 6h — sync only ACTIVE/PAUSED campaigns for real-time metrics
 */
@Injectable()
export class CampaignSyncService {
  private readonly logger = new Logger(CampaignSyncService.name);

  constructor(
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
  ) {}

  /**
   * Sync a list of enriched campaigns (already fetched during learning import).
   * Reuses data we already have — no extra Meta API calls.
   */
  async syncFromEnrichedData(
    tenantId: string,
    enrichedCampaigns: any[],
    conversionTypes: Set<string>,
  ): Promise<{ synced: number; created: number }> {
    let synced = 0;
    let created = 0;

    for (const campaign of enrichedCampaigns) {
      const insights = campaign.insights ?? {};
      const spend = parseFloat(insights.spend ?? '0');
      const impressions = parseInt(insights.impressions ?? '0', 10);
      const clicks = parseInt(insights.clicks ?? '0', 10);
      const ctr = parseFloat(insights.ctr ?? '0');
      const cpc = parseFloat(insights.cpc ?? '0');
      const conversions = this.extractConversions(insights.actions, conversionTypes);
      // Real ROAS: pull action_values from Meta. Each pixel event's `value`
      // param sums into action_values. ROAS = sum(value) / spend.
      const actionValue = extractActionValue(insights.action_values, conversionTypes);

      const metaStatus = campaign.status ?? 'PAUSED';
      const internalStatus = META_TO_INTERNAL_STATUS[metaStatus] ?? 'paused';

      // Build metaAdSets from enriched data
      const metaAdSets = this.buildMetaAdSets(campaign, conversionTypes);

      // ROAS resolution: prefer Meta-reported action_values (true value-tracked);
      // fall back to (conversions × 0) → 0 when neither available. The
      // syncFromEnrichedData path doesn't have product context here, so it can't
      // do the fallback-to-product.conversionValue trick — that's only available
      // in syncActiveCampaigns where we have company.products in scope.
      const roas = spend > 0 && actionValue > 0 ? actionValue / spend : 0;

      const existing = await this.campaignModel.findOne({
        tenantId,
        metaCampaignId: campaign.id,
      }).exec();

      if (existing) {
        await this.campaignModel.updateOne(
          { _id: existing._id },
          {
            $set: {
              name: campaign.name ?? '',
              status: internalStatus,
              spend, impressions, clicks, conversions, roas, ctr, cpc,
              metaAdSets,
              syncedAt: new Date(),
            },
          },
        );
        synced++;
      } else {
        await this.campaignModel.create({
          tenantId,
          name: campaign.name ?? '',
          runId: '',
          briefId: '',
          source: 'manual',
          metaCampaignId: campaign.id,
          topic: '',
          angle: '',
          status: internalStatus,
          budget: parseFloat(campaign.daily_budget ?? campaign.lifetime_budget ?? '0') / 100,
          objective: campaign.objective ?? '',
          launchedAt: campaign.start_time ? new Date(campaign.start_time) : undefined,
          spend, impressions, clicks, conversions, roas, ctr, cpc,
          metaAdSets,
          syncedAt: new Date(),
        });
        created++;
      }
    }

    this.logger.log(`Sync complete: ${synced} updated, ${created} new manual campaigns for ${tenantId}`);
    return { synced, created };
  }

  /**
   * Sync only ACTIVE/PAUSED campaigns from Meta — for the 6h cron job.
   * Fast call — only fetches running campaigns with current metrics.
   */
  async syncActiveCampaigns(company: CompanyDocument): Promise<{ synced: number }> {
    const tenantId = company.tenantId;
    const { accessToken } = company.meta!;

    const normalizeAccountId = (id: string) => id.startsWith('act_') ? id : `act_${id}`;
    const accountIds = ((company.meta!.accountIds?.length ?? 0) > 0
      ? company.meta!.accountIds!
      : [company.meta!.accountId]
    ).map(normalizeAccountId);

    // Build conversionTypes from BOTH standard events AND each product's custom
    // conversion ID. Without the per-product custom IDs, sync reports 0
    // conversions for products that rely on custom conversions (e.g. Nadi Leaf
    // uses customConversionId=1534101314938858 — without `offsite_conversion.
    // custom.1534101314938858` in this Set, the actions array from Meta is
    // silently filtered out as non-matching). Hit on 2026-06-10: 5 actual
    // conversions reported as 0.
    const conversionTypes = new Set<string>([
      'purchase', 'offsite_conversion.fb_pixel_purchase', 'lead',
      'offsite_conversion.fb_pixel_lead', 'complete_registration',
    ]);
    for (const p of (company.products ?? [])) {
      if (p.customConversionId) {
        conversionTypes.add(`offsite_conversion.custom.${p.customConversionId}`);
      }
      // Also include custom event names (when product fires a named custom event
      // like NADI_REPORT_PURCHASE_COMPLETED instead of a custom conversion).
      if (p.customEventName) {
        conversionTypes.add(p.customEventName);
      }
    }
    // For fallback ROAS calc when Meta returns no action_values (pixel didn't
    // fire with value param): use product.conversionValue ?? product.price.
    // Indexed by custom conversion ID to attribute per-product correctly.
    const fallbackValueByConversionType = new Map<string, number>();
    for (const p of (company.products ?? [])) {
      const v = p.conversionValue ?? p.price ?? 0;
      if (v > 0 && p.customConversionId) {
        fallbackValueByConversionType.set(`offsite_conversion.custom.${p.customConversionId}`, v);
      }
    }

    let totalSynced = 0;

    for (const accountId of accountIds) {
      try {
        // Fetch only active/paused campaigns with insights in one call
        const filtering = JSON.stringify([
          { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
        ]);

        // Campaigns — paginated. limit=200 was exactly hitting the cap for
        // 91astrology (200 active+paused campaigns) → certainty that some
        // campaigns were silently truncated. Following paging.next surfaces
        // the full list.
        const res = await this.fetchAllPages(
          `${META_API_BASE}/${accountId}/campaigns`,
          {
            fields: 'id,name,status,objective,daily_budget,lifetime_budget,start_time',
            filtering,
            limit: '200',
            access_token: accessToken,
          },
          `Campaigns ${accountId}`,
        );

        const campaigns: any[] = res.data?.data ?? [];

        // Fetch insights for these campaigns in one bulk call (paginated).
        const campaignIds = campaigns.map(c => c.id);
        if (campaignIds.length === 0) continue;

        const insightsRes = await this.fetchAllPagesChunked(
          `${META_API_BASE}/${accountId}/insights`,
          {
            fields: 'campaign_id,spend,impressions,clicks,ctr,cpc,actions,action_values',
            level: 'campaign',
            date_preset: 'maximum',
            limit: '200',
            access_token: accessToken,
          },
          'campaign.id',
          campaignIds,
          `Campaign insights ${accountId}`,
        );

        const insightsMap = new Map<string, any>();
        for (const row of insightsRes.data?.data ?? []) {
          insightsMap.set(row.campaign_id, row);
        }
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Ad-set metadata — paginated + chunked. Across 200+ active+paused
        // campaigns × 1-3 ad sets each, easily exceeds limit=500. Filtering by
        // hundreds of campaign IDs also overflows Meta's URL cap.
        const adSetsRes = await this.fetchAllPagesChunked(
          `${META_API_BASE}/${accountId}/adsets`,
          {
            fields: 'id,name,status,campaign_id,daily_budget,lifetime_budget,optimization_goal',
            filtering: JSON.stringify([
              { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
            ]),
            limit: '500',
            access_token: accessToken,
          },
          'campaign.id',
          campaignIds,
          `AdSets ${accountId}`,
        );
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Ad-set insights — paginated + chunked by campaign IDs.
        const adSetInsightsRes = await this.fetchAllPagesChunked(
          `${META_API_BASE}/${accountId}/insights`,
          {
            fields: 'adset_id,spend,impressions,clicks,ctr,cpc,actions,action_values,frequency',
            level: 'adset',
            date_preset: 'maximum',
            limit: '500',
            access_token: accessToken,
          },
          'campaign.id',
          campaignIds,
          `AdSet insights ${accountId}`,
        );
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Ads — paginated. With many active campaigns × 4 variants each,
        // total active ads can exceed limit=500. Without paging some ads
        // get dropped from adsByAdSet → metaAdSets[].ads[] missing entries.
        const activeCampaignIds = campaigns.filter(c => c.status === 'ACTIVE').map(c => c.id);
        const adsRes = activeCampaignIds.length > 0
          ? await this.fetchAllPagesChunked(
              `${META_API_BASE}/${accountId}/ads`,
              {
                fields: 'id,name,status,adset_id,creative{id,name,object_story_spec},insights{spend,impressions,clicks,ctr,cpc,actions,action_values}',
                filtering: JSON.stringify([
                  { field: 'effective_status', operator: 'IN', value: ['ACTIVE'] },
                ]),
                limit: '500',
                access_token: accessToken,
              },
              'campaign.id',
              activeCampaignIds,
              `Ads ${accountId}`,
            )
          : { data: { data: [] } };

        // Group ad sets and insights by campaign_id
        const adSetsByCampaign = new Map<string, any[]>();
        for (const adSet of adSetsRes.data?.data ?? []) {
          const list = adSetsByCampaign.get(adSet.campaign_id) ?? [];
          list.push(adSet);
          adSetsByCampaign.set(adSet.campaign_id, list);
        }

        const adSetInsightsMap = new Map<string, any>();
        for (const row of adSetInsightsRes.data?.data ?? []) {
          adSetInsightsMap.set(row.adset_id, row);
        }

        // Build ads lookup by adset_id
        const adsByAdSet = new Map<string, any[]>();
        for (const ad of adsRes.data?.data ?? []) {
          const list = adsByAdSet.get(ad.adset_id) ?? [];
          list.push(ad);
          adsByAdSet.set(ad.adset_id, list);
        }

        // Build ad insights map from embedded insights{} on each ad
        const adInsightsMap = new Map<string, any>();
        for (const ad of adsRes.data?.data ?? []) {
          const insightRow = ad.insights?.data?.[0];
          if (insightRow) adInsightsMap.set(ad.id, insightRow);
        }

        for (const campaign of campaigns) {
          const insights = insightsMap.get(campaign.id) ?? {};
          const spend = parseFloat(insights.spend ?? '0');
          const impressions = parseInt(insights.impressions ?? '0', 10);
          const clicks = parseInt(insights.clicks ?? '0', 10);
          const ctr = parseFloat(insights.ctr ?? '0');
          const cpc = parseFloat(insights.cpc ?? '0');
          const conversions = this.extractConversions(insights.actions, conversionTypes);
          const internalStatus = META_TO_INTERNAL_STATUS[campaign.status] ?? 'active';

          // Build metaAdSets from fetched ad sets + insights + ads
          const metaAdSets = (adSetsByCampaign.get(campaign.id) ?? []).map((as: any) => {
            // Build ads for this adset — full metrics for active campaigns, metadata only for paused
            const ads = (adsByAdSet.get(as.id) ?? []).map((ad: any) => {
              const adi = adInsightsMap.get(ad.id) ?? {};
              const creative = ad.creative ?? {};
              const format = this.inferFormatFromCreative(creative, ad.name ?? '');
              const hookStyle = this.inferHookStyle(
                ad.name ?? '',
                creative.object_story_spec?.link_data?.message ?? creative.object_story_spec?.video_data?.message ?? '',
                creative.name ?? '',
              );
              return {
                id: ad.id,
                name: ad.name ?? '',
                status: (META_TO_INTERNAL_STATUS[ad.status] ?? ad.status ?? '').toLowerCase(),
                hookStyle,
                format,
                spend: parseFloat(adi.spend ?? '0'),
                impressions: parseInt(adi.impressions ?? '0', 10),
                clicks: parseInt(adi.clicks ?? '0', 10),
                ctr: parseFloat(adi.ctr ?? '0'),
                cpc: parseFloat(adi.cpc ?? '0'),
                conversions: this.extractConversions(adi.actions, conversionTypes),
              };
            });

            // Aggregate adset metrics: ALWAYS prefer the ad-set-level insights
            // from Meta (canonical source). Previously: "if ads have data, sum
            // ads — else fall back to adset insights." That logic broke for any
            // ad set with paused ads, because the `/ads` query filters
            // `effective_status IN [ACTIVE]` — so paused ads' historical spend
            // is excluded from the rollup, while the ad-set-level insights
            // include EVERY ad (active + paused). Symptom: Nadi Leaf's
            // ADV-PLUS_BROAD showed ₹38 (only active ads' visible spend) when
            // Meta's true cumulative was ₹3,702. Hit 2026-06-11.
            const asi = adSetInsightsMap.get(as.id) ?? {};
            const asSpend = parseFloat(asi.spend ?? '0');
            const asImpressions = parseInt(asi.impressions ?? '0', 10);
            const asClicks = parseInt(asi.clicks ?? '0', 10);
            const asConversions = this.extractConversions(asi.actions, conversionTypes);
            const asCtr = asImpressions > 0 ? (asClicks / asImpressions) * 100 : 0;
            const asCpc = asClicks > 0 ? asSpend / asClicks : 0;
            const asCpa = asConversions > 0 ? asSpend / asConversions : 0;
            const asFrequency = parseFloat(asi.frequency ?? '0');

            return {
              id: as.id,
              name: as.name,
              status: (META_TO_INTERNAL_STATUS[as.status] ?? as.status).toLowerCase(),
              audienceType: this.inferAudienceType(as.name ?? ''),
              dailyBudget: parseFloat(as.daily_budget ?? '0') / 100,
              lifetimeBudget: parseFloat(as.lifetime_budget ?? '0') / 100,
              optimizationGoal: as.optimization_goal ?? '',
              spend: asSpend,
              impressions: asImpressions,
              clicks: asClicks,
              conversions: asConversions,
              ctr: asCtr,
              cpc: asCpc,
              cpa: asCpa,
              frequency: asFrequency,
              ads,
            };
          });

          await this.campaignModel.updateOne(
            { tenantId, metaCampaignId: campaign.id },
            {
              $set: {
                name: campaign.name ?? '',
                status: internalStatus,
                spend, impressions, clicks, conversions, ctr, cpc,
                metaAdSets,
                syncedAt: new Date(),
              },
              $setOnInsert: {
                tenantId,
                runId: '',
                briefId: '',
                source: 'manual',
                metaCampaignId: campaign.id,
                topic: '',
                angle: '',
                budget: parseFloat(campaign.daily_budget ?? campaign.lifetime_budget ?? '0') / 100,
                objective: campaign.objective ?? '',
                launchedAt: campaign.start_time ? new Date(campaign.start_time) : undefined,
              },
            },
            { upsert: true },
          );
          totalSynced++;
          await new Promise(resolve => setTimeout(resolve, 200));
        }

        this.logger.log(`Active campaign sync: ${campaigns.length} campaigns, ad sets fetched from ${accountId}`);
      } catch (err: any) {
        this.logger.warn(`Active sync failed for ${accountId}: ${err.message}`);
      }

      // Delay between accounts to avoid Meta user request rate limits
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    return { synced: totalSynced };
  }

  private async fetchWithRetry(
    fn: () => Promise<any>,
    label: string,
    retries = 2,
    backoffMs = 15000,
  ): Promise<any> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const msg = err.response?.data?.error?.message ?? err.message ?? '';
        const isRateLimit = msg.toLowerCase().includes('limit reached') || msg.toLowerCase().includes('rate');
        if (isRateLimit && attempt < retries) {
          this.logger.warn(`${label} rate limited, retrying in ${backoffMs / 1000}s (attempt ${attempt}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        } else {
          this.logger.warn(`${label} failed: ${msg}`);
          return { data: { data: [] } };
        }
      }
    }
    return { data: { data: [] } };
  }

  /**
   * Chunked + paginated fetch for endpoints that filter on a list of IDs.
   * Meta's filter param has a max URL length (~5000 chars). For tenants
   * with 200+ campaigns, an `IN [...]` filter listing all campaign IDs
   * overflows that → request returns no data (silent failure, since the
   * URL got truncated).
   *
   * Chunks the ID list into batches (default 50 ≈ 850 chars of IDs), runs
   * fetchAllPages per chunk, merges results. Use for any /insights call
   * that filters by campaign.id, ad set ID, or ad ID across many entities.
   */
  private async fetchAllPagesChunked(
    initialUrl: string,
    baseParams: any,
    filterField: string,         // e.g. 'campaign.id'
    ids: string[],
    label: string,
    chunkSize = 50,
  ): Promise<{ data: { data: any[] } }> {
    const allRows: any[] = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      // Compose filtering: merge any base filtering with the chunk's ID list.
      const baseFiltering = baseParams.filtering ? JSON.parse(baseParams.filtering) : [];
      // Drop any existing filter on filterField so the chunk's IDs are the
      // only constraint on that field.
      const otherFilters = baseFiltering.filter((f: any) => f.field !== filterField);
      const filtering = JSON.stringify([
        ...otherFilters,
        { field: filterField, operator: 'IN', value: chunk },
      ]);
      const chunkParams = { ...baseParams, filtering };
      const res = await this.fetchAllPages(initialUrl, chunkParams, `${label} chunk ${i / chunkSize + 1}/${Math.ceil(ids.length / chunkSize)}`);
      allRows.push(...(res.data?.data ?? []));
    }
    this.logger.log(`${label}: ${allRows.length} rows fetched across ${Math.ceil(ids.length / chunkSize)} chunks`);
    return { data: { data: allRows } };
  }

  /**
   * Paginated Meta Graph API fetch. Follows `paging.next` cursor URLs until
   * the page returns empty or the maxPages cap is hit.
   *
   * Why this helper exists: Meta's bulk endpoints (`/insights`, `/ads`,
   * `/campaigns`, `/customaudiences`) return up to `limit` rows + a cursor.
   * Setting `limit=500` and ignoring the cursor silently truncates the
   * response — symptoms include missing ad sets in adSetInsightsMap, missing
   * audiences in pre-launch validation, etc. We've hit this three times so
   * far (custom audiences, ad-set insights, and now generalized). 20-page
   * hard cap is defensive — bounded total of 20 × limit rows; protects
   * against runaway cursor loops.
   *
   * Returns `{ data: { data: [...] } }` shape mirroring axios .data for
   * drop-in compatibility with existing call sites that expected
   * axios-response objects.
   */
  private async fetchAllPages(
    initialUrl: string,
    initialParams: any,
    label: string,
    maxPages = 20,
  ): Promise<{ data: { data: any[] } }> {
    const rows: any[] = [];
    let url: string | null = initialUrl;
    let params: any = initialParams;
    for (let page = 0; page < maxPages && url; page++) {
      try {
        const res: any = await axios.get(url, { params, timeout: 60000 });
        rows.push(...(res.data?.data ?? []));
        // Meta returns paging.next as a fully-qualified URL with cursor
        // embedded. Pass with no params on subsequent pages.
        url = res.data?.paging?.next ?? null;
        params = undefined;
      } catch (err: any) {
        this.logger.warn(`${label} fetch failed (page ${page}): ${err.response?.data?.error?.message ?? err.message}`);
        url = null;
      }
    }
    this.logger.log(`${label}: ${rows.length} rows fetched across pages`);
    return { data: { data: rows } };
  }

  private buildMetaAdSets(campaign: any, conversionTypes: Set<string>): any[] {
    const adSets: any[] = campaign.adSets ?? [];
    const adSetInsights: any[] = campaign.adSetInsights ?? [];
    const adInsights: any[] = campaign.adInsights ?? [];
    const ads: any[] = campaign.ads ?? [];

    // Build raw adset lookup by ID for supplementary data (budget, optimization_goal)
    const rawAdSetById = new Map<string, any>();
    const rawAdSetByName = new Map<string, any>();
    for (const adSet of adSets) {
      if (adSet.id) rawAdSetById.set(String(adSet.id), adSet);
      if (adSet.name) rawAdSetByName.set(adSet.name, adSet);
    }

    // Iterate over adSetInsights as source of truth — only adsets with actual spend/activity
    return adSetInsights.map((insight: any) => {
      const adsetId = String(insight.adset_id ?? '');
      const adsetName = insight.adset_name ?? '';

      // Get supplementary data from raw adsets (budget, optimization_goal)
      const raw = rawAdSetById.get(adsetId) ?? rawAdSetByName.get(adsetName) ?? {};

      const spend = parseFloat(insight.spend ?? '0');
      const impressions = parseInt(insight.impressions ?? '0', 10);
      const clicks = parseInt(insight.clicks ?? '0', 10);
      const ctr = parseFloat(insight.ctr ?? '0');
      const frequency = parseFloat(insight.frequency ?? '0');
      const conversions = this.extractConversions(insight.actions, conversionTypes);
      const cpa = conversions > 0 ? spend / conversions : 0;
      const audienceType = this.inferAudienceType(adsetName);

      // Build ads for this adset — matched by adset_id
      const adSetAds = adInsights
        .filter((ad: any) => String(ad.adset_id) === adsetId)
        .map((ad: any) => {
          const creative = ads.find((a: any) => a.name === ad.ad_name);
          const format = this.inferFormatFromCreative(creative?.creative, ad.ad_name ?? '');
          const hookStyle = this.inferHookStyle(
            ad.ad_name ?? '',
            creative?.creative?.object_story_spec?.link_data?.message ?? creative?.creative?.object_story_spec?.video_data?.message ?? '',
            '',
          );
          return {
            id: ad.ad_id ?? '',
            name: ad.ad_name ?? '',
            hookStyle,
            format,
            spend: parseFloat(ad.spend ?? '0'),
            impressions: parseInt(ad.impressions ?? '0', 10),
            clicks: parseInt(ad.clicks ?? '0', 10),
            ctr: parseFloat(ad.ctr ?? '0'),
            cpc: parseFloat(ad.cpc ?? '0'),
          };
        });

      return {
        id: adsetId,
        name: adsetName,
        status: raw.status ?? '',
        audienceType,
        dailyBudget: parseFloat(raw.daily_budget ?? '0') / 100,
        lifetimeBudget: parseFloat(raw.lifetime_budget ?? '0') / 100,
        optimizationGoal: raw.optimization_goal ?? '',
        spend, impressions, clicks, conversions, ctr, cpa, frequency,
        ads: adSetAds,
      };
    });
  }

  // Inference helpers delegated to shared util (single source of truth).
  // Was: divergent regex banks producing 9 styles incl `ugc / question /
  // fear_then_relief / curiosity / personal_story` — none of which exist in
  // the canonical hook-styles taxonomy used by Day-7 saturation + replacement.
  private inferAudienceType(adSetName: string): string {
    return sharedInferAudienceType(adSetName);
  }

  private inferFormatFromCreative(creative: any, adName: string): string {
    return sharedInferFormatFromCreative(creative, adName);
  }

  private inferHookStyle(adName: string, copyBody: string, copyTitle: string): string {
    return inferHookStyleFromCopy(adName, copyBody, copyTitle);
  }

  private extractConversions(actions: any[] | undefined, conversionTypes: Set<string>): number {
    return extractConversions(actions, conversionTypes);
  }
}
