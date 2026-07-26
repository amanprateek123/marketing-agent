import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../../pipeline/schemas/intelligence-brief.schema';
import { extractConversions, extractActionValue } from './conversion-extractor.util';
import { getEffectiveConversionValue, getRefundFactor } from '../../common/conversion-value.util';
import { buildProductResolver } from './product-resolver.util';
import { SafetyChecks } from '../campaign-creator/safety-checks';
import {
  fetchAllPages as sharedFetchAllPages,
  fetchAllPagesChunked as sharedFetchAllPagesChunked,
} from './meta-fetch.util';
import {
  inferHookStyleFromCopy,
  inferAudienceType as sharedInferAudienceType,
  inferFormatFromCreative as sharedInferFormatFromCreative,
} from '../../common/creative/hook-inference.util';

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

/**
 * Ad fields sourced from the account-wide "ad insights lifetime" call. When
 * that call fails outright (rate limit / timeout), every ad's `adi` falls
 * back to `{}` and these would silently be overwritten with zero for every
 * ad in the account — while campaign-level spend (a separate, independent
 * call) stays correct. Hit 2026-07-06: "Application request limit reached"
 * zeroed spend/revenue/conversions for all 540 ads across all 7 campaigns
 * in one sync cycle. On detected failure, these are preserved from the
 * previous sync instead of overwritten.
 */
const AD_LIFETIME_METRIC_FIELDS = [
  'spend', 'revenue', 'roas', 'cpc', 'cpm', 'cpa', 'aov',
  'impressions', 'reach', 'frequency', 'clicks', 'ctr',
  'inlineLinkClicks', 'outboundClicks', 'linkCtr',
  'conversions', 'addToCart', 'initiateCheckout', 'landingPageView', 'cvr',
  'video3s', 'thruplay', 'hookRate', 'holdRate',
  'videoP25', 'videoP50', 'videoP75', 'videoP100',
  'videoP25Pct', 'videoP50Pct', 'videoP75Pct', 'videoP100Pct',
  'dateStart', 'dateStop', 'last7d',
] as const;

/**
 * Campaign-level top-line fields, same preservation rule as
 * AD_LIFETIME_METRIC_FIELDS above but for the campaign insights call (round 3
 * of syncActiveCampaigns) — previously ungated: a rate-limited/empty response
 * for that call silently zeroed campaign.spend/impressions/clicks/conversions
 * via an unconditional $set, with only the audit loop's own live-fetch
 * "emptyFetchOnSpendingCampaign" check catching it after the fact. Now that
 * this sync is meant to be the sole source of truth other systems read from
 * (no live re-fetch behind it to catch a zeroed value), the same
 * preserve-on-failure guard used for ad-lifetime metrics applies here too.
 */
