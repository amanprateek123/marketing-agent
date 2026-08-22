import { ObjectiveKey } from '../intelligence/orchestrator/decision-context';
import {
  ObjectiveProfile,
  getProfile,
  mapMetaObjective,
} from '../intelligence/objective/kpi-profiles';
import { Economics, round, weightedROAS } from '../common/economics/economics';

/**
 * Judge every campaign against the goal it was actually given.
 *
 * A Meta campaign optimising for REACH has no purchase pixel expectation, so
 * scoring it on ROAS reports "spending, zero sales — check your tracking" for
 * a campaign that is doing exactly what it was told to do. This account runs
 * six different objectives at once — 228 sales, 139 app-promotion, 67 leads,
 * 17 traffic, 12 engagement, 4 awareness — so a single purchase-ROAS verdict
 * is wrong for nearly half the portfolio. The app campaigns are the starkest
 * case: they report 15,000+ "conversions" that are in-app events carrying no
 * revenue, which a ROAS lens renders as a total loss.
 *
 * Thresholds are NOT reinvented here — they come from the same
 * intelligence/objective/kpi-profiles registry the decision engine uses, so
 * the dashboard and the optimiser cannot disagree about what "healthy" means.
 */

export type ObjectiveVerdict =
  // Revenue objectives — judged on contribution against breakeven.
  | 'profitable'
  | 'marginal'
  | 'below_breakeven'
  | 'losing_badly'
  | 'no_conversions'
  // Non-revenue objectives — judged on their own primary KPI.
  | 'on_target'
  | 'acceptable'
  | 'underperforming'
  | 'failing'
  // Shared
  | 'attribution_pending'
  | 'no_spend';

export const OBJECTIVE_LABELS: Record<ObjectiveKey, string> = {
  sales: 'Sales',
  catalog_sales: 'Catalog sales',
  retargeting: 'Retargeting sales',
  leads: 'Leads',
  awareness: 'Awareness',
  traffic: 'Traffic',
  engagement: 'Engagement',
  video_views: 'Video views',
  app_installs: 'App promotion',
  messages: 'Messages',
};

/**
 * Objectives where revenue is the point and breakeven ROAS applies.
 *
 * Everything else can still HAPPEN to produce revenue, and that revenue is
 * still reported — it just isn't the yardstick, because no one asked those
 * campaigns for it.
 */
const REVENUE_OBJECTIVES: ObjectiveKey[] = [
  'sales',
  'catalog_sales',
  'retargeting',
];

export function isRevenueObjective(key: ObjectiveKey): boolean {
  return REVENUE_OBJECTIVES.includes(key);
}

/** Metrics an evaluation needs. All rates as PERCENTAGES (1.43 = 1.43%). */
export interface ObjectiveMetrics {
  spend: number;
  revenue: number;
  conversions: number;
  clicks: number;
  impressions: number;
  reach?: number;
  frequency?: number;
}

export type KpiDirection = 'higher_better' | 'lower_better';

export interface KpiReading {
  key: string;
  label: string;
  value: number;
  display: string;
  /** The "healthy" threshold from the objective's profile. */
  target: number | null;
  targetDisplay: string | null;
  direction: KpiDirection;
  status: 'good' | 'watch' | 'bad' | 'neutral';
}

export interface ObjectiveEvaluation {
  objectiveRaw: string;
  objectiveKey: ObjectiveKey;
  objectiveLabel: string;
  isRevenueObjective: boolean;
  /** The KPI this campaign is actually judged on. */
  primaryKpi: KpiReading;
  /** Cost per result — informational for non-revenue objectives. */
  costPerResult: number | null;
  costPerResultDisplay: string | null;
  verdict: ObjectiveVerdict;
  verdictLabel: string;
  severity: 'good' | 'watch' | 'bad' | 'neutral';
  nextAction: string | null;
}

