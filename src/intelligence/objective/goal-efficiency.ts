import { isSourceMetricsFresh } from '../snapshot/snapshot-freshness';

/**
 * Action-grade, optimization-goal-specific peer evidence.
 *
 * This contract intentionally does not accept the broad `revenue`, `clicks`,
 * or `purchases` fields used elsewhere in the application. Callers have to
 * map a source row into the exact fields below and provide the provenance
 * that proves what Meta returned. Missing data therefore stays missing.
 */
export const GOAL_EFFICIENCY_VERSION = 'goal_efficiency_v1' as const;
export const GOAL_EFFICIENCY_GAP_MULTIPLE = 1.5;
export const GOAL_EFFICIENCY_MIN_ACTIVE_PEERS = 2;

export type SupportedMetaOptimizationGoal =
  | 'VALUE'
  | 'OFFSITE_CONVERSIONS'
  | 'REACH'
  | 'IMPRESSIONS'
  | 'LANDING_PAGE_VIEWS'
  | 'LINK_CLICKS'
  | 'THRUPLAY';

export type GoalEfficiencyEntityLevel = 'adset' | 'ad';

export type GoalEfficiencyResultMetricKey =
  | 'raw_meta_action_value'
  | 'exact_conversions'
  | 'reach'
  | 'impressions'
  | 'landing_page_views'
  | 'inline_link_clicks'
  | 'thruplays';

export type GoalEfficiencyMetricKey =
  | 'raw_roas'
  | 'cost_per_exact_conversion'
  | 'cost_per_thousand_people_reached'
  | 'cpm'
  | 'cost_per_landing_page_view'
  | 'cost_per_inline_link_click'
  | 'cost_per_thruplay';

export type GoalEfficiencyInputMetricKey =
  | 'spend'
  | 'rawMetaActionValue'
  | 'exactConversions'
  | 'reach'
  | 'impressions'
  | 'landingPageViews'
  | 'inlineLinkClicks'
  | 'thruplay';

export interface GoalEfficiencyMetrics {
  spend?: number;
  /** Exact Meta action_value before refund or configured-value transforms. */
  rawMetaActionValue?: number;
  /** Count restricted to the exact actionTypes declared in provenance. */
  exactConversions?: number;
  reach?: number;
  impressions?: number;
  landingPageViews?: number;
  inlineLinkClicks?: number;
  thruplay?: number;
}

export type TrustedGoalAttributionSource =
  | 'custom_conversion'
  | 'custom_event'
  | 'standard_event'
  | 'app_event';

export interface GoalEfficiencyAttributionIdentity {
  attributionSource: TrustedGoalAttributionSource | string;
  /** Stable identity of the configured event/product mapping used at sync. */
  conversionEventIdentity: string;
  /** Exact Meta action_type aliases included in the result. */
  actionTypes: readonly string[];
  /** Stable serialization/hash of the Meta attribution setting. */
  attributionSpecHash: string;
  /** VALUE is accepted only when this explicitly proves a Meta action value. */
  valueBasis?: 'meta_action_value' | string;
}

export interface GoalEfficiencyProvenance {
  rowObserved: boolean;
  responseComplete: boolean;
  dateStart: string;
  dateStop: string;
  metricScope: 'window' | 'lifetime' | string;
  metricsSyncedAt: Date | string;
  freshnessSec: number;
  source: 'meta_insights' | string;
  /** Identifies one source/query configuration shared by sibling rows. */
  sourceFingerprint: string;
  currency: string;
  attribution?: GoalEfficiencyAttributionIdentity | null;
}

export interface GoalEfficiencyRow {
  entityId: string;
  parentId: string;
  level: GoalEfficiencyEntityLevel;
  /** Exact effective Meta status. Only ACTIVE rows are comparison eligible. */
  effectiveStatus: string;
  objective: string;
  /** Exact Meta optimization goal; aliases and case variants are unsupported. */
  optimizationGoal: string;
  metrics: Readonly<GoalEfficiencyMetrics>;
  provenance: Readonly<GoalEfficiencyProvenance>;
}

export interface GoalEfficiencySpec {
  optimizationGoal: SupportedMetaOptimizationGoal;
  normalizedObjective: GoalEfficiencyObjective;
  resultMetric: {
    key: GoalEfficiencyResultMetricKey;
    label: string;
    unit: string;
  };
  efficiencyMetric: {
    key: GoalEfficiencyMetricKey;
    label: string;
    unit: string;
    lowerIsBetter: boolean;
  };
  evidenceFloor: {
    basis: 'exact_conversions' | 'primary_result';
    peerPoolMinimum: number;
    leaderTargetMinimum: number;
    laggardOpportunityMinimum: number;
  };
}

export interface GoalEfficiencyObservedValue {
  metric: GoalEfficiencyResultMetricKey;
  value: number;
  unit: string;
}

export interface GoalEfficiencyObservedEfficiency {
  metric: GoalEfficiencyMetricKey;
  /** Null only for an explicitly observed zero denominator result. */
  value: number | null;
  unit: string;
  lowerIsBetter: boolean;
}

