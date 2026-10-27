/**
 * Pure rules that turn metric inputs into a PmSituation (lessons.types.ts):
 * the tags lessons are scoped by. No I/O (situation.logic.spec.ts); the data
 * comes from situation.service.ts.
 */
import { relChange, targetOf } from '../../analysis/pm-stats';
import type { PmMetrics } from '../../analysis/pm-analysis.types';
import { daysBetween } from '../journal/journal.logic';
import type { CalendarHit } from '../tools/calendar.tools';
import type { PmSituation } from './lessons.types';

// ---------------------------------------------------------------- thresholds

/** Daily spend band edges (₹/day over the last 7 days). */
export const SPEND_BANDS = [5_000, 15_000, 50_000] as const;
/** Last 7 days vs the 7 before. */
export const CTR_DROP = -0.2; // CTR down 20%+
export const CPM_UP = 0.15; // CPM up 15%+
export const ORDERS_DROP = -0.3; // orders down 30%+ …
export const ORDERS_DROP_MIN_PRIOR = 5; // … from at least 5 orders
export const PAYMENT_DROP = -0.2; // orders ÷ payments started down 20%+
export const FUNNEL_DROP = -0.25; // visit-to-order down 25%+
/** Impression-weighted daily frequency at or above this. */
export const FREQ_HIGH = 1.5;
/** An edit within this many days. */
export const RECENT_EDIT_DAYS = 7;
/** Account CPM change (7d vs prior 7d) that counts as a trend. */
export const ACCOUNT_CPM_TREND = 0.1;
/** Calendar rows starting within this many days are tagged `pre-<id>`. */
export const SEASON_LOOKAHEAD_DAYS = 14;
/** Campaign-budget campaigns named like this are Advantage+ (the sync has no smart_promotion_type). */
export const ADVANTAGE_PLUS_NAME = /adva?\w*\+|advantage\s*plus|\basc\b/i;

type Metrics = Pick<
  PmMetrics,
  | 'spend'
  | 'impressions'
  | 'cpm'
  | 'ctr'
  | 'frequency'
  | 'firstPartyOrders'
  | 'firstPartyRevenue'
  | 'firstPartyRoas'
  | 'firstPartyCpa'
  | 'metaRoas'
  | 'visitToOrderRate'
  | 'sitePaymentsStarted'
>;

export interface PmSituationInput {
  date: string; // decision / run date; data runs to the day before
  product: string;
  objective: string;
  campaignName: string;
  budgetLevel: '' | 'campaign' | 'adset';
  /** Ad sets in scope (active ones; all when none is active). */
  adsets: { audienceType?: string; learningStage?: string }[];
  launchedOn: string | null; // YYYY-MM-DD
  lastEditOn: string | null; // YYYY-MM-DD, last change before `date`
  m7: Metrics;
  p7: Metrics; // the 7 days before m7
  accountCpm7: number | null;
  accountCpmPrior7: number | null;
  missingDays: number;
  /** calendar rows from `date` to date + 14 (PmCalendarTools.query, ref = date). */
  calendar: Pick<CalendarHit, 'id' | 'kind' | 'status' | 'daysFromDate'>[];
  level?: PmSituation['level'];
  entityId?: string;
}

export function spendBand(spendPerDay: number): PmSituation['spendBand'] {
  const [a, b, c] = SPEND_BANDS;
  return spendPerDay < a ? '<5k' : spendPerDay < b ? '5k-15k' : spendPerDay < c ? '15k-50k' : '>50k';
}

export function structureOf(budgetLevel: string, campaignName: string): PmSituation['structure'] {
  if (budgetLevel === 'adset') return 'ABO';
  if (budgetLevel === 'campaign') return ADVANTAGE_PLUS_NAME.test(campaignName) ? 'ADVANTAGE_PLUS' : 'CBO';
  return 'unknown';
}

/** targetingSummary.audienceType → prospecting / retargeting ('custom' lists are ambiguous). */
const AUDIENCE: Record<string, 'prospecting' | 'retargeting'> = {
  retargeting: 'retargeting',
  broad: 'prospecting',
  interest: 'prospecting',
  lookalike: 'prospecting',
};
export function audienceOf(types: (string | undefined)[]): PmSituation['audience'] {
  const known = new Set(types.map((t) => AUDIENCE[t ?? '']).filter(Boolean));
  return known.size === 0 ? 'unknown' : known.size > 1 ? 'mixed' : [...known][0];
}

