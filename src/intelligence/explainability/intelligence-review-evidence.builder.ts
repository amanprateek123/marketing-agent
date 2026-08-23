import type {
  DecisionContext,
  ObjectiveData,
  RecommendedAction,
} from '../orchestrator/decision-context';
import { isRevenueObjective, scoredMetricFor } from '../objective/kpi-profiles';
import {
  measureGoalEfficiency,
  type GoalEfficiencyMeasurementResult,
} from '../objective/goal-efficiency';
import { buildSnapshotGoalEfficiencyRow } from '../objective/goal-efficiency-snapshot';
import type { SliceIdentity } from '../shared/slice-repository.service';
import type {
  AdMetricSet,
  MetricSet,
  SnapshotAdEntity,
  SnapshotAdSetEntity,
  SnapshotData,
} from '../snapshot/snapshot.types';
import {
  INTELLIGENCE_EVIDENCE_SOURCES,
  INTELLIGENCE_REVIEW_SCHEMA_VERSION,
  type IntelligenceEvidenceKind,
  type IntelligenceEvidenceSource,
  type IntelligenceEvidenceUnknown,
  type IntelligenceEvidenceValue,
  type IntelligenceReviewEvidenceFact,
  type IntelligenceReviewEvidencePacket,
} from './intelligence-review.types';

export type IntelligenceHierarchyLevel =
  | 'campaign'
  | 'adset'
  | 'ad'
  | 'creative';

export interface IntelligenceHierarchyMetric {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  status: 'available' | 'unavailable' | 'unsupported';
  evidenceRef?: string;
}

export interface IntelligenceHierarchyNode {
  level: IntelligenceHierarchyLevel;
  id: string;
  parentId?: string;
  name: string;
  role: 'action_target' | 'context' | 'comparison';
  resolution: 'exact' | 'unresolved';
  status?: string;
  optimizationGoal?: string;
  format?: string;
  metrics: IntelligenceHierarchyMetric[];
  evidenceRefs: string[];
  creative?: {
    id?: string;
    title?: string;
    body?: string;
    cta?: string;
    thumbnailUrl?: string;
    source: 'meta';
    galleryResolution: 'unresolved';
  };
}

export interface IntelligenceReviewEvidenceBundle {
  packet: IntelligenceReviewEvidencePacket;
  hierarchy: {
    nodes: IntelligenceHierarchyNode[];
    coverage: {
      adSetsIncluded: number;
      adSetsTotal: number;
      adsIncluded: number;
      adsTotal: number;
      truncated: boolean;
    };
  };
  unknowns: IntelligenceEvidenceUnknown[];
  baseline: {
    metric: string;
    value: number | null;
    unit: string;
    evidenceRef?: string;
    capturedAt: string;
  };
}

interface BuildInput {
  deps: Partial<DecisionContext>;
  cycleId: string;
  identity: SliceIdentity;
  action: RecommendedAction;
}

/**
 * Builds the only information an LLM is allowed to review.
 *
 * It is deliberately pure and bounded: no DB/API reads, no raw engine dumps,
 * and no guessed hierarchy. Every displayed number receives a stable evidence
 * reference that resolves back to one persisted cycle slice.
 */