export interface NormalizedGoalEfficiencyProvenance {
  rowObserved: true;
  responseComplete: true;
  dateStart: string;
  dateStop: string;
  metricScope: string;
  metricsSyncedAt: string;
  freshnessSec: number;
  source: string;
  sourceFingerprint: string;
  currency: string;
  attribution: {
    attributionSource: TrustedGoalAttributionSource;
    conversionEventIdentity: string;
    actionTypes: string[];
    attributionSpecHash: string;
    valueBasis: string | null;
  } | null;
}

export interface GoalEfficiencyMeasurement {
  version: typeof GOAL_EFFICIENCY_VERSION;
  entityId: string;
  parentId: string;
  level: GoalEfficiencyEntityLevel;
  effectiveStatus: string;
  spec: GoalEfficiencySpec;
  spend: number;
  result: GoalEfficiencyObservedValue;
  /** Exact conversion count used as VALUE's evidence floor. */
  supportingExactConversions: number | null;
  efficiency: GoalEfficiencyObservedEfficiency;
  provenance: NormalizedGoalEfficiencyProvenance;
  /** Canonical identity used to enforce like-for-like peer evidence. */
  comparisonIdentity: string;
}

export type GoalEfficiencyUnavailableCode =
  | 'missing_identity'
  | 'unsupported_optimization_goal'
  | 'unsupported_objective'
  | 'objective_goal_mismatch'
  | 'row_not_observed'
  | 'response_incomplete'
  | 'invalid_window'
  | 'invalid_metric_scope'
  | 'invalid_sync_provenance'
  | 'stale_source'
  | 'invalid_source_provenance'
  | 'invalid_currency'
  | 'missing_attribution_identity'
  | 'untrusted_attribution_source'
  | 'invalid_action_type_identity'
  | 'invalid_value_basis'
  | 'metric_missing'
  | 'metric_invalid';

export type GoalEfficiencyMeasurementResult =
  | {
      status: 'measured';
      measurement: GoalEfficiencyMeasurement;
      code: null;
      reason: null;
    }
  | {
      status: 'unavailable';
      measurement: null;
      code: GoalEfficiencyUnavailableCode;
      reason: string;
    };

export interface GoalEfficiencyComparisonCurrent {
  entityId: string;
  spend: number;
  result: GoalEfficiencyObservedValue;
  supportingExactConversions: number | null;
  efficiency: GoalEfficiencyObservedEfficiency;
}

export interface GoalEfficiencyComparisonBaseline {
  peerCount: number;
  peerIds: string[];
  pooledSpend: number;
  pooledResult: GoalEfficiencyObservedValue;
  pooledSupportingExactConversions: number | null;
  efficiency: GoalEfficiencyObservedEfficiency & { value: number };
}

export type GoalEfficiencyPeerExclusionCode =
  | 'target_row'
  | 'not_sibling'
  | 'not_active'
  | 'unavailable'
  | 'provenance_mismatch';

export interface GoalEfficiencyPeerExclusion {
  entityId: string;
  code: GoalEfficiencyPeerExclusionCode;
  detail: string;
}

export type GoalEfficiencyInsufficientCode =
  | 'target_unavailable'
  | 'target_not_active'
  | 'not_enough_eligible_peers'
  | 'peer_pool_below_evidence_floor'
  | 'pooled_efficiency_unavailable'
  | 'relative_gap_below_threshold'
  | 'target_below_evidence_floor';

interface GoalEfficiencyComparisonBase {
  version: typeof GOAL_EFFICIENCY_VERSION;
  claimScope: 'observational_same_window_peer_comparison';
  causalClaim: false;
  expectedUplift: null;
  current: GoalEfficiencyComparisonCurrent | null;
  baseline: GoalEfficiencyComparisonBaseline | null;
  excludedPeers: GoalEfficiencyPeerExclusion[];
  relativeGap: {
    thresholdMultiple: typeof GOAL_EFFICIENCY_GAP_MULTIPLE;
    observedMultiple: number | null;
    unbounded: boolean;
    direction: 'better' | 'worse' | 'within_threshold' | 'unknown';
  };
}

export type GoalEfficiencyComparison =
  | (GoalEfficiencyComparisonBase & {
      status: 'leader' | 'laggard';
      code: 'observed_relative_efficiency';
      reason: string;
    })
  | (GoalEfficiencyComparisonBase & {
      status: 'insufficient';
      code: GoalEfficiencyInsufficientCode;
      reason: string;
    });

export interface CompareGoalEfficiencyPeersInput {
  target: GoalEfficiencyRow;
  /** Candidate siblings; the function independently verifies every row. */
  siblings: readonly GoalEfficiencyRow[];
}

type GoalEfficiencyObjective =
  | 'sales'
  | 'awareness'
  | 'traffic'
  | 'engagement'
  | 'video_views';

interface InternalSpec extends GoalEfficiencySpec {
  inputResultKey: Exclude<GoalEfficiencyInputMetricKey, 'spend'>;
  resultScale: number;
  requiresAttribution: boolean;
  requiresRawMetaValue: boolean;
}

