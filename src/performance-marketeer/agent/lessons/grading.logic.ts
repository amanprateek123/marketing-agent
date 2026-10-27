/**
 * Pure grading rules for decision outcomes (docs/performance-marketeer/10,
 * "Outcome"). No I/O (grading.logic.spec.ts); records.service.ts fetches the
 * windows and confounders.
 *
 * Difference-in-differences on first-party ROAS (R = revenue ÷ spend):
 *   d = (R_entity,after − R_entity,before) − (R_base,after − R_base,before)
 * Each window's ROAS is treated as a Poisson order count times a fixed
 * revenue-per-order over fixed spend — the same assumption as roasInterval
 * in pm-stats — so Var(R) ≈ R² ÷ orders (relative error 1/√orders), and
 *   95% interval = d ± 1.96 × √(Σ R_w² ÷ max(orders_w, 0.5))
 * over the four windows. No bootstrap. A baseline with no spend or no orders
 * in either window is dropped (d = the entity's own change; baseline null).
 */
import { addDays, Z95 } from '../../analysis/pm-stats';
import type { CalendarRow } from '../tools/calendar.tools';
import type { PmDecisionRecord, PmOutcomeRecord, PmOutcomeVerdict } from './lessons.types';
import { PM_LESSON_RULES } from './lessons.types';

export const BEFORE_DAYS = 7;
export const AFTER_DAYS: Record<PmOutcomeRecord['read'], number> = { early: 3, settled: 7 };
/** Share of product orders linked to a Meta ad falling this much (absolute) after vs before = tracking gap. */
export const TRACKING_DROP = 0.1;
/** Calendar rows shorter than this don't count as a season edge (one-day festivals are everywhere in Oct–Nov). */
export const MIN_SEASON_DAYS = 3;

export interface PmWindowSums {
  from: string;
  to: string;
  orders: number;
  revenue: number;
  spend: number;
}

/** 7 days before the change day vs N days after; the change day itself is excluded. */
export function windowsFor(changeDay: string, read: PmOutcomeRecord['read']) {
  return {
    before: { from: addDays(changeDay, -BEFORE_DAYS), to: addDays(changeDay, -1) },
    after: { from: addDays(changeDay, 1), to: addDays(changeDay, AFTER_DAYS[read]) },
  };
}

/** Gradeable on `date` once every after-day is complete (data runs to the day before). */
export const isDue = (changeDay: string, date: string, read: PmOutcomeRecord['read']) =>
  addDays(changeDay, AFTER_DAYS[read]) <= addDays(date, -1);

const roasOf = (w: PmWindowSums) => (w.spend > 0 ? w.revenue / w.spend : null);
const variance = (w: PmWindowSums) => (roasOf(w) ?? 0) ** 2 / Math.max(w.orders, 0.5);
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 10_000) / 10_000);

export function diffInDiff(before: PmWindowSums, after: PmWindowSums, baseBefore: PmWindowSums, baseAfter: PmWindowSums) {
  const rb = roasOf(before);
  const ra = roasOf(after);
  const baseOk = [baseBefore, baseAfter].every((w) => w.spend > 0 && w.orders > 0);
  const baseline = {
    roasBefore: baseOk ? r4(roasOf(baseBefore)) : null,
    roasAfter: baseOk ? r4(roasOf(baseAfter)) : null,
  };
  if (rb === null || ra === null) return { baseline, diffInDiff: { roas: null, low: null, high: null } };
  const windows = baseOk ? [before, after, baseBefore, baseAfter] : [before, after];
  const d = ra - rb - (baseOk ? roasOf(baseAfter)! - roasOf(baseBefore)! : 0);
  const se = Math.sqrt(windows.reduce((s, w) => s + variance(w), 0));
  return { baseline, diffInDiff: { roas: r4(d), low: r4(d - Z95 * se), high: r4(d + Z95 * se) } };
}

/**
 * What "worked" means per action: ROAS up for cuts, pauses, creative,
 * audience, etc.; for hold, budget increases and unpauses it is "no
 * significant deterioration" (scaling usually costs a little ROAS).
 */
export function ruleFor(type: string, direction?: 'up' | 'down'): 'roas_up' | 'no_worse' {
  return type === 'hold' || direction === 'up' ? 'no_worse' : 'roas_up';
}

export function verdictOf(
  rule: 'roas_up' | 'no_worse',
  did: { low: number | null; high: number | null },
  before: PmWindowSums,
  after: PmWindowSums,
  confounders: string[],
): PmOutcomeVerdict {
  const min = PM_LESSON_RULES.minOrdersPerWindow;
  if (before.orders < min || after.orders < min || did.low === null || did.high === null) return 'inconclusive';
  if (confounders.length) return 'contaminated';
  if (did.high < 0) return 'hurt';
  if (rule === 'no_worse') return 'worked';
  return did.low > 0 ? 'worked' : 'no_effect';
}

/**
 * decision.expected vs what happened. `metric` is free text from the plan:
 * ROAS or CPA only; "%", "pct", "change", "delta" or "lift" in the name =
 * relative change after vs before (× 100 when it says % / pct), otherwise
 * the after-window value. Anything else → null.
 */
