import { ObjectiveData, ObjectiveKey } from '../orchestrator/decision-context';

export type ObjectiveProfile = Pick<
  ObjectiveData,
  'objective' | 'primaryKPI' | 'supportingKPIs' | 'weights' | 'thresholds' | 'policy'
>;

const P = <T extends ObjectiveProfile>(x: T) => x;

export const SALES_PROFILE = P({
  objective: 'sales',
  primaryKPI: 'roas',
  supportingKPIs: ['cvr', 'aov', 'ctr'],
  weights: { roas: 0.5, cvr: 0.2, aov: 0.15, ctr: 0.15 },
  thresholds: {
    healthy: { roas: 1.5, cvr: 0.02, ctr: 0.01, frequency: 2.5 },
    warning: { roas: 1, cvr: 0.01, ctr: 0.008, frequency: 3 },
    critical: { roas: 0.7, cvr: 0.005, ctr: 0.005, frequency: 4 },
  },
  policy: {
    scaleBudgetIf: 'roas >= 2.0 && conversions >= 10',
    pauseIf: 'roas < 0.7 && spend > 500',
    refreshCreativeIf: 'ctrDelta7d < -0.3 || frequency > 3.5',
  },
} as const);

export const LEADS_PROFILE = P({
  objective: 'leads',
  primaryKPI: 'cvr',
  supportingKPIs: ['ctr', 'cpc'],
  weights: { cvr: 0.5, ctr: 0.3, cpc: 0.2 },
  thresholds: {
    healthy: { cvr: 0.03, ctr: 0.012, cpc: 30 },
    warning: { cvr: 0.015, ctr: 0.008, cpc: 60 },
    critical: { cvr: 0.005, ctr: 0.004, cpc: 120 },
  },
  policy: {
    scaleBudgetIf: 'cvr >= 0.03 && ctr >= 0.012',
    pauseIf: 'cvr < 0.005 && spend > 500',
    refreshCreativeIf: 'ctrDelta7d < -0.3',
  },
} as const);

export const AWARENESS_PROFILE = P({
  objective: 'awareness',
  primaryKPI: 'reach',
  supportingKPIs: ['cpm', 'impressions', 'frequency'],
  weights: { reach: 0.5, cpm: 0.3, impressions: 0.15, frequency: 0.05 },
  thresholds: {
    healthy: { cpm: 400, frequency: 3 },
    warning: { cpm: 600, frequency: 4.5 },
    critical: { cpm: 900, frequency: 6 },
  },
  policy: {
    scaleBudgetIf: 'cpm <= 400',
    pauseIf: 'cpm > 900 || frequency > 6',
    refreshCreativeIf: 'frequency > 4.5',
    ignoreSignals: ['cvr_collapse', 'unprofitable_run'],
  },
} as const);

export const TRAFFIC_PROFILE = P({
  objective: 'traffic',
  primaryKPI: 'cpc',
  supportingKPIs: ['ctr', 'clicks'],
  weights: { cpc: 0.5, ctr: 0.35, clicks: 0.15 },
  thresholds: {
    healthy: { cpc: 8, ctr: 0.015 },
    warning: { cpc: 15, ctr: 0.008 },
    critical: { cpc: 30, ctr: 0.004 },
  },
  policy: {
    scaleBudgetIf: 'cpc <= 8 && ctr >= 0.015',
    pauseIf: 'cpc > 30',
    refreshCreativeIf: 'ctrDelta7d < -0.3',
    ignoreSignals: ['cvr_collapse'],
  },
} as const);

export const ENGAGEMENT_PROFILE = P({
  objective: 'engagement',
  primaryKPI: 'ctr',
  supportingKPIs: ['cpm', 'frequency'],
  weights: { ctr: 0.6, cpm: 0.25, frequency: 0.15 },
  thresholds: {
    healthy: { ctr: 0.015, cpm: 500 },
    warning: { ctr: 0.008, cpm: 800 },
    critical: { ctr: 0.004, cpm: 1200 },
  },
  policy: {
    scaleBudgetIf: 'ctr >= 0.015',
    pauseIf: 'ctr < 0.004',
    refreshCreativeIf: 'frequency > 4.5',
    ignoreSignals: ['cvr_collapse', 'unprofitable_run'],
  },
} as const);

export const VIDEO_VIEWS_PROFILE = P({
  objective: 'video_views',
  primaryKPI: 'ctr',
  supportingKPIs: ['cpm', 'reach'],
  weights: { ctr: 0.5, cpm: 0.3, reach: 0.2 },
  thresholds: {
    healthy: { cpm: 300 },
    warning: { cpm: 500 },
    critical: { cpm: 800 },
  },
  policy: {
    scaleBudgetIf: 'cpm <= 300',
    pauseIf: 'cpm > 800',
    refreshCreativeIf: 'frequency > 4',
    ignoreSignals: ['cvr_collapse', 'unprofitable_run'],
  },
} as const);