const TRUSTED_ATTRIBUTION_SOURCES = new Set<TrustedGoalAttributionSource>([
  'custom_conversion',
  'custom_event',
  'standard_event',
  'app_event',
]);

const SPECS: Readonly<
  Record<
    SupportedMetaOptimizationGoal,
    Omit<InternalSpec, 'normalizedObjective'>
  >
> = {
  VALUE: {
    optimizationGoal: 'VALUE',
    inputResultKey: 'rawMetaActionValue',
    resultScale: 1,
    resultMetric: {
      key: 'raw_meta_action_value',
      label: 'Raw Meta action value',
      unit: 'currency',
    },
    efficiencyMetric: {
      key: 'raw_roas',
      label: 'Raw ROAS',
      unit: 'x',
      lowerIsBetter: false,
    },
    evidenceFloor: {
      basis: 'exact_conversions',
      peerPoolMinimum: 10,
      leaderTargetMinimum: 5,
      laggardOpportunityMinimum: 5,
    },
    requiresAttribution: true,
    requiresRawMetaValue: true,
  },
  OFFSITE_CONVERSIONS: {
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    inputResultKey: 'exactConversions',
    resultScale: 1,
    resultMetric: {
      key: 'exact_conversions',
      label: 'Exact attributed conversions',
      unit: 'conversions',
    },
    efficiencyMetric: {
      key: 'cost_per_exact_conversion',
      label: 'Cost per exact attributed conversion',
      unit: 'currency',
      lowerIsBetter: true,
    },
    evidenceFloor: {
      basis: 'exact_conversions',
      peerPoolMinimum: 10,
      leaderTargetMinimum: 5,
      laggardOpportunityMinimum: 5,
    },
    requiresAttribution: true,
    requiresRawMetaValue: false,
  },
  REACH: {
    optimizationGoal: 'REACH',
    inputResultKey: 'reach',
    resultScale: 1000,
    resultMetric: { key: 'reach', label: 'People reached', unit: 'people' },
    efficiencyMetric: {
      key: 'cost_per_thousand_people_reached',
      label: 'Cost per 1,000 people reached',
      unit: 'currency',
      lowerIsBetter: true,
    },
    evidenceFloor: {
      basis: 'primary_result',
      peerPoolMinimum: 10_000,
      leaderTargetMinimum: 5_000,
      laggardOpportunityMinimum: 5_000,
    },
    requiresAttribution: false,
    requiresRawMetaValue: false,
  },
  IMPRESSIONS: {
    optimizationGoal: 'IMPRESSIONS',
    inputResultKey: 'impressions',
    resultScale: 1000,
    resultMetric: {
      key: 'impressions',
      label: 'Impressions',
      unit: 'impressions',
    },
    efficiencyMetric: {
      key: 'cpm',
      label: 'CPM',
      unit: 'currency',
      lowerIsBetter: true,
    },
    evidenceFloor: {
      basis: 'primary_result',
      peerPoolMinimum: 10_000,
      leaderTargetMinimum: 5_000,
      laggardOpportunityMinimum: 5_000,
    },
    requiresAttribution: false,
    requiresRawMetaValue: false,
  },
  LANDING_PAGE_VIEWS: {
    optimizationGoal: 'LANDING_PAGE_VIEWS',
    inputResultKey: 'landingPageViews',
    resultScale: 1,
    resultMetric: {
      key: 'landing_page_views',
      label: 'Landing-page views',
      unit: 'views',
    },
    efficiencyMetric: {
      key: 'cost_per_landing_page_view',
      label: 'Cost per landing-page view',
      unit: 'currency',
      lowerIsBetter: true,
    },
    evidenceFloor: {
      basis: 'primary_result',
      peerPoolMinimum: 100,
      leaderTargetMinimum: 30,
      laggardOpportunityMinimum: 30,
    },
    requiresAttribution: false,
    requiresRawMetaValue: false,
  },
  LINK_CLICKS: {
    optimizationGoal: 'LINK_CLICKS',
    inputResultKey: 'inlineLinkClicks',
    resultScale: 1,
    resultMetric: {
      key: 'inline_link_clicks',
      label: 'Inline link clicks',
      unit: 'clicks',
    },
    efficiencyMetric: {
      key: 'cost_per_inline_link_click',
      label: 'Cost per inline link click',
      unit: 'currency',
      lowerIsBetter: true,
    },
    evidenceFloor: {
      basis: 'primary_result',
      peerPoolMinimum: 100,
      leaderTargetMinimum: 30,
      laggardOpportunityMinimum: 30,
    },
    requiresAttribution: false,
    requiresRawMetaValue: false,
  },
  THRUPLAY: {
    optimizationGoal: 'THRUPLAY',
    inputResultKey: 'thruplay',
    resultScale: 1,
    resultMetric: {
      key: 'thruplays',
      label: 'ThruPlays',
      unit: 'plays',
    },
    efficiencyMetric: {
      key: 'cost_per_thruplay',
      label: 'Cost per ThruPlay',
      unit: 'currency',
      lowerIsBetter: true,
    },
    evidenceFloor: {
      basis: 'primary_result',
      peerPoolMinimum: 100,
      leaderTargetMinimum: 30,
      laggardOpportunityMinimum: 30,
    },
    requiresAttribution: false,
    requiresRawMetaValue: false,
  },
};

