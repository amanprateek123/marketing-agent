import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Campaign,
  CampaignDocument,
  CampaignRevenueAttributionSource,
  CampaignRevenueBasis,
} from '../schemas/campaign.schema';
import {
  MetricTimeseries,
  MetricTimeseriesDocument,
} from '../schemas/metric-timeseries.schema';
import {
  BreakdownSnapshot,
  BreakdownSnapshotDocument,
} from '../schemas/breakdown-snapshot.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import {
  IntelligenceBrief,
  IntelligenceBriefDocument,
} from '../../pipeline/schemas/intelligence-brief.schema';
import {
  extractActionValue,
  extractConversions,
  resolveProductConversionTypes,
} from './conversion-extractor.util';
import {
  getEffectiveConversionValue,
  getRefundFactor,
} from '../../common/conversion-value.util';
import { buildProductResolver } from './product-resolver.util';
import { FetchCompleteness, fetchAllPagesChunked } from './meta-fetch.util';
import {
  buildRevenueConfigFingerprint,
  isTrustedProductScopedTimeseriesRevenue,
  PRODUCT_SCOPED_REVENUE_VERSION,
  ProductResolutionEvidence,
  resolvePersistedCampaignProduct,
} from './timeseries-revenue-provenance.util';

const META_API_BASE = 'https://graph.facebook.com/v21.0';

/** Insights window used for all breakdown snapshots. */
const BREAKDOWN_WINDOW = 'last_30d';

type CampaignRevenueRule = {
  conversionTypes: Set<string>;
  attributionSource: CampaignRevenueAttributionSource;
  effectiveConversionValue: number;
  refundFactor: number;
  campaignProductName: string;
  resolvedProductName: string;
  productResolutionEvidence: ProductResolutionEvidence;
  revenueConfigFingerprint: string;
};

type ResolvedDailyRevenue = {
  conversions: number;
  revenue: number;
  revenueBasis: CampaignRevenueBasis;
  revenueAttributionSource: CampaignRevenueAttributionSource;
  revenueAttributionActionTypes: string[];
  campaignProductName: string;
  resolvedProductName: string;
  productResolutionEvidence: ProductResolutionEvidence;
  revenueConfigFingerprint: string;
};

/**
 * MetaDeepSyncService — the "all data" layer on top of the 6h structural sync.
 *
 * Two products, both read-only against Meta:
 *  1. metric_timeseries — daily rows (time_increment=1) per campaign/adset/ad,
 *     90-day backfill then incremental. Feeds trend EMAs immediately instead
 *     of waiting for 30-min snapshots to accumulate.
 *  2. breakdown_snapshots — segment performance: age×gender, region, country,
 *     placement (platform×position×device), hour-of-day, day-of-week, and
 *     per-asset rows for dynamic-creative ads.
 *
 * Meta quirks encoded here:
 *  - region breakdown carries NO conversion data for this account (verified
 *    2026-07-03) — spend/clicks/CTR only, actions/action_values always empty
 *    regardless of fields requested. 'country' is fetched as a coarser-
 *    granularity check on the same restriction; if it's also always empty,
 *    purchase-by-region/country requires a first-party join outside Meta.
 *  - age,gender CAN combine in one call; adding platform breakdowns to them
 *    can NOT (the old 4-way fetchDemographicBreakdown 400s — that's why
 *    demographicBreakdown was empty on every campaign).
 *  - use_unified_attribution_setting=true makes rows follow each adset's
 *    attribution setting instead of the API default.
 *  - asset breakdowns only return rows for ads built on asset_feed_spec;
 *    a campaign with no dynamic creative yields 0 rows, not an error.
 */
@Injectable()
export class MetaDeepSyncService {
  private readonly logger = new Logger(MetaDeepSyncService.name);

  constructor(
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(MetricTimeseries.name)
    private readonly timeseriesModel: Model<MetricTimeseriesDocument>,
    @InjectModel(BreakdownSnapshot.name)
    private readonly breakdownModel: Model<BreakdownSnapshotDocument>,
    @InjectModel(IntelligenceBrief.name)
    private readonly briefModel: Model<IntelligenceBriefDocument>,
  ) {}

