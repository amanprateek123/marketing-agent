/**
 * Persisted fields that may be used as exact Meta optimization-goal evidence.
 *
 * These names intentionally match Campaign.metaAdSets. Callers must not alias
 * a broader metric (for example `clicks`) when the selected goal's narrower
 * field (`inlineLinkClicks`) is absent.
 */
export type PersistedOptimizationMetricKey =
  | 'spend'
  | 'revenue'
  | 'conversions'
  | 'reach'
  | 'impressions'
  | 'landingPageView'
  | 'inlineLinkClicks'
  | 'thruplay';

export type OptimizationEvidenceMetricKey =
  | 'rawRoas'
  | Exclude<PersistedOptimizationMetricKey, 'spend'>;

export type OptimizationEvidenceUnit =
  | 'x'
  | 'conversions'
  | 'people'
  | 'impressions'
  | 'views'
  | 'clicks'
  | 'plays';

export type OptimizationEvidenceKind =
  | 'sales_value'
  | 'sales_conversion'
  | 'awareness'
  | 'traffic'
  | 'video';

export type NormalizedEvidenceObjective =
  | 'sales'
  | 'awareness'
  | 'traffic'
  | 'engagement'
  | 'video_views';

export type MetricAvailabilityRule = 'finite_positive' | 'finite_non_negative';

export interface OptimizationMetricRequirement {
  key: PersistedOptimizationMetricKey;
  rule: MetricAvailabilityRule;
  description: string;
}

export interface OptimizationGoalEvidenceSpec {
  normalizedObjective: NormalizedEvidenceObjective;
  objectiveLabel: string;
  optimizationGoal: string;
  evidenceKind: OptimizationEvidenceKind;
  /** Displayed metric. `rawRoas` is derived only from revenue / spend. */
  metricKey: OptimizationEvidenceMetricKey;
  /** Exact persisted keys allowed to establish the displayed metric. */
  sourceMetricKeys: readonly PersistedOptimizationMetricKey[];
  label: string;
  unit: OptimizationEvidenceUnit;
  lowerIsBetter: boolean;
  requirements: readonly OptimizationMetricRequirement[];
}

export type UnsupportedOptimizationGoalEvidenceCode =
  | 'missing_optimization_goal'
  | 'mixed_optimization_goals'
  | 'unsupported_optimization_goal'
  | 'unsupported_objective'
  | 'objective_goal_mismatch';

export type OptimizationGoalEvidenceResolution =
  | {
      supported: true;
      code: 'supported';
      optimizationGoals: [string];
      spec: OptimizationGoalEvidenceSpec;
      unsupportedReason: null;
    }
  | {
      supported: false;
      code: UnsupportedOptimizationGoalEvidenceCode;
      optimizationGoals: string[];
      spec: null;
      unsupportedReason: string;
    };

export type OptimizationGoalEvidenceSelection =
  | {
      status: 'available';
      supported: true;
      available: true;
      code: 'available';
      spec: OptimizationGoalEvidenceSpec;
      value: number;
      sourceValues: Partial<Record<PersistedOptimizationMetricKey, number>>;
      missingMetricKeys: [];
      reason: null;
      unsupportedReason: null;
    }
  | {
      status: 'unavailable';
      supported: true;
      available: false;
      code: 'metric_unavailable';
      spec: OptimizationGoalEvidenceSpec;
      value: null;
      sourceValues: Partial<Record<PersistedOptimizationMetricKey, number>>;
      missingMetricKeys: PersistedOptimizationMetricKey[];
      reason: string;
      unsupportedReason: null;
    }
  | {
      status: 'unsupported';
      supported: false;
      available: false;
      code: UnsupportedOptimizationGoalEvidenceCode;
      spec: null;
      value: null;
      sourceValues: Record<string, never>;
      missingMetricKeys: [];
      reason: string;
      unsupportedReason: string;
    };

export interface OptimizationGoalEvidenceInput {
  objective?: string | null;
  /** One value per ad set. Repeated identical values are not considered mixed. */
  optimizationGoals: readonly (string | null | undefined)[];
}

