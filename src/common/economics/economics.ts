/**
 * Unit economics — the single source of truth for "is this ROAS actually good?".
 *
 * Every surface that judges performance MUST go through here. A raw ROAS
 * number is meaningless without the margin behind it: 1.5x is deeply
 * unprofitable for a 40%-margin physical product (breakeven 2.5x) and very
 * profitable for a 97%-margin digital report (breakeven 1.03x). The dashboard
 * previously hardcoded `roas >= 1.5 = good, >= 1.0 = watch`, which silently
 * flagged sub-breakeven spend as merely "watch this" for high-margin tenants
 * and as "working well" for low-margin ones.
 *
 * Kept as pure functions with no Nest/Mongo dependency so the same formula is
 * usable from the intelligence engines, the dashboard rollup, and tests.
 */

/** Below this margin the breakeven maths explodes toward infinity — clamp. */
const MIN_MARGIN = 0.01;
const MAX_MARGIN = 0.99;
const MAX_REFUND = 0.95;

/** Fallback when a tenant has no product config at all. */
export const GENERIC_MARGIN = 0.4;

export interface EconomicsInput {
  /** Contribution margin as a decimal 0-1 (0.97 = 97%). */
  marginPct?: number | null;
  /** Refund rate as a decimal 0-1 (0.30 = 30% of conversions refund). */
  refundPct?: number | null;
}

export interface Economics {
  marginPct: number;
  refundPct: number;
  /** Margin after refund haircut — the number breakeven actually divides by. */
  netMarginPct: number;
  /** ROAS at which contribution profit is exactly zero. */
  breakevenROAS: number;
  /**
   * The profit GOAL, not the survival line. 2x breakeven scales correctly
   * across products instead of a flat company-wide number that would sit
   * BELOW breakeven for low-margin products.
   */
  targetROAS: number;
}

export function clampMargin(value: number | null | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, value));
}

export function clampRefund(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.min(MAX_REFUND, Math.max(0, value));
}

/** breakeven ROAS = 1 / (margin x (1 - refundRate)) */
export function deriveEconomics(input: EconomicsInput): Economics {
  const marginPct = clampMargin(input.marginPct, GENERIC_MARGIN);
  const refundPct = clampRefund(input.refundPct);
  const netMarginPct = marginPct * (1 - refundPct);
  const breakevenROAS = netMarginPct > 0 ? 1 / netMarginPct : Infinity;
  const targetROAS = Number.isFinite(breakevenROAS) ? breakevenROAS * 2 : Infinity;
  return {
    marginPct: round(marginPct, 4),
    refundPct: round(refundPct, 4),
    netMarginPct: round(netMarginPct, 4),
    breakevenROAS: round(breakevenROAS, 3),
    targetROAS: round(targetROAS, 3),
  };
}

/**
 * Contribution profit in currency: what the spend actually earned or destroyed
 * after cost of goods. This — not ROAS — is the number that sums correctly
 * across campaigns and answers "how much money did we make or lose?".
 *
 * Revenue from the Meta snapshot is already refund-net (see revenue-engine),
 * so only the margin multiplier is applied here; applying the refund haircut
 * again would double-count it.
 */
export function contributionProfit(
  spend: number,
  revenue: number,
  econ: Pick<Economics, 'marginPct'>,
): number {
  return revenue * econ.marginPct - spend;
}

/**
 * The spend-WEIGHTED portfolio ROAS. The dashboard previously averaged
 * per-campaign ROAS unweighted, which lets a ₹500 campaign at 4x cancel out a
 * ₹300,000 campaign at 0.5x and reports a healthy portfolio while the account
 * bleeds. Always divide totals.
 */
export function weightedROAS(totalSpend: number, totalRevenue: number): number {
  return totalSpend > 0 ? totalRevenue / totalSpend : 0;
}

export type PerformanceVerdict =
  | 'profitable'        // at or above target — scale
  | 'marginal'          // above breakeven, below target
  | 'below_breakeven'   // spending, earning, still losing money
  | 'losing_badly'      // less than half of breakeven
  | 'no_conversions'    // real spend, real time elapsed, zero revenue
  | 'attribution_pending' // spending but too new to judge
  | 'no_spend';         // nothing has happened yet

export interface VerdictInput {
  spend: number;
  revenue: number;
  /** Hours since the campaign started delivering. Gates "too new to judge". */
  ageHours: number | null;
  econ: Economics;
  /** Minimum spend before a zero-revenue campaign is called a failure. */
  minSpendToJudge?: number;
  /** Attribution grace period — Meta's default click window is 7d, but a
   *  purchase-intent funnel that has produced nothing in 3 days is a signal,
   *  not a pending attribution. */
  attributionGraceHours?: number;
}

/**
 * Classify a campaign's economic state.
 *
 * The important case: `no_conversions` vs `attribution_pending`. Rendering
 * "No data yet" for a campaign that spent ₹13,335 over 9 days with zero
 * revenue is not a neutral empty state — it hides the single worst performer
 * in the account behind the quietest possible label. Only genuinely-recent
 * spend gets the benefit of the doubt.
 */
export function classifyPerformance(input: VerdictInput): PerformanceVerdict {
  const {
    spend,
    revenue,
    ageHours,
    econ,
    minSpendToJudge = 500,
    attributionGraceHours = 72,
  } = input;

  if (spend <= 0) return 'no_spend';

  if (revenue <= 0) {
    const tooNew = ageHours != null && ageHours < attributionGraceHours;
    if (tooNew || spend < minSpendToJudge) return 'attribution_pending';
    return 'no_conversions';
  }

  const roas = weightedROAS(spend, revenue);
  if (roas >= econ.targetROAS) return 'profitable';
  if (roas >= econ.breakevenROAS) return 'marginal';
  if (roas < econ.breakevenROAS / 2) return 'losing_badly';
  return 'below_breakeven';
}

/** Traffic-light bucket for a verdict — drives colour, never thresholds. */
export function verdictSeverity(
  verdict: PerformanceVerdict,
): 'good' | 'watch' | 'bad' | 'neutral' {
  switch (verdict) {
    case 'profitable':
      return 'good';
    case 'marginal':
      return 'watch';
    case 'below_breakeven':
    case 'losing_badly':
    case 'no_conversions':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function round(value: number, dp: number): number {
  if (!Number.isFinite(value)) return value;
  const f = Math.pow(10, dp);
  return Math.round(value * f) / f;
}