export function buildIntelligenceReviewEvidence(
  input: BuildInput,
): IntelligenceReviewEvidenceBundle {
  const objective = input.deps.objective!.data;
  const snapshot = input.deps.snapshot!.data as unknown as SnapshotData;
  const facts: IntelligenceReviewEvidenceFact[] = [];
  const unknowns: IntelligenceEvidenceUnknown[] = [];
  let factIndex = 0;

  const addFact = (args: {
    source: IntelligenceEvidenceSource;
    kind: IntelligenceEvidenceKind;
    statement: string;
    value: IntelligenceEvidenceValue;
    unit?: string;
    targetType?: 'campaign' | 'adset' | 'ad';
    targetId?: string;
  }): string => {
    const step = INTELLIGENCE_EVIDENCE_SOURCES[args.source];
    const ref = `s${step}.f${++factIndex}`;
    const target =
      args.targetType && args.targetId
        ? { targetType: args.targetType, targetId: args.targetId }
        : {};
    facts.push({
      ref,
      step,
      source: args.source,
      kind: args.kind,
      statement: compact(args.statement, 500),
      value: args.value,
      ...(args.unit ? { unit: args.unit } : {}),
      ...target,
    });
    return ref;
  };

  const goalRef = addFact({
    source: 'objective',
    kind: 'policy',
    statement: `This campaign is evaluated for the ${humanize(objective.objective)} objective using ${humanize(objective.primaryKPI)} as its primary KPI.`,
    value: objective.objective,
    unit: 'objective',
  });
  void goalRef;

  addFact({
    source: 'snapshot',
    kind: 'observed',
    statement: `Meta metrics were captured at ${toIso(snapshot.collectedAt)} with ${snapshot.meta.metricScope ?? 'unknown'} scope.`,
    value: toIso(snapshot.collectedAt),
    unit: snapshot.meta.metricScope ?? 'unknown_scope',
    targetType: 'campaign',
    targetId: input.identity.campaignId,
  });

  if (Number.isFinite(snapshot.freshnessSec) && snapshot.freshnessSec >= 0) {
    addFact({
      source: 'snapshot',
      kind: 'derived',
      statement: `The source metrics were ${formatNumber(snapshot.freshnessSec)} seconds old when the cycle ran.`,
      value: snapshot.freshnessSec,
      unit: 'seconds',
      targetType: 'campaign',
      targetId: input.identity.campaignId,
    });
  } else {
    unknowns.push({
      code: 'source_freshness_unknown',
      statement: 'The source-metric synchronization time is unknown.',
      effect: 'reduces_confidence',
    });
  }

  const hierarchy = buildHierarchy({
    snapshot,
    objective,
    action: input.action,
    campaignId: input.identity.campaignId,
    financialDataAvailable:
      !isRevenueObjective(objective.objective) ||
      input.deps.revenue?.data.financialDataAvailable === true,
    addFact,
    unknowns,
  });

  addEngineFacts(input, addFact, unknowns);

  const actionTargetNode = hierarchy.nodes.find(
    (node) =>
      node.role === 'action_target' &&
      node.level === input.action.targetType &&
      node.id === input.action.targetId,
  );
  const exactGoalMetric = actionTargetNode?.metrics[0];
  const fallbackMetric = scoredMetricFor(objective.objective).metric;
  const baselineMetric = exactGoalMetric?.key ?? fallbackMetric;
  const baselineValue = exactGoalMetric
    ? exactGoalMetric.status === 'available'
      ? exactGoalMetric.value
      : null
    : numericMetric(
        metricsForTarget(
          snapshot,
          input.action.targetType,
          input.action.targetId,
          input.identity.campaignId,
        ),
        fallbackMetric,
      );
  const baselineRef =
    exactGoalMetric?.evidenceRef ??
    facts.find(
      (fact) =>
        fact.targetType === input.action.targetType &&
        fact.targetId === input.action.targetId &&
        fact.unit === fallbackMetric,
    )?.ref;

  if (exactGoalMetric && exactGoalMetric.status !== 'available') {
    unknowns.push({
      code: `exact_goal_metric_${exactGoalMetric.status}:${input.action.targetType}:${input.action.targetId}`,
      statement: `The exact optimization-goal result for the action target is ${exactGoalMetric.status}.`,
      effect: 'blocks_validation',
    });
  } else if (!actionTargetNode) {
    unknowns.push({
      code: `action_target_metrics_unavailable:${input.action.targetType}:${input.action.targetId}`,
      statement:
        'The exact action target and its optimization-goal metrics are unavailable in the captured hierarchy.',
      effect: 'blocks_validation',
    });
  }

  return {
    packet: {
      schemaVersion: INTELLIGENCE_REVIEW_SCHEMA_VERSION,
      cycleId: input.cycleId,
      tenantId: input.identity.tenantId,
      campaignId: input.identity.campaignId,
      goal: {
        objective: objective.objective,
        primaryKPI: objective.primaryKPI,
        supportingKPIs: [...objective.supportingKPIs],
        optimizationGoal: actionTargetNode?.optimizationGoal ?? null,
        optimizationMetric:
          exactGoalMetric?.status === 'available' ? exactGoalMetric.key : null,
      },
      facts: facts.slice(0, 100),
      unknowns: unknowns.slice(0, 50),
    },
    hierarchy,
    unknowns,
    baseline: {
      metric: baselineMetric,
      value: baselineValue,
      unit: exactGoalMetric?.unit ?? metricUnit(baselineMetric),
      ...(baselineRef ? { evidenceRef: baselineRef } : {}),
      capturedAt: toIso(snapshot.collectedAt),
    },
  };
}

