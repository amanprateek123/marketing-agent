import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';
import { z } from 'zod';
import { PmAnalysisService } from '../../analysis/pm-analysis.service';
import { PmLevel, PmMetrics } from '../../analysis/pm-analysis.types';
import {
  addDays,
  bandIndexExpr,
  normaliseRegion,
  poissonRateZ,
  previousPeriod,
  ratio,
  relChange,
  SCROLL_BANDS,
  targetOf,
  TIME_BANDS,
  weightedFrequency,
  withMissingMeta,
} from '../../analysis/pm-stats';
import { findPmProduct, PM_PRODUCTS, pmEnv, PmEnv } from '../../pm.config';
import { dayRange, istDay, istDayBounds } from '../../pm.logic';
import {
  PmMetaBreakdown,
  PmMetaChange,
  PmMetaDaily,
  PmMetaEntity,
} from '../../schemas/pm-meta.schema';
import { PmOrder } from '../../schemas/pm-order.schema';
import { PmVisitorDay } from '../../schemas/pm-visitor-day.schema';
import { PmToolCtx } from '../pm-agent.types';
import { PmToolDef } from './pm-tool';

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RANGE = {
  from: DAY.optional().describe(
    'YYYY-MM-DD (IST). Default: 14 days ending `to`',
  ),
  to: DAY.optional().describe(
    'YYYY-MM-DD (IST). Default: the day before the run date',
  ),
};
const MAX_RANGE_DAYS = 92;
/** Daily series tools return at most this many entity-days. */
const MAX_SERIES_POINTS = 400;
const NOT_EMPTY = { $nin: [null, ''] };
const PAID_STARTED = {
  $cond: [{ $gt: [{ $size: { $ifNull: ['$payments', []] } }, 0] }, 1, 0],
};
/** Meta change-log event types that can reset learning (Meta's "significant edits"). */
const SIGNIFICANT_RE =
  /budget|bid|target|creative|optimization|create|run_status|schedule|delete|archive/i;

const METRICS_NOTE =
  'Money in ₹ (spend ex-GST; revenue = first-party net, ex-GST, minus refunds). firstParty* = our confirmed web orders whose buyer had a click on these ads in the 7 days before (device-matched, a LOWER bound — not every order is traceable). metaRoas / metaPurchases = Meta-reported (its own attribution incl. view-through and modelled conversions, usually an UPPER bound; purchase value can be a flat pixel value). frequency = average DAILY frequency (impression-weighted), not frequency over the period. ctrPct = link clicks ÷ impressions in %. cpm, cpc in ₹. null = denominator 0.';

const r = (x: number | null | undefined, d = 2) =>
  x == null ? null : Math.round(x * 10 ** d) / 10 ** d;
const pct = (x: number | null | undefined) => (x == null ? null : r(x * 100));

/** The metric block the model sees: ₹ rounded, rates in %. */
function brief(m: PmMetrics) {
  return {
    spend: r(m.spend, 0),
    impressions: m.impressions,
    linkClicks: m.linkClicks,
    cpm: r(m.cpm),
    ctrPct: pct(m.ctr),
    cpc: r(m.cpc),
    frequency: r(m.frequency),
    metaPurchases: m.metaPurchases,
    metaRoas: r(m.metaRoas),
    siteVisitors: m.siteVisitors,
    firstPartyOrders: m.firstPartyOrders,
    firstPartyRevenue: r(m.firstPartyRevenue, 0),
    firstPartyRoas: r(m.firstPartyRoas),
    firstPartyCpa: r(m.firstPartyCpa, 0),
    clickToOrderPct: pct(m.clickToOrderRate),
    visitToOrderPct: pct(m.visitToOrderRate),
    aov: r(m.averageOrderValue, 0),
  };
}
type Brief = ReturnType<typeof brief>;
/** % change a vs b per metric. */
const changePct = (a: Brief, b: Brief) =>
  Object.fromEntries(
    (Object.keys(a) as (keyof Brief)[]).map((k) => [
      k,
      pct(relChange(a[k], b[k])),
    ]),
  );
const pick = <T extends object, K extends keyof T>(o: T, keys: K[]) =>
  Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;

/** Default window: 14 days ending the day before the run date (IST). */
function period(ctx: PmToolCtx, from?: string, to?: string) {
  const t = to ?? addDays(ctx.date, -1);
  const f = from ?? addDays(t, -13);
  dayRange(f, t, MAX_RANGE_DAYS); // throws on bad / too long ranges
  return { from: f, to: t };
}

/**
 * Campaign-scoped data tools for the Step 3 agent (09-campaign-pipeline.md).
 * Read-only over our Mongo copies of Meta + first-party data. Prefers
 * PmAnalysisService; queries the models directly only for scopes it lacks
 * (one campaign's breakdowns, visitors, orders and change log). Aggregates
 * only — no personal data (no names, contacts, device ids or user ids).
 */