export const APP_INSTALLS_PROFILE = P({
  objective: 'app_installs',
  primaryKPI: 'cpc',
  supportingKPIs: ['ctr', 'cvr'],
  weights: { cpc: 0.4, ctr: 0.3, cvr: 0.3 },
  thresholds: {
    healthy: { cpc: 20, ctr: 0.012 },
    warning: { cpc: 40, ctr: 0.008 },
    critical: { cpc: 80, ctr: 0.004 },
  },
  policy: {
    scaleBudgetIf: 'cpc <= 20',
    pauseIf: 'cpc > 80',
    refreshCreativeIf: 'ctrDelta7d < -0.3',
  },
} as const);

export const MESSAGES_PROFILE = P({
  objective: 'messages',
  primaryKPI: 'cvr',
  supportingKPIs: ['ctr'],
  weights: { cvr: 0.6, ctr: 0.4 },
  thresholds: {
    healthy: { cvr: 0.02, ctr: 0.012 },
    warning: { cvr: 0.01, ctr: 0.008 },
    critical: { cvr: 0.005, ctr: 0.004 },
  },
  policy: {
    scaleBudgetIf: 'cvr >= 0.02',
    pauseIf: 'cvr < 0.005',
    refreshCreativeIf: 'ctr < 0.008',
  },
} as const);

export const CATALOG_SALES_PROFILE = P({
  ...SALES_PROFILE,
  objective: 'catalog_sales',
} as const);

export const RETARGETING_PROFILE = P({
  ...SALES_PROFILE,
  objective: 'retargeting',
  thresholds: {
    healthy: { roas: 3, cvr: 0.04, ctr: 0.015, frequency: 3 },
    warning: { roas: 2, cvr: 0.02, ctr: 0.01, frequency: 4.5 },
    critical: { roas: 1, cvr: 0.008, ctr: 0.005, frequency: 6 },
  },
} as const);

const REGISTRY: Record<ObjectiveKey, ObjectiveProfile> = {
  sales: SALES_PROFILE,
  leads: LEADS_PROFILE,
  awareness: AWARENESS_PROFILE,
  traffic: TRAFFIC_PROFILE,
  engagement: ENGAGEMENT_PROFILE,
  video_views: VIDEO_VIEWS_PROFILE,
  app_installs: APP_INSTALLS_PROFILE,
  messages: MESSAGES_PROFILE,
  catalog_sales: CATALOG_SALES_PROFILE,
  retargeting: RETARGETING_PROFILE,
};

export function getProfile(k: ObjectiveKey): ObjectiveProfile {
  return REGISTRY[k] ?? SALES_PROFILE;
}

/**
 * Meta objective enum strings → our canonical ObjectiveKey.
 * Handles both Meta's OUTCOME_* format (v14+) and legacy names.
 */
export function mapMetaObjective(raw?: string): ObjectiveKey | undefined {
  if (!raw) return undefined;
  const u = raw.toUpperCase();
  if (u.includes('SALES') && u.includes('CATALOG')) return 'catalog_sales';
  if (u.includes('SALES') || u.includes('CONVERSIONS') || u === 'OUTCOME_SALES') return 'sales';
  if (u.includes('LEAD')) return 'leads';
  if (u.includes('AWARENESS')) return 'awareness';
  if (u.includes('TRAFFIC') || u.includes('LINK_CLICKS')) return 'traffic';
  if (u.includes('ENGAGE')) return 'engagement';
  if (u.includes('VIDEO')) return 'video_views';
  // Meta's current ODAX objective is OUTCOME_APP_PROMOTION. Older imports can
  // still carry APP_INSTALLS. Both are non-revenue app objectives; allowing
  // the modern value to fall through makes the dashboard's compatibility
  // fallback classify app spend as Sales and incorrectly mix it into ROAS.
  if (u.includes('APP_INSTALL') || u.includes('APP_PROMOTION')) {
    return 'app_installs';
  }
  if (u.includes('MESSAGES')) return 'messages';
  return undefined;
}

// ─── Objective-aware KPI grading ────────────────────────────────────────────

/**
 * Which objectives are scored on revenue. Everything else produces results
 * that are real but carry no tracked purchase — clicks, impressions, app
 * events — and must never be graded on ROAS or purchase counts.
 */
const REVENUE_OBJECTIVES: ObjectiveKey[] = ['sales', 'catalog_sales', 'retargeting'];

export function isRevenueObjective(k: ObjectiveKey): boolean {
  return REVENUE_OBJECTIVES.includes(k);
}

export type ScoredMetric = 'roas' | 'cpm' | 'cpc' | 'ctr' | 'cvr';