/** Measure one row. This preserves an explicit zero but never creates one. */
export function measureGoalEfficiency(
  row: GoalEfficiencyRow,
): GoalEfficiencyMeasurementResult {
  const entityId = nonEmpty(row.entityId);
  const parentId = nonEmpty(row.parentId);
  if (!entityId || !parentId || (row.level !== 'adset' && row.level !== 'ad')) {
    return unavailable(
      'missing_identity',
      'Entity id, parent id, and an exact adset/ad level are required.',
    );
  }

  const objective = normalizeObjective(row.objective);
  if (!objective) {
    return unavailable(
      'unsupported_objective',
      `Objective "${String(row.objective ?? '')}" is unsupported.`,
    );
  }

  if (!isSupportedGoal(row.optimizationGoal)) {
    return unavailable(
      'unsupported_optimization_goal',
      `Optimization goal "${String(row.optimizationGoal ?? '')}" is unsupported.`,
    );
  }

  if (!isObjectiveCompatible(objective, row.optimizationGoal)) {
    return unavailable(
      'objective_goal_mismatch',
      `${row.optimizationGoal} is not compatible with objective ${objective}.`,
    );
  }

  const spec: InternalSpec = {
    ...SPECS[row.optimizationGoal],
    normalizedObjective: objective,
  };
  const provenanceResult = validateProvenance(
    row.provenance,
    spec.requiresAttribution,
    spec.requiresRawMetaValue,
  );
  if (!provenanceResult.ok) {
    return unavailable(provenanceResult.code, provenanceResult.reason);
  }

  const spend = ownNonNegativeNumber(row.metrics, 'spend');
  if (spend.status !== 'valid') {
    return unavailable(
      spend.status === 'missing' ? 'metric_missing' : 'metric_invalid',
      'Observed finite non-negative spend is required.',
    );
  }
  if (spend.value === 0) {
    return unavailable(
      'metric_invalid',
      'Positive spend is required for an efficiency comparison.',
    );
  }

  const result = ownNonNegativeNumber(row.metrics, spec.inputResultKey);
  if (result.status !== 'valid') {
    return unavailable(
      result.status === 'missing' ? 'metric_missing' : 'metric_invalid',
      `Observed finite non-negative ${spec.inputResultKey} is required.`,
    );
  }

  let supportingExactConversions: number | null = null;
  if (row.optimizationGoal === 'VALUE') {
    const conversions = ownNonNegativeNumber(row.metrics, 'exactConversions');
    if (conversions.status !== 'valid') {
      return unavailable(
        conversions.status === 'missing' ? 'metric_missing' : 'metric_invalid',
        'VALUE evidence requires its matching exact conversion count.',
      );
    }
    supportingExactConversions = conversions.value;
  } else if (row.optimizationGoal === 'OFFSITE_CONVERSIONS') {
    supportingExactConversions = result.value;
  }

  const efficiencyValue = computeEfficiency(spec, spend.value, result.value);
  const normalizedProvenance = provenanceResult.provenance;
  const publicSpec = stripInternalSpec(spec);
  const measurement: GoalEfficiencyMeasurement = {
    version: GOAL_EFFICIENCY_VERSION,
    entityId,
    parentId,
    level: row.level,
    effectiveStatus: row.effectiveStatus,
    spec: publicSpec,
    spend: spend.value,
    result: {
      metric: publicSpec.resultMetric.key,
      value: result.value,
      unit: publicSpec.resultMetric.unit,
    },
    supportingExactConversions,
    efficiency: {
      metric: publicSpec.efficiencyMetric.key,
      value: efficiencyValue,
      unit: publicSpec.efficiencyMetric.unit,
      lowerIsBetter: publicSpec.efficiencyMetric.lowerIsBetter,
    },
    provenance: normalizedProvenance,
    comparisonIdentity: comparisonIdentity({
      entityId,
      parentId,
      level: row.level,
      effectiveStatus: row.effectiveStatus,
      spec: publicSpec,
      spend: spend.value,
      result: {
        metric: publicSpec.resultMetric.key,
        value: result.value,
        unit: publicSpec.resultMetric.unit,
      },
      supportingExactConversions,
      efficiency: {
        metric: publicSpec.efficiencyMetric.key,
        value: efficiencyValue,
        unit: publicSpec.efficiencyMetric.unit,
        lowerIsBetter: publicSpec.efficiencyMetric.lowerIsBetter,
      },
      provenance: normalizedProvenance,
      version: GOAL_EFFICIENCY_VERSION,
      comparisonIdentity: '',
    }),
  };

  return { status: 'measured', measurement, code: null, reason: null };
}