function buildHierarchy(input: {
  snapshot: SnapshotData;
  objective: ObjectiveData;
  action: RecommendedAction;
  campaignId: string;
  financialDataAvailable: boolean;
  addFact: (args: {
    source: IntelligenceEvidenceSource;
    kind: IntelligenceEvidenceKind;
    statement: string;
    value: IntelligenceEvidenceValue;
    unit?: string;
    targetType?: 'campaign' | 'adset' | 'ad';
    targetId?: string;
  }) => string;
  unknowns: IntelligenceEvidenceUnknown[];
}): IntelligenceReviewEvidenceBundle['hierarchy'] {
  const {
    snapshot,
    objective,
    action,
    campaignId,
    financialDataAvailable,
    addFact,
    unknowns,
  } = input;
  const entities = snapshot.entities;
  const adSetEntries = Object.entries(snapshot.metrics.adSetLevel);
  const adEntries = Object.entries(snapshot.metrics.adLevel);
  const selectedAdSetIds = chooseAdSets(
    action,
    entities?.ads,
    adSetEntries,
    adEntries,
  );
  const selectedAdIds = chooseAds(
    action,
    selectedAdSetIds,
    entities?.ads,
    adEntries,
  );
  const nodes: IntelligenceHierarchyNode[] = [];

  const campaignName =
    cleanLabel(entities?.campaign?.name) || `Campaign ${shortId(campaignId)}`;
  const campaignRef = addFact({
    source: 'snapshot',
    kind: 'observed',
    statement: `The analysis scope is campaign “${campaignName}”.`,
    value: campaignName,
    unit: 'name',
    targetType: 'campaign',
    targetId: campaignId,
  });
  nodes.push(
    makeMetricNode({
      level: 'campaign',
      id: campaignId,
      name: campaignName,
      role: action.targetType === 'campaign' ? 'action_target' : 'context',
      resolution: entities?.campaign ? 'exact' : 'unresolved',
      status: entities?.campaign?.effectiveStatus ?? entities?.campaign?.status,
      metrics: snapshot.metrics.campaignLevel,
      objective,
      optimizationGoal: homogeneousOptimizationGoal(entities?.adSets),
      goalMeasurement: null,
      financialDataAvailable,
      evidenceRefs: [campaignRef],
      addFact,
      targetType: 'campaign',
    }),
  );

  if (!entities) {
    unknowns.push({
      code: 'snapshot_hierarchy_unavailable',
      statement:
        'This historical cycle did not retain exact campaign, ad-set, ad, and creative identity.',
      effect:
        action.targetType === 'campaign'
          ? 'reduces_confidence'
          : 'blocks_validation',
    });
  }

  for (const adSetId of selectedAdSetIds) {
    const entity = entities?.adSets[adSetId];
    const metrics = snapshot.metrics.adSetLevel[adSetId];
    if (!metrics) continue;
    const name = cleanLabel(entity?.name) || `Ad set ${shortId(adSetId)}`;
    const entityRef = addFact({
      source: 'snapshot',
      kind: 'observed',
      statement: entity?.optimizationGoal
        ? `Ad set “${name}” optimizes for ${entity.optimizationGoal}.`
        : `Ad set “${name}” has no retained optimization-goal value.`,
      value: entity?.optimizationGoal ?? null,
      unit: 'optimization_goal',
      targetType: 'adset',
      targetId: adSetId,
    });
    if (!entity?.optimizationGoal) {
      const isGoalForActionTarget =
        (action.targetType === 'adset' && action.targetId === adSetId) ||
        (action.targetType === 'ad' &&
          entities?.ads[action.targetId]?.adSetId === adSetId);
      unknowns.push({
        code: `optimization_goal_missing:${adSetId}`,
        statement: `The optimization goal for ad set “${name}” is unavailable.`,
        effect: isGoalForActionTarget
          ? 'blocks_validation'
          : 'reduces_confidence',
      });
    }
    nodes.push(
      makeMetricNode({
        level: 'adset',
        id: adSetId,
        parentId: campaignId,
        name,
        role:
          action.targetType === 'adset' && action.targetId === adSetId
            ? 'action_target'
            : 'comparison',
        resolution: entity ? 'exact' : 'unresolved',
        status: entity?.effectiveStatus ?? entity?.status,
        optimizationGoal: entity?.optimizationGoal,
        metrics,
        objective,
        goalMeasurement: goalMeasurementForTarget(snapshot, 'adset', adSetId),
        financialDataAvailable,
        evidenceRefs: [entityRef],
        addFact,
        targetType: 'adset',
      }),
    );
  }

  for (const adId of selectedAdIds) {
    const entity = entities?.ads[adId];
    const metrics = snapshot.metrics.adLevel[adId];
    if (!metrics) continue;
    const parentId = entity?.adSetId;
    const parent = parentId ? entities?.adSets[parentId] : undefined;
    const name = cleanLabel(entity?.name) || `Ad ${shortId(adId)}`;
    const entityRef = addFact({
      source: 'snapshot',
      kind: 'observed',
      statement: `Ad “${name}” is ${cleanLabel(entity?.effectiveStatus ?? entity?.status) || 'in an unknown delivery state'}.`,
      value: entity?.effectiveStatus ?? entity?.status ?? null,
      unit: 'delivery_status',
      targetType: 'ad',
      targetId: adId,
    });
    if (!parentId) {
      unknowns.push({
        code: `ad_parent_unresolved:${adId}`,
        statement: `The exact parent ad set for ad “${name}” is unavailable.`,
        effect: 'blocks_diagnosis',
      });
    }
    const adNode = makeMetricNode({
      level: 'ad',
      id: adId,
      ...(parentId ? { parentId } : {}),
      name,
      role:
        action.targetType === 'ad' && action.targetId === adId
          ? 'action_target'
          : 'comparison',
      resolution: entity ? 'exact' : 'unresolved',
      status: entity?.effectiveStatus ?? entity?.status,
      format: metrics.format,
      metrics,
      objective,
      optimizationGoal: parent?.optimizationGoal,
      goalMeasurement: goalMeasurementForTarget(snapshot, 'ad', adId),
      financialDataAvailable,
      evidenceRefs: [entityRef],
      addFact,
      targetType: 'ad',
    });
    nodes.push(adNode);

    const creative = entity?.creative;
    if (creative && hasCreativeIdentity(creative)) {
      const creativeName =
        cleanLabel(creative.name ?? creative.title) || `Creative for ${name}`;
      const creativeRef = addFact({
        source: 'snapshot',
        kind: 'observed',
        statement: `Ad “${name}” uses the ${metrics.format ?? 'unknown-format'} creative “${creativeName}”.`,
        value: creative.id ?? creativeName,
        unit: 'creative_identity',
        targetType: 'ad',
        targetId: adId,
      });
      nodes.push({
        level: 'creative',
        id: creative.id || `creative:${adId}`,
        parentId: adId,
        name: creativeName,
        role: adNode.role,
        resolution: creative.id ? 'exact' : 'unresolved',
        format: metrics.format,
        metrics: [],
        evidenceRefs: [creativeRef],
        creative: {
          ...(creative.id ? { id: creative.id } : {}),
          ...(cleanLabel(creative.title)
            ? { title: cleanLabel(creative.title) }
            : {}),
          ...(cleanLabel(creative.body)
            ? { body: cleanLabel(creative.body, 240) }
            : {}),
          ...(cleanLabel(creative.cta)
            ? { cta: cleanLabel(creative.cta) }
            : {}),
          ...(safeUrl(creative.thumbnailUrl)
            ? { thumbnailUrl: creative.thumbnailUrl }
            : {}),
          source: 'meta',
          galleryResolution: 'unresolved',
        },
      });
      unknowns.push({
        code: `gallery_lineage_unresolved:${adId}`,
        statement: `The live Meta creative for ad “${name}” is visible, but its immutable Gallery source is not linked.`,
        effect: isCreativeMutation(action)
          ? 'blocks_execution'
          : 'reduces_confidence',
      });
    } else {
      unknowns.push({
        code: `creative_identity_unresolved:${adId}`,
        statement: `Creative identity for ad “${name}” is unavailable.`,
        effect: isCreativeMutation(action)
          ? 'blocks_execution'
          : 'blocks_diagnosis',
      });
    }
  }

  return {
    nodes,
    coverage: {
      adSetsIncluded: selectedAdSetIds.length,
      adSetsTotal: adSetEntries.length,
      adsIncluded: selectedAdIds.length,
      adsTotal: adEntries.length,
      truncated:
        selectedAdSetIds.length < adSetEntries.length ||
        selectedAdIds.length < adEntries.length,
    },
  };
}