const VERDICT_LABELS: Record<ObjectiveVerdict, string> = {
  profitable: 'Making money',
  marginal: 'Above breakeven, below target',
  below_breakeven: 'Losing money',
  losing_badly: 'Losing money fast',
  no_conversions: 'Spending, zero sales',
  on_target: 'Hitting its goal',
  acceptable: 'Doing OK',
  underperforming: 'Below its goal',
  failing: 'Failing its goal',
  attribution_pending: 'Too early to judge',
  no_spend: 'Not spending yet',
};

export function evaluateObjective(opts: {
  objectiveRaw: string | undefined | null;
  metrics: ObjectiveMetrics;
  econ: Economics;
  ageHours: number | null;
  status: string;
  attributionGraceHours?: number;
  minSpendToJudge?: number;
}): ObjectiveEvaluation {
  const {
    objectiveRaw,
    metrics,
    econ,
    ageHours,
    status,
    attributionGraceHours = 72,
    minSpendToJudge = 500,
  } = opts;

  const objectiveKey = mapMetaObjective(objectiveRaw ?? undefined) ?? 'sales';
  const profile = getProfile(objectiveKey);
  const revenueObjective = isRevenueObjective(objectiveKey);
  const label = OBJECTIVE_LABELS[objectiveKey] ?? objectiveKey;

  const costPerResult =
    metrics.conversions > 0 ? metrics.spend / metrics.conversions : null;

  const base = {
    objectiveRaw: objectiveRaw ?? '',
    objectiveKey,
    objectiveLabel: label,
    isRevenueObjective: revenueObjective,
    costPerResult: costPerResult != null ? round(costPerResult, 2) : null,
    costPerResultDisplay:
      costPerResult != null
        ? `₹${Math.round(costPerResult).toLocaleString('en-IN')}`
        : null,
  };

  // Nothing has happened yet.
  if (metrics.spend <= 0) {
    return {
      ...base,
      primaryKpi: neutralKpi(profile, objectiveKey, metrics, econ),
      verdict: 'no_spend',
      verdictLabel: VERDICT_LABELS.no_spend,
      severity: 'neutral',
      nextAction: null,
    };
  }

  const tooNew =
    (ageHours != null && ageHours < attributionGraceHours) ||
    metrics.spend < minSpendToJudge;

  // ── Revenue objectives: unchanged breakeven economics ──────────────────
  if (revenueObjective) {
    const roas = weightedROAS(metrics.spend, metrics.revenue);
    const kpi: KpiReading = {
      key: 'roas',
      label: 'Return on ad spend',
      value: round(roas, 3),
      display: `${roas.toFixed(2)}x`,
      target: econ.targetROAS,
      targetDisplay: `${econ.targetROAS.toFixed(2)}x target · ${econ.breakevenROAS.toFixed(2)}x breakeven`,
      direction: 'higher_better',
      status:
        roas >= econ.targetROAS
          ? 'good'
          : roas >= econ.breakevenROAS
            ? 'watch'
            : 'bad',
    };

    let verdict: ObjectiveVerdict;
    if (metrics.revenue <= 0) {
      verdict = tooNew ? 'attribution_pending' : 'no_conversions';
    } else if (roas >= econ.targetROAS) verdict = 'profitable';
    else if (roas >= econ.breakevenROAS) verdict = 'marginal';
    else if (roas < econ.breakevenROAS / 2) verdict = 'losing_badly';
    else verdict = 'below_breakeven';

    return {
      ...base,
      primaryKpi: kpi,
      verdict,
      verdictLabel: VERDICT_LABELS[verdict],
      severity: revenueSeverity(verdict),
      nextAction: revenueAction(status, verdict, econ),
    };
  }

  // ── Non-revenue objectives: judged on the profile's own KPI ────────────
  const kpi = buildKpi(profile, objectiveKey, metrics);

  if (tooNew) {
    return {
      ...base,
      primaryKpi: kpi,
      verdict: 'attribution_pending',
      verdictLabel: VERDICT_LABELS.attribution_pending,
      severity: 'neutral',
      nextAction: null,
    };
  }

  const verdict = kpiToVerdict(kpi);
  return {
    ...base,
    primaryKpi: kpi,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    severity: kpi.status,
    nextAction: nonRevenueAction(status, verdict, kpi, label),
  };
}