@Injectable()
export class PmDataTools {
  constructor(
    private readonly pm: PmAnalysisService,
    @InjectModel(PmMetaEntity.name) private readonly ents: Model<PmMetaEntity>,
    @InjectModel(PmMetaDaily.name) private readonly daily: Model<PmMetaDaily>,
    @InjectModel(PmMetaBreakdown.name)
    private readonly bds: Model<PmMetaBreakdown>,
    @InjectModel(PmMetaChange.name)
    private readonly changes: Model<PmMetaChange>,
    @InjectModel(PmVisitorDay.name)
    private readonly visitors: Model<PmVisitorDay>,
    @InjectModel(PmOrder.name) private readonly orders: Model<PmOrder>,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  defs(): PmToolDef[] {
    const t = (
      name: string,
      description: string,
      shape: PmToolDef['shape'],
      run: PmToolDef['run'],
    ): PmToolDef => ({ name, description, shape, run });
    return [
      t(
        'campaign_overview',
        `This campaign at a glance: settings (objective, budget level CBO = budget on the campaign / ABO = per ad set, budgets in ₹/day, bid strategy, product), every ad set (status, budget, bid, optimisation goal, learning stage, created date, targeting summary, last-14-day spend/ROAS/orders) and the top 25 ads by 14-day spend (status, created, spend, CTR, ROAS, orders), plus metrics for the last 7 / 14 / 30 days ending yesterday with a verdict vs target first-party ROAS 1.0 (verdict needs BOTH first-party and Meta ROAS below target to say below_target; not_enough_data when Meta days are missing). ${METRICS_NOTE}`,
        {},
        (_a, ctx) => this.overview(ctx),
      ),
      t(
        'adset_metrics',
        `Daily series per ad set of this campaign: date, spend, impressions, cpm, ctrPct, frequency, metaPurchases, first-party orders / revenue / ROAS, siteVisitors — plus totals per ad set. Default: ad sets with the most spend in range (as many as fit in ${MAX_SERIES_POINTS} ad-set-days); pass ids to choose. Daily first-party ROAS with few orders is very noisy — judge on totals or with stat_compare. ${METRICS_NOTE}`,
        {
          ...RANGE,
          ids: z.array(z.string()).max(10).optional().describe('ad set ids'),
        },
        (a, ctx) => this.series('adset', ctx, a),
      ),
      t(
        'ad_metrics',
        `Daily series per ad of this campaign (same fields as adset_metrics) plus totals per ad and its ad set id. Default: the ads with the most spend in range (as many as fit in ${MAX_SERIES_POINTS} ad-days); pass ids to choose. ${METRICS_NOTE}`,
        {
          ...RANGE,
          ids: z.array(z.string()).max(12).optional().describe('ad ids'),
        },
        (a, ctx) => this.series('ad', ctx, a),
      ),
      t(
        'breakdowns',
        'Meta breakdown of THIS campaign\'s ad sets by region (Indian state), age_gender ("female|25-34"), placement ("instagram|instagram_reels") or device: spend, share of spend %, impressions, cpm, ctrPct, metaPurchases, metaRoas per key (top 25 by spend, the rest summed). For region it also joins first-party data: site visitors from this campaign by visit state (OpenPanel, IP-based) and attributed orders / revenue / first-party ROAS by the buyer\'s visit state — the two geographies can disagree. ALWAYS read `missingDays`: breakdowns are loaded only for some days; numbers cover `daysWithData` only.',
        {
          breakdown: z
            .enum(['region', 'age_gender', 'placement', 'device'])
            .default('region'),
          ...RANGE,
        },
        (a, ctx) => this.breakdowns(ctx, a),
      ),
      t(
        'compare_periods',
        `Compare two date ranges for one scope: level account (all covered products) / campaign (default: this one) / adset / ad (id required). Returns metrics for a and b, verdicts, % change a vs b per metric, and ordersPerRupeeZ (Poisson z for the change in first-party orders per ₹; |z| > 1.96 ≈ significant). b defaults to the same-length period right before a. ${METRICS_NOTE}`,
        {
          level: z
            .enum(['account', 'campaign', 'adset', 'ad'])
            .default('campaign'),
          id: z.string().optional(),
          a: z
            .object({ from: DAY, to: DAY })
            .describe('period under test, e.g. last 7 days'),
          b: z
            .object({ from: DAY, to: DAY })
            .optional()
            .describe('baseline; default = the period before a'),
        },
        (a, ctx) => this.compare(ctx, a),
      ),
      t(
        'learning_status',
        'Learning and recent edits for this campaign\'s ad sets: Meta learning stage (LEARNING = still learning, SUCCESS = exited, FAIL = learning limited), created date, budget, and the last significant edit touching each ad set (its own edit, a campaign edit, an edit to one of its ads, or a new ad) with days since and the date a 7-day settle ends. Also the change-log rows in range (newest first, max 40; significant = can reset learning: budget, bid, targeting, creative, optimisation, status, new ads). If the change log has no rows, edits may simply not be synced for those days — say so rather than assuming "no edits".',
        {
          days: z
            .number()
            .int()
            .min(1)
            .max(60)
            .default(14)
            .describe('look-back days ending yesterday'),
        },
        (a, ctx) => this.learning(ctx, a.days ?? 14),
      ),
      t(
        'funnel',
        "Website funnel for visitors who came from THIS campaign's ads (or one ad): landing visitors → the product's steps (e.g. CTA click, form submitted, payment started) → paid orders, with % of previous step and % of start, next to the same funnel for ALL Meta-ad visitors of the same product (the benchmark). Visitors are visitor-days (OpenPanel device ids rotate daily); a step counts visitor-days that fired it, so a skipped step can be lower than the next. Paid = confirmed web orders attributed to the campaign (7-day click) — not strictly a subset of the visitors in range.",
        {
          ...RANGE,
          adId: z
            .string()
            .optional()
            .describe('limit to one ad of this campaign'),
        },
        (a, ctx) => this.funnel(ctx, a),
      ),
      t(
        'landing_sessions',
        'How this campaign\'s visitors behave on the landing page vs all Meta-ad visitors of the same product: distribution by scroll depth band, time-on-landing band, device, browser (in-app "Facebook"/"Instagram" vs others), locale and landing path — each with visitors, share %, and % that started a payment. Correlations, not causes.',
        { ...RANGE },
        (a, ctx) => this.landing(ctx, a),
      ),
      t(
        'payment_health',
        "Payment step health: orders created by this campaign's attributed buyers vs paid (confirmed), not-paid (created / in progress = abandoned or failed at the gateway — the data cannot tell those apart), refunded, paid %; visitor-days that started a payment; and the same for all Meta-attributed orders of the product and for all web orders of the product (benchmarks). Staff-entered orders excluded.",
        { ...RANGE },
        (a, ctx) => this.payments(ctx, a),
      ),
      t(
        'attribution_health',
        "Can this campaign's numbers be trusted? Share of the product's confirmed web orders linked to a visit / to a Meta ad; first-party vs Meta-reported purchases for this campaign (matchRatio); missing Meta / order / visitor days; data freshness; site visitors per Meta link click (tracking capture — low means UTMs / ad ids not reaching the site) for the campaign and the ads where it looks broken. Use before blaming performance on tracking, and before trusting a ROAS drop.",
        { ...RANGE },
        (a, ctx) => this.attribution(ctx, a),
      ),
      t(
        'account_context',
        'Account-wide context (all covered products): daily spend, cpm, ctrPct, frequency, first-party ROAS for the range (default 28 days ending yesterday), and last 7 vs prior 7 days for the account next to this campaign — to tell a campaign problem from an auction-wide or seasonal move (e.g. CPM up everywhere). Frequency = average daily frequency.',
        {
          from: DAY.optional().describe('default: 28 days ending `to`'),
          to: DAY.optional().describe('default: the day before the run date'),
        },
        (a, ctx) => this.account(ctx, a),
      ),
    ];
  }

  // ---------- helpers ----------

  private get tenantId() {
    return this.env.tenantId;
  }

  private async campaign(id: string) {
    const c = await this.ents
      .findOne({ tenantId: this.tenantId, level: 'campaign', entityId: id })
      .lean();
    if (!c) throw new Error(`Campaign ${id} not found in pm_meta_entities`);
    return { ...c, pmProduct: findPmProduct(c.product) };
  }

  /** Funnel step keys of the product; for an untagged campaign, those every product has. */
  private stepKeys(product?: string) {
    const lists = (product ? [findPmProduct(product)!] : PM_PRODUCTS).map((p) =>
      p.steps.map((s) => s.key as string).filter((k) => k !== 'couponApplied'),
    );
    return lists[0].filter((k) => lists.every((l) => l.includes(k)));
  }

  /** pm_visitor_days filters: this campaign (or ad) vs all Meta-ad visitors of the product. */
  private visitorScopes(
    q: { from: string; to: string },
    campaignId: string,
    product?: string,
    adId?: string,
  ) {
    const base = {
      tenantId: this.tenantId,
      day: { $gte: q.from, $lte: q.to },
      ...(product ? { product } : {}),
    };
    return {
      campaign: adId
        ? {
            ...base,
            'metaAd.last.adId': adId,
            'metaAd.last.campaignId': campaignId,
          }
        : { ...base, 'metaAd.last.campaignId': campaignId },
      account: { ...base, 'metaAd.last.adId': NOT_EMPTY },
    };
  }

  private webOrders(
    q: { from: string; to: string },
    extra: Record<string, unknown>,
  ) {
    return {
      tenantId: this.tenantId,
      day: { $gte: q.from, $lte: q.to },
      adminCreated: false,
      ...extra,
    };
  }

  // ---------- campaign_overview ----------

  private async overview(ctx: PmToolCtx) {
    const id = ctx.campaignId;
    const c = await this.campaign(id);
    const to = addDays(ctx.date, -1);
    const q14 = { from: addDays(to, -13), to, product: c.product };
    const [windows, docs, adsetRows, adRows] = await Promise.all([
      Promise.all(
        ([7, 14, 30] as const).map(async (n) => {
          const q = { from: addDays(to, -(n - 1)), to };
          const [m, missing] = await Promise.all([
            this.pm.scopeMetrics(q, 'campaign', id),
            this.pm.metaMissingDays(q.from, q.to),
          ]);
          return [
            `last${n}`,
            {
              ...q,
              metrics: brief(m),
              verdict: withMissingMeta(targetOf(m), missing),
            },
          ] as const;
        }),
      ),
      this.ents
        .find(
          {
            tenantId: this.tenantId,
            campaignId: id,
            level: { $in: ['adset', 'ad'] },
          },
          { targeting: 0, promotedObject: 0, creative: 0 },
        )
        .lean(),
      this.pm.entities(q14, 'adset', id),
      this.pm.entities(q14, 'ad', id),
    ]);
    const m14 = new Map(
      [...adsetRows.rows, ...adRows.rows].map((x) => [x.id, brief(x.metrics)]),
    );
    const last14 = (eid: string) => {
      const m = m14.get(eid);
      return m
        ? pick(m, [
            'spend',
            'firstPartyOrders',
            'firstPartyRoas',
            'metaRoas',
            'ctrPct',
            'cpm',
            'frequency',
          ])
        : null;
    };
    const spendOf = (eid: string) => m14.get(eid)?.spend ?? 0;
    const bySpend = <T extends { entityId: string }>(xs: T[]) =>
      xs.sort((a, b) => spendOf(b.entityId) - spendOf(a.entityId));
    const adsets = bySpend(docs.filter((d) => d.level === 'adset'));
    const ads = bySpend(docs.filter((d) => d.level === 'ad'));
    const live = (s: string) => s === 'ACTIVE';
    const shownAds = ads.filter(
      (d) => spendOf(d.entityId) > 0 || live(d.effectiveStatus),
    );
    return {
      campaign: {
        id,
        name: c.name,
        product: c.product,
        objective: c.objective,
        status: c.effectiveStatus,
        budgetLevel:
          c.budgetLevel === 'campaign'
            ? 'CBO (budget on the campaign)'
            : c.budgetLevel === 'adset'
              ? 'ABO (budget per ad set)'
              : 'unknown',
        dailyBudget: c.dailyBudget,
        lifetimeBudget: c.lifetimeBudget || null,
        bidStrategy: c.bidStrategy || null,
        created: c.createdTime ? istDay(c.createdTime) : null,
      },
      ...Object.fromEntries(windows),
      counts: {
        adsets: adsets.length,
        activeAdsets: adsets.filter((d) => live(d.effectiveStatus)).length,
        ads: ads.length,
        activeAds: ads.filter((d) => live(d.effectiveStatus)).length,
      },
      adsets: adsets.slice(0, 15).map((d) => {
        const ts = d.targetingSummary;
        return {
          id: d.entityId,
          name: d.name,
          status: d.effectiveStatus,
          dailyBudget: d.dailyBudget,
          lifetimeBudget: d.lifetimeBudget || null,
          bidStrategy: d.bidStrategy || null,
          optimizationGoal: d.optimizationGoal || null,
          learningStage: d.learningStage || null,
          created: d.createdTime ? istDay(d.createdTime) : null,
          targeting: ts && {
            age: `${ts.ageMin ?? '?'}-${ts.ageMax ?? '?'}`,
            genders: ts.genders ?? 'all',
            countries: ts.countries,
            regions: ts.regions?.length ? ts.regions : undefined,
            cities: ts.cities?.length ?? 0,
            audienceType: ts.audienceType,
            advantageAudience: ts.advantageAudience,
            customAudiences: ts.customAudiences?.length ?? 0,
            excludedAudiences: ts.excludedAudiences?.length ?? 0,
            interests: ts.interests?.slice(0, 10),
          },
          last14: last14(d.entityId),
        };
      }),
      ads: shownAds.slice(0, 25).map((d) => ({
        id: d.entityId,
        name: d.name,
        adsetId: d.adsetId,
        status: d.effectiveStatus,
        created: d.createdTime ? istDay(d.createdTime) : null,
        last14: last14(d.entityId),
      })),
      ...(shownAds.length > 25 ? { adsNotShown: shownAds.length - 25 } : {}),
    };
  }

  // ---------- adset_metrics / ad_metrics ----------

  private async series(
    level: 'adset' | 'ad',
    ctx: PmToolCtx,
    a: { from?: string; to?: string; ids?: string[] },
  ) {
    const q = period(ctx, a.from, a.to);
    const days = dayRange(q.from, q.to, MAX_RANGE_DAYS).length;
    const cap = Math.max(
      1,
      Math.min(
        level === 'adset' ? 10 : 12,
        Math.floor(MAX_SERIES_POINTS / days),
      ),
    );
    const f = level === 'adset' ? 'adsetId' : 'adId';
    let ids = a.ids ?? [];
    if (!ids.length)
      ids = (
        await this.daily.aggregate<{ _id: string }>([
          {
            $match: {
              tenantId: this.tenantId,
              campaignId: ctx.campaignId,
              date: { $gte: q.from, $lte: q.to },
              [f]: NOT_EMPTY,
            },
          },
          { $group: { _id: `$${f}`, spend: { $sum: '$spend' } } },
          { $sort: { spend: -1 } },
          { $limit: cap + 1 },
        ])
      ).map((x) => x._id);
    const truncated = ids.length > cap;
    ids = ids.slice(0, cap);
    const [docs, trends] = await Promise.all([
      this.ents
        .find(
          { tenantId: this.tenantId, level, entityId: { $in: ids } },
          { entityId: 1, name: 1, effectiveStatus: 1, adsetId: 1 },
        )
        .lean(),
      Promise.all(ids.map((id) => this.pm.trend(q, level, id))),
    ]);
    const byId = new Map(docs.map((d) => [d.entityId, d]));
    return {
      query: { ...q, level },
      ...(truncated
        ? {
            note: `Only the top ${cap} by spend shown; pass ids or a shorter range for others`,
          }
        : {}),
      rows: ids.map((id, i) => {
        const pts = trends[i].points;
        const sum = (
          k:
            | 'spend'
            | 'impressions'
            | 'linkClicks'
            | 'firstPartyOrders'
            | 'firstPartyRevenue'
            | 'metaPurchases',
        ) => pts.reduce((s, p) => s + p[k], 0);
        const d = byId.get(id);
        return {
          id,
          name: d?.name ?? '',
          status: d?.effectiveStatus ?? '',
          ...(level === 'ad' ? { adsetId: d?.adsetId ?? '' } : {}),
          total: {
            spend: r(sum('spend'), 0),
            cpm: r(ratio(sum('spend') * 1000, sum('impressions'))),
            ctrPct: pct(ratio(sum('linkClicks'), sum('impressions'))),
            frequency: r(
              weightedFrequency(
                pts.map((p) => ({
                  frequency: p.frequency ?? 0,
                  impressions: p.impressions,
                })),
              ),
            ),
            metaPurchases: sum('metaPurchases'),
            firstPartyOrders: sum('firstPartyOrders'),
            firstPartyRevenue: r(sum('firstPartyRevenue'), 0),
            firstPartyRoas: r(ratio(sum('firstPartyRevenue'), sum('spend'))),
          },
          days: pts.map((p) => ({
            date: p.date,
            spend: r(p.spend, 0),
            impressions: p.impressions,
            cpm: r(p.cpm),
            ctrPct: pct(p.ctr),
            frequency: r(p.frequency),
            metaPurchases: p.metaPurchases,
            orders: p.firstPartyOrders,
            revenue: r(p.firstPartyRevenue, 0),
            roas: r(p.firstPartyRoas),
            visitors: p.siteVisitors,
          })),
        };
      }),
    };
  }

  // ---------- breakdowns ----------

  private async breakdowns(
    ctx: PmToolCtx,
    a: {
      breakdown?: 'region' | 'age_gender' | 'placement' | 'device';
      from?: string;
      to?: string;
    },
  ) {
    const breakdown = a.breakdown ?? 'region';
    const q = period(ctx, a.from, a.to);
    const id = ctx.campaignId;
    const range = { $gte: q.from, $lte: q.to };
    const match = {
      tenantId: this.tenantId,
      campaignId: id,
      breakdown,
      date: range,
    };
    const region = breakdown === 'region';
    const [rows, bdDays, spendDays, accountMissing, site, ords] =
      await Promise.all([
        this.bds.aggregate<{
          _id: string;
          spend: number;
          impressions: number;
          linkClicks: number;
          metaPurchases: number;
          metaPurchaseValue: number;
        }>([
          { $match: match },
          {
            $group: {
              _id: '$key',
              spend: { $sum: '$spend' },
              impressions: { $sum: '$impressions' },
              linkClicks: { $sum: '$linkClicks' },
              metaPurchases: { $sum: '$metaPurchases' },
              metaPurchaseValue: { $sum: '$metaPurchaseValue' },
            },
          },
        ]),
        this.bds.distinct('date', match),
        this.daily.distinct('date', {
          tenantId: this.tenantId,
          campaignId: id,
          date: range,
          spend: { $gt: 0 },
        }),
        this.pm.breakdownMissingDays(q.from, q.to, breakdown),
        region
          ? this.visitors.aggregate<{ _id: string | null; n: number }>([
              { $match: this.visitorScopes(q, id).campaign },
              { $group: { _id: '$geo.region', n: { $sum: 1 } } },
            ])
          : [],
        region ? this.ordersByVisitRegion(q, id) : [],
      ]);
    const days = new Set(bdDays as string[]);
    // Days the campaign spent but has no breakdown rows, plus account-level gaps.
    const missingDays = [
      ...new Set([
        ...(spendDays as string[]).filter((d) => !days.has(d)),
        ...accountMissing,
      ]),
    ].sort();
    type Acc = {
      spend: number;
      impressions: number;
      linkClicks: number;
      metaPurchases: number;
      metaPurchaseValue: number;
      siteVisitors: number;
      orders: number;
      revenue: number;
    };
    const acc = new Map<string, Acc>();
    const get = (k: string | null) => {
      const key = region ? normaliseRegion(k) : (k ?? 'unknown');
      if (!acc.has(key))
        acc.set(key, {
          spend: 0,
          impressions: 0,
          linkClicks: 0,
          metaPurchases: 0,
          metaPurchaseValue: 0,
          siteVisitors: 0,
          orders: 0,
          revenue: 0,
        });
      return acc.get(key)!;
    };
    for (const x of rows) {
      const g = get(x._id);
      g.spend += x.spend;
      g.impressions += x.impressions;
      g.linkClicks += x.linkClicks;
      g.metaPurchases += x.metaPurchases;
      g.metaPurchaseValue += x.metaPurchaseValue;
    }
    for (const s of site) get(s._id).siteVisitors += s.n;
    for (const o of ords) {
      const g = get(o._id);
      g.orders += o.orders;
      g.revenue += o.revenue;
    }
    const total = [...acc.values()].reduce((s, g) => s + g.spend, 0);
    const all = [...acc.entries()].sort(
      (x, y) =>
        y[1].spend - x[1].spend || y[1].siteVisitors - x[1].siteVisitors,
    );
    const row = (key: string, g: Acc) => ({
      key,
      spend: r(g.spend, 0),
      spendSharePct: pct(ratio(g.spend, total)),
      impressions: g.impressions,
      cpm: r(ratio(g.spend * 1000, g.impressions)),
      ctrPct: pct(ratio(g.linkClicks, g.impressions)),
      metaPurchases: g.metaPurchases,
      metaRoas: r(ratio(g.metaPurchaseValue, g.spend)),
      ...(region
        ? {
            siteVisitors: g.siteVisitors,
            firstPartyOrders: g.orders,
            firstPartyRevenue: r(g.revenue, 0),
            firstPartyRoas: r(ratio(g.revenue, g.spend)),
          }
        : {}),
    });
    const rest = all.slice(25).reduce(
      (s, [, g]) => {
        for (const k of Object.keys(s) as (keyof Acc)[]) s[k] += g[k];
        return s;
      },
      {
        spend: 0,
        impressions: 0,
        linkClicks: 0,
        metaPurchases: 0,
        metaPurchaseValue: 0,
        siteVisitors: 0,
        orders: 0,
        revenue: 0,
      },
    );
    return {
      query: { ...q, breakdown },
      daysWithData: days.size,
      missingDays,
      note: missingDays.length
        ? `Breakdown data missing for ${missingDays.length} day(s) the campaign spent (${missingDays.join(', ')}) — totals here cover only ${days.size} day(s) and are not comparable to campaign totals.`
        : 'Breakdown data complete for every day the campaign spent.',
      rows: all.slice(0, 25).map(([k, g]) => row(k, g)),
      ...(all.length > 25
        ? { otherKeys: { count: all.length - 25, ...row('(rest)', rest) } }
        : {}),
      ...(region
        ? {
            caveat:
              "Spend is Meta's region breakdown (ad set level, only the days listed); visitors/orders are first-party for the whole range, placed by the visit's IP state — ROAS by state is an estimate and only meaningful when missingDays is empty. One broad ad set cannot get per-state budgets; acting on a state means exclusions or a separate ad set.",
          }
        : {}),
    };
  }

  /** Attributed confirmed web orders of the campaign, by the state of the buyer's visit that day. */
  private ordersByVisitRegion(
    q: { from: string; to: string },
    campaignId: string,
  ) {
    return this.orders.aggregate<{
      _id: string | null;
      orders: number;
      revenue: number;
    }>([
      {
        $match: this.webOrders(q, {
          confirmed: true,
          'attribution.metaLast.campaignId': campaignId,
          'attribution.deviceIds.0': { $exists: true },
        }),
      },
      {
        $lookup: {
          from: this.visitors.collection.name,
          localField: 'attribution.deviceIds',
          foreignField: 'deviceId',
          // Listing the products lets Mongo walk the {tenantId, product, day,
          // deviceId} index directly; any product's row that day gives the state.
          let: { d: '$day' },
          pipeline: [
            {
              $match: {
                tenantId: this.tenantId,
                product: { $in: PM_PRODUCTS.map((p) => p.id) },
                $expr: { $eq: ['$day', '$$d'] },
              },
            },
            { $limit: 1 },
            { $project: { 'geo.region': 1 } },
          ],
          as: 'row',
        },
      },
      {
        $group: {
          _id: { $first: '$row.geo.region' },
          orders: { $sum: 1 },
          revenue: { $sum: '$netRevenue' },
        },
      },
    ] as PipelineStage[]);
  }

  // ---------- compare_periods ----------

  private async compare(
    ctx: PmToolCtx,
    a: {
      level?: PmLevel;
      id?: string;
      a: { from: string; to: string };
      b?: { from: string; to: string };
    },
  ) {
    const level = a.level ?? 'campaign';
    const id =
      level === 'account'
        ? undefined
        : (a.id ?? (level === 'campaign' ? ctx.campaignId : undefined));
    if (level !== 'account' && !id)
      throw new Error(`id is required for level ${level}`);
    const pa = period(ctx, a.a.from, a.a.to);
    const pb = a.b
      ? period(ctx, a.b.from, a.b.to)
      : previousPeriod(pa.from, pa.to);
    const side = async (p: { from: string; to: string }) => {
      const [m, missing] = await Promise.all([
        this.pm.scopeMetrics(p, level, id),
        this.pm.metaMissingDays(p.from, p.to),
      ]);
      return {
        m,
        out: {
          ...p,
          metrics: brief(m),
          verdict: withMissingMeta(targetOf(m), missing),
        },
      };
    };
    const [x, y] = await Promise.all([side(pa), side(pb)]);
    return {
      level,
      ...(id ? { id } : {}),
      a: x.out,
      b: y.out,
      changePct: changePct(x.out.metrics, y.out.metrics),
      ordersPerRupeeZ: r(
        poissonRateZ(
          x.m.firstPartyOrders,
          x.m.spend,
          y.m.firstPartyOrders,
          y.m.spend,
        ),
      ),
    };
  }

  // ---------- learning_status ----------

  private async learning(ctx: PmToolCtx, days: number) {
    const id = ctx.campaignId;
    const to = addDays(ctx.date, -1);
    const from = addDays(to, -(days - 1));
    const docs = await this.ents
      .find(
        { tenantId: this.tenantId, campaignId: id },
        {
          level: 1,
          entityId: 1,
          adsetId: 1,
          name: 1,
          effectiveStatus: 1,
          learningStage: 1,
          createdTime: 1,
          dailyBudget: 1,
          budgetLevel: 1,
        },
      )
      .lean();
    const rows = await this.changes
      .find({
        tenantId: this.tenantId,
        objectId: { $in: [id, ...docs.map((d) => d.entityId)] },
        eventTime: {
          $gte: istDayBounds(from).start,
          $lt: istDayBounds(to).end,
        },
      })
      .sort({ eventTime: -1 })
      .limit(500)
      .lean();
    const levelOf = new Map(docs.map((d) => [d.entityId, d.level]));
    const adsetOf = new Map(docs.map((d) => [d.entityId, d.adsetId]));
    const changes = rows.map((c) => ({
      at: new Date(c.eventTime).toISOString(),
      day: istDay(c.eventTime),
      level: levelOf.get(c.objectId) ?? c.objectType,
      objectId: c.objectId,
      objectName: c.objectName,
      event: c.translatedEventType || c.eventType,
      significant:
        SIGNIFICANT_RE.test(c.eventType) ||
        SIGNIFICANT_RE.test(c.translatedEventType),
      detail: (c.extraData ?? '').slice(0, 300),
    }));
    // Significant events per ad set: own edits, campaign edits, its ads' edits, new ads.
    const events = new Map<string, { day: string; what: string }[]>();
    const push = (adset: string, day: string, what: string) =>
      events.set(adset, [...(events.get(adset) ?? []), { day, what }]);
    const adsets = docs.filter((d) => d.level === 'adset');
    for (const c of changes.filter((x) => x.significant)) {
      if (c.objectId === id)
        adsets.forEach((s) => push(s.entityId, c.day, `campaign: ${c.event}`));
      else if (c.level === 'adset') push(c.objectId, c.day, c.event);
      else if (c.level === 'ad')
        push(
          adsetOf.get(c.objectId) ?? '',
          c.day,
          `ad ${c.objectName}: ${c.event}`,
        );
    }
    for (const d of docs)
      if (d.level === 'ad' && d.createdTime && istDay(d.createdTime) >= from)
        push(d.adsetId, istDay(d.createdTime), `new ad ${d.name}`);
    const daysBetween = (x: string, y: string) =>
      Math.round((Date.parse(y) - Date.parse(x)) / 86_400_000);
    return {
      query: { from, to },
      changeLogRows: rows.length,
      ...(rows.length
        ? {}
        : {
            note: 'No change-log rows for this campaign in range: either no edits, or the change log was not synced for these days. New ads are still detected from created dates.',
          }),
      adsets: adsets
        .sort(
          (x, y) =>
            (x.effectiveStatus === 'ACTIVE' ? 0 : 1) -
            (y.effectiveStatus === 'ACTIVE' ? 0 : 1),
        )
        .slice(0, 20)
        .map((s) => {
          const ev = (events.get(s.entityId) ?? []).sort((x, y) =>
            y.day.localeCompare(x.day),
          );
          const last = ev[0];
          const created = s.createdTime ? istDay(s.createdTime) : null;
          return {
            id: s.entityId,
            name: s.name,
            status: s.effectiveStatus,
            learningStage: s.learningStage || null,
            dailyBudget: s.dailyBudget,
            created,
            daysSinceCreated: created ? daysBetween(created, to) + 1 : null,
            lastSignificantEdit: last
              ? { ...last, daysAgo: daysBetween(last.day, to) + 1 }
              : null,
            settlesOn: last
              ? addDays(last.day, 7)
              : created && daysBetween(created, to) < 7
                ? addDays(created, 7)
                : null,
            significantEditsInRange: ev.length,
          };
        }),
      changes: changes.slice(0, 40),
    };
  }

  // ---------- funnel ----------

  private async funnelCounts(match: Record<string, unknown>, keys: string[]) {
    const [x] = await this.visitors.aggregate<Record<string, number>>([
      { $match: match },
      {
        $group: {
          _id: null,
          visitors: { $sum: 1 },
          paymentsStarted: { $sum: PAID_STARTED },
          ...Object.fromEntries(
            keys.map((k) => [
              k,
              {
                $sum: {
                  $cond: [
                    { $gt: [{ $ifNull: [`$steps.${k}.count`, 0] }, 0] },
                    1,
                    0,
                  ],
                },
              },
            ]),
          ),
        },
      },
    ]);
    return x ?? { visitors: 0, paymentsStarted: 0 };
  }

  private async funnel(
    ctx: PmToolCtx,
    a: { from?: string; to?: string; adId?: string },
  ) {
    const q = period(ctx, a.from, a.to);
    const c = await this.campaign(ctx.campaignId);
    const product = c.pmProduct?.id;
    const keys = this.stepKeys(product);
    const scopes = this.visitorScopes(q, ctx.campaignId, product, a.adId);
    const [cv, av, cPaid, aPaid] = await Promise.all([
      this.funnelCounts(scopes.campaign, keys),
      this.funnelCounts(scopes.account, keys),
      this.orders.countDocuments(
        this.webOrders(q, {
          confirmed: true,
          [a.adId
            ? 'attribution.metaLast.adId'
            : 'attribution.metaLast.campaignId']: a.adId ?? ctx.campaignId,
        }),
      ),
      this.orders.countDocuments(
        this.webOrders(q, {
          confirmed: true,
          'attribution.metaLast.adId': NOT_EMPTY,
          ...(product ? { product } : {}),
        }),
      ),
    ]);
    const seq = ['visitors', ...keys, 'paid'];
    const val = (v: Record<string, number>, paid: number, k: string) =>
      k === 'paid' ? paid : (v[k] ?? 0);
    return {
      query: {
        ...q,
        product: product ?? 'all',
        ...(a.adId ? { adId: a.adId } : {}),
      },
      steps: seq.map((k, i) => {
        const cn = val(cv, cPaid, k);
        const an = val(av, aPaid, k);
        return {
          step: k,
          campaign: cn,
          campaignPctOfPrev: i
            ? pct(ratio(cn, val(cv, cPaid, seq[i - 1])))
            : null,
          campaignPctOfStart: i ? pct(ratio(cn, cv.visitors)) : null,
          allMetaPctOfPrev: i
            ? pct(ratio(an, val(av, aPaid, seq[i - 1])))
            : null,
          allMetaPctOfStart: i ? pct(ratio(an, av.visitors)) : null,
        };
      }),
      allMetaVisitors: av.visitors,
    };
  }

  // ---------- landing_sessions ----------

  private async landing(ctx: PmToolCtx, a: { from?: string; to?: string }) {
    const q = period(ctx, a.from, a.to);
    const c = await this.campaign(ctx.campaignId);
    const scopes = this.visitorScopes(q, ctx.campaignId, c.pmProduct?.id);
    const g = (key: unknown, limit = 8) => [
      { $group: { _id: key, n: { $sum: 1 }, paid: { $sum: PAID_STARTED } } },
      { $sort: { n: -1 } },
      { $limit: limit },
    ];
    const facets = {
      scroll: g(bandIndexExpr('$maxScroll', SCROLL_BANDS.uppers)),
      timeOnLanding: g(
        bandIndexExpr('$activeSecondsLanding', TIME_BANDS.uppers),
      ),
      device: g({ $ifNull: ['$tech.device', 'unknown'] }),
      browser: g({ $ifNull: ['$tech.browser', 'unknown'] }, 6),
      locale: g({ $ifNull: ['$locale', 'en'] }, 6),
      landingPath: g({ $ifNull: ['$landingPath', ''] }, 6),
      totals: g(null, 1),
    };
    type B = { _id: string | number | null; n: number; paid: number };
    type F = Record<keyof typeof facets, B[]>;
    const [[cf], [af]] = await Promise.all([
      this.visitors.aggregate<F>([
        { $match: scopes.campaign },
        { $facet: facets },
      ] as PipelineStage[]),
      this.visitors.aggregate<F>([
        { $match: scopes.account },
        { $facet: facets },
      ] as PipelineStage[]),
    ]);
    const ct = cf.totals[0]?.n ?? 0;
    const at = af.totals[0]?.n ?? 0;
    const split = (k: keyof F, labels?: string[]) => {
      const am = new Map(af[k].map((b) => [String(b._id), b]));
      const rows = labels
        ? labels.map(
            (_, i) =>
              cf[k].find((b) => b._id === i) ?? { _id: i, n: 0, paid: 0 },
          )
        : cf[k];
      return rows.map((b) => {
        const o = am.get(String(b._id));
        return {
          key: labels ? labels[b._id as number] : String(b._id),
          visitors: b.n,
          sharePct: pct(ratio(b.n, ct)),
          paymentStartedPct: pct(ratio(b.paid, b.n)),
          allMetaSharePct: pct(ratio(o?.n ?? 0, at)),
          allMetaPaymentStartedPct: pct(ratio(o?.paid ?? 0, o?.n ?? 0)),
        };
      });
    };
    return {
      query: { ...q, product: c.pmProduct?.id ?? 'all' },
      visitors: ct,
      paymentStartedPct: pct(ratio(cf.totals[0]?.paid ?? 0, ct)),
      allMetaVisitors: at,
      allMetaPaymentStartedPct: pct(ratio(af.totals[0]?.paid ?? 0, at)),
      scroll: split('scroll', SCROLL_BANDS.labels),
      timeOnLanding: split('timeOnLanding', TIME_BANDS.labels),
      device: split('device'),
      browser: split('browser'),
      locale: split('locale'),
      landingPath: split('landingPath'),
      caveat:
        'Visitor-days from OpenPanel (device ids rotate daily). Scroll = deepest scroll mark on the landing page; time = active seconds on the landing page. allMeta* = all visitors from any Meta ad for the same product.',
    };
  }

  // ---------- payment_health ----------

  private async payments(ctx: PmToolCtx, a: { from?: string; to?: string }) {
    const q = period(ctx, a.from, a.to);
    const c = await this.campaign(ctx.campaignId);
    const product = c.pmProduct?.id;
    const prod = product ? { product } : {};
    const statusOf = (match: Record<string, unknown>) =>
      this.orders.aggregate<{
        _id: { c: boolean; s: string; p: string };
        n: number;
        refunded: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: { c: '$confirmed', s: '$status', p: '$paymentStatus' },
            n: { $sum: 1 },
            refunded: {
              $sum: { $cond: [{ $eq: ['$refund.state', 'refunded'] }, 1, 0] },
            },
          },
        },
        { $sort: { n: -1 } },
      ]);
    const scopes = this.visitorScopes(q, ctx.campaignId, product);
    const [co, ao, wo, cv, av] = await Promise.all([
      statusOf(
        this.webOrders(q, {
          'attribution.metaLast.campaignId': ctx.campaignId,
        }),
      ),
      statusOf(
        this.webOrders(q, { 'attribution.metaLast.adId': NOT_EMPTY, ...prod }),
      ),
      statusOf(this.webOrders(q, prod)),
      this.funnelCounts(scopes.campaign, []),
      this.funnelCounts(scopes.account, []),
    ]);
    const sumUp = (
      rows: Awaited<ReturnType<typeof statusOf>>,
      startedVisitors?: number,
    ) => {
      const created = rows.reduce((s, x) => s + x.n, 0);
      const paid = rows.filter((x) => x._id.c).reduce((s, x) => s + x.n, 0);
      return {
        ...(startedVisitors != null
          ? { visitorsStartedPayment: startedVisitors }
          : {}),
        ordersCreated: created,
        paid,
        notPaid: created - paid,
        paidPct: pct(ratio(paid, created)),
        refunded: rows.reduce((s, x) => s + x.refunded, 0),
        byStatus: rows.slice(0, 6).map((x) => ({
          status: x._id.s,
          paymentStatus: x._id.p,
          orders: x.n,
        })),
      };
    };
    return {
      query: { ...q, product: product ?? 'all' },
      campaign: sumUp(co, cv.paymentsStarted),
      allMetaAttributed: sumUp(ao, av.paymentsStarted),
      allWebOrders: sumUp(wo),
      caveat:
        "Orders created = order rows (the order is created before the gateway). Not paid = ORDER_CREATED / IN_PROGRESS etc.: abandoned or failed at the gateway, not separable here. Campaign orders are attributed by the buyer's Meta click in the 7 days before, so not every unpaid attempt is linked to a campaign. visitorsStartedPayment = visitor-days with a browser payment event.",
    };
  }

  // ---------- attribution_health ----------

  private async attribution(ctx: PmToolCtx, a: { from?: string; to?: string }) {
    const q = period(ctx, a.from, a.to);
    const id = ctx.campaignId;
    const c = await this.campaign(id);
    // Product-level checks use the campaign's product (all covered ones when untagged).
    const pq = c.pmProduct ? { ...q, product: c.pmProduct.id } : q;
    const range = { $gte: q.from, $lte: q.to };
    const [coverage, missing, reconcile, fresh, perAd, visits] =
      await Promise.all([
        this.pm.coverage(pq),
        this.pm.missingDays(pq),
        this.pm.reconcile({ ...q, product: c.product }),
        this.pm.freshness(c.pmProduct?.id),
        this.daily.aggregate<{
          _id: string;
          spend: number;
          linkClicks: number;
          lpv: number;
        }>([
          { $match: { tenantId: this.tenantId, campaignId: id, date: range } },
          {
            $group: {
              _id: '$adId',
              spend: { $sum: '$spend' },
              linkClicks: { $sum: '$linkClicks' },
              lpv: { $sum: '$landingPageViews' },
            },
          },
          { $sort: { spend: -1 } },
        ]),
        this.visitors.aggregate<{ _id: string; n: number }>([
          { $match: this.visitorScopes(q, id).campaign },
          { $group: { _id: '$metaAd.last.adId', n: { $sum: 1 } } },
        ]),
      ]);
    const v = new Map(visits.map((x) => [x._id, x.n]));
    const tot = perAd.reduce(
      (s, x) => ({ clicks: s.clicks + x.linkClicks, lpv: s.lpv + x.lpv }),
      { clicks: 0, lpv: 0 },
    );
    const visitors = visits.reduce((s, x) => s + x.n, 0);
    // Ads with real traffic but almost no tracked visits: UTMs / ad ids not reaching the site.
    const suspect = perAd
      .filter(
        (x) => x.linkClicks >= 30 && (v.get(x._id) ?? 0) / x.linkClicks < 0.2,
      )
      .slice(0, 10);
    const names = new Map(
      (
        await this.ents
          .find(
            {
              tenantId: this.tenantId,
              level: 'ad',
              entityId: { $in: suspect.map((x) => x._id) },
            },
            { entityId: 1, name: 1 },
          )
          .lean()
      ).map((d) => [d.entityId, d.name]),
    );
    const rec = reconcile.rows.find((x) => x.campaignId === id);
    return {
      query: pq,
      productOrdersLinkedToVisitPct: pct(coverage.linkedToVisit),
      productOrdersLinkedToMetaAdPct: pct(coverage.linkedToMetaAd),
      campaign: {
        metaPurchases: rec?.metaPurchases ?? 0,
        firstPartyOrders: rec?.firstPartyOrders ?? 0,
        firstPartyPerMetaPurchasePct: pct(rec?.matchRatio),
        linkClicks: tot.clicks,
        landingPageViews: tot.lpv,
        trackedVisitors: visitors,
        visitorsPerLinkClickPct: pct(ratio(visitors, tot.clicks)),
        visitorsPerLandingPageViewPct: pct(ratio(visitors, tot.lpv)),
      },
      adsWithFewTrackedVisits: suspect.map((x) => ({
        adId: x._id,
        name: names.get(x._id) ?? '',
        spend: r(x.spend, 0),
        linkClicks: x.linkClicks,
        trackedVisitors: v.get(x._id) ?? 0,
      })),
      missingDays: missing,
      dataFreshness: fresh,
      notes: [
        'Visitors per link click is normally well below 100% (bots, in-app browser drop-offs, consent); compare ads within the campaign — an ad far below its siblings likely has broken URL parameters.',
        "First-party per Meta purchase below ~50% is common (device-matched 7-day click vs Meta's modelled attribution); a sudden fall is the signal.",
        ...reconcile.notes.slice(0, 3),
      ],
    };
  }

  // ---------- account_context ----------

  private async account(ctx: PmToolCtx, a: { from?: string; to?: string }) {
    const to = a.to ?? addDays(ctx.date, -1);
    const q = period(ctx, a.from ?? addDays(to, -27), to);
    const last7 = { from: addDays(q.to, -6), to: q.to };
    const prior7 = { from: addDays(q.to, -13), to: addDays(q.to, -7) };
    const keys: (keyof Brief)[] = [
      'spend',
      'cpm',
      'ctrPct',
      'cpc',
      'frequency',
      'metaRoas',
      'firstPartyRoas',
      'firstPartyCpa',
      'clickToOrderPct',
    ];
    const pair = async (level: PmLevel, id?: string) => {
      const [x, y] = await Promise.all([
        this.pm.scopeMetrics(last7, level, id).then(brief),
        this.pm.scopeMetrics(prior7, level, id).then(brief),
      ]);
      return {
        last7: pick(x, keys),
        prior7: pick(y, keys),
        changePct: pick(changePct(x, y), keys),
      };
    };
    const [trend, account, campaign, missing] = await Promise.all([
      this.pm.trend(q),
      pair('account'),
      pair('campaign', ctx.campaignId),
      this.pm.metaMissingDays(q.from, q.to),
    ]);
    return {
      query: q,
      ...(missing.length ? { metaMissingDays: missing } : {}),
      last7VsPrior7: { last7, prior7, account, campaign },
      accountDaily: trend.points.map((p) => ({
        date: p.date,
        spend: r(p.spend, 0),
        cpm: r(p.cpm),
        ctrPct: pct(p.ctr),
        frequency: r(p.frequency),
        firstPartyRoas: r(p.firstPartyRoas),
      })),
    };
  }
}