/**
 * Compare one target with a leave-one-out pooled baseline. The output is an
 * observation, never an incrementality or causal-uplift claim.
 */
export function compareGoalEfficiencyPeers(
  input: CompareGoalEfficiencyPeersInput,
): GoalEfficiencyComparison {
  const exclusions: GoalEfficiencyPeerExclusion[] = [];
  const targetResult = measureGoalEfficiency(input.target);
  if (targetResult.status === 'unavailable') {
    return insufficient(
      'target_unavailable',
      `Target cannot be measured: ${targetResult.reason}`,
      null,
      null,
      exclusions,
    );
  }
  const target = targetResult.measurement;
  const current = toCurrent(target);
  if (target.effectiveStatus !== 'ACTIVE') {
    return insufficient(
      'target_not_active',
      'The target is not explicitly ACTIVE.',
      current,
      null,
      exclusions,
    );
  }

  const eligiblePeers: GoalEfficiencyMeasurement[] = [];
  for (const candidate of input.siblings) {
    const candidateId = nonEmpty(candidate.entityId) ?? '(missing id)';
    if (candidateId === target.entityId) {
      exclusions.push({
        entityId: candidateId,
        code: 'target_row',
        detail: 'The target is excluded from its leave-one-out baseline.',
      });
      continue;
    }
    if (
      candidate.parentId !== target.parentId ||
      candidate.level !== target.level
    ) {
      exclusions.push({
        entityId: candidateId,
        code: 'not_sibling',
        detail: 'Parent or hierarchy level differs from the target.',
      });
      continue;
    }
    if (candidate.effectiveStatus !== 'ACTIVE') {
      exclusions.push({
        entityId: candidateId,
        code: 'not_active',
        detail: 'Peer is not explicitly ACTIVE.',
      });
      continue;
    }
    const measured = measureGoalEfficiency(candidate);
    if (measured.status === 'unavailable') {
      exclusions.push({
        entityId: candidateId,
        code: 'unavailable',
        detail: measured.reason,
      });
      continue;
    }
    if (measured.measurement.comparisonIdentity !== target.comparisonIdentity) {
      exclusions.push({
        entityId: candidateId,
        code: 'provenance_mismatch',
        detail:
          'Goal, objective, window, currency, source, or attribution identity differs.',
      });
      continue;
    }
    eligiblePeers.push(measured.measurement);
  }

  if (eligiblePeers.length < GOAL_EFFICIENCY_MIN_ACTIVE_PEERS) {
    return insufficient(
      'not_enough_eligible_peers',
      `At least ${GOAL_EFFICIENCY_MIN_ACTIVE_PEERS} exact active peers are required; ${eligiblePeers.length} qualified.`,
      current,
      null,
      exclusions,
    );
  }

  const baseline = poolBaseline(target, eligiblePeers);
  if (!baseline) {
    return insufficient(
      'pooled_efficiency_unavailable',
      'The eligible peer pool has no finite pooled efficiency.',
      current,
      null,
      exclusions,
    );
  }

  const peerFloorValue = floorValue(
    target.spec.evidenceFloor.basis,
    baseline.pooledResult.value,
    baseline.pooledSupportingExactConversions,
  );
  if (peerFloorValue < target.spec.evidenceFloor.peerPoolMinimum) {
    return insufficient(
      'peer_pool_below_evidence_floor',
      `Peer pool evidence ${peerFloorValue} is below the required ${target.spec.evidenceFloor.peerPoolMinimum}.`,
      current,
      baseline,
      exclusions,
    );
  }

  const gap = relativeGap(target.efficiency, baseline.efficiency);
  if (gap.direction === 'within_threshold' || gap.direction === 'unknown') {
    return insufficient(
      'relative_gap_below_threshold',
      `Observed efficiency is not at least ${GOAL_EFFICIENCY_GAP_MULTIPLE}x better or worse than the pooled peer baseline.`,
      current,
      baseline,
      exclusions,
      gap,
    );
  }

  const status = gap.direction === 'better' ? 'leader' : 'laggard';
  if (!targetMeetsFloor(target, baseline, status)) {
    return insufficient(
      'target_below_evidence_floor',
      `Target evidence does not meet the conservative ${status} floor.`,
      current,
      baseline,
      exclusions,
      gap,
    );
  }

  return {
    version: GOAL_EFFICIENCY_VERSION,
    status,
    code: 'observed_relative_efficiency',
    reason: `${target.entityId} is an observed relative efficiency ${status} against ${baseline.peerCount} exact active siblings over the same reporting provenance.`,
    claimScope: 'observational_same_window_peer_comparison',
    causalClaim: false,
    expectedUplift: null,
    current,
    baseline,
    excludedPeers: exclusions,
    relativeGap: gap,
  };
}