// ─── KPI construction ────────────────────────────────────────────────────

/**
 * Which metric each objective is scored on.
 *
 * Follows the profile's own `primaryKPI` wherever that metric has thresholds
 * defined. Awareness is the one deliberate substitution: its profile names
 * `reach` as primary but defines thresholds only for cpm/frequency, and a raw
 * reach count cannot be judged without a target — so CPM (efficiency of that
 * reach) is what actually gets a verdict, with reach reported as volume.
 */
function scoredMetricFor(key: ObjectiveKey): {
  metric: 'cpm' | 'cpc' | 'ctr' | 'cvr';
  label: string;
  direction: KpiDirection;
} {
  switch (key) {
    case 'awareness':
    case 'video_views':
      return {
        metric: 'cpm',
        label: 'Cost per 1,000 views',
        direction: 'lower_better',
      };
    case 'traffic':
    case 'app_installs':
      return {
        metric: 'cpc',
        label: 'Cost per click',
        direction: 'lower_better',
      };
    case 'engagement':
      return {
        metric: 'ctr',
        label: 'Click-through rate',
        direction: 'higher_better',
      };
    case 'leads':
    case 'messages':
      return {
        metric: 'cvr',
        label: 'Conversion rate',
        direction: 'higher_better',
      };
    default:
      return {
        metric: 'cvr',
        label: 'Conversion rate',
        direction: 'higher_better',
      };
  }
}

function buildKpi(
  profile: ObjectiveProfile,
  key: ObjectiveKey,
  m: ObjectiveMetrics,
): KpiReading {
  const spec = scoredMetricFor(key);
  const value = computeMetric(spec.metric, m);
  const available = metricIsAvailable(spec.metric, m);

  // Profile thresholds store rates as FRACTIONS (0.015 = 1.5%) while the
  // dashboard carries them as percentages — convert before comparing or a
  // 1.4% CTR reads as 140x its target.
  const isRate = spec.metric === 'ctr' || spec.metric === 'cvr';
  const scale = isRate ? 100 : 1;
  const th = profile.thresholds as Record<string, Record<string, number>>;
  const healthy = th.healthy?.[spec.metric];
  const warning = th.warning?.[spec.metric];

  const target = healthy != null ? round(healthy * scale, 3) : null;
  const warn = warning != null ? warning * scale : null;

  let status: KpiReading['status'] = 'neutral';
  if (available && target != null) {
    if (spec.direction === 'lower_better') {
      status =
        value <= target
          ? 'good'
          : warn != null && value <= warn
            ? 'watch'
            : 'bad';
    } else {
      status =
        value >= target
          ? 'good'
          : warn != null && value >= warn
            ? 'watch'
            : 'bad';
    }
  }

  return {
    key: spec.metric,
    label: spec.label,
    value: round(value, 3),
    display: available ? formatMetric(spec.metric, value) : '—',
    target,
    targetDisplay:
      target != null
        ? `${spec.direction === 'lower_better' ? 'under ' : 'over '}${formatMetric(spec.metric, target)}`
        : null,
    direction: spec.direction,
    status,
  };
}

function metricIsAvailable(metric: string, m: ObjectiveMetrics): boolean {
  switch (metric) {
    case 'cpm':
    case 'ctr':
      return m.impressions > 0;
    case 'cpc':
    case 'cvr':
      return m.clicks > 0;
    default:
      return false;
  }
}