export function insideRange(
  expected: PmDecisionRecord['expected'],
  before: { roas: number | null; cpa: number | null },
  after: { roas: number | null; cpa: number | null },
): boolean | null {
  if (!expected) return null;
  const key = /roas/i.test(expected.metric) ? 'roas' : /cpa/i.test(expected.metric) ? 'cpa' : null;
  if (!key) return null;
  const a = after[key];
  const b = before[key];
  let observed: number | null = a;
  if (/%|pct|percent|change|delta|lift/i.test(expected.metric)) {
    observed = a === null || !b ? null : a / b - 1;
    if (observed !== null && /%|pct|percent/i.test(expected.metric)) observed *= 100;
  }
  if (observed === null) return null;
  const [lo, hi] = expected.low <= expected.high ? [expected.low, expected.high] : [expected.high, expected.low];
  return observed >= lo && observed <= hi;
}

/** Right call given what was known, separate from how it turned out. */
export function decisionQualityOf(q: {
  checksFailed: string[];
  causeVerdicts: string[]; // verdicts of the causes the action cites
  disputed: boolean;
} | null): PmOutcomeRecord['decisionQuality'] {
  if (!q) return 'unknown';
  if (q.checksFailed.length || q.causeVerdicts.includes('rejected')) return 'poor';
  if (q.causeVerdicts.length && q.causeVerdicts.every((v) => v === 'confirmed' || v === 'weakened') && !q.disputed)
    return 'good';
  return 'unknown';
}

/** Multi-day, non-neutral calendar rows that start or end strictly inside [from, to]. */
export function seasonEdges(rows: Pick<CalendarRow, 'id' | 'start' | 'end' | 'mood'>[], from: string, to: string) {
  const span = (r: { start: string; end: string }) => (Date.parse(r.end) - Date.parse(r.start)) / 864e5 + 1;
  return rows
    .filter((r) => r.mood !== 'neutral' && span(r) >= MIN_SEASON_DAYS)
    .filter((r) => (r.start > from && r.start <= to) || (r.end >= from && r.end < to))
    .map((r) => r.id);
}

export function confoundersOf(c: {
  otherEdits: number;
  /** One of those other edits resets learning. */
  resetByOther: boolean;
  missingDays: number;
  coverageBefore: number | null; // share of orders linked to a Meta ad
  coverageAfter: number | null;
  seasonEdges: number;
}): string[] {
  const out: string[] = [];
  if (c.resetByOther) out.push('learning_reset');
  if (c.otherEdits) out.push('other_edit');
  if (c.coverageBefore !== null && c.coverageAfter !== null && c.coverageBefore - c.coverageAfter >= TRACKING_DROP)
    out.push('tracking_gap');
  if (c.seasonEdges) out.push('festival_edge');
  if (c.missingDays) out.push('missing_days');
  return out;
}

const side = (w: PmWindowSums) => ({
  from: w.from,
  to: w.to,
  roas: r4(roasOf(w)),
  orders: w.orders,
  spend: Math.round(w.spend * 100) / 100,
  cpa: w.orders > 0 && w.spend > 0 ? Math.round(w.spend / w.orders) : null,
});

export function gradeOutcome(i: {
  decision: Pick<PmDecisionRecord, 'type' | 'direction' | 'expected'>;
  read: PmOutcomeRecord['read'];
  before: PmWindowSums;
  after: PmWindowSums;
  baseBefore: PmWindowSums;
  baseAfter: PmWindowSums;
  confounders: string[];
  quality: Parameters<typeof decisionQualityOf>[0];
}): Omit<PmOutcomeRecord, 'decisionId' | 'weak' | 'gradedAt'> {
  const { baseline, diffInDiff: did } = diffInDiff(i.before, i.after, i.baseBefore, i.baseAfter);
  const before = side(i.before);
  const after = side(i.after);
  return {
    read: i.read,
    before,
    after,
    baseline,
    diffInDiff: did,
    verdict: verdictOf(ruleFor(i.decision.type, i.decision.direction), did, i.before, i.after, i.confounders),
    confounders: i.confounders,
    insidePredictedRange: insideRange(i.decision.expected, before, after),
    decisionQuality: decisionQualityOf(i.quality),
  };
}

// ---------------------------------------------------------------- diagnosis checks

/** How the cause's follow-up metric moved a week after the run (significant moves only; else 'same'). */
export type PmMove = 'better' | 'worse' | 'same';

/**
 * Fixed (a taken action cites the cause): held if the metric got better,
 * not held if it got worse, else unclear. Not fixed: held if the signal
 * persisted (same / worse), not held if it went away by itself.
 */
export function diagnosisOf(fixed: boolean, move: PmMove | null): 'held' | 'not_held' | 'unclear' {
  if (move === null) return 'unclear';
  if (fixed) return move === 'better' ? 'held' : move === 'worse' ? 'not_held' : 'unclear';
  return move === 'better' ? 'not_held' : 'held';
}