export interface SelectOptimizationGoalEvidenceInput extends OptimizationGoalEvidenceInput {
  metrics?: Readonly<Record<string, unknown>> | null;
}

/**
 * Resolve the one trustworthy persisted result metric for an ad-set goal.
 * Unknown, incomplete, mixed, and objective-incompatible inputs fail closed.
 */
export function resolveOptimizationGoalEvidenceSpec(
  input: OptimizationGoalEvidenceInput,
): OptimizationGoalEvidenceResolution {
  const normalizedGoals = normalizeOptimizationGoals(input.optimizationGoals);
  if (!normalizedGoals.ok) {
    return normalizedGoals.result;
  }

  const [optimizationGoal] = normalizedGoals.goals;
  const normalizedObjective = normalizeObjective(input.objective);
  if (!normalizedObjective) {
    const supplied = cleanString(input.objective);
    return unsupported(
      'unsupported_objective',
      [optimizationGoal],
      supplied
        ? `Objective "${supplied}" is not supported for optimization-goal evidence.`
        : 'A recognized campaign objective is required for optimization-goal evidence.',
    );
  }

  const spec = specFor(optimizationGoal, normalizedObjective);
  if (spec) {
    return {
      supported: true,
      code: 'supported',
      optimizationGoals: [optimizationGoal],
      spec,
      unsupportedReason: null,
    };
  }

  if (!SUPPORTED_GOALS.has(optimizationGoal)) {
    return unsupported(
      'unsupported_optimization_goal',
      [optimizationGoal],
      `Optimization goal "${optimizationGoal}" has no trustworthy persisted evidence mapping.`,
    );
  }

  return unsupported(
    'objective_goal_mismatch',
    [optimizationGoal],
    `Optimization goal "${optimizationGoal}" is not valid evidence for objective "${cleanString(input.objective) ?? normalizedObjective}".`,
  );
}

/**
 * Select an observed value without coercion or a zero fallback. A present
 * numeric zero is evidence; an absent, string, negative, NaN, or infinite
 * field is unavailable. VALUE additionally requires positive spend because
 * raw ROAS is undefined at zero spend.
 */
export function selectOptimizationGoalEvidence(
  input: SelectOptimizationGoalEvidenceInput,
): OptimizationGoalEvidenceSelection {
  const resolution = resolveOptimizationGoalEvidenceSpec(input);
  if (!resolution.supported) {
    return {
      status: 'unsupported',
      supported: false,
      available: false,
      code: resolution.code,
      spec: null,
      value: null,
      sourceValues: {},
      missingMetricKeys: [],
      reason: resolution.unsupportedReason,
      unsupportedReason: resolution.unsupportedReason,
    };
  }

  const sourceValues: Partial<Record<PersistedOptimizationMetricKey, number>> =
    {};
  const missingMetricKeys: PersistedOptimizationMetricKey[] = [];
  for (const requirement of resolution.spec.requirements) {
    const value = ownFiniteNumber(input.metrics, requirement.key);
    const meetsRule =
      value !== null &&
      (requirement.rule === 'finite_positive' ? value > 0 : value >= 0);
    if (!meetsRule) {
      missingMetricKeys.push(requirement.key);
      continue;
    }
    sourceValues[requirement.key] = value;
  }

  if (missingMetricKeys.length > 0) {
    const descriptions = resolution.spec.requirements
      .filter((requirement) => missingMetricKeys.includes(requirement.key))
      .map((requirement) => requirement.description);
    return {
      status: 'unavailable',
      supported: true,
      available: false,
      code: 'metric_unavailable',
      spec: resolution.spec,
      value: null,
      sourceValues,
      missingMetricKeys,
      reason: `${resolution.spec.label} is unavailable: ${descriptions.join('; ')}.`,
      unsupportedReason: null,
    };
  }

  const value = computeValue(resolution.spec, sourceValues);
  if (value === null) {
    return {
      status: 'unavailable',
      supported: true,
      available: false,
      code: 'metric_unavailable',
      spec: resolution.spec,
      value: null,
      sourceValues,
      missingMetricKeys: [...resolution.spec.sourceMetricKeys],
      reason: `${resolution.spec.label} is unavailable because its persisted inputs could not be evaluated.`,
      unsupportedReason: null,
    };
  }

  return {
    status: 'available',
    supported: true,
    available: true,
    code: 'available',
    spec: resolution.spec,
    value,
    sourceValues,
    missingMetricKeys: [],
    reason: null,
    unsupportedReason: null,
  };
}