const CAMPAIGN_METRIC_FIELDS = [
  'spend', 'impressions', 'clicks', 'reach', 'conversions',
  'roas', 'ctr', 'cpc', 'cpm', 'frequency', 'revenue', 'dataAsOf',
] as const;

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
    @InjectModel(IntelligenceBrief.name)
    private readonly briefModel: Model<IntelligenceBriefDocument>,
  ) {}

  /**
   * Sync a list of enriched campaigns (already fetched during learning import).
   * Reuses data we already have — no extra Meta API calls.
   */
  async syncFromEnrichedData(
    tenantId: string,
    enrichedCampaigns: any[],
    conversionTypes: Set<string>,
    products?: any[],
  ): Promise<{ synced: number; created: number }> {
    let synced = 0;
    let created = 0;
    // Same refund-rate haircut syncActiveCampaigns applies (see there for
    // rationale) — a single tenant-wide active product, since this one-time
    // import path has no per-campaign brief/product resolution wired. Good
    // enough for historical import; syncActiveCampaigns is the sole recurring
    // writer active campaigns are actually consolidated onto.
    const defaultProduct = (products ?? []).find((p: any) => p.active);
    const refundFactor = getRefundFactor(defaultProduct);

    for (const campaign of enrichedCampaigns) {
      const insights = campaign.insights ?? {};
      const spend = parseFloat(insights.spend ?? '0');
      const impressions = parseInt(insights.impressions ?? '0', 10);
      const clicks = parseInt(insights.clicks ?? '0', 10);
      const ctr = parseFloat(insights.ctr ?? '0');
      const cpc = parseFloat(insights.cpc ?? '0');
      const conversions = this.extractConversions(insights.actions, conversionTypes);
      // Real ROAS: pull action_values from Meta. Each pixel event's `value`
      // param sums into action_values. ROAS = sum(value) / spend. Net down
      // by the refund haircut — this is gross pixel revenue otherwise.
      const actionValue = extractActionValue(insights.action_values, conversionTypes) * refundFactor;

      const metaStatus = campaign.status ?? 'PAUSED';
      const internalStatus = META_TO_INTERNAL_STATUS[metaStatus] ?? 'paused';

      // Build metaAdSets from enriched data
      const metaAdSets = this.buildMetaAdSets(campaign, conversionTypes);

      // ROAS resolution: prefer Meta-reported action_values (true value-tracked);
      // fall back to (conversions × 0) → 0 when neither available. The
      // syncFromEnrichedData path doesn't have per-campaign product context here, so it can't
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
      // Net of refunds — fallback revenue must match the audit chain's basis.
      const v = getEffectiveConversionValue(p);
      if (v > 0 && p.customConversionId) {
        fallbackValueByConversionType.set(`offsite_conversion.custom.${p.customConversionId}`, v);
      }
    }

    let totalSynced = 0;

    for (const accountId of accountIds) {
      try {
        // ACTIVE-only sync. Large accounts (91astrology has 454 campaigns)
        // burn through Meta's per-account API budget in minutes when we fetch
        // paused/archived campaigns too. Paused campaigns keep their
        // last-known state in Mongo; we only refresh what's live.
        const filtering = JSON.stringify([
          { field: 'effective_status', operator: 'IN', value: ['ACTIVE'] },
        ]);

        const res = await this.fetchAllPages(
          `${META_API_BASE}/${accountId}/campaigns`,
          {
            fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,bid_strategy,buying_type,smart_promotion_type,special_ad_categories,spend_cap',
            filtering,
            limit: '200',
            access_token: accessToken,
          },
          `Campaigns ${accountId}`,
        );

        const campaigns: any[] = res.data?.data ?? [];

        // Reconcile drift: the fetch above only returns currently-ACTIVE
        // campaigns, so a campaign that paused/archived/etc. since the last
        // sync (whether via our own auditor, a manual pause in Ads Manager,
        // or Meta's own automated rules) is silently absent from `campaigns`
        // — its Mongo status stays frozen at whatever it was the last time
        // it WAS active, potentially for days, with the dashboard showing
        // "active" for a campaign that's long since stopped spending. Runs
        // before the early-continue below so it still fires even when zero
        // campaigns are currently active (e.g. everything got paused).
        const activeMetaIdSet = new Set(campaigns.map(c => c.id));
        const staleActiveDocs = await this.campaignModel
          .find({ tenantId, status: 'active', metaCampaignId: { $nin: ['', null] } })
          .select('metaCampaignId metaAccountId')
          .lean()
          .exec();
        const staleIds = staleActiveDocs
          .filter((d) => {
            if (!d.metaCampaignId || activeMetaIdSet.has(d.metaCampaignId)) return false;
            // Multi-account tenants: a doc tagged with a DIFFERENT account's
            // id is never "stale relative to this account" — it simply
            // doesn't belong here. Without this guard, every other account's
            // still-active campaigns look like they fell out of THIS
            // account's active set, and since the reconcile re-fetch below
            // is also scoped to this account's own /campaigns edge, it can
            // never find them there and marks them 'completed' via the
            // "missing = assume deleted" fallback below. Hit 2026-07-15:
            // syncing 2 accounts sequentially flipped 6 genuinely-ACTIVE
            // campaigns on the first account to 'completed' during the
            // second account's reconcile pass. Untagged legacy docs (synced
            // before metaAccountId was backfilled here) fall through to the
            // old tenant-wide check since we can't tell which account they
            // belong to.
            if (accountIds.length > 1 && d.metaAccountId && d.metaAccountId !== accountId) return false;
            return true;
          })
          .map((d) => d.metaCampaignId as string);

        if (staleIds.length > 0) {
          const reconcileRes = await this.fetchAllPagesChunked(
            `${META_API_BASE}/${accountId}/campaigns`,
            { fields: 'id,status,updated_time', limit: '50', access_token: accessToken },
            'id',
            staleIds,
            `Reconcile drifted status ${accountId}`,
          );
          const seen = new Set<string>();
          for (const c of reconcileRes.data?.data ?? []) {
            seen.add(c.id);
            const newStatus = META_TO_INTERNAL_STATUS[c.status] ?? 'paused';
            // updated_time is Meta's own last-modified timestamp on the
            // campaign — the closest proxy to "when did this actually
            // pause" (no dedicated status-change-time field exists). Only
            // meaningful for the 'paused' outcome; other transitions don't
            // surface a pausedAt in the UI.
            const set: Record<string, unknown> = { status: newStatus, syncedAt: new Date() };
            if (newStatus === 'paused') {
              set.pausedAt = c.updated_time ? new Date(c.updated_time) : new Date();
              set.pauseReason = 'Detected outside our sync — paused via Ads Manager, Meta automated rules, or another tool';
            }
            await this.campaignModel.updateOne(
              { tenantId, metaCampaignId: c.id },
              { $set: set },
            );
          }
          // IDs Meta didn't return at all (deleted, or campaign-level access
          // revoked) — can't distinguish those cases from here, so fall back
          // to 'completed' rather than leaving them incorrectly 'active'.
          const missing = staleIds.filter((id) => !seen.has(id));
          if (missing.length > 0) {
            await this.campaignModel.updateMany(
              { tenantId, metaCampaignId: { $in: missing } },
              { $set: { status: 'completed', syncedAt: new Date() } },
            );
          }
          this.logger.log(
            `Reconciled ${staleIds.length} campaign(s) that left the active set for ${accountId}`,
          );
        }

        // Fetch insights ONLY for the active campaigns just returned.
        const campaignIds = campaigns.map(c => c.id);
        if (campaignIds.length === 0) continue;

        const insightsRes = await this.fetchAllPagesChunked(
          `${META_API_BASE}/${accountId}/insights`,
          {
            // reach/cpm/frequency/date_stop added alongside the pre-existing
            // fields — frequency feeds runSafetyRails' hard fatigue pause,
            // date_stop feeds the staleness gate's reporting-lag check, both
            // previously only available from the old audit loop's own live
            // fetch (meta-metrics.service.ts). This is the sole fetcher now.
            fields: 'campaign_id,spend,impressions,clicks,reach,ctr,cpc,cpm,frequency,actions,action_values,date_stop',
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

        // Detect a total fetch failure for THIS call (rate limit / timeout —
        // see CAMPAIGN_METRIC_FIELDS comment) and preload each campaign's
        // last-known top-line metrics so they can be preserved below instead
        // of zeroed. Mirrors the existing adLifetimeFetchFailed guard.
        const campaignInsightsFetchFailed = campaignIds.length > 0 && insightsMap.size === 0;
        const prevCampaignMetricsById = new Map<string, any>();
        if (campaignInsightsFetchFailed) {
          const existing = await this.campaignModel
            .find(
              { tenantId, metaCampaignId: { $in: campaignIds } },
              { metaCampaignId: 1, spend: 1, impressions: 1, clicks: 1, reach: 1, conversions: 1, roas: 1, ctr: 1, cpc: 1, cpm: 1, frequency: 1, revenue: 1, dataAsOf: 1 },
            )
            .lean()
            .exec();
          for (const c of existing) prevCampaignMetricsById.set((c as any).metaCampaignId, c);
          this.logger.warn(
            `Campaign insights fetch returned 0 rows for ${accountId} — preserving previous top-line metrics for ${prevCampaignMetricsById.size} campaigns instead of zeroing them`,
          );
        }

        // Per-campaign product resolution — needed for the refund-rate
        // haircut below (net-of-refund revenue is per-product, not
        // per-tenant). Batched once per account instead of once per campaign.
        const productByCampaign = await buildProductResolver(
          this.campaignModel,
          this.briefModel,
          tenantId,
          campaignIds,
          company.products,
        );

        await new Promise(resolve => setTimeout(resolve, 3000));

        // Ad-set metadata — restricted to ACTIVE campaigns only. Fetching ad
        // sets for every paused/archived campaign in a large account (454
        // campaigns × chunks of 10 IDs) burns through Meta's per-account API
        // budget in minutes and triggers "User request limit reached" errors
        // for the actively-running campaigns we actually care about.
        // For campaigns that later transition ACTIVE → PAUSED, their existing
        // metaAdSets stays in Mongo (see the write-preservation guard below).
        const activeMetaIds = campaigns
          .filter((c) => c.status === 'ACTIVE')
          .map((c) => c.id);

        const adSetsRes =
          activeMetaIds.length > 0
            ? await this.fetchAllPagesChunked(
                `${META_API_BASE}/${accountId}/adsets`,
                {
                  fields:
                    'id,name,status,campaign_id,daily_budget,lifetime_budget,optimization_goal,configured_status,effective_status,learning_stage_info,targeting,bid_amount,bid_strategy,billing_event,attribution_spec,promoted_object,start_time,end_time',
                  filtering: JSON.stringify([
                    { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
                  ]),
                  limit: '500',
                  access_token: accessToken,
                },
                'campaign.id',
                activeMetaIds,
                `AdSets ${accountId}`,
              )
            : { data: { data: [] } };
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Ad-set insights — same restriction. Only active campaigns get insights refreshed.
        const adSetInsightsRes =
          activeMetaIds.length > 0
            ? await this.fetchAllPagesChunked(
                `${META_API_BASE}/${accountId}/insights`,
                {
                  fields:
                    'adset_id,spend,impressions,reach,clicks,ctr,cpc,cpm,actions,action_values,frequency,quality_ranking,engagement_rate_ranking,conversion_rate_ranking,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,date_start,date_stop',
                  level: 'adset',
                  date_preset: 'maximum',
                  limit: '500',
                  access_token: accessToken,
                },
                'campaign.id',
                activeMetaIds,
                `AdSet insights ${accountId}`,
              )
            : { data: { data: [] } };
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Ads — paginated. With many active campaigns × 4 variants each,
        // total active ads can exceed limit=500. Without paging some ads
        // get dropped from adsByAdSet → metaAdSets[].ads[] missing entries.
        const activeCampaignIds = campaigns.filter(c => c.status === 'ACTIVE').map(c => c.id);
        const adsRes = activeCampaignIds.length > 0
          ? await this.fetchAllPagesChunked(
              `${META_API_BASE}/${accountId}/ads`,
              {
                // Meta only computes quality_/engagement_rate_/conversion_rate_ranking
                // over a rolling 7-day window — anything else returns UNKNOWN. We must
                // pass date_preset to the insights subquery, otherwise it defaults to
                // 'maximum' and every ranking comes back as UNKNOWN regardless of
                // impression volume. Lifetime ad metrics come from the separate
                // level=ad insights call below — this embedded query is the
                // rankings + recency window only.
                // thumbnail_width/height must be requested — Meta defaults
                // thumbnail_url to a tiny (often 64x64) image otherwise,
                // which is unusable for the ad preview lightbox.
                fields: 'id,name,status,effective_status,adset_id,creative.thumbnail_width(1080).thumbnail_height(1080){id,name,object_story_spec,asset_feed_spec,thumbnail_url},insights.date_preset(last_7d){spend,impressions,reach,clicks,ctr,cpc,cpm,actions,action_values,quality_ranking,engagement_rate_ranking,conversion_rate_ranking,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions}',
                // ACTIVE-only used to hide every ad inside a paused adset
                // (effective_status=ADSET_PAUSED) — 20 of 42 adsets had zero
                // ads despite ₹lakhs of historical spend, starving the
                // learning engine of past winners/losers.
                filtering: JSON.stringify([
                  {
                    field: 'effective_status',
                    operator: 'IN',
                    value: ['ACTIVE', 'PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED', 'WITH_ISSUES'],
                  },
                ]),
                // limit=500 with creative{asset_feed_spec} + embedded insights
                // trips Meta's per-request data cap ("Please reduce the amount
                // of data") now that paused ads are included — small pages +
                // one chunk per campaign, cursor-paging fetches the rest.
                limit: '50',
                access_token: accessToken,
              },
              'campaign.id',
              activeCampaignIds,
              `Ads ${accountId}`,
              1,
            )
          : { data: { data: [] } };
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Ad-level LIFETIME insights — the embedded insights above are last_7d
        // (required for rankings). Without this call, ad metrics were stored on
        // a 7-day window while adset/campaign metrics were lifetime — cross-
        // level math compared different windows, and 87% of ads showed zero
        // conversions purely because of the short window. Also fetches the
        // fields the embedded query never asked for: frequency, link clicks
        // vs all clicks, 3-sec video plays (hook rate), thruplay.
        const adLifetimeRes = activeCampaignIds.length > 0
          ? await this.fetchAllPagesChunked(
              `${META_API_BASE}/${accountId}/insights`,
              {
                fields:
                  'ad_id,adset_id,spend,impressions,reach,frequency,clicks,inline_link_clicks,outbound_clicks,ctr,cpc,cpm,actions,action_values,video_play_actions,video_thruplay_watched_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,date_start,date_stop',
                level: 'ad',
                date_preset: 'maximum',
                use_unified_attribution_setting: 'true',
                limit: '500',
                access_token: accessToken,
              },
              'campaign.id',
              activeCampaignIds,
              `Ad insights lifetime ${accountId}`,
            )
          : { data: { data: [] } };

        const adLifetimeMap = new Map<string, any>();
        for (const row of adLifetimeRes.data?.data ?? []) {
          if (row.ad_id) adLifetimeMap.set(row.ad_id, row);
        }

        // Detect a total fetch failure (see AD_LIFETIME_METRIC_FIELDS comment)
        // and preload each ad's last-known lifetime metrics so they can be
        // preserved instead of zeroed below.
        const adLifetimeFetchFailed = activeCampaignIds.length > 0 && adLifetimeMap.size === 0;
        const prevAdMetricsById = new Map<string, any>();
        if (adLifetimeFetchFailed) {
          const existing = await this.campaignModel
            .find({ tenantId, metaCampaignId: { $in: activeCampaignIds } }, { metaAdSets: 1 })
            .lean()
            .exec();
          for (const c of existing) {
            for (const as of (c as any).metaAdSets ?? []) {
              for (const ad of as.ads ?? []) if (ad.id) prevAdMetricsById.set(ad.id, ad);
            }
          }
          this.logger.warn(
            `Ad lifetime insights fetch returned 0 rows for ${accountId} — preserving previous money/funnel metrics for ${prevAdMetricsById.size} ads instead of zeroing them`,
          );
        }

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

        // Last-7d map from the embedded insights{} on each ad — this is the
        // rankings + recency window; lifetime metrics come from adLifetimeMap.
        const ad7dMap = new Map<string, any>();
        for (const ad of adsRes.data?.data ?? []) {
          const insightRow = ad.insights?.data?.[0];
          if (insightRow) ad7dMap.set(ad.id, insightRow);
        }

        for (const campaign of campaigns) {
          const insights = insightsMap.get(campaign.id) ?? {};
          const spend = parseFloat(insights.spend ?? '0');
          const impressions = parseInt(insights.impressions ?? '0', 10);
          const clicks = parseInt(insights.clicks ?? '0', 10);
          const reach = parseInt(insights.reach ?? '0', 10);
          const ctr = parseFloat(insights.ctr ?? '0');
          const cpc = parseFloat(insights.cpc ?? '0');
          const cpm = parseFloat(insights.cpm ?? '0');
          const frequency = parseFloat(insights.frequency ?? '0');
          const dataAsOf = insights.date_stop ?? null;
          const conversions = this.extractConversions(insights.actions, conversionTypes);
          const product = productByCampaign(campaign.id);
          const refundFactor = getRefundFactor(product);

          // Revenue + ROAS: prefer Meta's action_values (true pixel-tracked
          // revenue, GROSS — net it down by the product's refund rate, same
          // haircut meta-metrics.service.ts applies); fall back to
          // conversions × product.conversionValue (already net via
          // getEffectiveConversionValue in fallbackValueByConversionType)
          // when the pixel doesn't fire with a `value` param — that branch
          // must NOT be haircut again, or refunds get double-counted.
          let actionValue = extractActionValue(insights.action_values, conversionTypes);
          if (actionValue > 0) {
            actionValue = actionValue * refundFactor;
          } else if (conversions > 0) {
            // Pick the product-specific fallback: match any custom-conversion
            // that this campaign's insights.actions reported.
            for (const [type, val] of fallbackValueByConversionType.entries()) {
              if (this.hasActionOfType(insights.actions, type)) {
                actionValue = conversions * val;
                break;
              }
            }
          }
          let roas = spend > 0 && actionValue > 0 ? actionValue / spend : 0;

          // Preserve prior top-line metrics on a total fetch failure instead
          // of writing zeros (see CAMPAIGN_METRIC_FIELDS / the guard above).
          let finalSpend = spend, finalImpressions = impressions, finalClicks = clicks,
            finalReach = reach, finalConversions = conversions, finalRoas = roas,
            finalCtr = ctr, finalCpc = cpc, finalCpm = cpm, finalFrequency = frequency,
            finalRevenue = actionValue, finalDataAsOf = dataAsOf;
          if (campaignInsightsFetchFailed) {
            const prev = prevCampaignMetricsById.get(campaign.id);
            if (prev) {
              finalSpend = prev.spend ?? spend;
              finalImpressions = prev.impressions ?? impressions;
              finalClicks = prev.clicks ?? clicks;
              finalReach = prev.reach ?? reach;
              finalConversions = prev.conversions ?? conversions;
              finalRoas = prev.roas ?? roas;
              finalCtr = prev.ctr ?? ctr;
              finalCpc = prev.cpc ?? cpc;
              finalCpm = prev.cpm ?? cpm;
              finalFrequency = prev.frequency ?? frequency;
              finalRevenue = prev.revenue ?? actionValue;
              finalDataAsOf = prev.dataAsOf ?? dataAsOf;
            }
          }

          const internalStatus = META_TO_INTERNAL_STATUS[campaign.status] ?? 'active';

          // Build metaAdSets from fetched ad sets + insights + ads
          const metaAdSets = (adSetsByCampaign.get(campaign.id) ?? []).map((as: any) => {
            // Build ads for this adset — full metrics for active campaigns, metadata only for paused
            const ads = (adsByAdSet.get(as.id) ?? []).map((ad: any) => {
              const adi = adLifetimeMap.get(ad.id) ?? {};
              const ad7 = ad7dMap.get(ad.id) ?? {};
              const creative = ad.creative ?? {};
              const creativeAttrs = parseCreativeAttributes(creative);
              const format =
                creativeAttrs.format || this.inferFormatFromCreative(creative, ad.name ?? '');
              const hookStyle = this.inferHookStyle(
                ad.name ?? '',
                creativeAttrs.body ||
                  (creative.object_story_spec?.link_data?.message ?? creative.object_story_spec?.video_data?.message ?? ''),
                creativeAttrs.title || (creative.name ?? ''),
              );
              const adSpend = parseFloat(adi.spend ?? '0');
              const adImpressions = parseInt(adi.impressions ?? '0', 10);
              const adClicks = parseInt(adi.clicks ?? '0', 10);
              const adConversions = this.extractConversions(adi.actions, conversionTypes);
              let adActionValue = extractActionValue(adi.action_values, conversionTypes);
              if (adActionValue > 0) {
                adActionValue = adActionValue * refundFactor;
              } else if (adConversions > 0) {
                for (const [type, val] of fallbackValueByConversionType.entries()) {
                  if (this.hasActionOfType(adi.actions, type)) {
                    adActionValue = adConversions * val;
                    break;
                  }
                }
              }
              const adRoas = adSpend > 0 && adActionValue > 0 ? adActionValue / adSpend : 0;
              const adCpa = adConversions > 0 ? adSpend / adConversions : 0;
              const adCvr = adClicks > 0 ? (adConversions / adClicks) * 100 : 0;
              const adAov = adConversions > 0 ? adActionValue / adConversions : 0;
              const adAddToCart = countAction(adi.actions, ['add_to_cart', 'omni_add_to_cart']);
              const adInitiateCheckout = countAction(adi.actions, ['initiate_checkout', 'omni_initiated_checkout']);
              const adLandingPageView = countAction(adi.actions, ['landing_page_view', 'omni_landing_page_view']);
              const videoP25 = firstActionValue(adi.video_p25_watched_actions);
              const videoP50 = firstActionValue(adi.video_p50_watched_actions);
              const videoP75 = firstActionValue(adi.video_p75_watched_actions);
              const videoP100 = firstActionValue(adi.video_p100_watched_actions);
              const videoImp = adImpressions > 0 ? adImpressions : 0;
              const adInlineLinkClicks = parseInt(adi.inline_link_clicks ?? '0', 10);
              const adOutboundClicks = firstActionValue(adi.outbound_clicks);
              // 3-sec plays + thruplay → hook rate (stopped the scroll) and
              // hold rate (kept watching) — the two numbers creative learning
              // actually correlates with winners.
              const adVideo3s = firstActionValue(adi.video_play_actions);
              const adThruplay = firstActionValue(adi.video_thruplay_watched_actions);
              const ad7Conversions = this.extractConversions(ad7.actions, conversionTypes);
              const ad7Spend = parseFloat(ad7.spend ?? '0');
              const builtAd = {
                id: ad.id,
                name: ad.name ?? '',
                status: (META_TO_INTERNAL_STATUS[ad.status] ?? ad.status ?? '').toLowerCase(),
                effectiveStatus: ad.effective_status ?? '',
                hookStyle,
                format,
                creativeId: creative.id ?? '',
                creativeName: creative.name ?? '',
                // Creative attributes (parsed from object_story_spec / asset_feed_spec)
                creativeBody: creativeAttrs.body,
                creativeTitle: creativeAttrs.title,
                creativeCta: creativeAttrs.cta,
                creativeLinkUrl: creativeAttrs.linkUrl,
                creativeVideoId: creativeAttrs.videoId,
                creativeImageHash: creativeAttrs.imageHash,
                thumbnailUrl: creative.thumbnail_url ?? '',
                isDynamicCreative: creativeAttrs.isDynamicCreative,
                // Money (lifetime window — same basis as adset/campaign)
                spend: adSpend,
                revenue: adActionValue,
                roas: adRoas,
                cpc: parseFloat(adi.cpc ?? '0'),
                cpm: parseFloat(adi.cpm ?? '0'),
                cpa: adCpa,
                aov: adAov,
                // Reach / delivery
                impressions: adImpressions,
                reach: parseInt(adi.reach ?? '0', 10),
                frequency: parseFloat(adi.frequency ?? '0'),
                clicks: adClicks,
                ctr: parseFloat(adi.ctr ?? '0'),
                inlineLinkClicks: adInlineLinkClicks,
                outboundClicks: adOutboundClicks,
                linkCtr: adImpressions > 0 ? (adInlineLinkClicks / adImpressions) * 100 : 0,
                // Funnel
                conversions: adConversions,
                addToCart: adAddToCart,
                initiateCheckout: adInitiateCheckout,
                landingPageView: adLandingPageView,
                cvr: adCvr,
                // Rankings — only computed by Meta over a rolling 7d window
                qualityRanking: ad7.quality_ranking ?? undefined,
                engagementRanking: ad7.engagement_rate_ranking ?? undefined,
                conversionRanking: ad7.conversion_rate_ranking ?? undefined,
                // Video watch counts + %
                video3s: adVideo3s,
                thruplay: adThruplay,
                hookRate: videoImp > 0 ? (adVideo3s / videoImp) * 100 : 0,
                holdRate: adVideo3s > 0 ? (adThruplay / adVideo3s) * 100 : 0,
                videoP25,
                videoP50,
                videoP75,
                videoP100,
                videoP25Pct: videoImp > 0 ? (videoP25 / videoImp) * 100 : 0,
                videoP50Pct: videoImp > 0 ? (videoP50 / videoImp) * 100 : 0,
                videoP75Pct: videoImp > 0 ? (videoP75 / videoImp) * 100 : 0,
                videoP100Pct: videoImp > 0 ? (videoP100 / videoImp) * 100 : 0,
                dateStart: adi.date_start ?? '',
                dateStop: adi.date_stop ?? '',
                // Recency window (7d) — fatigue/decay reads this, not lifetime
                last7d: {
                  spend: ad7Spend,
                  impressions: parseInt(ad7.impressions ?? '0', 10),
                  clicks: parseInt(ad7.clicks ?? '0', 10),
                  ctr: parseFloat(ad7.ctr ?? '0'),
                  conversions: ad7Conversions,
                  // Gross-only, no fallback (matches pre-existing behavior) —
                  // still worth netting the pixel-revenue branch so this
                  // window is on the same refund basis as the lifetime figures above.
                  revenue: extractActionValue(ad7.action_values, conversionTypes) * refundFactor,
                  cpa: ad7Conversions > 0 ? ad7Spend / ad7Conversions : 0,
                },
              } as Record<string, unknown>;

              if (adLifetimeFetchFailed) {
                const prev = prevAdMetricsById.get(ad.id);
                if (prev) {
                  for (const f of AD_LIFETIME_METRIC_FIELDS) {
                    if (prev[f] !== undefined) builtAd[f] = prev[f];
                  }
                }
              }
              return builtAd;
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
            const asReach = parseInt(asi.reach ?? '0', 10);
            const asClicks = parseInt(asi.clicks ?? '0', 10);
            const asConversions = this.extractConversions(asi.actions, conversionTypes);
            // Prefer Meta-reported ctr/cpc/cpm if present, fall back to computed.
            const asCtr = parseFloat(asi.ctr ?? '0') || (asImpressions > 0 ? (asClicks / asImpressions) * 100 : 0);
            const asCpc = parseFloat(asi.cpc ?? '0') || (asClicks > 0 ? asSpend / asClicks : 0);
            const asCpm = parseFloat(asi.cpm ?? '0') || (asImpressions > 0 ? (asSpend / asImpressions) * 1000 : 0);
            const asCpa = asConversions > 0 ? asSpend / asConversions : 0;
            const asFrequency = parseFloat(asi.frequency ?? '0');

            // Revenue + ROAS at ad-set level. Same logic as campaign level:
            // prefer Meta's action_values, fall back to conversions ×
            // product.conversionValue when the pixel event has no value param.
            let asActionValue = extractActionValue(asi.action_values, conversionTypes);
            if (asActionValue > 0) {
              asActionValue = asActionValue * refundFactor;
            } else if (asConversions > 0) {
              for (const [type, val] of fallbackValueByConversionType.entries()) {
                if (this.hasActionOfType(asi.actions, type)) {
                  asActionValue = asConversions * val;
                  break;
                }
              }
            }
            const asRoas = asSpend > 0 && asActionValue > 0 ? asActionValue / asSpend : 0;
            const asCvr = asClicks > 0 ? (asConversions / asClicks) * 100 : 0;
            const asAov = asConversions > 0 ? asActionValue / asConversions : 0;
            const asAddToCart = countAction(asi.actions, ['add_to_cart', 'omni_add_to_cart']);
            const asInitiateCheckout = countAction(asi.actions, [
              'initiate_checkout',
              'omni_initiated_checkout',
            ]);
            const asLandingPageView = countAction(asi.actions, [
              'landing_page_view',
              'omni_landing_page_view',
            ]);
            const asVideoP25 = firstActionValue(asi.video_p25_watched_actions);
            const asVideoP50 = firstActionValue(asi.video_p50_watched_actions);
            const asVideoP75 = firstActionValue(asi.video_p75_watched_actions);
            const asVideoP100 = firstActionValue(asi.video_p100_watched_actions);
            const videoImpressionBase = asImpressions > 0 ? asImpressions : 0;
            const asVideoP25Pct = videoImpressionBase > 0 ? (asVideoP25 / videoImpressionBase) * 100 : 0;
            const asVideoP50Pct = videoImpressionBase > 0 ? (asVideoP50 / videoImpressionBase) * 100 : 0;
            const asVideoP75Pct = videoImpressionBase > 0 ? (asVideoP75 / videoImpressionBase) * 100 : 0;
            const asVideoP100Pct = videoImpressionBase > 0 ? (asVideoP100 / videoImpressionBase) * 100 : 0;
            const targeting = as.targeting ?? {};
            const learningStage =
              as.learning_stage_info?.status ?? as.configured_status ?? '';

            return {
              id: as.id,
              name: as.name,
              status: (META_TO_INTERNAL_STATUS[as.status] ?? as.status).toLowerCase(),
              audienceType: this.inferAudienceType(as.name ?? ''),
              dailyBudget: parseFloat(as.daily_budget ?? '0') / 100,
              lifetimeBudget: parseFloat(as.lifetime_budget ?? '0') / 100,
              optimizationGoal: as.optimization_goal ?? '',
              // Money
              spend: asSpend,
              revenue: asActionValue,
              roas: asRoas,
              cpc: asCpc,
              cpm: asCpm,
              cpa: asCpa,
              aov: asAov,
              // Reach / delivery
              impressions: asImpressions,
              reach: asReach,
              frequency: asFrequency,
              clicks: asClicks,
              ctr: asCtr,
              // Funnel
              conversions: asConversions,
              addToCart: asAddToCart,
              initiateCheckout: asInitiateCheckout,
              landingPageView: asLandingPageView,
              cvr: asCvr,
              // Video watch %
              videoP25: asVideoP25,
              videoP50: asVideoP50,
              videoP75: asVideoP75,
              videoP100: asVideoP100,
              videoP25Pct: asVideoP25Pct,
              videoP50Pct: asVideoP50Pct,
              videoP75Pct: asVideoP75Pct,
              videoP100Pct: asVideoP100Pct,
              // Rankings
              qualityRanking: asi.quality_ranking ?? undefined,
              engagementRanking: asi.engagement_rate_ranking ?? undefined,
              conversionRanking: asi.conversion_rate_ranking ?? undefined,
              // Delivery insight
              learningStage,
              effectiveStatus: as.effective_status ?? '',
              // Bidding / delivery config
              bidAmount: parseFloat(as.bid_amount ?? '0') / 100,
              bidStrategy: as.bid_strategy ?? '',
              billingEvent: as.billing_event ?? '',
              attributionSpec: as.attribution_spec ?? undefined,
              promotedObject: as.promoted_object ?? undefined,
              startTime: as.start_time ?? '',
              endTime: as.end_time ?? '',
              // Targeting — legacy summary strings (dashboard) …
              age: summarizeAge(targeting),
              gender: summarizeGender(targeting),
              placement: summarizePlacements(targeting),
              audienceSize: Number(targeting.audience_size) || undefined,
              interests: Array.isArray(targeting.interests)
                ? targeting.interests.slice(0, 5).map((i: any) => i.name).filter(Boolean)
                : [],
              geo: Array.isArray(targeting.geo_locations?.countries)
                ? targeting.geo_locations.countries.join(', ')
                : '',
              // … + the full structured version (previously discarded — custom
              // audiences, exclusions, regions/cities, locales, Advantage flags
              // were all lost at write time).
              targetingDetail: structureTargeting(targeting),
              rawTargeting: targeting,
              dateStart: asi.date_start ?? '',
              dateStop: asi.date_stop ?? '',
              ads,
            };
          });

          // Only overwrite metaAdSets when we actually got ad sets back for
          // THIS campaign. Meta's /adsets endpoint rate-limits aggressively at
          // scale (chunked by 10 IDs) — a rate-limited chunk returns an empty
          // array and would previously wipe out perfectly good ad sets from
          // the last successful sync. Preserve existing data on partial fetch
          // failures.
          const gotAdSetsFromMeta = adSetsByCampaign.has(campaign.id);

          // Same preservation rule for the ads arrays: the /ads fetch is
          // chunked per campaign and swallows rate-limit failures — a
          // throttled chunk yields zero ads for that campaign and would wipe
          // every adset's ads[] (hit 2026-07-03: 4 of 7 campaigns lost their
          // ad history to a "too many calls" burst). If Meta returned no ads
          // for a campaign that previously had some, keep the old arrays.
          const fetchedAdCount = metaAdSets.reduce(
            (s: number, a: any) => s + (a.ads?.length ?? 0),
            0,
          );
          if (gotAdSetsFromMeta && fetchedAdCount === 0) {
            const existing = await this.campaignModel
              .findOne(
                { tenantId, metaCampaignId: campaign.id },
                { 'metaAdSets.id': 1, 'metaAdSets.ads': 1 },
              )
              .lean();
            const oldAds = new Map(
              ((existing?.metaAdSets as any[]) ?? []).map((a) => [a.id, a.ads ?? []]),
            );
            let preserved = 0;
            for (const a of metaAdSets as any[]) {
              const prev = oldAds.get(a.id);
              if (prev && prev.length > 0) {
                a.ads = prev;
                preserved += prev.length;
              }
            }
            if (preserved > 0) {
              this.logger.warn(
                `Ads fetch returned 0 for ${campaign.id} — preserved ${preserved} existing ads`,
              );
            }
          }

          // Budget model — which budget levers exist on this campaign.
          // ASC: Advantage+ shopping. CBO: campaign owns the budget. ABO:
          // budget lives on the adsets (campaign daily_budget absent) — sum
          // each active ad set's own daily/lifetime budget instead, so
          // `campaign.budget` reflects the real total rather than silently
          // staying 0 forever. Signal detection, the audit-agent prompt, and
          // scale_adset math all read campaign.budget directly and treated a
          // stale 0 as "no budget" for every ABO campaign in this account.
          const campaignLevelBudget =
            parseFloat(campaign.daily_budget ?? campaign.lifetime_budget ?? '0') / 100;
          const activeAdSetBudgetSum = (metaAdSets as any[]).reduce(
            (s: number, a: any) =>
              a.status === 'active' ? s + (a.dailyBudget || a.lifetimeBudget || 0) : s,
            0,
          );
          const campaignBudget =
            campaignLevelBudget > 0 ? campaignLevelBudget : activeAdSetBudgetSum;
          const budgetModel =
            campaign.smart_promotion_type === 'AUTOMATED_SHOPPING_ADS'
              ? 'asc'
              : campaignLevelBudget > 0
                ? 'cbo'
                : 'abo';

          const setDoc: Record<string, unknown> = {
            name: campaign.name ?? '',
            status: internalStatus,
            // Written here (not just $setOnInsert) so pre-existing docs that
            // predate this field, or were synced before it was wired up,
            // get backfilled on their next sync too — not just new inserts.
            // Matches the act_-prefixed format campaign-creator.service.ts
            // already writes at launch time (accountId is normalizeAccountId'd
            // above, before this loop starts).
            metaAccountId: accountId,
            spend: finalSpend,
            impressions: finalImpressions,
            clicks: finalClicks,
            reach: finalReach,
            conversions: finalConversions,
            roas: finalRoas,
            ctr: finalCtr,
            cpc: finalCpc,
            cpm: finalCpm,
            frequency: finalFrequency,
            revenue: finalRevenue,
            dataAsOf: finalDataAsOf,
            effectiveStatus: campaign.effective_status ?? '',
            // Structure — previously only written on insert, so budget stayed
            // stale (0) forever on existing docs. Now refreshed every sync.
            budget: campaignBudget,
            objective: campaign.objective ?? '',
            bidStrategy: campaign.bid_strategy ?? '',
            buyingType: campaign.buying_type ?? '',
            smartPromotionType: campaign.smart_promotion_type ?? '',
            specialAdCategories: campaign.special_ad_categories ?? [],
            spendCap: parseFloat(campaign.spend_cap ?? '0') / 100,
            budgetModel,
            stopTime: campaign.stop_time ? new Date(campaign.stop_time) : undefined,
            syncedAt: new Date(),
          };
          if (gotAdSetsFromMeta) setDoc.metaAdSets = metaAdSets;

          // A cap set in the Meta UI never passes through our launch gate, so
          // this is the first point at which an incoherent one is visible.
          // Flag it on the sync that observes it rather than waiting for the
          // mid-flight force-pause — the breach date is fully determined the
          // moment the cap and the daily budget are both known.
          const capCheck = SafetyChecks.evaluateCapCoherence({
            dailyBudget: campaignBudget,
            cap: setDoc.spendCap as number,
            startTime: campaign.start_time,
            stopTime: campaign.stop_time,
          });
          if (capCheck && !capCheck.ok) {
            this.logger.warn(
              `Spend cap incoherent on "${campaign.name ?? campaign.id}" (${campaign.id}): ${capCheck.message}`,
            );
          }

          await this.campaignModel.updateOne(
            { tenantId, metaCampaignId: campaign.id },
            {
              $set: setDoc,
              $setOnInsert: {
                tenantId,
                runId: '',
                briefId: '',
                source: 'manual',
                metaCampaignId: campaign.id,
                topic: '',
                angle: '',
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
  // [SUPERSEDED 2026-07-23] Original fetchAllPagesChunked body — swallowed
  // errors via fetchAllPages below with no retry (fetchWithRetry above was
  // defined but never actually wired to either helper). meta-deep-sync.ts
  // already used the shared, retry-enabled meta-fetch.util.ts version; this
  // service is now the sole Meta fetcher for the consolidation, so it needs
  // at least the same resilience. Kept here, commented, for reference —
  // delegating implementation follows.
  //
  // private async fetchAllPagesChunked(
  //   initialUrl: string,
  //   baseParams: any,
  //   filterField: string,         // e.g. 'campaign.id'
  //   ids: string[],
  //   label: string,
  //   chunkSize = 50,
  // ): Promise<{ data: { data: any[] } }> {
  //   const allRows: any[] = [];
  //   for (let i = 0; i < ids.length; i += chunkSize) {
  //     const chunk = ids.slice(i, i + chunkSize);
  //     const baseFiltering = baseParams.filtering ? JSON.parse(baseParams.filtering) : [];
  //     const otherFilters = baseFiltering.filter((f: any) => f.field !== filterField);
  //     const filtering = JSON.stringify([
  //       ...otherFilters,
  //       { field: filterField, operator: 'IN', value: chunk },
  //     ]);
  //     const chunkParams = { ...baseParams, filtering };
  //     const res = await this.fetchAllPages(initialUrl, chunkParams, `${label} chunk ${i / chunkSize + 1}/${Math.ceil(ids.length / chunkSize)}`);
  //     allRows.push(...(res.data?.data ?? []));
  //   }
  //   this.logger.log(`${label}: ${allRows.length} rows fetched across ${Math.ceil(ids.length / chunkSize)} chunks`);
  //   return { data: { data: allRows } };
  // }

  private async fetchAllPagesChunked(
    initialUrl: string,
    baseParams: any,
    filterField: string,         // e.g. 'campaign.id'
    ids: string[],
    label: string,
    chunkSize = 50,
  ): Promise<{ data: { data: any[] } }> {
    const rows = await sharedFetchAllPagesChunked(
      initialUrl, baseParams, filterField, ids, label, this.logger, chunkSize,
    );
    return { data: { data: rows } };
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
  // [SUPERSEDED 2026-07-23] Original fetchAllPages body — no retry on
  // transient/rate-limit errors, unlike the shared meta-fetch.util.ts version
  // deep-sync already used. Kept here, commented, for reference — delegating
  // implementation follows.
  //
  // private async fetchAllPages(
  //   initialUrl: string,
  //   initialParams: any,
  //   label: string,
  //   maxPages = 20,
  // ): Promise<{ data: { data: any[] } }> {
  //   const rows: any[] = [];
  //   let url: string | null = initialUrl;
  //   let params: any = initialParams;
  //   for (let page = 0; page < maxPages && url; page++) {
  //     try {
  //       const res: any = await axios.get(url, { params, timeout: 60000 });
  //       rows.push(...(res.data?.data ?? []));
  //       url = res.data?.paging?.next ?? null;
  //       params = undefined;
  //     } catch (err: any) {
  //       this.logger.warn(`${label} fetch failed (page ${page}): ${err.response?.data?.error?.message ?? err.message}`);
  //       url = null;
  //     }
  //   }
  //   this.logger.log(`${label}: ${rows.length} rows fetched across pages`);
  //   return { data: { data: rows } };
  // }

  private async fetchAllPages(
    initialUrl: string,
    initialParams: any,
    label: string,
    maxPages = 20,
  ): Promise<{ data: { data: any[] } }> {
    const rows = await sharedFetchAllPages(initialUrl, initialParams, label, this.logger, maxPages);
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

  /** Did Meta report ANY event of this action_type in the campaign's actions array? */
  private hasActionOfType(actions: any[] | undefined, actionType: string): boolean {
    if (!Array.isArray(actions)) return false;
    return actions.some((a) => a?.action_type === actionType);
  }
}

/** Sum the value across any of the given action_types. */
function countAction(
  actions: any[] | undefined,
  types: string[],
): number {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) {
    const hit = actions.find((a) => a?.action_type === t);
    if (hit) return parseInt(hit.value ?? '0', 10) || 0;
  }
  return 0;
}

/** Pick the first `value` out of a Meta action-values-style array. */
function firstActionValue(arr: any[] | undefined): number {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const v = arr[0]?.value;
  const n = typeof v === 'number' ? v : parseFloat(v ?? '0');
  return Number.isFinite(n) ? n : 0;
}

/**
 * Extract concrete creative attributes from object_story_spec /
 * asset_feed_spec. Before this, hookStyle/format were inferred from ad NAMES
 * (64% "unknown") while the actual copy, CTA, and media identity sat unparsed
 * in the fetched creative object.
 */
function parseCreativeAttributes(creative: any): {
  body: string;
  title: string;
  cta: string;
  linkUrl: string;
  videoId: string;
  imageHash: string;
  format: string;
  isDynamicCreative: boolean;
} {
  const oss = creative?.object_story_spec ?? {};
  const link = oss.link_data ?? {};
  const video = oss.video_data ?? {};
  const afs = creative?.asset_feed_spec ?? {};
  const afsBodies = Array.isArray(afs.bodies) ? afs.bodies : [];
  const afsTitles = Array.isArray(afs.titles) ? afs.titles : [];
  const afsVideos = Array.isArray(afs.videos) ? afs.videos : [];
  const afsImages = Array.isArray(afs.images) ? afs.images : [];
  const afsCtas = Array.isArray(afs.call_to_action_types) ? afs.call_to_action_types : [];
  const afsLinks = Array.isArray(afs.link_urls) ? afs.link_urls : [];

  const body = link.message ?? video.message ?? afsBodies[0]?.text ?? '';
  const title = link.name ?? video.title ?? afsTitles[0]?.text ?? '';
  const cta =
    link.call_to_action?.type ?? video.call_to_action?.type ?? afsCtas[0] ?? '';
  const linkUrl =
    link.link ?? video.call_to_action?.value?.link ?? afsLinks[0]?.website_url ?? '';
  const videoId = video.video_id ?? afsVideos[0]?.video_id ?? '';
  const imageHash = link.image_hash ?? afsImages[0]?.hash ?? '';

  let format = '';
  if (videoId) format = 'video';
  else if (Array.isArray(link.child_attachments) && link.child_attachments.length > 0)
    format = 'carousel';
  else if (imageHash || link.picture || video.image_url) format = 'image';

  // >1 body/title/media asset = Meta mixes variants at delivery time —
  // per-ad copy attribution is unreliable; use asset breakdowns instead.
  const isDynamicCreative =
    afsBodies.length > 1 || afsTitles.length > 1 || afsVideos.length > 1 || afsImages.length > 1;

  return { body, title, cta, linkUrl, videoId, imageHash, format, isDynamicCreative };
}

/**
 * Full structured targeting — everything the agent needs to know WHO an adset
 * reaches. Names + IDs preserved so decisions can reference ("exclude
 * purchasers audience 123…") and the audience library can aggregate across
 * campaigns by audience identity.
 */
function structureTargeting(targeting: any | undefined): Record<string, unknown> | undefined {
  if (!targeting || typeof targeting !== 'object' || Object.keys(targeting).length === 0) {
    return undefined;
  }
  const idName = (arr: any[] | undefined) =>
    Array.isArray(arr) ? arr.map((x) => ({ id: x?.id ?? '', name: x?.name ?? '' })) : [];
  const geo = targeting.geo_locations ?? {};
  const excludedGeo = targeting.excluded_geo_locations ?? {};
  return {
    ageMin: targeting.age_min ?? null,
    ageMax: targeting.age_max ?? null,
    genders: summarizeGender(targeting),
    geo: {
      countries: geo.countries ?? [],
      regions: idName(geo.regions).map((r, i) => ({ ...r, key: geo.regions?.[i]?.key ?? '' })),
      cities: Array.isArray(geo.cities)
        ? geo.cities.map((c: any) => ({
            key: c?.key ?? '',
            name: c?.name ?? '',
            radius: c?.radius ?? null,
            distanceUnit: c?.distance_unit ?? '',
          }))
        : [],
      locationTypes: geo.location_types ?? [],
      excludedCountries: excludedGeo.countries ?? [],
      excludedRegions: idName(excludedGeo.regions),
      excludedCities: idName(excludedGeo.cities),
    },
    interests: idName(targeting.interests),
    behaviors: idName(targeting.behaviors),
    /** AND/OR groups of detailed targeting (interests ∧ behaviors ∧ demographics). */
    flexibleSpec: targeting.flexible_spec ?? [],
    /** Detailed-targeting exclusions. */
    exclusions: targeting.exclusions ?? undefined,
    customAudiences: idName(targeting.custom_audiences),
    excludedCustomAudiences: idName(targeting.excluded_custom_audiences),
    locales: targeting.locales ?? [],
    devicePlatforms: targeting.device_platforms ?? [],
    publisherPlatforms: targeting.publisher_platforms ?? [],
    facebookPositions: targeting.facebook_positions ?? [],
    instagramPositions: targeting.instagram_positions ?? [],
    audienceNetworkPositions: targeting.audience_network_positions ?? [],
    messengerPositions: targeting.messenger_positions ?? [],
    /** Advantage+ audience — targeting is a suggestion, not a constraint. */
    advantageAudience:
      targeting.targeting_automation?.advantage_audience === 1 ||
      targeting.targeting_automation?.advantage_audience === true,
    /** Advantage detailed-targeting / lookalike expansion flags. */
    targetingOptimization: targeting.targeting_optimization ?? '',
    brandSafety: targeting.brand_safety_content_filter_levels ?? [],
  };
}

/** Summarize adset targeting into a compact placement string. */
function summarizePlacements(targeting: any | undefined): string {
  if (!targeting || typeof targeting !== 'object') return '';
  const platforms: string[] = Array.isArray(targeting.publisher_platforms)
    ? targeting.publisher_platforms
    : [];
  if (platforms.length === 0) return 'automatic';
  return platforms.join(', ');
}

/** Format an adset targeting age range as "18-65+". */
function summarizeAge(targeting: any | undefined): string {
  if (!targeting) return '';
  const lo = targeting.age_min;
  const hi = targeting.age_max;
  if (!lo && !hi) return '';
  return `${lo ?? 18}-${hi ?? 65}`;
}

/** "male" / "female" / "all" from Meta genders array. */
function summarizeGender(targeting: any | undefined): string {
  if (!targeting) return '';
  const g: number[] = Array.isArray(targeting.genders) ? targeting.genders : [];
  if (g.length === 0 || g.length === 2) return 'all';
  if (g.includes(1)) return 'male';
  if (g.includes(2)) return 'female';
  return '';
}