function neutralKpi(
  profile: ObjectiveProfile,
  key: ObjectiveKey,
  m: ObjectiveMetrics,
  econ: Economics,
): KpiReading {
  if (isRevenueObjective(key)) {
    return {
      key: 'roas',
      label: 'Return on ad spend',
      value: 0,
      display: '—',
      target: econ.targetROAS,
      targetDisplay: `${econ.targetROAS.toFixed(2)}x target`,
      direction: 'higher_better',
      status: 'neutral',
    };
  }
  return { ...buildKpi(profile, key, m), status: 'neutral', display: '—' };
}

function computeMetric(metric: string, m: ObjectiveMetrics): number {
  switch (metric) {
    case 'cpm':
      return m.impressions > 0 ? (m.spend / m.impressions) * 1000 : 0;
    case 'cpc':
      return m.clicks > 0 ? m.spend / m.clicks : 0;
    case 'ctr':
      return m.impressions > 0 ? (m.clicks / m.impressions) * 100 : 0;
    case 'cvr':
      return m.clicks > 0 ? (m.conversions / m.clicks) * 100 : 0;
    default:
      return 0;
  }
}

function formatMetric(metric: string, value: number): string {
  if (metric === 'ctr' || metric === 'cvr') return `${value.toFixed(2)}%`;
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

function kpiToVerdict(kpi: KpiReading): ObjectiveVerdict {
  if (kpi.status === 'good') return 'on_target';
  if (kpi.status === 'watch') return 'acceptable';
  if (kpi.status === 'bad') {
    // "Failing" is reserved for a KPI at least 2x the wrong side of target,
    // so an ordinary miss doesn't read with the same urgency as a collapse.
    if (kpi.target != null && kpi.target > 0) {
      const ratio =
        kpi.direction === 'lower_better'
          ? kpi.value / kpi.target
          : kpi.target / Math.max(kpi.value, 0.0001);
      if (ratio >= 2) return 'failing';
    }
    return 'underperforming';
  }
  return 'attribution_pending';
}

function revenueSeverity(
  v: ObjectiveVerdict,
): 'good' | 'watch' | 'bad' | 'neutral' {
  switch (v) {
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

function revenueAction(
  status: string,
  verdict: ObjectiveVerdict,
  econ: Economics,
): string | null {
  if (status === 'pending_approval') return 'Review and approve';
  if (status !== 'active') {
    if (verdict === 'profitable')
      return 'Rebuild this structure — it beat target';
    if (verdict === 'losing_badly' || verdict === 'no_conversions') {
      return "Don't rebuild this audience/offer combination";
    }
    return null;
  }
  switch (verdict) {
    case 'profitable':
      return 'Scale budget while it holds above target';
    case 'marginal':
      return `Push toward ${econ.targetROAS.toFixed(2)}x before scaling`;
    case 'below_breakeven':
      return 'Cut spend or fix the landing page';
    case 'losing_badly':
      return 'Pause now — every rupee is destroying value';
    case 'no_conversions':
      return 'Check pixel/tracking, then pause if genuinely zero';
    default:
      return null;
  }
}

function nonRevenueAction(
  status: string,
  verdict: ObjectiveVerdict,
  kpi: KpiReading,
  objectiveLabel: string,
): string | null {
  if (status === 'pending_approval') return 'Review and approve';
  if (status !== 'active') {
    return verdict === 'on_target'
      ? `Rebuild this — it beat its ${objectiveLabel.toLowerCase()} goal`
      : null;
  }
  switch (verdict) {
    case 'on_target':
      return `Scale it — ${kpi.label.toLowerCase()} is beating target`;
    case 'acceptable':
      return `Refresh creative to push ${kpi.label.toLowerCase()} to ${kpi.targetDisplay ?? 'target'}`;
    case 'underperforming':
      return `${kpi.label} is ${kpi.display} vs ${kpi.targetDisplay ?? 'target'} — refresh creative or narrow audience`;
    case 'failing':
      return `Pause — ${kpi.label.toLowerCase()} is far off target`;
    default:
      return null;
  }
}