function makeMetricNode(input: {
  level: 'campaign' | 'adset' | 'ad';
  id: string;
  parentId?: string;
  name: string;
  role: IntelligenceHierarchyNode['role'];
  resolution: IntelligenceHierarchyNode['resolution'];
  status?: string;
  optimizationGoal?: string;
  format?: string;
  metrics: MetricSet | AdMetricSet;
  objective: ObjectiveData;
  goalMeasurement: GoalEfficiencyMeasurementResult | null;
  financialDataAvailable: boolean;
  evidenceRefs: string[];
  addFact: (args: {
    source: IntelligenceEvidenceSource;
    kind: IntelligenceEvidenceKind;
    statement: string;
    value: IntelligenceEvidenceValue;
    unit?: string;
    targetType?: 'campaign' | 'adset' | 'ad';
    targetId?: string;
  }) => string;
  targetType: 'campaign' | 'adset' | 'ad';
}): IntelligenceHierarchyNode {
  const result: IntelligenceHierarchyMetric[] = [];
  const targetLabel = `${humanize(input.level)} “${input.name}”`;
  for (const key of diagnosticMetricKeys(
    input.objective,
    input.financialDataAvailable,
  )) {
    const value = numericMetric(input.metrics, key);
    if (value === null) continue;
    const unit = metricUnit(key);
    const ref = input.addFact({
      source: 'snapshot',
      kind: metricEvidenceKind(key),
      statement: `${targetLabel} has ${metricLabel(key)} ${formatMetric(value, unit)} in the captured ${'last7d' in input.metrics && input.metrics.last7d ? 'lifetime snapshot; a separate recent window is also retained' : 'snapshot'}.`,
      value,
      unit: key,
      targetType: input.targetType,
      targetId: input.id,
    });
    result.push({
      key,
      label: metricLabel(key),
      value,
      unit,
      status: 'available',
      evidenceRef: ref,
    });
    input.evidenceRefs.push(ref);
  }

  if (input.goalMeasurement?.status === 'measured') {
    const measurement = input.goalMeasurement.measurement;
    const resultRef = input.addFact({
      source: 'snapshot',
      kind: 'observed',
      statement: `${targetLabel} produced ${formatMetric(measurement.result.value, displayGoalUnit(measurement.result.unit, measurement.provenance.currency))} of exact ${measurement.spec.optimizationGoal} result in the captured Meta row.`,
      value: measurement.result.value,
      unit: measurement.result.metric,
      targetType: input.targetType,
      targetId: input.id,
    });
    const efficiencyRef = input.addFact({
      source: 'snapshot',
      kind: 'derived',
      statement:
        measurement.efficiency.value === null
          ? `${targetLabel}'s ${measurement.spec.efficiencyMetric.label.toLowerCase()} is mathematically undefined because Meta explicitly observed zero ${measurement.spec.resultMetric.label.toLowerCase()} on positive spend.`
          : `${targetLabel}'s exact ${measurement.spec.efficiencyMetric.label.toLowerCase()} is ${formatMetric(measurement.efficiency.value, displayGoalUnit(measurement.efficiency.unit, measurement.provenance.currency))}, derived only from the observed spend and exact goal result above.`,
      value: measurement.efficiency.value,
      unit: measurement.efficiency.metric,
      targetType: input.targetType,
      targetId: input.id,
    });
    result.unshift({
      key: measurement.result.metric,
      label: measurement.spec.resultMetric.label,
      value: measurement.result.value,
      unit: displayGoalUnit(
        measurement.result.unit,
        measurement.provenance.currency,
      ),
      status: 'available',
      evidenceRef: resultRef,
    });
    result.unshift({
      key: measurement.efficiency.metric,
      label: measurement.spec.efficiencyMetric.label,
      value: measurement.efficiency.value,
      unit: displayGoalUnit(
        measurement.efficiency.unit,
        measurement.provenance.currency,
      ),
      status: 'available',
      evidenceRef: efficiencyRef,
    });
    input.evidenceRefs.push(resultRef, efficiencyRef);
  } else {
    const unavailable = input.goalMeasurement;
    const unsupported =
      unavailable?.status === 'unavailable' &&
      (unavailable.code === 'unsupported_optimization_goal' ||
        unavailable.code === 'unsupported_objective' ||
        unavailable.code === 'objective_goal_mismatch');
    result.unshift({
      key: 'goal_efficiency',
      label: 'Exact optimization-goal efficiency',
      value: null,
      unit: 'unknown',
      status: unsupported ? 'unsupported' : 'unavailable',
    });
  }

  return {
    level: input.level,
    id: input.id,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    name: input.name,
    role: input.role,
    resolution: input.resolution,
    ...(input.status ? { status: input.status } : {}),
    ...(input.optimizationGoal
      ? { optimizationGoal: input.optimizationGoal }
      : {}),
    ...(input.format ? { format: input.format } : {}),
    metrics: result,
    evidenceRefs: input.evidenceRefs,
  };
}