export function learningOf(stages: (string | undefined)[]): PmSituation['learning'] {
  const s = new Set(stages.filter((x): x is 'LEARNING' | 'SUCCESS' | 'FAIL' => ['LEARNING', 'SUCCESS', 'FAIL'].includes(x ?? '')));
  return s.size === 0 ? 'unknown' : s.size > 1 ? 'mixed' : [...s][0];
}

/** `<id>` for rows on `date`, `pre-<id>` for rows starting within 14 days. */
export function seasonOf(rows: PmSituationInput['calendar']) {
  const season: string[] = [];
  let festivalInDays: number | null = null;
  for (const r of rows) {
    // Year-free tag too ('diwali' for 'diwali-2026'), so season lessons carry over to next year.
    const ids = [...new Set([r.id, r.id.replace(/-\d{4}$/, '')])];
    if (r.status === 'ongoing') season.push(...ids);
    else if (r.status === 'upcoming' && r.daysFromDate <= SEASON_LOOKAHEAD_DAYS)
      season.push(...ids.map((id) => `pre-${id}`));
    else continue;
    if (r.kind === 'festival' && (festivalInDays === null || r.daysFromDate < festivalInDays))
      festivalInDays = r.daysFromDate;
  }
  return { season, festivalInDays };
}

const paySuccess = (m: Metrics) => (m.sitePaymentsStarted > 0 ? m.firstPartyOrders / m.sitePaymentsStarted : null);
const dropped = (cur: number | null, prior: number | null, limit: number) => {
  const c = relChange(cur, prior);
  return c !== null && c <= limit;
};

export function symptomsOf(i: PmSituationInput, learning: PmSituation['learning'], daysSinceLastEdit: number | null) {
  const out: string[] = [];
  const verdict = targetOf(i.m7 as PmMetrics).verdict;
  if (verdict === 'below_target') out.push('below_target');
  if (verdict === 'above_target') out.push('above_target');
  if (dropped(i.m7.ctr, i.p7.ctr, CTR_DROP)) out.push('ctr_drop');
  const cpm = relChange(i.m7.cpm, i.p7.cpm);
  if (cpm !== null && cpm >= CPM_UP) out.push('cpm_up');
  if ((i.m7.frequency ?? 0) >= FREQ_HIGH) out.push('freq_high');
  if (i.p7.firstPartyOrders >= ORDERS_DROP_MIN_PRIOR && dropped(i.m7.firstPartyOrders, i.p7.firstPartyOrders, ORDERS_DROP))
    out.push('orders_drop');
  if (dropped(paySuccess(i.m7), paySuccess(i.p7), PAYMENT_DROP)) out.push('payment_drop');
  if (dropped(i.m7.visitToOrderRate, i.p7.visitToOrderRate, FUNNEL_DROP)) out.push('funnel_drop');
  if (learning === 'FAIL' || i.adsets.some((a) => a.learningStage === 'FAIL')) out.push('learning_limited');
  if (i.missingDays > 0) out.push('data_gap');
  if (daysSinceLastEdit !== null && daysSinceLastEdit < RECENT_EDIT_DAYS) out.push('recent_edit');
  return out;
}

const round = (x: number | null, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function buildSituation(i: PmSituationInput): PmSituation {
  const learning = learningOf(i.adsets.map((a) => a.learningStage));
  const daysSinceLastEdit = i.lastEditOn ? daysBetween(i.lastEditOn, i.date) : null;
  const trend = relChange(i.accountCpm7, i.accountCpmPrior7);
  const { season, festivalInDays } = seasonOf(i.calendar);
  return {
    product: i.product || 'other',
    structure: structureOf(i.budgetLevel, i.campaignName),
    objective: i.objective || 'unknown',
    audience: audienceOf(i.adsets.map((a) => a.audienceType)),
    spendBand: spendBand(i.m7.spend / 7),
    learning,
    daysSinceLaunch: i.launchedOn ? daysBetween(i.launchedOn, i.date) : null,
    daysSinceLastEdit,
    roas7d: round(i.m7.firstPartyRoas),
    cpa7d: round(i.m7.firstPartyCpa, 0),
    ctr7d: round(i.m7.ctr === null ? null : i.m7.ctr * 100),
    cpm7d: round(i.m7.cpm, 0),
    freqDay: round(i.m7.frequency),
    accountCpmTrend: trend === null ? 'flat' : trend >= ACCOUNT_CPM_TREND ? 'up' : trend <= -ACCOUNT_CPM_TREND ? 'down' : 'flat',
    season,
    festivalInDays,
    symptoms: symptomsOf(i, learning, daysSinceLastEdit),
    ...(i.level ? { level: i.level } : {}),
    ...(i.entityId ? { entityId: i.entityId } : {}),
  };
}