/**
 * The metric an objective is actually judged on.
 *
 * Awareness is a deliberate substitution: its profile names `reach` as
 * primaryKPI but defines thresholds only for cpm/frequency, and a raw reach
 * count cannot be graded without a target — so CPM (the efficiency of that
 * reach) is what carries the verdict.
 */
export function scoredMetricFor(k: ObjectiveKey): {
  metric: ScoredMetric;
  label: string;
  lowerIsBetter: boolean;
} {
  switch (k) {
    case 'awareness':
    case 'video_views':
      return { metric: 'cpm', label: 'Cost per 1,000 views', lowerIsBetter: true };
    case 'traffic':
    case 'app_installs':
      return { metric: 'cpc', label: 'Cost per click', lowerIsBetter: true };
    case 'engagement':
      return { metric: 'ctr', label: 'Click-through rate', lowerIsBetter: false };
    case 'leads':
    case 'messages':
      return { metric: 'cvr', label: 'Conversion rate', lowerIsBetter: false };
    default:
      return { metric: 'roas', label: 'Return on ad spend', lowerIsBetter: false };
  }
}

/** Raw inputs for grading. Rates are Meta's convention: ctr 0.95 means 0.95%. */
export interface ObjectiveMetricInput {
  spend: number;
  revenue?: number;
  purchases?: number;
  conversions?: number;
  clicks: number;
  impressions: number;
}

/**
 * The countable "result" for an objective — the analogue of a purchase.
 *
 * Used by lifecycle to decide whether a campaign has produced ENOUGH of
 * whatever it was asked for to be classified at all. Keyed off the objective
 * because a traffic campaign with 12,796 clicks and zero purchases has
 * produced a great deal; counting only purchases records it as having done
 * nothing.
 */
export function resultsFor(k: ObjectiveKey, m: ObjectiveMetricInput): number {
  switch (k) {
    case 'awareness':
    case 'video_views':
      return num(m.impressions);
    case 'traffic':
    case 'engagement':
    case 'app_installs':
      return num(m.clicks);
    case 'leads':
    case 'messages':
      return num(m.conversions ?? m.purchases);
    default:
      return num(m.purchases ?? m.conversions);
  }
}

export function computeObjectiveMetric(
  metric: ScoredMetric,
  m: ObjectiveMetricInput,
): number {
  const spend = num(m.spend);
  switch (metric) {
    case 'roas':
      return spend > 0 ? num(m.revenue) / spend : 0;
    case 'cpm':
      return num(m.impressions) > 0 ? (spend / num(m.impressions)) * 1000 : 0;
    case 'cpc':
      return num(m.clicks) > 0 ? spend / num(m.clicks) : 0;
    // Percentage-point convention, matching Meta's own `ctr` field.
    case 'ctr':
      return num(m.impressions) > 0 ? (num(m.clicks) / num(m.impressions)) * 100 : 0;
    case 'cvr':
      return num(m.clicks) > 0 ? (num(m.conversions ?? m.purchases) / num(m.clicks)) * 100 : 0;
  }
}

export interface KpiGrade {
  metric: ScoredMetric;
  label: string;
  value: number;
  healthy: number | null;
  warning: number | null;
  lowerIsBetter: boolean;
  status: 'good' | 'watch' | 'bad' | 'unknown';
}

/**
 * Grade an objective's own KPI against its own profile thresholds.
 *
 * Unit note: profile thresholds store ctr/cvr as FRACTIONS (0.015 = 1.5%)
 * while Meta reports them as percentage points. The x100 conversion happens
 * here, once — doing it at each call site is how a 1.4% CTR ends up compared
 * against 0.015 and read as 90x its target.
 */
export function gradeObjectiveKpi(
  k: ObjectiveKey,
  m: ObjectiveMetricInput,
): KpiGrade {
  const spec = scoredMetricFor(k);
  const value = computeObjectiveMetric(spec.metric, m);
  const profile = getProfile(k);
  const th = profile.thresholds as unknown as Record<string, Record<string, number>>;

  const isRate = spec.metric === 'ctr' || spec.metric === 'cvr';
  const scale = isRate ? 100 : 1;
  const rawHealthy = th.healthy?.[spec.metric];
  const rawWarning = th.warning?.[spec.metric];
  const healthy = rawHealthy != null ? rawHealthy * scale : null;
  const warning = rawWarning != null ? rawWarning * scale : null;

  let status: KpiGrade['status'] = 'unknown';
  if (healthy != null) {
    if (spec.lowerIsBetter) {
      status = value <= healthy ? 'good' : warning != null && value <= warning ? 'watch' : 'bad';
    } else {
      status = value >= healthy ? 'good' : warning != null && value >= warning ? 'watch' : 'bad';
    }
  }

  return {
    metric: spec.metric,
    label: spec.label,
    value,
    healthy,
    warning,
    lowerIsBetter: spec.lowerIsBetter,
    status,
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