function addEngineFacts(
  input: BuildInput,
  addFact: (args: {
    source: IntelligenceEvidenceSource;
    kind: IntelligenceEvidenceKind;
    statement: string;
    value: IntelligenceEvidenceValue;
    unit?: string;
    targetType?: 'campaign' | 'adset' | 'ad';
    targetId?: string;
  }) => string,
  unknowns: IntelligenceEvidenceUnknown[],
): void {
  const { deps, action } = input;
  const lifecycle = deps.lifecycle?.data;
  if (lifecycle) {
    addFact({
      source: 'lifecycle',
      kind: 'derived',
      statement: `The deterministic lifecycle engine classified the campaign as ${humanize(lifecycle.stage)}.`,
      value: lifecycle.stage,
      unit: 'lifecycle_stage',
    });
    addFact({
      source: 'lifecycle',
      kind: 'derived',
      statement: `The campaign age used by the safety gates is ${formatNumber(lifecycle.ageHours)} hours.`,
      value: lifecycle.ageHours,
      unit: 'hours',
    });
  }

  const trend = deps.trend?.data;
  if (trend) {
    addFact({
      source: 'trend',
      kind: 'derived',
      statement: trend.trendReady
        ? `The trend gate passed with ${formatNumber(trend.observationCount ?? 0)} daily observations across ${formatNumber(trend.windowElapsedDays ?? 0)} elapsed days.`
        : `The trend gate did not pass; ${formatNumber(trend.observationCount ?? 0)} daily observations cover ${formatNumber(trend.windowElapsedDays ?? 0)} elapsed days.`,
      value: trend.trendReady === true,
      unit: 'trend_ready',
    });
  }

  const revenue = deps.revenue?.data;
  if (revenue && isRevenueObjective(deps.objective!.data.objective)) {
    addFact({
      source: 'revenue',
      kind: 'derived',
      statement: revenue.financialDataAvailable
        ? `Campaign-scoped return evidence and product economics passed the financial-data gate.`
        : `Campaign-scoped return evidence or product economics did not pass the financial-data gate.`,
      value: revenue.financialDataAvailable,
      unit: 'financial_gate',
      targetType: 'campaign',
      targetId: input.identity.campaignId,
    });
    if (revenue.financialDataAvailable) {
      const snapshot = deps.snapshot!.data as unknown as SnapshotData;
      addFact({
        source: 'revenue',
        kind: 'derived',
        statement: `The verified campaign raw ROAS is ${formatMetric(revenue.netRevenue / Math.max(1, snapshot.metrics.campaignLevel.spend), 'x')} and the product breakeven ROAS is ${formatMetric(revenue.breakeven.roas, 'x')}.`,
        value: revenue.breakeven.roas,
        unit: 'breakeven_roas',
        targetType: 'campaign',
        targetId: input.identity.campaignId,
      });
    } else {
      unknowns.push({
        code: 'financial_evidence_withheld',
        statement:
          'Financial conclusions are withheld because exact return provenance or product economics is incomplete.',
        effect: 'blocks_recommendation',
      });
    }
  }

  for (const signal of deps.signal?.data.signals ?? []) {
    if (
      signal.targetType !== action.targetType ||
      signal.targetId !== action.targetId
    ) {
      continue;
    }
    addFact({
      source: 'signal',
      kind: 'derived',
      statement: `The deterministic ${humanize(signal.kind)} rule fired on this exact target: ${signal.reasoning}`,
      value: signal.strength,
      unit: 'signal_strength',
      targetType: signal.targetType,
      targetId: signal.targetId,
    });
  }

  const causes = (deps.diagnosis?.data.rootCauses ?? []).filter(
    (cause) =>
      cause.targetType === action.targetType &&
      cause.targetId === action.targetId,
  );
  if (causes.length > 0) {
    const cause = causes[0];
    addFact({
      source: 'diagnosis',
      kind: 'model_output',
      statement: `The deterministic diagnosis proposes “${cause.hypothesis}” for this exact target with ${formatMetric(cause.confidence, 'ratio')} confidence.`,
      value: cause.confidence,
      unit: 'diagnosis_confidence',
      targetType: action.targetType,
      targetId: action.targetId,
    });
  } else {
    unknowns.push({
      code: 'exact_root_cause_unresolved',
      statement:
        'No corroborated root cause was established on the exact action target.',
      effect: 'blocks_diagnosis',
    });
  }

  const business = deps.business?.data;
  if (business) {
    addFact({
      source: 'business',
      kind: 'policy',
      statement: `The configured weekly budget headroom is ₹${formatNumber(business.budgetPolicy.weeklyCapRemainingINR)}.`,
      value: business.budgetPolicy.weeklyCapRemainingINR,
      unit: 'INR',
    });
  }

  const portfolio = deps.portfolio?.data;
  const rank = portfolio?.ranking?.find(
    (entry) => entry.campaignId === input.identity.campaignId,
  );
  if (rank) {
    addFact({
      source: 'portfolio',
      kind: 'derived',
      statement: `The deterministic portfolio ranking places this campaign in tier ${rank.tier}.`,
      value: rank.tier,
      unit: 'portfolio_tier',
      targetType: 'campaign',
      targetId: input.identity.campaignId,
    });
  }

  const forecast = deps.forecast?.data;
  if (forecast) {
    addFact({
      source: 'forecast',
      kind: 'model_output',
      statement: `The forecast method is ${humanize(forecast.method)}; it is a model projection, not an observed result.`,
      value: forecast.method,
      unit: 'forecast_method',
      targetType: 'campaign',
      targetId: input.identity.campaignId,
    });
  }

  const confidence = deps.confidence?.data;
  if (confidence) {
    addFact({
      source: 'confidence',
      kind: 'derived',
      statement: `The deterministic evidence-readiness score is ${formatMetric(confidence.overall, 'ratio')}; execution readiness is ${confidence.gates.okToExecute ? 'open' : 'held'}.`,
      value: confidence.overall,
      unit: 'confidence',
    });
  }

  const sameTargetPast = (deps.memory?.data.pastActions ?? []).filter(
    (past) => past.targetId === action.targetId,
  );
  if (sameTargetPast.length > 0) {
    addFact({
      source: 'memory',
      kind: 'observed',
      statement: `The exact target has ${sameTargetPast.length} recorded prior action outcome${sameTargetPast.length === 1 ? '' : 's'}.`,
      value: sameTargetPast.length,
      unit: 'outcomes',
      targetType: action.targetType,
      targetId: action.targetId,
    });
  }

  addFact({
    source: 'recommendation',
    kind: 'model_output',
    statement: `The deterministic cascade proposed ${humanize(action.type)} on the exact ${humanize(action.targetType)} target; the OpenAI reviewer cannot change it.`,
    value: action.type,
    unit: 'action',
    targetType: action.targetType,
    targetId: action.targetId,
  });
}

