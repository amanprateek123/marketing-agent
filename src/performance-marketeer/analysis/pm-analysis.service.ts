import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';
import { findPmProduct, PM_PRODUCTS, pmEnv, PmEnv } from '../pm.config';
import { dayRange, istDay, istDayBounds } from '../pm.logic';
import {
  PmMetaAccountDaily,
  PmMetaBreakdown,
  PmMetaChange,
  PmMetaDaily,
  PmMetaEntity,
} from '../schemas/pm-meta.schema';
import { PmOrder } from '../schemas/pm-order.schema';
import { PmVisitorDay } from '../schemas/pm-visitor-day.schema';
import {
  PmBudgetResponse,
  PmBudgetRow,
  PmChangesResponse,
  PmDecomposeResponse,
  PmEntitiesResponse,
  PmEntityRow,
  PmFatigueResponse,
  PmFunnelResponse,
  PmGeoResponse,
  PmLevel,
  PmQuery,
  PmReconcileResponse,
  PmReportResponse,
  PmSummaryResponse,
  PmTrendResponse,
} from './pm-analysis.types';
import { buildReport } from './pm-findings';
import {
  addDays,
  bandIndexExpr,
  budgetSignalOf,
  confidenceFor,
  decomposeCpa,
  fatigueOf,
  MetaSums,
  metricsChange,
  normaliseRegion,
  olsSlope,
  OrderSums,
  previousPeriod,
  ratio,
  relChange,
  SCROLL_BANDS,
  SiteSums,
  TIME_BANDS,
  targetOf,
  toMetrics,
  WindowSums,
  withMissingMeta,
  missingFrom,
  listDays,
} from './pm-stats';

type BudgetDay = {
  date: string;
  spend: number;
  metaValue: number;
  reach: number;
  freqImp: number;
  impressions: number;
  ads: string[];
};
type Stages = PipelineStage[];
const $m = (x: Record<string, unknown>): Stages => [{ $match: x }];
/** Account-day reconciles when ad-level spend is within 1% or ₹50 of Meta's account total. */
const GAP_SHARE = 0.01;
const GAP_INR = 50;
const CHANGES_LIMIT = 500;
/** A breakdown day is covered when its spend is within 5% of the account totals. */
const BREAKDOWN_SHARE = 0.05;
type EntityLevel = Exclude<PmLevel, 'account'>;
const ID_FIELD: Record<EntityLevel, 'campaignId' | 'adsetId' | 'adId'> = {
  campaign: 'campaignId',
  adset: 'adsetId',
  ad: 'adId',
};
const NOT_EMPTY = { $nin: [null, ''] };

// Sums per source. Frequency is kept as Σ frequency × impressions so the
// weighted average can be taken after any regrouping.
const META_SUMS = {
  spend: { $sum: '$spend' },
  impressions: { $sum: '$impressions' },
  clicks: { $sum: '$clicks' },
  linkClicks: { $sum: '$linkClicks' },
  landingPageViews: { $sum: '$landingPageViews' },
  freqImp: { $sum: { $multiply: ['$frequency', '$impressions'] } },
  metaPurchases: { $sum: '$metaPurchases' },
  metaPurchaseValue: { $sum: '$metaPurchaseValue' },
};
const ORDER_SUMS = {
  orders: { $sum: 1 },
  revenue: { $sum: '$netRevenue' },
  newCustomers: { $sum: { $cond: [{ $eq: ['$newToBusiness', true] }, 1, 0] } },
};
const hasStep = (key: string) => ({
  $cond: [{ $gt: [{ $ifNull: [`$steps.${key}.count`, 0] }, 0] }, 1, 0],
});
const PAID_STARTED = {
  $cond: [{ $gt: [{ $size: { $ifNull: ['$payments', []] } }, 0] }, 1, 0],
};
const SITE_SUMS = {
  visitors: { $sum: 1 },
  ctaClicks: { $sum: hasStep('ctaClick') },
  paymentsStarted: { $sum: PAID_STARTED },
};

const STEP_LABELS: Record<string, string> = {
  visitors: 'Landing visitors',
  productView: 'Product view',
  ctaClick: 'CTA click',
  addToCart: 'Add to cart',
  beginCheckout: 'Begin checkout',
  formSubmit: 'Details form submitted',
  paymentInitiated: 'Payment started',
  order: 'Confirmed order',
};

/**
 * Read-only analysis over the pm_* collections (contract:
 * pm-analysis.types.ts). Aggregation runs in Mongo; JS only merges the
 * grouped results. Every query is scoped to the configured tenant.
 */