const SUPPORTED_GOALS = new Set([
  'VALUE',
  'OFFSITE_CONVERSIONS',
  'REACH',
  'IMPRESSIONS',
  'LANDING_PAGE_VIEWS',
  'LINK_CLICKS',
  'THRUPLAY',
]);

function specFor(
  optimizationGoal: string,
  objective: NormalizedEvidenceObjective,
): OptimizationGoalEvidenceSpec | null {
  switch (optimizationGoal) {
    case 'VALUE':
      return objective === 'sales'
        ? makeSpec({
            normalizedObjective: objective,
            objectiveLabel: 'Sales value',
            optimizationGoal,
            evidenceKind: 'sales_value',
            metricKey: 'rawRoas',
            sourceMetricKeys: ['spend', 'revenue'],
            label: 'Raw ROAS',
            unit: 'x',
            lowerIsBetter: false,
            requirements: [
              requirement('spend', 'finite_positive'),
              requirement('revenue', 'finite_non_negative'),
            ],
          })
        : null;
    case 'OFFSITE_CONVERSIONS':
      return objective === 'sales'
        ? makeSpec({
            normalizedObjective: objective,
            objectiveLabel: 'Sales',
            optimizationGoal,
            evidenceKind: 'sales_conversion',
            metricKey: 'conversions',
            sourceMetricKeys: ['conversions'],
            label: 'Attributed sales conversions',
            unit: 'conversions',
            lowerIsBetter: false,
            requirements: [requirement('conversions', 'finite_non_negative')],
          })
        : null;
    case 'REACH':
      return objective === 'awareness'
        ? makeSpec({
            normalizedObjective: objective,
            objectiveLabel: 'Awareness',
            optimizationGoal,
            evidenceKind: 'awareness',
            metricKey: 'reach',
            sourceMetricKeys: ['reach'],
            label: 'People reached',
            unit: 'people',
            lowerIsBetter: false,
            requirements: [requirement('reach', 'finite_non_negative')],
          })
        : null;
    case 'IMPRESSIONS':
      return objective === 'awareness'
        ? makeSpec({
            normalizedObjective: objective,
            objectiveLabel: 'Awareness',
            optimizationGoal,
            evidenceKind: 'awareness',
            metricKey: 'impressions',
            sourceMetricKeys: ['impressions'],
            label: 'Impressions',
            unit: 'impressions',
            lowerIsBetter: false,
            requirements: [requirement('impressions', 'finite_non_negative')],
          })
        : null;
    case 'LANDING_PAGE_VIEWS':
      return objective === 'traffic'
        ? makeSpec({
            normalizedObjective: objective,
            objectiveLabel: 'Traffic',
            optimizationGoal,
            evidenceKind: 'traffic',
            metricKey: 'landingPageView',
            sourceMetricKeys: ['landingPageView'],
            label: 'Landing-page views',
            unit: 'views',
            lowerIsBetter: false,
            requirements: [
              requirement('landingPageView', 'finite_non_negative'),
            ],
          })
        : null;
    case 'LINK_CLICKS':
      return objective === 'traffic'
        ? makeSpec({
            normalizedObjective: objective,
            objectiveLabel: 'Traffic',
            optimizationGoal,
            evidenceKind: 'traffic',
            metricKey: 'inlineLinkClicks',
            sourceMetricKeys: ['inlineLinkClicks'],
            label: 'Inline link clicks',
            unit: 'clicks',
            lowerIsBetter: false,
            requirements: [
              requirement('inlineLinkClicks', 'finite_non_negative'),
            ],
          })
        : null;
    case 'THRUPLAY':
      return objective === 'engagement' || objective === 'video_views'
        ? makeSpec({
            normalizedObjective: objective,
            // Current ODAX reports video-view campaigns as OUTCOME_ENGAGEMENT.
            objectiveLabel: 'Video views',
            optimizationGoal,
            evidenceKind: 'video',
            metricKey: 'thruplay',
            sourceMetricKeys: ['thruplay'],
            label: 'ThruPlays',
            unit: 'plays',
            lowerIsBetter: false,
            requirements: [requirement('thruplay', 'finite_non_negative')],
          })
        : null;
    default:
      return null;
  }
}