function chooseAdSets(
  action: RecommendedAction,
  ads: Record<string, SnapshotAdEntity> | undefined,
  adSets: Array<[string, MetricSet]>,
  adMetrics: Array<[string, AdMetricSet]>,
): string[] {
  if (action.targetType === 'adset') {
    const recipient =
      action.type === 'shift_budget_between_adsets' &&
      typeof action.parameters.toAdSetId === 'string'
        ? action.parameters.toAdSetId.trim()
        : '';
    return [...new Set([action.targetId, recipient].filter(Boolean))];
  }
  if (action.targetType === 'ad') {
    const parent = ads?.[action.targetId]?.adSetId;
    return parent ? [parent] : [];
  }
  return [...adSets]
    .sort((a, b) => b[1].spend - a[1].spend)
    .slice(0, 3)
    .map(([id]) => id)
    .filter((id) =>
      adMetrics.length === 0
        ? true
        : adSets.some(([candidate]) => candidate === id),
    );
}

function goalMeasurementForTarget(
  snapshot: SnapshotData,
  level: 'adset' | 'ad',
  entityId: string,
): GoalEfficiencyMeasurementResult | null {
  const row = buildSnapshotGoalEfficiencyRow({ snapshot, level, entityId });
  return row ? measureGoalEfficiency(row) : null;
}

