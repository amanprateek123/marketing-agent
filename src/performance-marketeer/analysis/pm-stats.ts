/**
 * Pure helpers for the Performance Marketeer analysis layer: ratios, periods,
 * confidence, target verdicts, CPA decomposition, bands. No I/O — every rule
 * is unit-tested in pm-stats.spec.ts.
 */
import { DAY_MS } from '../pm.config';
import { dayRange } from '../pm.logic';
import {
  PmConfidence,
  PmMetrics,
  PmQuery,
  PmTargetCheck,
} from './pm-analysis.types';

export const TARGET_ROAS = 1.0;

/** n / d, or null when d is 0 or either side is not a finite number. */
export const ratio = (n: number | null, d: number | null): number | null =>
  n == null || d == null || !Number.isFinite(n) || !Number.isFinite(d) || !d
    ? null
    : n / d;

/** Relative change (cur − prior) / prior; null when prior is 0/null. */
export const relChange = (
  cur: number | null,
  prior: number | null,
): number | null =>
  cur == null || prior == null || !prior ? null : (cur - prior) / prior;

export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** The same-length IST period immediately before from..to. */
export function previousPeriod(from: string, to: string) {
  const n = dayRange(from, to, 400).length;
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

/**
 * Confidence from the number of orders behind a number:
 * < 5 low, 5–19 medium, ≥ 20 high.
 */
export const CONFIDENCE_MIN_MEDIUM = 5;
export const CONFIDENCE_MIN_HIGH = 20;
export const confidenceFor = (orders: number): PmConfidence =>
  orders >= CONFIDENCE_MIN_HIGH
    ? 'high'
    : orders >= CONFIDENCE_MIN_MEDIUM
      ? 'medium'
      : 'low';

/**
 * Rough 95% range on ROAS from the order count alone (Poisson: relative
 * error ≈ 1/√orders): ROAS × (1 ± 1.96/√n). Revenue per order and spend are
 * treated as fixed. Above target only if the low end > target, below only if
 * the high end < target, otherwise near — so the "near" band is wide with few
 * orders (±88% at 5 orders, ±44% at 20, ±20% at 100).
 */
export const Z95 = 1.96;
export function roasInterval(roas: number, orders: number) {
  const e = Z95 / Math.sqrt(orders);
  return { low: Math.max(0, roas * (1 - e)), high: roas * (1 + e) };
}
/**
 * With fewer than 5 orders we only call a verdict when the spend is clearly
 * large and revenue near zero: spend ≥ ₹10,000 and ROAS < 0.25 (≈ one Nadi
 * order on ₹10k) — that is below target even if attribution misses half.
 */
export const LARGE_SPEND = 10_000;
export const NEAR_ZERO_ROAS = 0.25;

const fmtRoas = (r: number) => r.toFixed(2);

/**
 * ROAS verdict vs target. First-party ROAS is a lower bound (only ~60% of
 * orders are traceable) and Meta-reported ROAS is usually an upper bound, so
 * `below_target` needs BOTH: the first-party range's high end < target AND
 * Meta-reported ROAS < target. First-party below but Meta at/above target →
 * near_target (attribution gap). Every note shows the [first-party,
 * Meta-reported] range when Meta reports a value.
 */
export function targetCheck(
  spend: number,
  revenue: number,
  orders: number,
  metaRoas: number | null = null,
  targetRoas = TARGET_ROAS,
): PmTargetCheck {
  const base = { targetRoas, confidence: confidenceFor(orders) };
  const roas = ratio(revenue, spend);
  if (roas == null)
    return {
      ...base,
      confidence: 'low',
      verdict: 'not_enough_data',
      note: 'No Meta spend in range',
    };
  const orderWord = `${orders} first-party order${orders === 1 ? '' : 's'}`;
  const hasMeta = metaRoas != null && metaRoas > 0;
  const range = hasMeta
    ? `; range first-party ${fmtRoas(roas)} – Meta-reported ${fmtRoas(metaRoas)}`
    : '';
  const metaAbove = hasMeta && metaRoas >= targetRoas;
  const gap = (lowEnd: number) => ({
    ...base,
    verdict: 'near_target' as const,
    note: `First-party below, Meta-reported above — attribution gap; true ROAS likely between ${fmtRoas(lowEnd)} and ${fmtRoas(metaRoas!)} (first-party ${fmtRoas(roas)} on ${orderWord})`,
  });
  if (orders < CONFIDENCE_MIN_MEDIUM) {
    if (spend >= LARGE_SPEND && roas < NEAR_ZERO_ROAS) {
      if (metaAbove) return gap(roas);
      return {
        ...base,
        verdict: 'below_target',
        confidence: 'medium',
        note: `ROAS ${fmtRoas(roas)} on ₹${Math.round(spend).toLocaleString('en-IN')} spend with only ${orderWord} — below target even allowing for missed attribution${range}`,
      };
    }
    return {
      ...base,
      verdict: 'not_enough_data',
      note: `${orderWord} — too few to judge${range}`,
    };
  }
  const { low, high } = roasInterval(roas, orders);
  const verdict =
    low > targetRoas
      ? 'above_target'
      : high < targetRoas
        ? 'below_target'
        : 'near_target';
  if (verdict === 'below_target' && metaAbove) return gap(roas);
  return {
    ...base,
    verdict,
    note: `ROAS ${fmtRoas(roas)} (rough 95% range ${fmtRoas(low)}–${fmtRoas(high)}) vs target ${fmtRoas(targetRoas)} on ${orderWord} (lower bound)${range}`,
  };
}

export interface CpaFactors {
  cpm: number | null;
  ctr: number | null;
  clickToOrderRate: number | null;
}

/**
 * CPA = CPM / (1000 × CTR × click→order). log(CPA₁/CPA₀) =
 * log(cpm₁/cpm₀) − log(ctr₁/ctr₀) − log(cvr₁/cvr₀); each term's share of the
 * total is its contribution (shares sum to exactly 1; a factor moving against
 * the total gets a negative share). Null when any factor is 0/null in either
 * period, or CPA did not change.
 */
export function decomposeCpa(cur: CpaFactors, prior: CpaFactors) {
  const keys = ['cpm', 'ctr', 'clickToOrderRate'] as const;
  const sign = { cpm: 1, ctr: -1, clickToOrderRate: -1 };
  const ok = keys.every((k) => (cur[k] ?? 0) > 0 && (prior[k] ?? 0) > 0);
  const terms = Object.fromEntries(
    keys.map((k) => [k, ok ? sign[k] * Math.log(cur[k]! / prior[k]!) : null]),
  ) as Record<(typeof keys)[number], number | null>;
  const total = ok ? keys.reduce((s, k) => s + terms[k]!, 0) : null;
  const usable = total != null && Math.abs(total) > 1e-9;
  return keys.map((k) => ({
    name: k,
    current: cur[k],
    prior: prior[k],
    change: relChange(cur[k], prior[k]),
    contribution: usable ? terms[k]! / total : null,
  }));
}

/**
 * z-score for a change in orders per rupee between two periods (Poisson
 * counts, spend fixed). null when either period has no spend or orders.
 */
export function poissonRateZ(o1: number, s1: number, o0: number, s0: number) {
  if (!s1 || !s0 || !o1 || !o0) return null;
  const r1 = o1 / s1;
  const r0 = o0 / s0;
  return (r1 - r0) / Math.sqrt(o1 / (s1 * s1) + o0 / (s0 * s0));
}

/** Ordinary least-squares slope of y on x; null with < 2 points or no x spread. */
export function olsSlope(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = ys.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  return sxx > 1e-9 ? sxy / sxx : null;
}

/** Daily frequency averaged with impression weights (reach is not additive). */
export const weightedFrequency = (
  rows: { frequency: number; impressions: number }[],
) =>
  ratio(
    rows.reduce((s, r) => s + r.frequency * r.impressions, 0),
    rows.reduce((s, r) => s + r.impressions, 0),
  );

/** Bands (same as astro_be product-insights). `uppers` are exclusive upper bounds. */
export const SCROLL_BANDS = {
  uppers: [25, 50, 75, 100],
  labels: ['<25%', '25–49%', '50–74%', '75–99%', '100%'],
};
export const TIME_BANDS = {
  uppers: [10, 30, 60, 180],
  labels: ['<10s', '10–30s', '30–60s', '1–3m', '3m+'],
};

export const bandIndex = (value: number, uppers: number[]) => {
  const i = uppers.findIndex((u) => (value ?? 0) < u);
  return i === -1 ? uppers.length : i;
};

/** The same rule as bandIndex, as a Mongo expression. */
export const bandIndexExpr = (field: string, uppers: number[]) => ({
  $switch: {
    branches: uppers.map((u, i) => ({
      case: { $lt: [{ $ifNull: [field, 0] }, u] },
      then: i,
    })),
    default: uppers.length,
  },
});

export interface MetaSums {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  landingPageViews: number;
  /** Σ frequency × impressions, for the weighted frequency. */
  freqImp: number;
  metaPurchases: number;
  metaPurchaseValue: number;
}
export interface OrderSums {
  orders: number;
  revenue: number;
  newCustomers: number;
}
export interface SiteSums {
  visitors: number;
  ctaClicks: number;
  paymentsStarted: number;
}

export const ZERO_META: MetaSums = {
  spend: 0,
  impressions: 0,
  clicks: 0,
  linkClicks: 0,
  landingPageViews: 0,
  freqImp: 0,
  metaPurchases: 0,
  metaPurchaseValue: 0,
};
export const ZERO_ORDERS: OrderSums = {
  orders: 0,
  revenue: 0,
  newCustomers: 0,
};
export const ZERO_SITE: SiteSums = {
  visitors: 0,
  ctaClicks: 0,
  paymentsStarted: 0,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sums from the three sources → the contract's metric block. */
export function toMetrics(
  m: MetaSums = ZERO_META,
  o: OrderSums = ZERO_ORDERS,
  s: SiteSums = ZERO_SITE,
): PmMetrics {
  return {
    spend: round2(m.spend),
    impressions: m.impressions,
    clicks: m.clicks,
    linkClicks: m.linkClicks,
    landingPageViews: m.landingPageViews,
    cpm: ratio(m.spend * 1000, m.impressions),
    ctr: ratio(m.linkClicks, m.impressions),
    cpc: ratio(m.spend, m.linkClicks),
    frequency: ratio(m.freqImp, m.impressions),
    metaPurchases: m.metaPurchases,
    metaPurchaseValue: round2(m.metaPurchaseValue),
    metaRoas: ratio(m.metaPurchaseValue, m.spend),
    siteVisitors: s.visitors,
    siteCtaClicks: s.ctaClicks,
    sitePaymentsStarted: s.paymentsStarted,
    firstPartyOrders: o.orders,
    firstPartyRevenue: round2(o.revenue),
    firstPartyRoas: ratio(o.revenue, m.spend),
    // No spend data → CPA unknown, not ₹0.
    firstPartyCpa: m.spend > 0 ? ratio(m.spend, o.orders) : null,
    newCustomerOrders: o.newCustomers,
    clickToOrderRate: ratio(o.orders, m.linkClicks),
    visitToOrderRate: ratio(o.orders, s.visitors),
    averageOrderValue: ratio(o.revenue, o.orders),
  };
}

/** Relative change per numeric metric. */
export function metricsChange(cur: PmMetrics, prior: PmMetrics) {
  const out: Partial<Record<keyof PmMetrics, number | null>> = {};
  for (const k of Object.keys(cur) as (keyof PmMetrics)[])
    out[k] = relChange(cur[k], prior[k]);
  return out;
}

export const targetOf = (m: PmMetrics) =>
  targetCheck(m.spend, m.firstPartyRevenue, m.firstPartyOrders, m.metaRoas);

export const periodOf = (from: string, to: string, product?: string) =>
  ({ from, to, ...(product ? { product } : {}) }) as PmQuery;

/**
 * Meta (pm_meta_breakdowns) and OpenPanel name some Indian states
 * differently; both sides are mapped through this before joining.
 */
const REGION_ALIASES: Record<string, string> = {
  'national capital territory of delhi': 'Delhi',
  'nct of delhi': 'Delhi',
  'new delhi': 'Delhi',
  orissa: 'Odisha',
  pondicherry: 'Puducherry',
  'union territory of puducherry': 'Puducherry',
  'andaman and nicobar': 'Andaman and Nicobar Islands',
  'jammu & kashmir': 'Jammu and Kashmir',
  uttaranchal: 'Uttarakhand',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
};
export const normaliseRegion = (r: string | null | undefined) => {
  const t = (r ?? '').trim();
  if (!t || t.toLowerCase() === 'unknown') return 'Unknown';
  return REGION_ALIASES[t.toLowerCase()] ?? t;
};

const pct = (x: number) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;

export interface WindowSums {
  spend: number;
  impressions: number;
  linkClicks: number;
  freqImp: number;
  orders: number;
}

/**
 * Creative fatigue, first 7 vs last 7 active (spend > 0) days of the ad in
 * range. Using 7-day windows, never single days, is what makes a signal
 * "sustained".
 * Frequency here is the average daily frequency (impression-weighted mean of
 * each ad-day's frequency), not period frequency.
 * - not_enough_data: < 14 active days (windows would overlap) or < 3,000
 *   impressions in either window.
 * - signals: frequency +20% or more; link CTR −20% or more (only with ≥ 100
 *   link clicks in each window); first-party CPA +30% or more (only when
 *   both windows have ≥ 5 orders).
 * - fatigued: frequency rising AND (CTR falling OR CPA rising).
 * - watch: CTR falling or CPA rising alone, or frequency rising to ≥ 2.5.
 */
export const FATIGUE = {
  minActiveDays: 14,
  minWindowImpressions: 3000,
  minWindowLinkClicks: 100,
  freqRise: 0.2,
  ctrFall: -0.2,
  cpaRise: 0.3,
  cpaMinOrders: 5,
  highFrequency: 2.5,
};
export function fatigueOf(activeDays: number, a: WindowSums, b: WindowSums) {
  const f0 = ratio(a.freqImp, a.impressions);
  const f1 = ratio(b.freqImp, b.impressions);
  const c0 = ratio(a.linkClicks, a.impressions);
  const c1 = ratio(b.linkClicks, b.impressions);
  const p0 = ratio(a.spend, a.orders);
  const p1 = ratio(b.spend, b.orders);
  const out = {
    frequencyFirst7: f0,
    frequencyLast7: f1,
    ctrFirst7: c0,
    ctrLast7: c1,
    cpaFirst7: p0,
    cpaLast7: p1,
  };
  const reasons: string[] = [];
  if (activeDays < FATIGUE.minActiveDays)
    return {
      ...out,
      status: 'not_enough_data' as const,
      reasons: [`${activeDays} active days — need ${FATIGUE.minActiveDays}`],
    };
  if (Math.min(a.impressions, b.impressions) < FATIGUE.minWindowImpressions)
    return {
      ...out,
      status: 'not_enough_data' as const,
      reasons: [
        `Under ${FATIGUE.minWindowImpressions.toLocaleString('en-IN')} impressions in a 7-day window`,
      ],
    };
  const df = relChange(f1, f0);
  const dc =
    Math.min(a.linkClicks, b.linkClicks) >= FATIGUE.minWindowLinkClicks
      ? relChange(c1, c0)
      : null;
  const dp =
    Math.min(a.orders, b.orders) >= FATIGUE.cpaMinOrders
      ? relChange(p1, p0)
      : null;
  const freqUp = df != null && df >= FATIGUE.freqRise;
  const ctrDown = dc != null && dc <= FATIGUE.ctrFall;
  const cpaUp = dp != null && dp >= FATIGUE.cpaRise;
  if (df != null)
    reasons.push(
      `Avg daily frequency ${f0!.toFixed(2)} → ${f1!.toFixed(2)} (${pct(df)})`,
    );
  if (dc == null) reasons.push('Too few link clicks per window to compare CTR');
  else
    reasons.push(
      `Link CTR ${(c0! * 100).toFixed(2)}% → ${(c1! * 100).toFixed(2)}% (${pct(dc)})`,
    );
  if (dp != null)
    reasons.push(
      `First-party CPA ₹${Math.round(p0!)} → ₹${Math.round(p1!)} (${pct(dp)})`,
    );
  else reasons.push('Too few orders per window to compare CPA');
  const status =
    freqUp && (ctrDown || cpaUp)
      ? ('fatigued' as const)
      : ctrDown || cpaUp || (freqUp && (f1 ?? 0) >= FATIGUE.highFrequency)
        ? ('watch' as const)
        : ('healthy' as const);
  return { ...out, status, reasons };
}

export type BudgetSignal =
  | 'room_to_scale'
  | 'saturating'
  | 'hold'
  | 'reduce'
  | 'not_enough_data';

/**
 * Budget signal for a campaign or ad set (descriptive, not causal):
 * - not_enough_data: < 7 days with spend, or the ROAS verdict is
 *   not_enough_data.
 * - hold: edited in the last 3 days of the range (let delivery settle).
 * - reduce: only relative laggards — verdict below target (first-party AND
 *   Meta-reported, see targetCheck) with medium/high confidence, first-party
 *   ROAS ≤ 0.8 × the account's (same product scope, same window), and
 *   marginal ROAS known and below the account ROAS. A below-target entity
 *   that is not a laggard → hold (the whole account is below target).
 * - saturating: at/above target but avg daily frequency +15% or more with
 *   reach flat (≤ +5%; reach trend only counts when the same ads ran in
 *   both halves — the caller passes null otherwise), or marginal ROAS below
 *   target over ≥ 14 days with spend (daily revenue is too noisy to trust
 *   the slope on fewer).
 * - room_to_scale: above target with high confidence (≥ 20 orders), marginal
 *   ROAS unknown or ≥ target, frequency not rising 15%+.
 * - hold: anything else.
 */
export const BUDGET = {
  minDays: 7,
  marginalMinDays: 14,
  freqRise: 0.15,
  reachFlat: 0.05,
  laggardShare: 0.8,
};
export function budgetSignalOf(i: {
  activeDays: number;
  spend: number;
  revenue: number;
  orders: number;
  metaRoas?: number | null;
  /** Account first-party ROAS, same product scope and window. */
  accountRoas?: number | null;
  marginalRoas: number | null;
  frequencyTrend: number | null;
  reachTrend: number | null;
  recentChange: string | null;
}): { signal: BudgetSignal; reasons: string[] } {
  const t = targetCheck(i.spend, i.revenue, i.orders, i.metaRoas ?? null);
  const reasons = [t.note];
  if (i.activeDays < BUDGET.minDays)
    return {
      signal: 'not_enough_data',
      reasons: [`${i.activeDays} days with spend — need ${BUDGET.minDays}`],
    };
  if (t.verdict === 'not_enough_data')
    return { signal: 'not_enough_data', reasons };
  if (i.marginalRoas != null)
    reasons.push(`Observed marginal ROAS ${i.marginalRoas.toFixed(2)}`);
  if (i.frequencyTrend != null)
    reasons.push(
      `Avg daily frequency ${pct(i.frequencyTrend)} (2nd half vs 1st)`,
    );
  if (i.reachTrend != null)
    reasons.push(`Daily reach ${pct(i.reachTrend)} (2nd half vs 1st)`);
  if (i.recentChange) {
    reasons.push(`Edited recently (${i.recentChange}) — let delivery settle`);
    return { signal: 'hold', reasons };
  }
  const target = TARGET_ROAS;
  const mOk = i.marginalRoas == null || i.marginalRoas >= target;
  const freqUp = (i.frequencyTrend ?? 0) >= BUDGET.freqRise;
  if (t.verdict === 'below_target') {
    const roas = ratio(i.revenue, i.spend)!;
    const acct = i.accountRoas ?? null;
    const laggard =
      t.confidence !== 'low' &&
      acct != null &&
      roas <= BUDGET.laggardShare * acct &&
      i.marginalRoas != null &&
      i.marginalRoas < acct;
    if (laggard) {
      reasons.push(
        `First-party ROAS ${roas.toFixed(2)} vs account ${acct.toFixed(2)} — a laggard within the account`,
      );
      return { signal: 'reduce', reasons };
    }
    reasons.push(
      acct != null && acct < target
        ? 'Whole account below target — fix at account level (funnel/pricing/creative), not by cutting this one'
        : `Below target but not clearly worse than the account (account ROAS ${acct == null ? 'n/a' : acct.toFixed(2)}) — investigate before cutting`,
    );
    return { signal: 'hold', reasons };
  }
  if (
    (freqUp && i.reachTrend != null && i.reachTrend <= BUDGET.reachFlat) ||
    (!mOk && i.activeDays >= BUDGET.marginalMinDays)
  )
    return { signal: 'saturating', reasons };
  if (t.verdict === 'above_target' && t.confidence === 'high' && mOk && !freqUp)
    return { signal: 'room_to_scale', reasons };
  return { signal: 'hold', reasons };
}

/** Days of `all` not in `present`, in order. */
export const missingFrom = (all: string[], present: Iterable<string>) => {
  const have = new Set(present);
  return all.filter((d) => !have.has(d));
};

/** Compact list: "2026-10-23, 2026-10-24" (first 5, then "+N more"). */
export const listDays = (days: string[]) =>
  days.length > 5
    ? `${days.slice(0, 5).join(', ')} +${days.length - 5} more`
    : days.join(', ');

/** With Meta days missing, spend is understated — no verdict. */
export function withMissingMeta(
  t: PmTargetCheck,
  metaMissing: string[] | undefined,
): PmTargetCheck {
  if (!metaMissing?.length) return t;
  return {
    ...t,
    verdict: 'not_enough_data',
    confidence: 'low',
    note: `Meta data missing for ${listDays(metaMissing)}`,
  };
}
