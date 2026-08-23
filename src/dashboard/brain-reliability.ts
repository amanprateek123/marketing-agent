import { round } from '../common/economics/economics';
import {
  ENGINE_SLICE_KEYS,
  EngineSliceKey,
} from '../intelligence/orchestrator/decision-context';
import { DashboardCampaignRow, ToolImpactOverview } from './dashboard.types';

type UnknownRow = Record<string, any>;

/**
 * Confidence v1.0 predates objective-aware statistical-power and source-
 * freshness gates. Its persisted `okToRecommend=true` can coexist with a
 * `power<0.5` blocker, so it is historical trace evidence—not a current
 * safety-readiness result. Accept v1.2+ and future compatible versions.
 */
const hasCurrentConfidenceContract = (version: unknown): boolean => {
  const match = /^confidence@(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ''));
  if (!match) return false;
  const [, majorRaw, minorRaw] = match;
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  return major > 1 || (major === 1 && minor >= 2);
};

export interface BrainReliabilityInput {
  tenantId: string;
  exactCampaignIds: string[];
  campaignRows: DashboardCampaignRow[];
  cycles: UnknownRow[];
  engineOutputs: UnknownRow[];
  decisions: UnknownRow[];
  executedActions: UnknownRow[];
  now: Date;
  windowDays: number;
  minimumConclusiveOutcomes: number;
}

const isFiniteDate = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(new Date(value as string | number | Date).getTime());
};

/**
 * Select the exact, recent cycle ids whose slices the dashboard may load.
 * `buildBrainReliability` repeats these checks before constructing any
 * denominator, so the database predicate and response calculation each keep
 * their own tenant/cohort boundary.
 */