function homogeneousOptimizationGoal(
  adSets: Record<string, SnapshotAdSetEntity> | undefined,
): string | undefined {
  const rows = Object.values(adSets ?? {});
  if (rows.length === 0) return undefined;
  if (
    rows.some(
      (row) =>
        !cleanLabel(row.effectiveStatus ?? row.status) ||
        !cleanLabel(row.optimizationGoal),
    )
  ) {
    return undefined;
  }
  const activeGoals = rows
    .filter(
      (row) =>
        cleanLabel(row.effectiveStatus ?? row.status).toUpperCase() ===
        'ACTIVE',
    )
    .map((row) => cleanLabel(row.optimizationGoal));
  const unique = [...new Set(activeGoals)];
  return unique.length === 1 ? unique[0] : undefined;
}

function chooseAds(
  action: RecommendedAction,
  selectedAdSetIds: string[],
  ads: Record<string, SnapshotAdEntity> | undefined,
  metrics: Array<[string, AdMetricSet]>,
): string[] {
  if (action.targetType === 'ad') return [action.targetId];
  const allowed = new Set(selectedAdSetIds);
  const candidates = metrics.filter(([id]) => {
    const parent = ads?.[id]?.adSetId;
    return parent ? allowed.has(parent) : false;
  });
  const byParent = new Map<string, [string, AdMetricSet]>();
  for (const entry of candidates.sort((a, b) => b[1].spend - a[1].spend)) {
    const parent = ads?.[entry[0]]?.adSetId;
    if (parent && !byParent.has(parent)) byParent.set(parent, entry);
  }
  return [...byParent.values()].slice(0, 3).map(([id]) => id);
}