@Injectable()
export class PmAnalysisService {
  constructor(
    @InjectModel(PmVisitorDay.name)
    private readonly visitors: Model<PmVisitorDay>,
    @InjectModel(PmOrder.name) private readonly orders: Model<PmOrder>,
    @InjectModel(PmMetaDaily.name)
    private readonly metaDaily: Model<PmMetaDaily>,
    @InjectModel(PmMetaEntity.name)
    private readonly entitiesModel: Model<PmMetaEntity>,
    @InjectModel(PmMetaBreakdown.name)
    private readonly breakdowns: Model<PmMetaBreakdown>,
    @InjectModel(PmMetaChange.name)
    private readonly changesModel: Model<PmMetaChange>,
    @InjectModel(PmMetaAccountDaily.name)
    private readonly accountDaily: Model<PmMetaAccountDaily>,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  // ---------- scoping ----------

  private products(product?: string) {
    return product ? [product] : PM_PRODUCTS.map((p) => p.id);
  }
  private metaMatch(q: PmQuery, extra: Record<string, unknown> = {}) {
    return {
      tenantId: this.env.tenantId,
      product: { $in: this.products(q.product) },
      date: { $gte: q.from, $lte: q.to },
      ...extra,
    };
  }
  /** Confirmed web orders in range (staff-entered excluded — definition 8), any product. */
  private webOrders(q: PmQuery, extra: Record<string, unknown> = {}) {
    return {
      tenantId: this.env.tenantId,
      day: { $gte: q.from, $lte: q.to },
      confirmed: true,
      adminCreated: false,
      ...extra,
    };
  }
  /** Confirmed web orders of the selected products (unattributed views: coverage, funnel). */
  private orderMatch(q: PmQuery, extra: Record<string, unknown> = {}) {
    return this.webOrders(q, {
      product: { $in: this.products(q.product) },
      ...extra,
    });
  }
  /**
   * Adds `adProduct`: the product tag of the order's last-click Meta ad
   * (pm_meta_entities, else pm_meta_daily), null when the ad is unknown.
   */
  private adTagStages(): Stages {
    const t = this.env.tenantId;
    const look = (
      from: string,
      foreignField: string,
      as: string,
      extra = {},
    ) => ({
      $lookup: {
        from,
        localField: 'attribution.metaLast.adId',
        foreignField,
        pipeline: [
          { $match: { tenantId: t, ...extra } },
          { $limit: 1 },
          { $project: { product: 1 } },
        ],
        as,
      },
    });
    return [
      look(this.entitiesModel.collection.name, 'entityId', '_e', {
        level: 'ad',
      }),
      look(this.metaDaily.collection.name, 'adId', '_d'),
      {
        $addFields: {
          adProduct: {
            $ifNull: [
              { $first: '$_e.product' },
              { $first: '$_d.product' },
              null,
            ],
          },
        },
      },
    ];
  }
  /**
   * Meta-attributed web orders counted at account/product level: an order
   * counts when its attributed ad's product tag is in scope — the same rule
   * that selects spend — whatever product the order itself is.
   */
  private taggedOrders(
    q: PmQuery,
    extra: Record<string, unknown> = {},
  ): Stages {
    return [
      {
        $match: this.webOrders(q, {
          'attribution.metaLast.adId': NOT_EMPTY,
          ...extra,
        }),
      },
      ...this.adTagStages(),
      { $match: { adProduct: { $in: this.products(q.product) } } },
    ];
  }
  private siteMatch(q: PmQuery, extra: Record<string, unknown> = {}) {
    return {
      tenantId: this.env.tenantId,
      product: { $in: this.products(q.product) },
      day: { $gte: q.from, $lte: q.to },
      ...extra,
    };
  }

  /**
   * Pipelines on the three sources. Account/product: spend by ad tag, orders
   * by their ad's tag, visitors by page product. One entity: joined purely
   * by its id, no product filter (definition 3).
   */
  private scope(q: PmQuery, level: PmLevel, id?: string) {
    if (level === 'account' || !id)
      return {
        meta: $m(this.metaMatch(q)),
        order: this.taggedOrders(q),
        site: $m(this.siteMatch(q, { 'metaAd.last.adId': NOT_EMPTY })),
      };
    const f = ID_FIELD[level];
    const days = { $gte: q.from, $lte: q.to };
    return {
      meta: $m({ tenantId: this.env.tenantId, date: days, [f]: id }),
      order: $m(this.webOrders(q, { [`attribution.metaLast.${f}`]: id })),
      site: $m({
        tenantId: this.env.tenantId,
        day: days,
        [`metaAd.last.${f}`]: id,
      }),
    };
  }

  /** Group a collection by `key` (null = one bucket '_') into a Map. */
  private async sums<T>(
    model: Model<any>,
    stages: Stages,
    key: unknown,
    group: Record<string, unknown>,
  ): Promise<Map<string, T & { _id: any }>> {
    const rows = await model.aggregate<T & { _id: any }>([
      ...stages,
      { $group: { _id: key, ...group } },
    ] as Stages);
    return new Map(
      rows.map((r) => [
        typeof r._id === 'object' && r._id !== null
          ? JSON.stringify(r._id)
          : String(r._id ?? '_'),
        r,
      ]),
    );
  }

  /** One PmMetrics block for a scope and period. */
  async scopeMetrics(q: PmQuery, level: PmLevel = 'account', id?: string) {
    const s = this.scope(q, level, id);
    const [m, o, v] = await Promise.all([
      this.sums<MetaSums>(this.metaDaily, s.meta, null, META_SUMS),
      this.sums<OrderSums>(this.orders, s.order, null, ORDER_SUMS),
      this.sums<SiteSums>(this.visitors, s.site, null, SITE_SUMS),
    ]);
    return toMetrics(m.get('_'), o.get('_'), v.get('_'));
  }

  // ---------- summary ----------

  async summary(q: PmQuery): Promise<PmSummaryResponse> {
    const previous = { ...previousPeriod(q.from, q.to), product: q.product };
    const [current, prior, allOrders, attributionCoverage, dataFreshness] =
      await Promise.all([
        this.scopeMetrics(q),
        this.scopeMetrics(previous),
        this.allOrders(q),
        this.coverage(q),
        this.freshness(q.product),
      ]);
    const missingDays = await this.missingDays(q);
    return {
      query: q,
      previous: stripUndefined(previous),
      current,
      prior,
      change: metricsChange(current, prior),
      target: withMissingMeta(targetOf(current), missingDays.meta),
      allOrders,
      attributionCoverage,
      dataFreshness: { ...dataFreshness, missingDays },
    };
  }

  /** All confirmed orders, web and staff-entered, no attribution. */
  async allOrders(q: PmQuery) {
    const [r] = await this.orders.aggregate<{
      orders: number;
      revenue: number;
      webOrders: number;
      adminOrders: number;
    }>([
      {
        $match: {
          tenantId: this.env.tenantId,
          product: { $in: this.products(q.product) },
          day: { $gte: q.from, $lte: q.to },
          confirmed: true,
        },
      },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          revenue: { $sum: '$netRevenue' },
          webOrders: { $sum: { $cond: ['$adminCreated', 0, 1] } },
          adminOrders: { $sum: { $cond: ['$adminCreated', 1, 0] } },
        },
      },
    ]);
    return {
      orders: r?.orders ?? 0,
      revenue: Math.round((r?.revenue ?? 0) * 100) / 100,
      webOrders: r?.webOrders ?? 0,
      adminOrders: r?.adminOrders ?? 0,
    };
  }

  async coverage(q: PmQuery) {
    const [r] = await this.orders.aggregate<{
      n: number;
      visit: number;
      meta: number;
    }>([
      { $match: this.orderMatch(q) },
      {
        $group: {
          _id: null,
          n: { $sum: 1 },
          visit: {
            $sum: {
              $cond: [
                {
                  $gt: [
                    { $size: { $ifNull: ['$attribution.deviceIds', []] } },
                    0,
                  ],
                },
                1,
                0,
              ],
            },
          },
          meta: {
            $sum: {
              $cond: [{ $ifNull: ['$attribution.metaLast.adId', false] }, 1, 0],
            },
          },
        },
      },
    ]);
    return {
      linkedToVisit: ratio(r?.visit ?? 0, r?.n ?? 0),
      linkedToMetaAd: ratio(r?.meta ?? 0, r?.n ?? 0),
    };
  }

  async freshness(product?: string) {
    const base = {
      tenantId: this.env.tenantId,
      product: { $in: this.products(product) },
    };
    const [m, o, v] = await Promise.all([
      this.metaDaily.findOne(base, { date: 1 }).sort({ date: -1 }).lean(),
      this.orders.findOne(base, { day: 1 }).sort({ day: -1 }).lean(),
      this.visitors.findOne(base, { day: 1 }).sort({ day: -1 }).lean(),
    ]);
    return {
      metaThrough: m?.date ?? null,
      ordersThrough: o?.day ?? null,
      visitorsThrough: v?.day ?? null,
    };
  }

  /**
   * Meta days that are missing or partial: some configured ad account has no
   * pm_meta_account_daily row for the day, or its ad-level spend differs from
   * the account total by more than 1% and ₹50. Product-independent: a product
   * with no spend while the accounts reconcile simply was not advertised.
   */
  async metaMissingDays(from: string, to: string) {
    const days = dayRange(from, to, 400);
    const accounts = this.env.meta.accountIds;
    const range = { $gte: from, $lte: to };
    const [totals, adSums] = await Promise.all([
      this.accountDaily
        .find(
          {
            tenantId: this.env.tenantId,
            accountId: { $in: accounts },
            date: range,
          },
          { accountId: 1, date: 1, spend: 1 },
        )
        .lean(),
      this.sums<{ spend: number }>(
        this.metaDaily,
        $m({
          tenantId: this.env.tenantId,
          accountId: { $in: accounts },
          date: range,
        }),
        { a: '$accountId', d: '$date' },
        { spend: { $sum: '$spend' } },
      ),
    ]);
    const total = new Map(
      totals.map((t) => [`${t.accountId}|${t.date}`, t.spend ?? 0]),
    );
    return days.filter((d) =>
      accounts.some((a) => {
        const want = total.get(`${a}|${d}`);
        if (want === undefined) return true;
        const got = adSums.get(JSON.stringify({ a, d }))?.spend ?? 0;
        const diff = Math.abs(got - want);
        return diff > GAP_SHARE * want && diff > GAP_INR;
      }),
    );
  }

  /**
   * Days whose `breakdown` spend (all products) is not within 5% of the summed
   * account totals in pm_meta_account_daily for the configured accounts.
   * Both 0 counts as covered.
   */
  async breakdownMissingDays(from: string, to: string, breakdown = 'region') {
    const days = dayRange(from, to, 400);
    const accounts = this.env.meta.accountIds;
    const base = {
      tenantId: this.env.tenantId,
      accountId: { $in: accounts },
      date: { $gte: from, $lte: to },
    };
    const byDate = (m: Model<any>, extra = {}) =>
      this.sums<{ spend: number }>(m, $m({ ...base, ...extra }), '$date', {
        spend: { $sum: '$spend' },
      });
    const [acct, bd] = await Promise.all([
      byDate(this.accountDaily),
      byDate(this.breakdowns, { breakdown }),
    ]);
    return days.filter((d) => {
      const a = acct.get(d)?.spend ?? 0;
      const b = bd.get(d)?.spend ?? 0;
      if (!a && !b) return false;
      return Math.abs(b - a) > BREAKDOWN_SHARE * a;
    });
  }

  /**
   * Days in the window with no data. Meta: see metaMissingDays. Orders: no
   * order rows at all (any product or status — a quiet product is not a
   * gap). Visitors: any selected product has no rows.
   */
  async missingDays(q: PmQuery) {
    const days = dayRange(q.from, q.to, 400);
    const ids = this.products(q.product);
    const [meta, orders, visitors] = await Promise.all([
      this.metaMissingDays(q.from, q.to),
      this.orders.distinct('day', {
        tenantId: this.env.tenantId,
        product: { $in: PM_PRODUCTS.map((p) => p.id) },
        day: { $gte: q.from, $lte: q.to },
      }),
      this.visitors.aggregate<{ _id: string }>([
        { $match: this.siteMatch(q) },
        { $group: { _id: { day: '$day', product: '$product' } } },
        { $group: { _id: '$_id.day', n: { $sum: 1 } } },
        { $match: { n: ids.length } },
      ]),
    ]);
    return {
      meta,
      orders: missingFrom(days, orders as string[]),
      visitors: missingFrom(
        days,
        visitors.map((r) => r._id),
      ),
    };
  }

  /**
   * What the product scoping leaves out: Meta-attributed web orders of the
   * selected products whose ad is untagged or tagged outside the covered
   * products, and spend on ads tagged outside them (e.g. 'other').
   */
  async scopeLeaks(q: PmQuery) {
    const ids = PM_PRODUCTS.map((p) => p.id);
    const [[o], [m]] = await Promise.all([
      this.orders.aggregate<{ orders: number; revenue: number }>([
        {
          $match: this.orderMatch(q, {
            'attribution.metaLast.adId': NOT_EMPTY,
          }),
        },
        ...this.adTagStages(),
        { $match: { adProduct: { $nin: ids } } },
        {
          $group: {
            _id: null,
            orders: { $sum: 1 },
            revenue: { $sum: '$netRevenue' },
          },
        },
      ] as Stages),
      this.metaDaily.aggregate<{ spend: number }>([
        {
          $match: {
            tenantId: this.env.tenantId,
            date: { $gte: q.from, $lte: q.to },
            product: { $nin: ids },
          },
        },
        { $group: { _id: null, spend: { $sum: '$spend' } } },
      ]),
    ]);
    return {
      untaggedOrders: o?.orders ?? 0,
      untaggedRevenue: Math.round((o?.revenue ?? 0) * 100) / 100,
      otherSpend: Math.round((m?.spend ?? 0) * 100) / 100,
    };
  }

  // ---------- entities ----------

  /**
   * Rows for one level. Each row joins spend, orders and visitors purely by
   * the entity id (no product filter on orders — definition 3); the product
   * filter picks which entities are listed, by their tag.
   */
  async entities(
    q: PmQuery,
    level: EntityLevel,
    parentId?: string,
  ): Promise<PmEntitiesResponse> {
    const f = ID_FIELD[level];
    const t = this.env.tenantId;
    const days = { $gte: q.from, $lte: q.to };
    const parent = (prefix: string) =>
      parentId
        ? {
            $or: [
              { [`${prefix}campaignId`]: parentId },
              { [`${prefix}adsetId`]: parentId },
            ],
          }
        : {};
    const [meta, ords, site, missing] = await Promise.all([
      this.sums<
        MetaSums & {
          campaignId: string;
          adsetId: string;
          accountId: string;
          products: string[];
          activeDays: string[];
        }
      >(
        this.metaDaily,
        $m({ tenantId: t, date: days, [f]: NOT_EMPTY, ...parent('') }),
        `$${f}`,
        {
          ...META_SUMS,
          campaignId: { $first: '$campaignId' },
          adsetId: { $first: '$adsetId' },
          accountId: { $first: '$accountId' },
          products: { $addToSet: '$product' },
          activeDays: {
            $addToSet: { $cond: [{ $gt: ['$spend', 0] }, '$date', '$$REMOVE'] },
          },
        },
      ),
      this.sums<OrderSums & { campaignId: string; adsetId: string }>(
        this.orders,
        $m(
          this.webOrders(q, {
            [`attribution.metaLast.${f}`]: NOT_EMPTY,
            ...parent('attribution.metaLast.'),
          }),
        ),
        `$attribution.metaLast.${f}`,
        {
          ...ORDER_SUMS,
          campaignId: { $first: '$attribution.metaLast.campaignId' },
          adsetId: { $first: '$attribution.metaLast.adsetId' },
        },
      ),
      this.sums<SiteSums>(
        this.visitors,
        $m({
          tenantId: t,
          day: days,
          [`metaAd.last.${f}`]: NOT_EMPTY,
          ...parent('metaAd.last.'),
        }),
        `$metaAd.last.${f}`,
        SITE_SUMS,
      ),
      this.metaMissingDays(q.from, q.to),
    ]);
    const all = [...new Set([...meta.keys(), ...ords.keys()])];
    const docs = await this.entitiesModel
      .find({ tenantId: t, level, entityId: { $in: all } })
      .lean();
    const byId = new Map(docs.map((d) => [d.entityId, d]));
    const scope = new Set(this.products(q.product));
    // The entity's own tag; else the tag on its daily rows.
    const tagOf = (id: string) => {
      const m = meta.get(id)?.products ?? [];
      return byId.get(id)?.product || m.find((p) => scope.has(p)) || m[0] || '';
    };
    // Entities with delivery or with attributed orders (orders with no spend
    // in range still show, with ROAS null — they are not hidden). Unknown
    // entities (no tag) are left out; scopeLeaks reports their orders.
    const ids = all.filter((id) => scope.has(tagOf(id)));
    const rows: PmEntityRow[] = ids.map((id) => {
      const m = meta.get(id);
      const o = ords.get(id);
      const e = byId.get(id);
      const metrics = toMetrics(m, o, site.get(id));
      return {
        level,
        id,
        name: e?.name ?? '',
        campaignId:
          level === 'campaign'
            ? id
            : e?.campaignId || m?.campaignId || o?.campaignId || '',
        adsetId:
          level === 'adset'
            ? id
            : level === 'ad'
              ? e?.adsetId || m?.adsetId || o?.adsetId || ''
              : '',
        accountId: e?.accountId || m?.accountId || '',
        product: tagOf(id),
        status: e?.status ?? '',
        effectiveStatus: e?.effectiveStatus ?? '',
        budgetLevel: e?.budgetLevel ?? '',
        dailyBudget: e?.dailyBudget ?? null,
        metrics,
        target: withMissingMeta(targetOf(metrics), missing),
        activeDays: m?.activeDays.length ?? 0,
      };
    });
    rows.sort(
      (a, b) =>
        b.metrics.spend - a.metrics.spend ||
        b.metrics.firstPartyOrders - a.metrics.firstPartyOrders,
    );
    return {
      query: { ...q, level, ...(parentId ? { parentId } : {}) },
      rows,
    };
  }

  // ---------- trend ----------

  async trend(
    q: PmQuery,
    level: PmLevel = 'account',
    id?: string,
  ): Promise<PmTrendResponse> {
    const s = this.scope(q, level, id);
    const [m, o, v] = await Promise.all([
      this.sums<MetaSums>(this.metaDaily, s.meta, '$date', META_SUMS),
      this.sums<OrderSums>(this.orders, s.order, '$day', ORDER_SUMS),
      this.sums<SiteSums>(this.visitors, s.site, '$day', SITE_SUMS),
    ]);
    const days = dayRange(q.from, q.to);
    const points = days.map((date) => {
      const x = toMetrics(m.get(date), o.get(date), v.get(date));
      return {
        date,
        spend: x.spend,
        impressions: x.impressions,
        linkClicks: x.linkClicks,
        cpm: x.cpm,
        ctr: x.ctr,
        frequency: x.frequency,
        metaPurchases: x.metaPurchases,
        firstPartyOrders: x.firstPartyOrders,
        firstPartyRevenue: x.firstPartyRevenue,
        firstPartyRoas: x.firstPartyRoas,
        firstPartyCpa: x.firstPartyCpa,
        siteVisitors: x.siteVisitors,
      };
    });
    // Null until 7 days of the range are available.
    const rollingRoas7 = points.map((_, i) => {
      if (i < 6) return null;
      const w = points.slice(i - 6, i + 1);
      return ratio(
        w.reduce((t, p) => t + p.firstPartyRevenue, 0),
        w.reduce((t, p) => t + p.spend, 0),
      );
    });
    return {
      query: { ...q, level, ...(id ? { id } : {}) },
      points,
      rollingRoas7,
    };
  }

  // ---------- decompose ----------

  async decompose(
    q: PmQuery,
    level: PmLevel = 'account',
    id?: string,
  ): Promise<PmDecomposeResponse> {
    const previous = { ...previousPeriod(q.from, q.to), product: q.product };
    const [cur, pri, missing] = await Promise.all([
      this.scopeMetrics(q, level, id),
      this.scopeMetrics(previous, level, id),
      this.metaMissingDays(previous.from, q.to),
    ]);
    const factors = decomposeCpa(cur, pri);
    const cpa = {
      current: cur.firstPartyCpa,
      prior: pri.firstPartyCpa,
      change: relChange(cur.firstPartyCpa, pri.firstPartyCpa),
    };
    return {
      query: { ...q, level, ...(id ? { id } : {}) },
      previous: stripUndefined(previous),
      cpa,
      factors,
      read:
        (missing.length
          ? `Meta data missing for ${listDays(missing)} — treat with caution. `
          : '') + readDecomposition(cpa.change, factors),
      confidence: missing.length
        ? 'low'
        : confidenceFor(Math.min(cur.firstPartyOrders, pri.firstPartyOrders)),
    };
  }

  // ---------- funnel ----------

  /**
   * Confirmed web orders joined to the visitor-day row of their device on the
   * order's day (the row with the payment event first). Orders with no
   * same-day row are dropped. `rowFilter` applies to the joined row.
   */
  private ordersWithRow(
    orderStages: Stages,
    rowFilter: Record<string, unknown>,
    tail: Stages,
  ) {
    const rowMatch = Object.fromEntries(
      Object.entries(rowFilter).map(([k, val]) => [`row.${k}`, val]),
    );
    return this.orders.aggregate([
      ...orderStages,
      {
        $lookup: {
          from: this.visitors.collection.name,
          localField: 'attribution.deviceIds',
          foreignField: 'deviceId',
          let: { p: '$product', d: '$day' },
          pipeline: [
            {
              $match: {
                tenantId: this.env.tenantId,
                $expr: {
                  $and: [
                    { $eq: ['$product', '$$p'] },
                    { $eq: ['$day', '$$d'] },
                  ],
                },
              },
            },
            { $addFields: { np: { $size: { $ifNull: ['$payments', []] } } } },
            { $sort: { np: -1, deviceId: 1 } },
            { $limit: 1 },
            {
              $project: {
                traffic: 1,
                metaAd: 1,
                tech: 1,
                locale: 1,
                geo: 1,
                maxScroll: 1,
                activeSecondsLanding: 1,
              },
            },
          ],
          as: 'row',
        },
      },
      { $unwind: '$row' },
      ...(Object.keys(rowMatch).length ? [{ $match: rowMatch }] : []),
      ...tail,
    ] as PipelineStage[]);
  }

  async funnel(
    q: PmQuery,
    channel?: string,
    adId?: string,
  ): Promise<PmFunnelResponse> {
    const rowFilter: Record<string, unknown> = {};
    if (channel) rowFilter['traffic.channel'] = channel;
    if (adId) rowFilter['metaAd.last.adId'] = adId;

    // Stage order. For one product: its configured steps (coupon is optional,
    // not a stage). For all products: only steps every product has.
    const lists = this.products(q.product).map((id) =>
      findPmProduct(id)!
        .steps.map((s) => s.key as string)
        .filter((k) => k !== 'couponApplied'),
    );
    const stepKeys = lists[0].filter((k) => lists.every((l) => l.includes(k)));

    const groupCounts = (key: unknown, extra: Record<string, unknown> = {}) => [
      { $group: { _id: key, n: { $sum: 1 }, ...extra } },
    ];
    const deep = { $sum: { $cond: [{ $gte: ['$maxScroll', 75] }, 1, 0] } };
    const facets = (p: string) => ({
      scroll: groupCounts(bandIndexExpr(`$${p}maxScroll`, SCROLL_BANDS.uppers)),
      time: groupCounts(
        bandIndexExpr(`$${p}activeSecondsLanding`, TIME_BANDS.uppers),
      ),
      channel: groupCounts({ $ifNull: [`$${p}traffic.channel`, 'unknown'] }),
      device: groupCounts({ $ifNull: [`$${p}tech.device`, 'unknown'] }),
      locale: groupCounts({ $ifNull: [`$${p}locale`, 'en'] }),
    });

    type Bucket = { _id: string | number; n: number; deep?: number };
    type F = Record<
      'scroll' | 'time' | 'channel' | 'device' | 'locale',
      Bucket[]
    >;
    const visitorFacets = {
      ...facets(''),
      channel: groupCounts(
        { $ifNull: ['$traffic.channel', 'unknown'] },
        { deep },
      ),
      totals: [
        {
          $group: {
            _id: null,
            visitors: { $sum: 1 },
            ...Object.fromEntries(
              stepKeys.map((k) => [k, { $sum: hasStep(k) }]),
            ),
          },
        },
      ],
    };
    const [[vf], [of]] = await Promise.all([
      this.visitors.aggregate<F & { totals: Record<string, number>[] }>([
        { $match: this.siteMatch(q, rowFilter) },
        { $facet: visitorFacets },
      ]),
      this.ordersWithRow(
        $m(
          this.orderMatch(q, { 'attribution.deviceIds.0': { $exists: true } }),
        ),
        rowFilter,
        [{ $facet: { ...facets('row.'), totals: [{ $count: 'n' }] } }],
      ) as unknown as Promise<(F & { totals: { n: number }[] })[]>,
    ]);
    const totals = vf.totals[0] ?? { visitors: 0 };
    const orderCount = of.totals[0]?.n ?? 0;

    const seq = [
      { key: 'visitors', visitors: totals.visitors ?? 0 },
      ...stepKeys.map((k) => ({ key: k, visitors: totals[k] ?? 0 })),
      { key: 'order', visitors: orderCount },
    ];
    const start = seq[0].visitors;
    const steps = seq.map((s, i) => ({
      key: s.key,
      label: STEP_LABELS[s.key] ?? s.key,
      visitors: s.visitors,
      rateFromPrevious: i ? ratio(s.visitors, seq[i - 1].visitors) : null,
      rateFromStart: i ? ratio(s.visitors, start) : null,
    }));

    const toMap = (b: Bucket[]) => new Map(b.map((x) => [String(x._id), x]));
    const bands = (labels: string[], v: Bucket[], o: Bucket[]) => {
      const vm = toMap(v);
      const om = toMap(o);
      return labels.map((band, i) => {
        const visitors = vm.get(String(i))?.n ?? 0;
        const orders = om.get(String(i))?.n ?? 0;
        return { band, visitors, orders, conversion: ratio(orders, visitors) };
      });
    };
    const split = (v: Bucket[], o: Bucket[]) => {
      const om = toMap(o);
      return v
        .map((x) => {
          const orders = om.get(String(x._id))?.n ?? 0;
          return {
            key: String(x._id),
            visitors: x.n,
            orders,
            conversion: ratio(orders, x.n),
            deep: x.deep,
          };
        })
        .sort((a, b) => b.visitors - a.visitors);
    };

    return {
      query: {
        ...q,
        ...(channel ? { channel } : {}),
        ...(adId ? { adId } : {}),
      },
      steps,
      scroll: bands(SCROLL_BANDS.labels, vf.scroll, of.scroll),
      timeOnPage: bands(TIME_BANDS.labels, vf.time, of.time),
      byChannel: split(vf.channel, of.channel).map((x) => ({
        channel: x.key,
        visitors: x.visitors,
        orders: x.orders,
        conversion: x.conversion,
        deepScrollShare: ratio(x.deep ?? 0, x.visitors),
      })),
      byDevice: split(vf.device, of.device).map((x) => ({
        device: x.key,
        visitors: x.visitors,
        orders: x.orders,
        conversion: x.conversion,
      })),
      byLocale: split(vf.locale, of.locale).map((x) => ({
        locale: x.key,
        visitors: x.visitors,
        orders: x.orders,
        conversion: x.conversion,
      })),
      caveat:
        'Visitors are OpenPanel visitor-days (device ids rotate daily). Each step counts visitors who fired that event, so a later step can exceed an earlier one when people skip it. Orders are confirmed web orders matched to the buyer’s device on the order day (staff-entered orders excluded; orders without a same-day visit are not counted). Scroll depth, time on page and the other splits are correlations, not causes — deeper scrolling does not make people buy.',
    };
  }

  // ---------- fatigue ----------

  async fatigue(q: PmQuery): Promise<PmFatigueResponse> {
    type Day = {
      date: string;
      spend: number;
      impressions: number;
      linkClicks: number;
      freqImp: number;
    };
    const [ads, ordersByDay, missing] = await Promise.all([
      this.metaDaily.aggregate<{
        _id: string;
        product: string;
        campaignId: string;
        spend: number;
        n: number;
        first: Day[];
        last: Day[];
      }>([
        { $match: this.metaMatch(q, { spend: { $gt: 0 } }) },
        { $sort: { date: 1 } },
        {
          $group: {
            _id: '$adId',
            product: { $first: '$product' },
            campaignId: { $first: '$campaignId' },
            spend: { $sum: '$spend' },
            days: {
              $push: {
                date: '$date',
                spend: '$spend',
                impressions: '$impressions',
                linkClicks: '$linkClicks',
                freqImp: { $multiply: ['$frequency', '$impressions'] },
              },
            },
          },
        },
        {
          $project: {
            product: 1,
            campaignId: 1,
            spend: 1,
            n: { $size: '$days' },
            first: { $slice: ['$days', 7] },
            last: { $slice: ['$days', -7] },
          },
        },
        { $sort: { spend: -1 } },
      ]),
      // By ad id only — every order the ad got, whatever its product.
      this.sums<{ orders: number }>(
        this.orders,
        $m(this.webOrders(q, { 'attribution.metaLast.adId': NOT_EMPTY })),
        { ad: '$attribution.metaLast.adId', day: '$day' },
        { orders: { $sum: 1 } },
      ),
      this.metaMissingDays(q.from, q.to),
    ]);
    const gap = missing.length
      ? {
          status: 'not_enough_data' as const,
          reasons: [`Meta data missing for ${listDays(missing)}`],
        }
      : {};
    const ids = [...new Set(ads.flatMap((a) => [a._id, a.campaignId]))];
    const docs = await this.entitiesModel
      .find({ tenantId: this.env.tenantId, entityId: { $in: ids } })
      .lean();
    const byId = new Map(docs.map((d) => [d.entityId, d]));
    const sum = (adId: string, days: Day[]): WindowSums =>
      days.reduce(
        (s, d) => ({
          spend: s.spend + d.spend,
          impressions: s.impressions + d.impressions,
          linkClicks: s.linkClicks + d.linkClicks,
          freqImp: s.freqImp + d.freqImp,
          orders:
            s.orders +
            (ordersByDay.get(JSON.stringify({ ad: adId, day: d.date }))
              ?.orders ?? 0),
        }),
        { spend: 0, impressions: 0, linkClicks: 0, freqImp: 0, orders: 0 },
      );
    return {
      query: q,
      rows: ads.map((a) => {
        const e = byId.get(a._id);
        const c = e?.creative;
        return {
          adId: a._id,
          adName: e?.name ?? '',
          campaignName: byId.get(a.campaignId)?.name ?? '',
          product: e?.product || a.product,
          daysLive: a.n,
          spend: Math.round(a.spend * 100) / 100,
          ...fatigueOf(a.n, sum(a._id, a.first), sum(a._id, a.last)),
          ...gap,
          creative: c
            ? {
                title: c.title,
                body: c.body,
                thumbnailUrl: c.thumbnailUrl ?? c.imageUrl,
                linkUrl: c.linkUrl,
              }
            : null,
        };
      }),
    };
  }

  // ---------- geo ----------

  async geo(q: PmQuery): Promise<PmGeoResponse> {
    const [meta, site, ords, missing, regionMissing] = await Promise.all([
      this.breakdowns.aggregate<{
        _id: string;
        spend: number;
        linkClicks: number;
      }>([
        { $match: this.metaMatch(q, { breakdown: 'region' }) },
        {
          $group: {
            _id: '$key',
            spend: { $sum: '$spend' },
            linkClicks: { $sum: '$linkClicks' },
          },
        },
      ]),
      this.visitors.aggregate<{ _id: string | null; n: number }>([
        { $match: this.siteMatch(q, { 'metaAd.last.adId': NOT_EMPTY }) },
        { $group: { _id: '$geo.region', n: { $sum: 1 } } },
      ]),
      this.ordersWithRow(
        this.taggedOrders(q, { 'attribution.deviceIds.0': { $exists: true } }),
        {},
        [
          {
            $group: {
              _id: '$row.geo.region',
              orders: { $sum: 1 },
              revenue: { $sum: '$netRevenue' },
            },
          },
        ],
      ) as unknown as Promise<
        { _id: string | null; orders: number; revenue: number }[]
      >,
      this.metaMissingDays(q.from, q.to),
      this.breakdownMissingDays(q.from, q.to, 'region'),
    ]);
    const gap = missing.length > 0 || regionMissing.length > 0;
    const acc = new Map<
      string,
      {
        spend: number;
        linkClicks: number;
        siteVisitors: number;
        orders: number;
        revenue: number;
      }
    >();
    const get = (r: string | null) => {
      const k = normaliseRegion(r);
      if (!acc.has(k))
        acc.set(k, {
          spend: 0,
          linkClicks: 0,
          siteVisitors: 0,
          orders: 0,
          revenue: 0,
        });
      return acc.get(k)!;
    };
    for (const m of meta) {
      const g = get(m._id);
      g.spend += m.spend;
      g.linkClicks += m.linkClicks;
    }
    for (const s of site) get(s._id).siteVisitors += s.n;
    for (const o of ords) {
      const g = get(o._id);
      g.orders += o.orders;
      g.revenue += o.revenue;
    }
    const rows = [...acc.entries()]
      .map(([state, g]) => ({
        state,
        spend: Math.round(g.spend * 100) / 100,
        linkClicks: g.linkClicks,
        siteVisitors: g.siteVisitors,
        firstPartyOrders: g.orders,
        firstPartyRevenue: Math.round(g.revenue * 100) / 100,
        roasEstimate: regionMissing.length ? null : ratio(g.revenue, g.spend),
        visitToOrderRate: ratio(g.orders, g.siteVisitors),
        confidence: gap ? ('low' as const) : confidenceFor(g.orders),
      }))
      .sort((a, b) => b.spend - a.spend || b.siteVisitors - a.siteVisitors);
    return {
      query: q,
      rows,
      caveat:
        (regionMissing.length
          ? `Region spend missing for ${listDays(regionMissing)} — ROAS by state not computed. `
          : '') +
        (missing.length
          ? `Meta data missing for ${listDays(missing)} — spend is understated, confidence lowered. `
          : '') +
        'Spend and clicks are Meta’s region breakdown; visitors and orders are first-party, placed in a state by the OpenPanel (IP-based) region of the buyer’s visit — the two geographies can disagree. State names are normalised between the two (e.g. “National Capital Territory of Delhi” → “Delhi”). Orders are Meta-attributed web orders (device-matched, 7-day click), a lower bound, so ROAS here is an estimate. Respect the ad set targeting: one broad ad set cannot be given a per-state budget.',
    };
  }

  // ---------- budget ----------

  async budget(q: PmQuery): Promise<PmBudgetResponse> {
    const t = this.env.tenantId;
    const days = { $gte: q.from, $lte: q.to };
    const levels = ['campaign', 'adset'] as const;
    const recentFrom = istDayBounds(addDays(q.to, -2)).start;
    const recentTo = istDayBounds(q.to).end;
    // Joined purely by entity id; the product filter picks entities by tag.
    const perLevel = await Promise.all(
      levels.map(async (level) => {
        const f = ID_FIELD[level];
        const [series, revenue] = await Promise.all([
          this.metaDaily.aggregate<{
            _id: string;
            campaignId: string;
            products: string[][];
            days: BudgetDay[];
          }>([
            { $match: { tenantId: t, date: days, [f]: NOT_EMPTY } },
            {
              $group: {
                _id: { e: `$${f}`, date: '$date' },
                campaignId: { $first: '$campaignId' },
                products: { $addToSet: '$product' },
                spend: { $sum: '$spend' },
                metaValue: { $sum: '$metaPurchaseValue' },
                // Σ ad reach overstates unique reach; only its trend is used.
                reach: { $sum: '$reach' },
                impressions: { $sum: '$impressions' },
                freqImp: {
                  $sum: { $multiply: ['$frequency', '$impressions'] },
                },
                ads: {
                  $addToSet: {
                    $cond: [{ $gt: ['$spend', 0] }, '$adId', '$$REMOVE'],
                  },
                },
              },
            },
            { $match: { spend: { $gt: 0 } } },
            { $sort: { '_id.date': 1 } },
            {
              $group: {
                _id: '$_id.e',
                campaignId: { $first: '$campaignId' },
                products: { $push: '$products' },
                days: {
                  $push: {
                    date: '$_id.date',
                    spend: '$spend',
                    metaValue: '$metaValue',
                    reach: '$reach',
                    impressions: '$impressions',
                    freqImp: '$freqImp',
                    ads: '$ads',
                  },
                },
              },
            },
          ]),
          this.sums<{ revenue: number; orders: number }>(
            this.orders,
            $m(this.webOrders(q, { [`attribution.metaLast.${f}`]: NOT_EMPTY })),
            { e: `$attribution.metaLast.${f}`, day: '$day' },
            { revenue: { $sum: '$netRevenue' }, orders: { $sum: 1 } },
          ),
        ]);
        // All attributed orders per entity in range (also days without spend).
        const totals = new Map<string, { orders: number; revenue: number }>();
        for (const [k, v] of revenue) {
          const e = (JSON.parse(k) as { e: string }).e;
          const x = totals.get(e) ?? { orders: 0, revenue: 0 };
          x.orders += v.orders;
          x.revenue += v.revenue;
          totals.set(e, x);
        }
        return { level, series, revenue, totals };
      }),
    );
    const ids = [
      ...new Set(
        perLevel.flatMap((l) => l.series.flatMap((s) => [s._id, s.campaignId])),
      ),
    ];
    const [docs, changes, newAds, missing, account] = await Promise.all([
      this.entitiesModel.find({ tenantId: t, entityId: { $in: ids } }).lean(),
      this.changesModel.aggregate<{ _id: string; last: Date; type: string }>([
        {
          $match: {
            tenantId: t,
            eventTime: { $gte: recentFrom, $lt: recentTo },
          },
        },
        { $sort: { eventTime: -1 } },
        {
          $group: {
            _id: '$objectId',
            last: { $first: '$eventTime' },
            type: { $first: '$translatedEventType' },
          },
        },
      ]),
      this.entitiesModel
        .find(
          {
            tenantId: t,
            level: 'ad',
            createdTime: { $gte: recentFrom, $lt: recentTo },
          },
          { adsetId: 1, campaignId: 1, createdTime: 1 },
        )
        .lean(),
      this.metaMissingDays(q.from, q.to),
      this.scopeMetrics(q),
    ]);
    const byId = new Map(docs.map((d) => [d.entityId, d]));
    const changed = new Map(changes.map((c) => [c._id, c]));
    const scope = new Set(this.products(q.product));
    const fmt = (c: { type: string; last: Date }, what: string) =>
      `${what}${c.type || 'change'} ${istDay(c.last)}`;

    const rows: PmBudgetRow[] = perLevel.flatMap(
      ({ level, series, revenue, totals }) =>
        series
          .filter((s) =>
            scope.has(
              byId.get(s._id)?.product ||
                s.products.flat().find((p) => scope.has(p)) ||
                '',
            ),
          )
          .map((s) => {
            const e = byId.get(s._id);
            const camp = byId.get(s.campaignId);
            const days = s.days;
            const n = days.length;
            const rev = days.map(
              (d) =>
                revenue.get(JSON.stringify({ e: s._id, day: d.date }))
                  ?.revenue ?? 0,
            );
            const orders = totals.get(s._id)?.orders ?? 0;
            const totalRev = totals.get(s._id)?.revenue ?? 0;
            const spend = days.reduce((x, d) => x + d.spend, 0);
            const half = Math.floor(n / 2);
            const h1 = days.slice(0, half);
            const h2 = days.slice(n - half);
            const wf = (h: BudgetDay[]) =>
              ratio(
                h.reduce((x, d) => x + d.freqImp, 0),
                h.reduce((x, d) => x + d.impressions, 0),
              );
            const avgReach = (h: BudgetDay[]) =>
              ratio(
                h.reduce((x, d) => x + d.reach, 0),
                h.length,
              );
            const adSet = (h: BudgetDay[]) =>
              [...new Set(h.flatMap((d) => d.ads))].sort().join(',');
            // Summed reach is only comparable when the same ads ran.
            const sameAds = half > 0 && adSet(h1) === adSet(h2);
            const marginalRoas =
              n >= 7
                ? olsSlope(
                    days.map((d) => d.spend),
                    rev,
                  )
                : null;
            const frequencyTrend = half ? relChange(wf(h2), wf(h1)) : null;
            const reachTrend = sameAds
              ? relChange(avgReach(h2), avgReach(h1))
              : null;
            const budgetLevel =
              (level === 'campaign' ? e?.budgetLevel : camp?.budgetLevel) ?? '';
            // Recent edits: the entity itself, its CBO campaign, or a new ad under it.
            const own = changed.get(s._id);
            const parent =
              level === 'adset' && budgetLevel === 'campaign'
                ? changed.get(s.campaignId)
                : undefined;
            const added = newAds.find((x) =>
              level === 'adset' ? x.adsetId === s._id : x.campaignId === s._id,
            );
            const recentChange = own
              ? fmt(own, '')
              : parent
                ? fmt(parent, 'campaign ')
                : added?.createdTime
                  ? `new ad ${istDay(added.createdTime)}`
                  : null;
            const sig = missing.length
              ? {
                  signal: 'not_enough_data' as const,
                  reasons: [`Meta data missing for ${listDays(missing)}`],
                }
              : budgetSignalOf({
                  activeDays: n,
                  spend,
                  revenue: totalRev,
                  orders,
                  metaRoas: ratio(
                    days.reduce((x, d) => x + d.metaValue, 0),
                    spend,
                  ),
                  accountRoas: account.firstPartyRoas,
                  marginalRoas,
                  frequencyTrend,
                  reachTrend,
                  recentChange,
                });
            if (half && !sameAds)
              sig.reasons.push(
                'Different ads ran in the two halves — reach trend not comparable',
              );
            if (level === 'adset' && budgetLevel === 'campaign')
              sig.reasons.push(
                'Budget is set on the campaign (CBO/Advantage+) — change it there, not on this ad set',
              );
            if (level === 'campaign' && budgetLevel === 'adset')
              sig.reasons.push(
                'Budgets are set per ad set (ABO) — act on the ad sets',
              );
            return {
              level,
              id: s._id,
              name: e?.name ?? '',
              budgetLevel,
              dailyBudget: e?.dailyBudget ?? null,
              learningStage: e?.learningStage ?? '',
              spend: Math.round(spend * 100) / 100,
              firstPartyRoas: ratio(totalRev, spend),
              marginalRoas,
              frequencyTrend,
              reachTrend,
              signal: sig.signal,
              reasons: sig.reasons,
            };
          }),
    );
    rows.sort((a, b) => b.spend - a.spend);
    return {
      query: q,
      rows,
      caveat:
        'Signals are descriptive, not causal. Marginal ROAS is the slope of daily first-party revenue on daily spend over the range — days differ in more than spend, and a handful of orders per day makes it noisy. Revenue is first-party (device-matched, 7-day click), a lower bound. Frequency is the average daily frequency (impression-weighted), not period frequency. Reach is summed across ads, so its trend is shown only when the same ads ran in both halves. Budget changes reset learning; test in steps of 10–20% and re-check after 7 days.',
    };
  }

  // ---------- reconcile ----------

  async reconcile(q: PmQuery): Promise<PmReconcileResponse> {
    const [meta, ords, all, leaks] = await Promise.all([
      this.sums<{
        metaPurchases: number;
        metaPurchaseValue: number;
        product: string;
      }>(
        this.metaDaily,
        $m(this.metaMatch(q, { campaignId: NOT_EMPTY })),
        '$campaignId',
        {
          metaPurchases: { $sum: '$metaPurchases' },
          metaPurchaseValue: { $sum: '$metaPurchaseValue' },
          product: { $first: '$product' },
        },
      ),
      this.sums<OrderSums & { product: string }>(
        this.orders,
        this.taggedOrders(q, { 'attribution.metaLast.campaignId': NOT_EMPTY }),
        '$attribution.metaLast.campaignId',
        { ...ORDER_SUMS, product: { $first: '$adProduct' } },
      ),
      this.allOrders(q),
      this.scopeLeaks(q),
    ]);
    const ids = [...new Set([...meta.keys(), ...ords.keys()])];
    const docs = await this.entitiesModel
      .find({
        tenantId: this.env.tenantId,
        level: 'campaign',
        entityId: { $in: ids },
      })
      .lean();
    const byId = new Map(docs.map((d) => [d.entityId, d]));
    const rows = ids
      .map((id) => {
        const m = meta.get(id);
        const o = ords.get(id);
        const metaPurchases = m?.metaPurchases ?? 0;
        const firstPartyOrders = o?.orders ?? 0;
        return {
          campaignId: id,
          campaignName: byId.get(id)?.name ?? '',
          product: byId.get(id)?.product || m?.product || o?.product || '',
          metaPurchases,
          metaPurchaseValue:
            Math.round((m?.metaPurchaseValue ?? 0) * 100) / 100,
          firstPartyOrders,
          firstPartyRevenue: Math.round((o?.revenue ?? 0) * 100) / 100,
          matchRatio: ratio(firstPartyOrders, metaPurchases),
        };
      })
      .filter((r) => r.metaPurchases || r.firstPartyOrders)
      .sort(
        (a, b) =>
          b.metaPurchases - a.metaPurchases ||
          b.firstPartyOrders - a.firstPartyOrders,
      );
    const totals = {
      metaPurchases: rows.reduce((t, r) => t + r.metaPurchases, 0),
      firstPartyOrders: rows.reduce((t, r) => t + r.firstPartyOrders, 0),
      allConfirmedOrders: all.orders,
    };
    return {
      query: q,
      rows,
      totals,
      notes: [
        'Meta purchases use the ad account’s attribution setting (click and view windows, modelled conversions) — expect them to exceed first-party.',
        'First-party orders: confirmed web orders whose buyer device had a Meta ad click in the 7 days before (device ids rotate daily, so a lower bound).',
        'Meta purchase value is what the pixel/CAPI sent (e.g. a flat ₹1,300 for Nadi Premium), not net revenue.',
        `All confirmed orders (${all.orders}, incl. ${all.adminOrders} staff-entered) is the product-level reality check across every channel.`,
        'Orders are counted under the product their attributed ad is tagged with (same rule as spend), not the product bought.',
        ...(leaks.untaggedOrders
          ? [
              `${leaks.untaggedOrders} Meta-attributed orders (₹${Math.round(leaks.untaggedRevenue).toLocaleString('en-IN')}) came from ads that are untagged or tagged outside the covered products — not counted here.`,
            ]
          : []),
        ...(leaks.otherSpend
          ? [
              `₹${Math.round(leaks.otherSpend).toLocaleString('en-IN')} Meta spend on ads tagged outside the covered products is excluded.`,
            ]
          : []),
      ],
    };
  }

  // ---------- report ----------

  /**
   * The daily rule-based report for `date` (last 7 days ending on it),
   * optionally for one product.
   */
  async report(date: string, product?: string): Promise<PmReportResponse> {
    const p = product ? { product } : {};
    const last7 = { from: addDays(date, -6), to: date, ...p };
    const prior7 = { from: addDays(date, -13), to: addDays(date, -7), ...p };
    const last30 = { from: addDays(date, -29), to: date, ...p };
    const covered = product
      ? PM_PRODUCTS.filter((x) => x.id === product)
      : PM_PRODUCTS;
    const [
      summary,
      priorCoverage,
      products,
      adsets,
      decompose,
      fatigue,
      budget,
      geo,
      reconcile,
      changes,
      missing30,
      leaks,
      breakdownMissing30,
    ] = await Promise.all([
      this.summary(last7),
      this.coverage(prior7),
      Promise.all(
        covered.map((x) =>
          Promise.all([
            this.scopeMetrics({ ...last7, product: x.id }),
            this.scopeMetrics({ ...prior7, product: x.id }),
          ]),
        ),
      ),
      this.entities(last7, 'adset'),
      this.decompose(last7),
      this.fatigue(last30),
      this.budget(last30),
      this.geo(last30),
      this.reconcile(last7),
      this.productChanges(last7),
      this.metaMissingDays(last30.from, last30.to),
      this.scopeLeaks(last7),
      this.breakdownMissingDays(last30.from, last30.to, 'region'),
    ]);
    const adsetsOnHold = await this.adsetsOnHold(
      adsets.rows.map((r) => r.id),
      changes.rows.map((c) => c.objectId),
    );
    const metaMissing = summary.dataFreshness.missingDays?.meta ?? [];
    return buildReport({
      date,
      window: { last7, prior7, last30 },
      scopeName: product ? covered[0].label : 'All covered products',
      summary,
      priorCoverage,
      byProduct: covered.map((x, i) => ({
        product: x.id,
        label: x.label,
        last7: products[i][0],
        prior7: products[i][1],
        metaMissing,
      })),
      adsets,
      adsetsOnHold,
      decompose,
      fatigue,
      budget,
      geo,
      reconcile,
      changes,
      missing30,
      breakdownMissing30,
      leaks,
      generatedAt: new Date().toISOString(),
    });
  }

  /**
   * Ad sets not to judge yet: in Meta's learning phase, or edited in the
   * window (the ad set, its campaign, or one of its ads).
   */
  private async adsetsOnHold(adsetIds: string[], changedIds: string[]) {
    const changed = new Set(changedIds);
    const docs = await this.entitiesModel
      .find(
        {
          tenantId: this.env.tenantId,
          $or: [
            { level: 'adset', entityId: { $in: adsetIds } },
            { level: 'ad', entityId: { $in: changedIds } },
          ],
        },
        { level: 1, entityId: 1, adsetId: 1, campaignId: 1, learningStage: 1 },
      )
      .lean();
    const adsWithEdits = new Set(
      docs.filter((d) => d.level === 'ad').map((d) => d.adsetId),
    );
    return docs
      .filter(
        (d) =>
          d.level === 'adset' &&
          (/^LEARNING$/i.test(d.learningStage ?? '') ||
            changed.has(d.entityId) ||
            changed.has(d.campaignId) ||
            adsWithEdits.has(d.entityId)),
      )
      .map((d) => d.entityId);
  }

  /** Change log for a period; with a product, only edits to its entities. */
  private async productChanges(q: PmQuery) {
    const res = await this.changes(q.from, q.to);
    if (!q.product) return res;
    const ids = new Set(
      (
        await this.entitiesModel
          .find(
            { tenantId: this.env.tenantId, product: q.product },
            { entityId: 1 },
          )
          .lean()
      ).map((e) => e.entityId),
    );
    return { ...res, rows: res.rows.filter((r) => ids.has(r.objectId)) };
  }

  // ---------- changes ----------

  async changes(
    from: string,
    to: string,
    objectId?: string,
  ): Promise<PmChangesResponse> {
    const rows = await this.changesModel
      .find({
        tenantId: this.env.tenantId,
        eventTime: {
          $gte: istDayBounds(from).start,
          $lt: istDayBounds(to).end,
        },
        ...(objectId ? { objectId } : {}),
      })
      .sort({ eventTime: -1 })
      .limit(CHANGES_LIMIT + 1)
      .lean();
    const truncated = rows.length > CHANGES_LIMIT;
    return {
      query: { from, to, ...(objectId ? { objectId } : {}) },
      ...(truncated ? { truncated } : {}),
      rows: rows.slice(0, CHANGES_LIMIT).map((r) => ({
        eventTime: new Date(r.eventTime).toISOString(),
        accountId: r.accountId,
        objectType: r.objectType,
        objectId: r.objectId,
        objectName: r.objectName,
        eventType: r.eventType,
        translatedEventType: r.translatedEventType,
        actorName: r.actorName,
        extraData: r.extraData,
      })),
    };
  }
}

const stripUndefined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const FACTOR_WORDS = {
  cpm: {
    up: 'ads got more expensive to show (CPM)',
    down: 'cheaper impressions (CPM)',
  },
  ctr: {
    up: 'fewer people clicking the ads (CTR)',
    down: 'more people clicking the ads (CTR)',
  },
  clickToOrderRate: {
    up: 'fewer clicks turning into orders (site, offer or attribution)',
    down: 'more clicks turning into orders',
  },
};

export function readDecomposition(
  change: number | null,
  factors: { name: keyof typeof FACTOR_WORDS; contribution: number | null }[],
) {
  if (change == null || factors.some((f) => f.contribution == null))
    return 'Not enough first-party orders, clicks or impressions in one of the periods to split the CPA change.';
  const top = [...factors].sort((a, b) => b.contribution! - a.contribution!)[0];
  const dir = change > 0 ? 'rise' : 'fall';
  const words = FACTOR_WORDS[top.name][change > 0 ? 'up' : 'down'];
  return `CPA ${change > 0 ? '+' : ''}${Math.round(change * 100)}% vs the previous period. Most of the ${dir} (${Math.round(top.contribution! * 100)}%) came from ${words}.`;
}