function validateProvenance(
  input: Readonly<GoalEfficiencyProvenance>,
  requiresAttribution: boolean,
  requiresRawMetaValue: boolean,
):
  | { ok: true; provenance: NormalizedGoalEfficiencyProvenance }
  | {
      ok: false;
      code: GoalEfficiencyUnavailableCode;
      reason: string;
    } {
  if (input.rowObserved !== true) {
    return {
      ok: false,
      code: 'row_not_observed',
      reason: 'The source insight row was not proven to be observed.',
    };
  }
  if (input.responseComplete !== true) {
    return {
      ok: false,
      code: 'response_incomplete',
      reason: 'The source response was not proven complete.',
    };
  }
  if (!validDateOnly(input.dateStart) || !validDateOnly(input.dateStop)) {
    return {
      ok: false,
      code: 'invalid_window',
      reason: 'Exact YYYY-MM-DD dateStart and dateStop are required.',
    };
  }
  if (input.dateStart > input.dateStop) {
    return {
      ok: false,
      code: 'invalid_window',
      reason: 'dateStart must not be after dateStop.',
    };
  }
  const metricScope = nonEmpty(input.metricScope);
  if (!metricScope || !['window', 'lifetime'].includes(metricScope)) {
    return {
      ok: false,
      code: 'invalid_metric_scope',
      reason: 'Metric scope must be explicitly window or lifetime.',
    };
  }
  const syncedAt = normalizeDateTime(input.metricsSyncedAt);
  if (
    !syncedAt ||
    !Number.isFinite(input.freshnessSec) ||
    input.freshnessSec < 0
  ) {
    return {
      ok: false,
      code: 'invalid_sync_provenance',
      reason:
        'A valid metricsSyncedAt and non-negative freshnessSec are required.',
    };
  }
  if (!isSourceMetricsFresh(input.freshnessSec)) {
    return {
      ok: false,
      code: 'stale_source',
      reason: `Source metrics are stale at ${input.freshnessSec}s.`,
    };
  }
  const source = nonEmpty(input.source);
  const sourceFingerprint = nonEmpty(input.sourceFingerprint);
  if (source !== 'meta_insights' || !sourceFingerprint) {
    return {
      ok: false,
      code: 'invalid_source_provenance',
      reason: 'Exact meta_insights source provenance is required.',
    };
  }
  const currency = nonEmpty(input.currency);
  if (!currency || currency !== currency.toUpperCase()) {
    return {
      ok: false,
      code: 'invalid_currency',
      reason: 'An exact uppercase currency identity is required.',
    };
  }

  let attribution: NormalizedGoalEfficiencyProvenance['attribution'] = null;
  if (requiresAttribution) {
    const raw = input.attribution;
    if (
      !raw ||
      !nonEmpty(raw.conversionEventIdentity) ||
      !nonEmpty(raw.attributionSpecHash)
    ) {
      return {
        ok: false,
        code: 'missing_attribution_identity',
        reason:
          'Conversion/value evidence requires event and attribution-spec identities.',
      };
    }
    if (!isTrustedAttributionSource(raw.attributionSource)) {
      return {
        ok: false,
        code: 'untrusted_attribution_source',
        reason: `Attribution source "${raw.attributionSource}" is not trusted.`,
      };
    }
    const actionTypes = normalizeActionTypes(raw.actionTypes);
    if (!actionTypes) {
      return {
        ok: false,
        code: 'invalid_action_type_identity',
        reason: 'At least one exact, unique Meta action_type is required.',
      };
    }
    if (requiresRawMetaValue && raw.valueBasis !== 'meta_action_value') {
      return {
        ok: false,
        code: 'invalid_value_basis',
        reason: 'VALUE requires valueBasis=meta_action_value.',
      };
    }
    attribution = {
      attributionSource: raw.attributionSource,
      conversionEventIdentity: nonEmpty(raw.conversionEventIdentity)!,
      actionTypes,
      attributionSpecHash: nonEmpty(raw.attributionSpecHash)!,
      valueBasis: nonEmpty(raw.valueBasis),
    };
  }

  return {
    ok: true,
    provenance: {
      rowObserved: true,
      responseComplete: true,
      dateStart: input.dateStart,
      dateStop: input.dateStop,
      metricScope,
      metricsSyncedAt: syncedAt,
      freshnessSec: input.freshnessSec,
      source,
      sourceFingerprint,
      currency,
      attribution,
    },
  };
}

function poolBaseline(
  target: GoalEfficiencyMeasurement,
  peers: GoalEfficiencyMeasurement[],
): GoalEfficiencyComparisonBaseline | null {
  const pooledSpend = sumFinite(peers.map((peer) => peer.spend));
  const pooledResultValue = sumFinite(peers.map((peer) => peer.result.value));
  const pooledSupportingExactConversions =
    target.spec.evidenceFloor.basis === 'exact_conversions'
      ? sumFinite(
          peers.map((peer) => peer.supportingExactConversions ?? Number.NaN),
        )
      : null;
  if (
    pooledSpend === null ||
    pooledResultValue === null ||
    (target.spec.evidenceFloor.basis === 'exact_conversions' &&
      pooledSupportingExactConversions === null)
  ) {
    return null;
  }
  const internal = SPECS[target.spec.optimizationGoal];
  const efficiency = computeEfficiency(
    { ...internal, normalizedObjective: target.spec.normalizedObjective },
    pooledSpend,
    pooledResultValue,
  );
  if (efficiency === null) return null;

  return {
    peerCount: peers.length,
    peerIds: peers.map((peer) => peer.entityId).sort(),
    pooledSpend,
    pooledResult: {
      metric: target.result.metric,
      value: pooledResultValue,
      unit: target.result.unit,
    },
    pooledSupportingExactConversions,
    efficiency: {
      metric: target.efficiency.metric,
      value: efficiency,
      unit: target.efficiency.unit,
      lowerIsBetter: target.efficiency.lowerIsBetter,
    },
  };
}