  async deepSync(
    company: CompanyDocument,
    opts?: { backfillDays?: number },
  ): Promise<{
    timeseriesRows: number;
    breakdownDocs: number;
    campaigns: number;
    errors: string[];
  }> {
    const tenantId = company.tenantId;
    const accessToken = company.meta?.accessToken;
    if (!accessToken)
      throw new Error(`tenant ${tenantId} has no meta.accessToken`);

    const normalizeAccountId = (id: string) =>
      id.startsWith('act_') ? id : `act_${id}`;
    const accountIds = (
      (company.meta!.accountIds?.length ?? 0) > 0
        ? company.meta!.accountIds!
        : [company.meta!.accountId]
    ).map(normalizeAccountId);

    const active = await this.campaignModel
      .find({
        tenantId,
        status: 'active',
        metaCampaignId: { $nin: ['', null] },
      })
      .select('metaCampaignId name objective productName')
      .lean()
      .exec();
    const campaignIds = active.map((c) => c.metaCampaignId);
    if (campaignIds.length === 0) {
      return {
        timeseriesRows: 0,
        breakdownDocs: 0,
        campaigns: 0,
        errors: ['no active campaigns'],
      };
    }

    // Operational trend data retains the legacy resolver as an explicitly
    // untrusted fallback. Founder-facing evidence accepts only the separate
    // exact Campaign.productName resolution stamped below.
    const fallbackProductByCampaign = await buildProductResolver(
      this.campaignModel,
      this.briefModel,
      tenantId,
      campaignIds,
      company.products,
    );
    const activeByCampaignId = new Map(
      active.map((campaign) => [String(campaign.metaCampaignId), campaign]),
    );
    const revenueRulesByCampaignId = new Map<string, CampaignRevenueRule>();
    for (const id of campaignIds) {
      const campaign = activeByCampaignId.get(id) as any;
      const resolution = resolvePersistedCampaignProduct(
        campaign?.productName,
        company.products,
      );
      const inferredProduct = fallbackProductByCampaign(id);
      const product = resolution.product ?? inferredProduct;
      const productResolutionEvidence: ProductResolutionEvidence =
        resolution.product
          ? 'persisted_campaign_product_exact'
          : inferredProduct
            ? 'inferred_fallback'
            : resolution.evidence;
      const useAppEvents = campaign?.objective === 'OUTCOME_APP_PROMOTION';
      const attribution = resolveProductConversionTypes(product, new Set(), {
        useAppEvents,
      });
      const effectiveConversionValue = getEffectiveConversionValue(product);
      const refundFactor = getRefundFactor(product);
      revenueRulesByCampaignId.set(id, {
        conversionTypes: attribution.conversionTypes,
        attributionSource: attribution.source,
        effectiveConversionValue,
        refundFactor,
        campaignProductName: resolution.campaignProductName,
        resolvedProductName: String(product?.name ?? '').trim(),
        productResolutionEvidence,
        revenueConfigFingerprint: product
          ? buildRevenueConfigFingerprint({
              product,
              conversionTypes: attribution.conversionTypes,
              effectiveConversionValue,
              refundFactor,
              useAppEvents,
            })
          : '',
      });
    }

    const backfillDays = opts?.backfillDays ?? 90;
    const until = new Date();
    const since = new Date(until.getTime() - backfillDays * 86400 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const timeRange = JSON.stringify({ since: fmt(since), until: fmt(until) });

    const errors: string[] = [];
    let timeseriesRows = 0;
    let breakdownDocs = 0;

    for (const accountId of accountIds) {
      // ── 1. Daily series at all three levels ──────────────────────────────
      for (const level of ['campaign', 'adset', 'ad'] as const) {
        try {
          const completeness: FetchCompleteness = { complete: true };
          const idField =
            level === 'campaign'
              ? 'campaign_id'
              : level === 'adset'
                ? 'adset_id'
                : 'ad_id';
          const rows = await fetchAllPagesChunked(
            `${META_API_BASE}/${accountId}/insights`,
            {
              fields: `campaign_id,${level === 'ad' ? 'adset_id,ad_id,' : level === 'adset' ? 'adset_id,' : ''}spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions,action_values,video_play_actions,video_thruplay_watched_actions,date_start`,
              level,
              time_increment: 1,
              time_range: timeRange,
              use_unified_attribution_setting: 'true',
              limit: '500',
              access_token: accessToken,
            },
            'campaign.id',
            campaignIds,
            `Timeseries ${level} ${accountId}`,
            this.logger,
            50,
            completeness,
          );
          const rowsWritten = await this.upsertTimeseries(
            tenantId,
            level,
            rows,
            idField,
            revenueRulesByCampaignId,
            completeness,
          );
          timeseriesRows += rowsWritten;
          if (!completeness.complete) {
            errors.push(
              `timeseries ${level}: incomplete Meta response; skipped all ${rows.length} partial row(s)`,
            );
          }
        } catch (err: any) {
          errors.push(`timeseries ${level}: ${err.message}`);
        }
        await sleep(3000);
      }

      // ── 2. Segment breakdowns (adset level; campaign docs are rollups) ──
      // NOTE on 'region': verified against this account (2026-07-03) that
      // Meta's region-breakdown rows carry NO conversion data at all — only
      // on-platform actions (link_click, video_view, post_engagement), never
      // pixel purchases/custom conversions/action_values, however this field
      // list is constructed. Spend/impressions/clicks/CTR by region ARE real.
      // 'country' is included alongside it as a coarser-granularity
      // experiment — Meta sometimes preserves action attribution at country
      // level even when a finer breakdown (region/DMA) suppresses it. If
      // country rows also come back with conversions=0/revenue=0, that
      // confirms the restriction applies account-wide regardless of
      // granularity, and true region/country purchase amounts require a
      // first-party join (tag orders with region/country from your own
      // checkout data, then merge with this spend-by-region data yourself —
      // Meta cannot supply attributed revenue at this breakdown via the API).
      const segmentSpecs: Array<{
        type: string;
        breakdowns: string;
        keys: string[];
      }> = [
        {
          type: 'age_gender',
          breakdowns: 'age,gender',
          keys: ['age', 'gender'],
        },
        { type: 'region', breakdowns: 'region', keys: ['region'] },
        { type: 'country', breakdowns: 'country', keys: ['country'] },
        {
          type: 'placement',
          breakdowns: 'publisher_platform,platform_position,device_platform',
          keys: ['publisher_platform', 'platform_position', 'device_platform'],
        },
      ];
      for (const spec of segmentSpecs) {
        try {
          const rows = await fetchAllPagesChunked(
            `${META_API_BASE}/${accountId}/insights`,
            {
              fields:
                'campaign_id,adset_id,spend,impressions,reach,clicks,ctr,actions,action_values',
              level: 'adset',
              breakdowns: spec.breakdowns,
              date_preset: BREAKDOWN_WINDOW,
              use_unified_attribution_setting: 'true',
              limit: '500',
              access_token: accessToken,
            },
            'campaign.id',
            campaignIds,
            `Breakdown ${spec.type} ${accountId}`,
            this.logger,
          );
          breakdownDocs += await this.upsertBreakdowns(
            tenantId,
            spec.type,
            spec.keys,
            rows,
            revenueRulesByCampaignId,
          );
        } catch (err: any) {
          errors.push(`breakdown ${spec.type}: ${err.message}`);
        }
        await sleep(3000);
      }

      // ── 3. Hour-of-day at campaign level ────────────────────────────────
      try {
        const rows = await fetchAllPagesChunked(
          `${META_API_BASE}/${accountId}/insights`,
          {
            fields:
              'campaign_id,spend,impressions,clicks,ctr,actions,action_values',
            level: 'campaign',
            breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone',
            date_preset: BREAKDOWN_WINDOW,
            use_unified_attribution_setting: 'true',
            limit: '500',
            access_token: accessToken,
          },
          'campaign.id',
          campaignIds,
          `Breakdown hourly ${accountId}`,
          this.logger,
        );
        breakdownDocs += await this.upsertBreakdowns(
          tenantId,
          'hourly',
          ['hourly_stats_aggregated_by_advertiser_time_zone'],
          rows,
          revenueRulesByCampaignId,
          'campaign',
        );
      } catch (err: any) {
        errors.push(`breakdown hourly: ${err.message}`);
      }
      await sleep(3000);

      // ── 4. Asset breakdowns for dynamic-creative ads ─────────────────────
      for (const assetSpec of [
        { type: 'asset_video', breakdown: 'video_asset' },
        { type: 'asset_body', breakdown: 'body_asset' },
        { type: 'asset_title', breakdown: 'title_asset' },
      ]) {
        try {
          const rows = await fetchAllPagesChunked(
            `${META_API_BASE}/${accountId}/insights`,
            {
              fields:
                'campaign_id,adset_id,ad_id,spend,impressions,clicks,ctr,actions,action_values',
              level: 'ad',
              breakdowns: assetSpec.breakdown,
              date_preset: BREAKDOWN_WINDOW,
              use_unified_attribution_setting: 'true',
              // video_asset rows are heavy (embedded asset objects) — 500/page
              // trips Meta's per-request data cap on ad-level asset breakdowns.
              limit: '25',
              access_token: accessToken,
            },
            'campaign.id',
            campaignIds,
            `Breakdown ${assetSpec.type} ${accountId}`,
            this.logger,
            1,
          );
          breakdownDocs += await this.upsertBreakdowns(
            tenantId,
            assetSpec.type,
            [assetSpec.breakdown],
            rows,
            revenueRulesByCampaignId,
            'ad',
          );
        } catch (err: any) {
          // Expected to be empty/failing when no ads use asset_feed_spec.
          errors.push(`breakdown ${assetSpec.type}: ${err.message}`);
        }
        await sleep(3000);
      }
    }

    // ── 5. Day-of-week — computed from the daily series, no extra API call ─
    try {
      breakdownDocs += await this.computeDayOfWeek(
        tenantId,
        campaignIds,
        revenueRulesByCampaignId,
      );
    } catch (err: any) {
      errors.push(`dow: ${err.message}`);
    }

    this.logger.log(
      `Deep sync ${tenantId}: ${timeseriesRows} timeseries rows, ${breakdownDocs} breakdown docs, ${errors.length} errors`,
    );
    return {
      timeseriesRows,
      breakdownDocs,
      campaigns: campaignIds.length,
      errors,
    };
  }

  // ───────────────────────── helpers ─────────────────────────

  private resolveDailyRevenue(
    row: any,
    revenueRulesByCampaignId: ReadonlyMap<string, CampaignRevenueRule>,
  ): ResolvedDailyRevenue {
    const rule = revenueRulesByCampaignId.get(String(row.campaign_id ?? ''));
    const provenance = {
      campaignProductName: rule?.campaignProductName ?? '',
      resolvedProductName: rule?.resolvedProductName ?? '',
      productResolutionEvidence:
        rule?.productResolutionEvidence ??
        ('missing_persisted_campaign_product' as const),
      revenueConfigFingerprint: rule?.revenueConfigFingerprint ?? '',
    };
    if (
      !rule ||
      rule.attributionSource === 'unresolved' ||
      rule.conversionTypes.size === 0
    ) {
      return {
        conversions: 0,
        revenue: 0,
        revenueBasis: 'unknown',
        revenueAttributionSource: 'unresolved',
        revenueAttributionActionTypes: [],
        ...provenance,
      };
    }

    const conversions = extractConversions(row.actions, rule.conversionTypes);
    const grossActionValue = extractActionValue(
      row.action_values,
      rule.conversionTypes,
    );
    if (grossActionValue > 0) {
      return {
        conversions,
        revenue: grossActionValue * rule.refundFactor,
        revenueBasis: 'meta_action_value',
        revenueAttributionSource: rule.attributionSource,
        revenueAttributionActionTypes: [...rule.conversionTypes],
        ...provenance,
      };
    }
    if (conversions > 0 && rule.effectiveConversionValue > 0) {
      return {
        conversions,
        revenue: conversions * rule.effectiveConversionValue,
        revenueBasis: 'configured_conversion_value',
        revenueAttributionSource: rule.attributionSource,
        revenueAttributionActionTypes: [...rule.conversionTypes],
        ...provenance,
      };
    }
    return {
      conversions,
      revenue: 0,
      revenueBasis: 'no_attributed_revenue',
      revenueAttributionSource: rule.attributionSource,
      revenueAttributionActionTypes: [...rule.conversionTypes],
      ...provenance,
    };
  }

  private async upsertTimeseries(
    tenantId: string,
    level: string,
    rows: any[],
    idField: string,
    revenueRulesByCampaignId: ReadonlyMap<string, CampaignRevenueRule>,
    completeness: FetchCompleteness,
  ): Promise<number> {
    if (!completeness.complete) {
      this.logger.warn(
        `Skipping incomplete ${level} timeseries batch for ${tenantId}; ${rows.length} partial row(s) were not written`,
      );
      return 0;
    }
    if (rows.length === 0) return 0;
    const ops = rows
      .filter((r) => r[idField] && r.date_start)
      .map((r) => {
        const revenue = this.resolveDailyRevenue(r, revenueRulesByCampaignId);
        return {
          updateOne: {
            filter: {
              tenantId,
              level,
              entityId: r[idField],
              date: r.date_start,
            },
            update: {
              $set: {
                metaCampaignId: r.campaign_id ?? '',
                adsetId: level === 'ad' ? (r.adset_id ?? '') : '',
                spend: parseFloat(r.spend ?? '0'),
                impressions: parseInt(r.impressions ?? '0', 10),
                reach: parseInt(r.reach ?? '0', 10),
                frequency: parseFloat(r.frequency ?? '0'),
                clicks: parseInt(r.clicks ?? '0', 10),
                inlineLinkClicks: parseInt(r.inline_link_clicks ?? '0', 10),
                ctr: parseFloat(r.ctr ?? '0'),
                cpc: parseFloat(r.cpc ?? '0'),
                cpm: parseFloat(r.cpm ?? '0'),
                conversions: revenue.conversions,
                revenue: revenue.revenue,
                revenueBasis: revenue.revenueBasis,
                revenueAttributionSource: revenue.revenueAttributionSource,
                revenueAttributionActionTypes:
                  revenue.revenueAttributionActionTypes,
                revenueCalculationVersion: PRODUCT_SCOPED_REVENUE_VERSION,
                revenueFetchCompleteness: 'complete',
                campaignProductName: revenue.campaignProductName,
                resolvedProductName: revenue.resolvedProductName,
                productResolutionEvidence: revenue.productResolutionEvidence,
                revenueConfigFingerprint: revenue.revenueConfigFingerprint,
                addToCart: countAction(r.actions, [
                  'add_to_cart',
                  'omni_add_to_cart',
                ]),
                initiateCheckout: countAction(r.actions, [
                  'initiate_checkout',
                  'omni_initiated_checkout',
                ]),
                landingPageView: countAction(r.actions, [
                  'landing_page_view',
                  'omni_landing_page_view',
                ]),
                video3s: firstValue(r.video_play_actions),
                thruplay: firstValue(r.video_thruplay_watched_actions),
                syncedAt: new Date(),
              },
            },
            upsert: true,
          },
        };
      });
    if (ops.length === 0) return 0;
    const res = await this.timeseriesModel.bulkWrite(ops, { ordered: false });
    return (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
  }

  /**
   * Group segment rows by entity, write one doc per entity, plus a campaign-
   * level rollup doc (summed across the campaign's adsets) for adset-level
   * breakdowns so campaign-wide questions don't re-aggregate at read time.
   */
  private async upsertBreakdowns(
    tenantId: string,
    breakdownType: string,
    keyFields: string[],
    rows: any[],
    revenueRulesByCampaignId: ReadonlyMap<string, CampaignRevenueRule>,
    level: 'adset' | 'campaign' | 'ad' = 'adset',
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const keyName = (f: string) =>
      f === 'hourly_stats_aggregated_by_advertiser_time_zone'
        ? 'hour'
        : f === 'publisher_platform'
          ? 'publisherPlatform'
          : f === 'platform_position'
            ? 'platformPosition'
            : f === 'device_platform'
              ? 'devicePlatform'
              : f;
    const toRow = (r: any) => {
      const resolvedRevenue = this.resolveDailyRevenue(
        r,
        revenueRulesByCampaignId,
      );
      const spend = parseFloat(r.spend ?? '0');
      const keys: Record<string, string> = {};
      for (const f of keyFields) {
        const v = r[f];
        // Asset breakdowns return objects ({video_id,…} / {text,id}); flatten
        // to a stable id + display text.
        if (v && typeof v === 'object') {
          keys[keyName(f)] = String(v.video_id ?? v.id ?? '');
          if (v.text) keys.assetText = String(v.text).slice(0, 200);
          if (v.video_name ?? v.name)
            keys.assetName = String(v.video_name ?? v.name);
        } else {
          keys[keyName(f)] = String(v ?? '');
        }
      }
      return {
        keys,
        spend,
        impressions: parseInt(r.impressions ?? '0', 10),
        reach: parseInt(r.reach ?? '0', 10),
        clicks: parseInt(r.clicks ?? '0', 10),
        ctr: parseFloat(r.ctr ?? '0'),
        conversions: resolvedRevenue.conversions,
        revenue: resolvedRevenue.revenue,
        cpa:
          resolvedRevenue.conversions > 0
            ? spend / resolvedRevenue.conversions
            : 0,
        roas:
          spend > 0 && resolvedRevenue.revenue > 0
            ? resolvedRevenue.revenue / spend
            : 0,
      };
    };

    const entityField =
      level === 'ad'
        ? 'ad_id'
        : level === 'campaign'
          ? 'campaign_id'
          : 'adset_id';
    const byEntity = new Map<string, { campaignId: string; rows: any[] }>();
    for (const r of rows) {
      const id = r[entityField];
      if (!id) continue;
      const e = byEntity.get(id) ?? {
        campaignId: r.campaign_id ?? '',
        rows: [] as any[],
      };
      e.rows.push(toRow(r));
      byEntity.set(id, e);
    }

    const now = new Date();
    const ops: any[] = [];
    for (const [entityId, e] of byEntity.entries()) {
      ops.push({
        updateOne: {
          filter: {
            tenantId,
            entityId,
            breakdownType,
            window: BREAKDOWN_WINDOW,
          },
          update: {
            $set: {
              metaCampaignId: e.campaignId,
              level,
              rows: e.rows,
              fetchedAt: now,
            },
          },
          upsert: true,
        },
      });
    }

    // Campaign rollup for adset-level segment breakdowns.
    if (level === 'adset') {
      const byCampaign = new Map<string, Map<string, any>>();
      for (const e of byEntity.values()) {
        const seg = byCampaign.get(e.campaignId) ?? new Map<string, any>();
        for (const row of e.rows) {
          const k = JSON.stringify(row.keys);
          const agg = seg.get(k) ?? {
            ...row,
            spend: 0,
            impressions: 0,
            reach: 0,
            clicks: 0,
            conversions: 0,
            revenue: 0,
          };
          agg.spend += row.spend;
          agg.impressions += row.impressions;
          agg.reach += row.reach;
          agg.clicks += row.clicks;
          agg.conversions += row.conversions;
          agg.revenue += row.revenue;
          seg.set(k, agg);
        }
        byCampaign.set(e.campaignId, seg);
      }
      for (const [campaignId, seg] of byCampaign.entries()) {
        if (!campaignId) continue;
        const rolled = [...seg.values()].map((a) => ({
          ...a,
          ctr: a.impressions > 0 ? (a.clicks / a.impressions) * 100 : 0,
          cpa: a.conversions > 0 ? a.spend / a.conversions : 0,
          roas: a.spend > 0 && a.revenue > 0 ? a.revenue / a.spend : 0,
        }));
        ops.push({
          updateOne: {
            filter: {
              tenantId,
              entityId: campaignId,
              breakdownType,
              window: BREAKDOWN_WINDOW,
            },
            update: {
              $set: {
                metaCampaignId: campaignId,
                level: 'campaign',
                rows: rolled,
                fetchedAt: now,
              },
            },
            upsert: true,
          },
        });
      }
    }

    if (ops.length === 0) return 0;
    const res = await this.breakdownModel.bulkWrite(ops, { ordered: false });
    return (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
  }

  /** Day-of-week rollup from the campaign-level daily series. */
  private async computeDayOfWeek(
    tenantId: string,
    campaignIds: string[],
    revenueRulesByCampaignId: ReadonlyMap<string, CampaignRevenueRule>,
  ): Promise<number> {
    const days = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ];
    const now = new Date();
    let written = 0;
    for (const campaignId of campaignIds) {
      const series = await this.timeseriesModel
        .find({ tenantId, level: 'campaign', entityId: campaignId })
        .lean()
        .exec();
      if (series.length === 0) continue;
      const expectedProductName =
        revenueRulesByCampaignId.get(campaignId)?.campaignProductName ?? '';
      const byDow = new Map<string, any>();
      for (const d of series) {
        const dow = days[new Date(`${d.date}T00:00:00Z`).getUTCDay()];
        const trustedReturn = isTrustedProductScopedTimeseriesRevenue(
          d,
          expectedProductName,
        );
        const agg = byDow.get(dow) ?? {
          spend: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          knownRevenue: 0,
          persistedRevenue: 0,
          rows: 0,
          trustedRows: 0,
        };
        agg.spend += d.spend;
        agg.impressions += d.impressions;
        agg.clicks += d.clicks;
        agg.conversions += d.conversions;
        agg.persistedRevenue += d.revenue;
        agg.rows++;
        if (trustedReturn) {
          agg.knownRevenue += d.revenue;
          agg.trustedRows++;
        }
        byDow.set(dow, agg);
      }
      const rows = [...byDow.entries()].map(([dow, a]) => {
        const returnCoverage: 'complete' | 'partial' | 'none' =
          a.trustedRows === a.rows
            ? 'complete'
            : a.trustedRows > 0
              ? 'partial'
              : 'none';
        const revenue = returnCoverage === 'complete' ? a.knownRevenue : null;
        return {
          keys: { dow },
          spend: a.spend,
          impressions: a.impressions,
          clicks: a.clicks,
          ctr: a.impressions > 0 ? (a.clicks / a.impressions) * 100 : 0,
          conversions: a.conversions,
          revenue,
          persistedRevenue: a.persistedRevenue,
          returnCoverage,
          cpa: a.conversions > 0 ? a.spend / a.conversions : 0,
          roas: revenue != null && a.spend > 0 ? revenue / a.spend : null,
        };
      });
      await this.breakdownModel.updateOne(
        {
          tenantId,
          entityId: campaignId,
          breakdownType: 'dow',
          window: 'last_90d',
        },
        {
          $set: {
            metaCampaignId: campaignId,
            level: 'campaign',
            rows,
            fetchedAt: now,
          },
        },
        { upsert: true },
      );
      written++;
    }
    return written;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countAction(actions: any[] | undefined, types: string[]): number {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) {
    const hit = actions.find((a) => a?.action_type === t);
    if (hit) return parseInt(hit.value ?? '0', 10) || 0;
  }
  return 0;
}

function firstValue(arr: any[] | undefined): number {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const v = arr[0]?.value;
  const n = typeof v === 'number' ? v : parseFloat(v ?? '0');
  return Number.isFinite(n) ? n : 0;
}