function makeSpec(
  spec: OptimizationGoalEvidenceSpec,
): OptimizationGoalEvidenceSpec {
  return spec;
}

function requirement(
  key: PersistedOptimizationMetricKey,
  rule: MetricAvailabilityRule,
): OptimizationMetricRequirement {
  return {
    key,
    rule,
    description:
      rule === 'finite_positive'
        ? `persisted ${key} must be a finite number greater than zero`
        : `persisted ${key} must be a finite, non-negative number`,
  };
}

function normalizeOptimizationGoals(
  input: readonly (string | null | undefined)[],
):
  | { ok: true; goals: [string] }
  | { ok: false; result: OptimizationGoalEvidenceResolution } {
  if (input.length === 0) {
    return {
      ok: false,
      result: unsupported(
        'missing_optimization_goal',
        [],
        'At least one ad-set optimization goal is required.',
      ),
    };
  }

  const normalized: string[] = [];
  for (const raw of input) {
    const value = cleanString(raw)?.toUpperCase();
    if (!value) {
      return {
        ok: false,
        result: unsupported(
          'missing_optimization_goal',
          [...new Set(normalized)].sort(),
          'Every ad set must have a persisted optimization goal.',
        ),
      };
    }
    normalized.push(value);
  }

  const unique = [...new Set(normalized)].sort();
  if (unique.length !== 1) {
    return {
      ok: false,
      result: unsupported(
        'mixed_optimization_goals',
        unique,
        `Ad sets use mixed optimization goals (${unique.join(', ')}); one metric cannot represent them safely.`,
      ),
    };
  }
  return { ok: true, goals: [unique[0]] };
}

function normalizeObjective(
  raw: string | null | undefined,
): NormalizedEvidenceObjective | null {
  const value = cleanString(raw)?.toUpperCase();
  if (!value) return null;
  switch (value) {
    case 'OUTCOME_SALES':
    case 'SALES':
    case 'CONVERSIONS':
    case 'CATALOG_SALES':
    case 'PRODUCT_CATALOG_SALES':
    case 'RETARGETING':
      return 'sales';
    case 'OUTCOME_AWARENESS':
    case 'AWARENESS':
    case 'BRAND_AWARENESS':
      return 'awareness';
    case 'OUTCOME_TRAFFIC':
    case 'TRAFFIC':
      return 'traffic';
    case 'OUTCOME_ENGAGEMENT':
    case 'ENGAGEMENT':
      return 'engagement';
    case 'VIDEO_VIEWS':
    case 'OUTCOME_VIDEO_VIEWS':
      return 'video_views';
    default:
      return null;
  }
}

function ownFiniteNumber(
  metrics: Readonly<Record<string, unknown>> | null | undefined,
  key: PersistedOptimizationMetricKey,
): number | null {
  if (!metrics || !Object.prototype.hasOwnProperty.call(metrics, key)) {
    return null;
  }
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function computeValue(
  spec: OptimizationGoalEvidenceSpec,
  values: Partial<Record<PersistedOptimizationMetricKey, number>>,
): number | null {
  if (spec.metricKey === 'rawRoas') {
    const spend = values.spend;
    const revenue = values.revenue;
    if (spend === undefined || spend <= 0 || revenue === undefined) return null;
    const roas = revenue / spend;
    return Number.isFinite(roas) ? roas : null;
  }
  const value = values[spec.metricKey];
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function unsupported(
  code: UnsupportedOptimizationGoalEvidenceCode,
  optimizationGoals: string[],
  unsupportedReason: string,
): Extract<OptimizationGoalEvidenceResolution, { supported: false }> {
  return {
    supported: false,
    code,
    optimizationGoals,
    spec: null,
    unsupportedReason,
  };
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}