function relativeGap(
  current: GoalEfficiencyObservedEfficiency,
  baseline: GoalEfficiencyComparisonBaseline['efficiency'],
): GoalEfficiencyComparisonBase['relativeGap'] {
  const unknown: GoalEfficiencyComparisonBase['relativeGap'] = {
    thresholdMultiple: GOAL_EFFICIENCY_GAP_MULTIPLE,
    observedMultiple: null,
    unbounded: false,
    direction: 'unknown',
  };
  if (!Number.isFinite(baseline.value) || baseline.value < 0) return unknown;

  if (current.value === null) {
    return current.lowerIsBetter && baseline.value > 0
      ? { ...unknown, unbounded: true, direction: 'worse' }
      : unknown;
  }
  if (!Number.isFinite(current.value) || current.value < 0) return unknown;

  if (current.lowerIsBetter) {
    if (baseline.value === 0 && current.value === 0) {
      return { ...unknown, direction: 'within_threshold' };
    }
    if (baseline.value === 0) {
      return { ...unknown, unbounded: true, direction: 'worse' };
    }
    if (current.value === 0) {
      return { ...unknown, unbounded: true, direction: 'better' };
    }
    const worse = current.value / baseline.value;
    const better = baseline.value / current.value;
    if (worse >= GOAL_EFFICIENCY_GAP_MULTIPLE) {
      return {
        ...unknown,
        observedMultiple: worse,
        direction: 'worse',
      };
    }
    if (better >= GOAL_EFFICIENCY_GAP_MULTIPLE) {
      return {
        ...unknown,
        observedMultiple: better,
        direction: 'better',
      };
    }
    return {
      ...unknown,
      observedMultiple: Math.max(worse, better),
      direction: 'within_threshold',
    };
  }

  if (baseline.value === 0 && current.value === 0) {
    return { ...unknown, direction: 'within_threshold' };
  }
  if (current.value === 0) {
    return { ...unknown, unbounded: true, direction: 'worse' };
  }
  if (baseline.value === 0) {
    return { ...unknown, unbounded: true, direction: 'better' };
  }
  const better = current.value / baseline.value;
  const worse = baseline.value / current.value;
  if (better >= GOAL_EFFICIENCY_GAP_MULTIPLE) {
    return { ...unknown, observedMultiple: better, direction: 'better' };
  }
  if (worse >= GOAL_EFFICIENCY_GAP_MULTIPLE) {
    return { ...unknown, observedMultiple: worse, direction: 'worse' };
  }
  return {
    ...unknown,
    observedMultiple: Math.max(better, worse),
    direction: 'within_threshold',
  };
}

function targetMeetsFloor(
  target: GoalEfficiencyMeasurement,
  baseline: GoalEfficiencyComparisonBaseline,
  status: 'leader' | 'laggard',
): boolean {
  const floor = target.spec.evidenceFloor;
  const targetFloorValue = floorValue(
    floor.basis,
    target.result.value,
    target.supportingExactConversions,
  );
  if (status === 'leader') {
    return targetFloorValue >= floor.leaderTargetMinimum;
  }

  if (
    floor.basis === 'primary_result' &&
    (target.spec.optimizationGoal === 'REACH' ||
      target.spec.optimizationGoal === 'IMPRESSIONS')
  ) {
    return targetFloorValue >= floor.laggardOpportunityMinimum;
  }
  if (targetFloorValue >= floor.laggardOpportunityMinimum) return true;

  const peerOpportunityResult = floorValue(
    floor.basis,
    baseline.pooledResult.value,
    baseline.pooledSupportingExactConversions,
  );
  if (peerOpportunityResult <= 0) return false;
  const pooledCostPerFloorResult = baseline.pooledSpend / peerOpportunityResult;
  return (
    Number.isFinite(pooledCostPerFloorResult) &&
    target.spend >= pooledCostPerFloorResult * floor.laggardOpportunityMinimum
  );
}

function floorValue(
  basis: GoalEfficiencySpec['evidenceFloor']['basis'],
  primaryResult: number,
  exactConversions: number | null,
): number {
  return basis === 'exact_conversions'
    ? (exactConversions ?? Number.NEGATIVE_INFINITY)
    : primaryResult;
}