function metricsForTarget(
  snapshot: SnapshotData,
  targetType: RecommendedAction['targetType'],
  targetId: string,
  campaignId: string,
): MetricSet | AdMetricSet | undefined {
  if (targetType === 'campaign') {
    return targetId === campaignId ? snapshot.metrics.campaignLevel : undefined;
  }
  if (targetType === 'adset') return snapshot.metrics.adSetLevel[targetId];
  return snapshot.metrics.adLevel[targetId];
}

function diagnosticMetricKeys(
  objective: ObjectiveData,
  financialDataAvailable: boolean,
): string[] {
  const scored = scoredMetricFor(objective.objective).metric;
  return [...new Set(['spend', scored, ...objective.supportingKPIs])]
    .filter(
      (key) => financialDataAvailable || (key !== 'roas' && key !== 'revenue'),
    )
    .slice(0, 5);
}

function numericMetric(
  metrics: MetricSet | AdMetricSet | undefined,
  key: string,
): number | null {
  if (!metrics) return null;
  const value = (metrics as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metricEvidenceKind(key: string): 'observed' | 'derived' {
  return ['revenue', 'roas', 'cvr', 'aov', 'rawRoas'].includes(key)
    ? 'derived'
    : 'observed';
}

function isCreativeMutation(action: RecommendedAction): boolean {
  return action.type === 'replace_creative' || action.type === 'add_creative';
}

function hasCreativeIdentity(
  creative: NonNullable<SnapshotAdEntity['creative']>,
): boolean {
  return Boolean(
    creative.id ||
    cleanLabel(creative.name) ||
    cleanLabel(creative.title) ||
    cleanLabel(creative.body) ||
    safeUrl(creative.thumbnailUrl),
  );
}

function metricLabel(key: string): string {
  const labels: Record<string, string> = {
    spend: 'spend',
    revenue: 'attributed value',
    roas: 'raw ROAS',
    ctr: 'CTR',
    cvr: 'conversion rate',
    cpc: 'cost per click',
    cpm: 'cost per thousand impressions',
    reach: 'reach',
    impressions: 'impressions',
    clicks: 'clicks',
    purchases: 'sales conversions',
    frequency: 'frequency',
    aov: 'average order value',
  };
  return labels[key] ?? humanize(key);
}

function metricUnit(key: string): string {
  if (
    key === 'spend' ||
    key === 'revenue' ||
    key === 'cpc' ||
    key === 'cpm' ||
    key === 'aov'
  )
    return 'INR';
  if (key === 'roas' || key === 'frequency') return 'x';
  if (key === 'ctr') return 'percent';
  if (key === 'cvr') return 'ratio';
  return 'count';
}

function formatMetric(value: number, unit: string): string {
  if (unit === 'INR' || unit === 'currency') return `₹${formatNumber(value)}`;
  if (/^[A-Z]{3}$/.test(unit)) return `${unit} ${formatNumber(value)}`;
  if (unit === 'x' || unit === 'rawRoas') return `${value.toFixed(2)}×`;
  if (unit === 'percent') return `${value.toFixed(2)}%`;
  if (unit === 'ratio') return `${Math.round(value * 1000) / 10}%`;
  return formatNumber(value);
}

function displayGoalUnit(unit: string, currency: string): string {
  return unit === 'currency' ? currency : unit;
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanLabel(value: unknown, max = 120): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
}

function compact(value: string, max: number): string {
  return cleanLabel(value, max);
}

function safeUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\//i.test(value);
}

function shortId(value: string): string {
  return value.length > 8 ? `…${value.slice(-8)}` : value;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(
    value,
  );
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown time';
}