export function brainReliabilityCycleIds(input: {
  cycles: UnknownRow[];
  exactCampaignIds: string[];
  now: Date;
  windowDays: number;
}): string[] {
  const fromMs = input.now.getTime() - input.windowDays * 864e5;
  const exactCampaignIdSet = new Set(input.exactCampaignIds);
  return [
    ...new Set(
      input.cycles
        .filter((cycle) => {
          if (!exactCampaignIdSet.has(String(cycle.campaignId ?? ''))) {
            return false;
          }
          if (!isFiniteDate(cycle.startedAt)) return false;
          const startedAt = new Date(cycle.startedAt).getTime();
          return startedAt >= fromMs && startedAt <= input.now.getTime();
        })
        .map((cycle) => String(cycle.cycleId ?? '').trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Build four independently-denominated checks of the intelligence system's
 * operating evidence. There is deliberately no composite score: completing
 * a pipeline, passing a safety gate, writing a prediction, and observing a
 * later campaign result are different facts.
 */
export function buildBrainReliability(
  input: BrainReliabilityInput,
): ToolImpactOverview['brainReliability'] {
  const {
    tenantId,
    exactCampaignIds,
    campaignRows,
    cycles,
    engineOutputs,
    decisions,
    executedActions,
    now,
    windowDays,
    minimumConclusiveOutcomes,
  } = input;
  const from = new Date(now.getTime() - windowDays * 864e5);
  const exactCampaignIdSet = new Set(exactCampaignIds);

  // The query is already scoped. Re-check here so an over-broad mock,
  // migration view, or future query refactor cannot contaminate a denominator.
  const reliabilityCycles = cycles.filter((cycle) => {
    if (!exactCampaignIdSet.has(String(cycle.campaignId ?? ''))) return false;
    if (!isFiniteDate(cycle.startedAt)) return false;
    const startedAt = new Date(cycle.startedAt).getTime();
    return startedAt >= from.getTime() && startedAt <= now.getTime();
  });
  const reliabilityCycleIdSet = new Set(
    reliabilityCycles
      .map((cycle) => String(cycle.cycleId ?? '').trim())
      .filter(Boolean),
  );

  const knownEngines = new Set<string>(ENGINE_SLICE_KEYS);
  const outputsByCycle = new Map<string, Map<EngineSliceKey, UnknownRow>>();
  for (const output of engineOutputs) {
    const cycleId = String(output.cycleId ?? '').trim();
    const campaignId = String(output.campaignId ?? '').trim();
    const engine = String(output.engine ?? '');
    if (
      output.tenantId !== tenantId ||
      !exactCampaignIdSet.has(campaignId) ||
      !reliabilityCycleIdSet.has(cycleId) ||
      !knownEngines.has(engine)
    ) {
      continue;
    }
    const byEngine = outputsByCycle.get(cycleId) ?? new Map();
    // The collection has a unique (cycleId, engine) index. The map also makes
    // malformed duplicate data count once, never as a seventeenth step.
    if (!byEngine.has(engine as EngineSliceKey)) {
      byEngine.set(engine as EngineSliceKey, output);
    }
    outputsByCycle.set(cycleId, byEngine);
  }

  const requiredSteps = ENGINE_SLICE_KEYS.length;
  const stepsForCycle = (cycleId: string): number =>
    outputsByCycle.get(cycleId)?.size ?? 0;
  const fullTraceCycles = reliabilityCycles.filter(
    (cycle) => stepsForCycle(String(cycle.cycleId ?? '')) === requiredSteps,
  ).length;
  const partialTraceCycles = reliabilityCycles.filter((cycle) => {
    const count = stepsForCycle(String(cycle.cycleId ?? ''));
    return count > 0 && count < requiredSteps;
  }).length;
  const unavailableTraceCycles =
    reliabilityCycles.length - fullTraceCycles - partialTraceCycles;

  type ParsedGate = {
    okToRecommend: boolean;
    okToExecute: boolean;
    reasonsBlocked: string[];
    confidenceOverall: number | null;
  };
  const gateByCycle = new Map<string, ParsedGate>();
  for (const cycle of reliabilityCycles) {
    const cycleId = String(cycle.cycleId ?? '');
    const output = outputsByCycle.get(cycleId)?.get('confidence');
    if (!hasCurrentConfidenceContract(output?.slice?.version)) continue;
    const data = output?.slice?.data;
    const gates = data?.gates;
    // Do not infer a gate result from a confidence number or reason string.
    // Both persisted booleans are required; malformed history fails closed.
    if (
      typeof gates?.okToRecommend !== 'boolean' ||
      typeof gates?.okToExecute !== 'boolean'
    ) {
      continue;
    }
    const rawReasons: unknown[] = Array.isArray(gates.reasonsBlocked)
      ? gates.reasonsBlocked
      : [];
    const reasonsBlocked: string[] = [
      ...new Set(
        rawReasons
          .filter(
            (reason): reason is string =>
              typeof reason === 'string' && reason.trim().length > 0,
          )
          .map((reason) => reason.trim()),
      ),
    ];
    const overall = data?.overall;
    gateByCycle.set(cycleId, {
      okToRecommend: gates.okToRecommend,
      okToExecute: gates.okToExecute,
      reasonsBlocked,
      confidenceOverall:
        typeof overall === 'number' &&
        Number.isFinite(overall) &&
        overall >= 0 &&
        overall <= 1
          ? overall
          : null,
    });
  }

  const evaluatedGates = [...gateByCycle.values()];
  const recommendPassed = evaluatedGates.filter(
    (gate) => gate.okToRecommend,
  ).length;
  const recommendHeld = evaluatedGates.length - recommendPassed;
  const executionEvidencePassed = evaluatedGates.filter(
    (gate) => gate.okToExecute,
  ).length;
  const blockerCounts = new Map<string, number>();
  for (const gate of evaluatedGates) {
    if (gate.okToRecommend) continue;
    const recommendReasons = gate.reasonsBlocked.filter((reason) =>
      reason.startsWith('recommend:'),
    );
    const reasons =
      recommendReasons.length > 0
        ? recommendReasons
        : ['recommend:reason_unavailable'];
    for (const reason of new Set(reasons)) {
      // Confidence reasons include the observed value in parentheses. Strip
      // that volatile suffix for aggregation while recent-cycle detail keeps
      // the complete persisted reason available for audit.
      const code = reason.replace(/\s+\([^)]*\)$/, '');
      blockerCounts.set(code, (blockerCounts.get(code) ?? 0) + 1);
    }
  }

  const reliabilityDecisions = decisions.filter(
    (decision) =>
      exactCampaignIdSet.has(String(decision.campaignId ?? '')) &&
      reliabilityCycleIdSet.has(String(decision.cycleId ?? '')),
  );
  const predictionStatuses = {
    shadow_review: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
  };
  let unrecognizedPredictionStatus = 0;
  for (const decision of reliabilityDecisions) {
    const status = decision.status as keyof typeof predictionStatuses;
    if (status in predictionStatuses) predictionStatuses[status]++;
    else unrecognizedPredictionStatus++;
  }
  const goalAwareDecisions = reliabilityDecisions.filter(
    (decision) => decision.decisionContractVersion === 'goal_aware_v1',
  );
  const completePredictions = goalAwareDecisions.filter((decision) => {
    const expected = decision.expectedImpact;
    const deltaPct = expected?.deltaPct;
    const confidence = expected?.confidence;
    return (
      typeof decision.objective === 'string' &&
      decision.objective.trim().length > 0 &&
      typeof decision.primaryKPI === 'string' &&
      decision.primaryKPI.trim().length > 0 &&
      typeof expected?.metric === 'string' &&
      expected.metric.trim().length > 0 &&
      typeof deltaPct === 'number' &&
      Number.isFinite(deltaPct) &&
      typeof confidence === 'number' &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1
    );
  }).length;

  // These are cohort action records, not intelligence-decision outcomes. The
  // schema currently has no source decision id, so linkage and accuracy remain
  // explicitly unavailable even if campaign/action names happen to resemble.
  const reliabilityActions = executedActions.filter((action) => {
    if (!exactCampaignIdSet.has(String(action.campaignId ?? ''))) return false;
    if (!isFiniteDate(action.executedAt)) return false;
    const executedAt = new Date(action.executedAt).getTime();
    return executedAt >= from.getTime() && executedAt <= now.getTime();
  });
  const hasMeasurement = (value: unknown): boolean =>
    Boolean(value && typeof value === 'object');
  const due24h = reliabilityActions.filter(
    (action) =>
      isFiniteDate(action.evaluateAt24h) &&
      new Date(action.evaluateAt24h).getTime() <= now.getTime(),
  );
  const measured24h = due24h.filter((action) =>
    hasMeasurement(action.metricsAtT24h),
  ).length;
  const due72h = reliabilityActions.filter(
    (action) =>
      isFiniteDate(action.evaluateAt72h) &&
      new Date(action.evaluateAt72h).getTime() <= now.getTime(),
  );
  const knownOutcomeLabels = new Set([
    'improved',
    'worsened',
    'neutral',
    'inconclusive',
  ]);
  const finalized72hActions = due72h.filter(
    (action) =>
      action.status === 'final' &&
      hasMeasurement(action.metricsAtT72h) &&
      knownOutcomeLabels.has(String(action.outcomeLabel ?? '')),
  );
  const outcomeLabels = {
    improved: 0,
    worsened: 0,
    neutral: 0,
    inconclusive: 0,
  };
  for (const action of finalized72hActions) {
    const label = action.outcomeLabel as keyof typeof outcomeLabels;
    outcomeLabels[label]++;
  }
  const conclusive72h =
    outcomeLabels.improved + outcomeLabels.worsened + outcomeLabels.neutral;
  const reportable = conclusive72h >= minimumConclusiveOutcomes;

  const decisionsByCycle = new Map<string, number>();
  for (const decision of reliabilityDecisions) {
    const cycleId = String(decision.cycleId ?? '');
    decisionsByCycle.set(cycleId, (decisionsByCycle.get(cycleId) ?? 0) + 1);
  }
  const campaignNames = new Map(
    campaignRows.map((campaign) => [campaign.id, campaign.name]),
  );
  const recentCycles = [...reliabilityCycles]
    .sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    )
    .slice(0, 5)
    .map((cycle) => {
      const cycleId = String(cycle.cycleId ?? '');
      const campaignId = String(cycle.campaignId ?? '');
      const gate = gateByCycle.get(cycleId);
      return {
        cycleId,
        campaignId,
        campaignName: campaignNames.get(campaignId) ?? 'Unknown campaign',
        startedAt: new Date(cycle.startedAt).toISOString(),
        status: cycle.status as 'pending' | 'completed' | 'failed',
        stepsRecorded: stepsForCycle(cycleId),
        requiredSteps: 16 as const,
        confidenceOverall: gate?.confidenceOverall ?? null,
        recommendGate: !gate
          ? ('unavailable' as const)
          : gate.okToRecommend
            ? ('passed' as const)
            : ('held' as const),
        executionEvidenceGate: !gate
          ? ('unavailable' as const)
          : gate.okToExecute
            ? ('passed' as const)
            : ('held' as const),
        decisionsWritten: decisionsByCycle.get(cycleId) ?? 0,
        reasonsBlocked: gate?.reasonsBlocked ?? [],
      };
    });

  return {
    label: 'Operating evidence — not causal uplift or prediction accuracy',
    window: {
      days: windowDays,
      from: from.toISOString(),
      to: now.toISOString(),
      cohort: 'exact_verified_tool_launches',
    },
    cycleCompleteness: {
      requiredSteps: 16,
      cyclesRun: reliabilityCycles.length,
      statusCompleted: reliabilityCycles.filter(
        (cycle) => cycle.status === 'completed',
      ).length,
      failed: reliabilityCycles.filter((cycle) => cycle.status === 'failed')
        .length,
      pending: reliabilityCycles.filter((cycle) => cycle.status === 'pending')
        .length,
      fullTraceCycles,
      partialTraceCycles,
      unavailableTraceCycles,
      fullTraceRatePct:
        reliabilityCycles.length > 0
          ? round((fullTraceCycles / reliabilityCycles.length) * 100, 1)
          : null,
    },
    gateReadiness: {
      evaluatedCycles: evaluatedGates.length,
      unavailableCycles: reliabilityCycles.length - evaluatedGates.length,
      recommendPassed,
      recommendHeld,
      recommendPassRatePct:
        evaluatedGates.length > 0
          ? round((recommendPassed / evaluatedGates.length) * 100, 1)
          : null,
      executionEvidencePassed,
      executionEvidenceHeld: evaluatedGates.length - executionEvidencePassed,
      topRecommendBlockers: [...blockerCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
        .slice(0, 5),
    },
    predictions: {
      decisions: reliabilityDecisions.length,
      goalAwareDecisions: goalAwareDecisions.length,
      completePredictions,
      legacyOrIncomplete: reliabilityDecisions.length - completePredictions,
      contractCoveragePct:
        reliabilityDecisions.length > 0
          ? round((completePredictions / reliabilityDecisions.length) * 100, 1)
          : null,
      byStatus: predictionStatuses,
      unrecognizedStatus: unrecognizedPredictionStatus,
      executionSucceeded: reliabilityDecisions.filter(
        (decision) =>
          decision.executionStatus === 'succeeded' &&
          isFiniteDate(decision.executedAt),
      ).length,
      executionFailedOrBlocked: reliabilityDecisions.filter((decision) =>
        ['failed', 'blocked'].includes(String(decision.executionStatus)),
      ).length,
    },
    outcomes: {
      scope: 'campaign_cohort_actions_unlinked_to_predictions',
      recorded: reliabilityActions.length,
      due24h: due24h.length,
      measured24h,
      overdue24h: due24h.length - measured24h,
      notYetDue24h: reliabilityActions.length - due24h.length,
      due72h: due72h.length,
      finalized72h: finalized72hActions.length,
      overdue72h: due72h.length - finalized72hActions.length,
      notYetDue72h: reliabilityActions.length - due72h.length,
      conclusive72h,
      byLabel: outcomeLabels,
      minimumConclusiveSample: minimumConclusiveOutcomes,
      improvedRatePct: reportable
        ? round((outcomeLabels.improved / conclusive72h) * 100, 1)
        : null,
      reportable,
      predictionAccuracyPct: null,
      limitation:
        'Campaign action records do not preserve an intelligence decision identifier, so observed checkpoints cannot be attributed one-to-one to the predictions above.',
    },
    recentCycles,
  };
}