function computeEfficiency(
  spec: InternalSpec,
  spend: number,
  result: number,
): number | null {
  if (spec.optimizationGoal === 'VALUE') {
    const value = result / spend;
    return Number.isFinite(value) ? value : null;
  }
  if (result === 0) return null;
  const value = (spend / result) * spec.resultScale;
  return Number.isFinite(value) ? value : null;
}

function comparisonIdentity(measurement: GoalEfficiencyMeasurement): string {
  const p = measurement.provenance;
  return JSON.stringify({
    parentId: measurement.parentId,
    level: measurement.level,
    objective: measurement.spec.normalizedObjective,
    optimizationGoal: measurement.spec.optimizationGoal,
    resultMetric: measurement.result.metric,
    efficiencyMetric: measurement.efficiency.metric,
    dateStart: p.dateStart,
    dateStop: p.dateStop,
    metricScope: p.metricScope,
    source: p.source,
    sourceFingerprint: p.sourceFingerprint,
    currency: p.currency,
    attribution: p.attribution,
  });
}

function stripInternalSpec(spec: InternalSpec): GoalEfficiencySpec {
  return {
    optimizationGoal: spec.optimizationGoal,
    normalizedObjective: spec.normalizedObjective,
    resultMetric: { ...spec.resultMetric },
    efficiencyMetric: { ...spec.efficiencyMetric },
    evidenceFloor: { ...spec.evidenceFloor },
  };
}

function toCurrent(
  measurement: GoalEfficiencyMeasurement,
): GoalEfficiencyComparisonCurrent {
  return {
    entityId: measurement.entityId,
    spend: measurement.spend,
    result: { ...measurement.result },
    supportingExactConversions: measurement.supportingExactConversions,
    efficiency: { ...measurement.efficiency },
  };
}

function insufficient(
  code: GoalEfficiencyInsufficientCode,
  reason: string,
  current: GoalEfficiencyComparisonCurrent | null,
  baseline: GoalEfficiencyComparisonBaseline | null,
  excludedPeers: GoalEfficiencyPeerExclusion[],
  relativeGap: GoalEfficiencyComparisonBase['relativeGap'] = {
    thresholdMultiple: GOAL_EFFICIENCY_GAP_MULTIPLE,
    observedMultiple: null,
    unbounded: false,
    direction: 'unknown',
  },
): GoalEfficiencyComparison {
  return {
    version: GOAL_EFFICIENCY_VERSION,
    status: 'insufficient',
    code,
    reason,
    claimScope: 'observational_same_window_peer_comparison',
    causalClaim: false,
    expectedUplift: null,
    current,
    baseline,
    excludedPeers,
    relativeGap,
  };
}

function unavailable(
  code: GoalEfficiencyUnavailableCode,
  reason: string,
): GoalEfficiencyMeasurementResult {
  return { status: 'unavailable', measurement: null, code, reason };
}

function ownNonNegativeNumber(
  metrics: Readonly<GoalEfficiencyMetrics>,
  key: GoalEfficiencyInputMetricKey,
):
  | { status: 'valid'; value: number }
  | { status: 'missing' | 'invalid'; value: null } {
  if (!Object.prototype.hasOwnProperty.call(metrics, key)) {
    return { status: 'missing', value: null };
  }
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? { status: 'valid', value }
    : { status: 'invalid', value: null };
}

function isSupportedGoal(
  value: string,
): value is SupportedMetaOptimizationGoal {
  return Object.prototype.hasOwnProperty.call(SPECS, value);
}

function isObjectiveCompatible(
  objective: GoalEfficiencyObjective,
  goal: SupportedMetaOptimizationGoal,
): boolean {
  switch (goal) {
    case 'VALUE':
    case 'OFFSITE_CONVERSIONS':
      return objective === 'sales';
    case 'REACH':
    case 'IMPRESSIONS':
      return objective === 'awareness';
    case 'LANDING_PAGE_VIEWS':
    case 'LINK_CLICKS':
      return objective === 'traffic';
    case 'THRUPLAY':
      return objective === 'engagement' || objective === 'video_views';
  }
}

function normalizeObjective(value: string): GoalEfficiencyObjective | null {
  switch (nonEmpty(value)?.toUpperCase()) {
    case 'OUTCOME_SALES':
    case 'SALES':
    case 'CONVERSIONS':
    case 'CATALOG_SALES':
    case 'PRODUCT_CATALOG_SALES':
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

function isTrustedAttributionSource(
  value: string,
): value is TrustedGoalAttributionSource {
  return TRUSTED_ATTRIBUTION_SOURCES.has(value as TrustedGoalAttributionSource);
}

function normalizeActionTypes(input: readonly string[]): string[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const cleaned = input.map(nonEmpty);
  if (cleaned.some((value) => value === null)) return null;
  const normalized = cleaned as string[];
  const unique = [...new Set(normalized)].sort();
  // Repeated aliases indicate ambiguous/unclean provenance, so fail closed.
  return unique.length === normalized.length ? unique : null;
}

function normalizeDateTime(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function sumFinite(values: number[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) return null;
    sum += value;
  }
  return Number.isFinite(sum) ? sum : null;
}
