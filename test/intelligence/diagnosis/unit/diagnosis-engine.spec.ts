import { DiagnosisEngine } from '../../../../src/intelligence/diagnosis/diagnosis-engine.service';
import { SliceRepository } from '../../../../src/intelligence/shared/slice-repository.service';
import { EngineEventBus } from '../../../../src/intelligence/shared/engine-event-bus.service';
import { EngineRegistry } from '../../../../src/intelligence/shared/engine-registry';
import { EngineContext } from '../../../../src/intelligence/shared/engine-context';
import { ComputeDeps } from '../../../../src/intelligence/shared/engine.interface';
import {
  DiagnosisData,
  Signal,
  SignalKind,
} from '../../../../src/intelligence/orchestrator/decision-context';

class TestableDiagnosisEngine extends DiagnosisEngine {
  run(deps: ComputeDeps<'diagnosis'>) {
    return this.compute(deps);
  }

  confidence(data: DiagnosisData) {
    return this.computeConfidence({} as ComputeDeps<'diagnosis'>, data);
  }
}

const context = <T>(data: T): EngineContext<T> => ({
  data,
  confidence: 0.9,
  evidence: [],
  version: 'test@1',
  computedAt: new Date('2026-08-23T00:00:00.000Z'),
  ms: 1,
  deterministic: true,
});

const signal = (
  kind: SignalKind,
  strength = 1,
  targetType: Signal['targetType'] = 'campaign',
  targetId = 'campaign-1',
): Signal => ({
  kind,
  severity: 'critical',
  targetType,
  targetId,
  metricEvidence: {},
  trigger: kind,
  strength,
  reasoning: `${kind} observed`,
  firstSeenAt: new Date('2026-08-23T00:00:00.000Z'),
});

const goalSignal = (
  kind:
    | 'optimization_goal_efficiency_lagging'
    | 'optimization_goal_efficiency_leading',
  targetType: Signal['targetType'],
  targetId: string,
): Signal => ({
  ...signal(kind, 0.8, targetType, targetId),
  goalEvidence: {
    optimizationGoal: 'LANDING_PAGE_VIEWS',
    resultMetric: 'landing_page_views',
    efficiencyMetric: 'cost_per_landing_page_view',
    efficiencyUnit: 'currency',
    lowerIsBetter: true,
    current: { spend: 450, result: 30, efficiency: 15 },
    pooledSiblingBaseline: {
      peerCount: 2,
      peerIds: ['peer-1', 'peer-2'],
      spend: 500,
      result: 100,
      efficiency: 5,
    },
    observedGap: {
      thresholdMultiple: 1.5,
      multiple: 3,
      unbounded: false,
      direction: kind.endsWith('lagging') ? 'worse' : 'better',
    },
    window: {
      dateStart: '2026-08-01',
      dateStop: '2026-08-22',
      metricScope: 'lifetime',
    },
    sourceFingerprint: 'same-query',
    currency: 'INR',
    claimScope: 'observational_same_window_peer_comparison',
    causalClaim: false,
    expectedUplift: null,
  },
});

function deps(signals: Signal[]): ComputeDeps<'diagnosis'> {
  return {
    signal: context({ signals }),
    trend: context({}),
    revenue: context({
      breakeven: { isProfitable: true },
    }),
    objective: context({}),
  } as unknown as ComputeDeps<'diagnosis'>;
}

describe('DiagnosisEngine corroboration gates', () => {
  let engine: TestableDiagnosisEngine;

  beforeEach(() => {
    engine = new TestableDiagnosisEngine(
      {} as SliceRepository,
      {} as EngineEventBus,
      {} as EngineRegistry,
    );
  });

  it('does not infer creative and audience causes from frequency alone', async () => {
    const result = await engine.run(deps([signal('frequency_ceiling')]));

    expect(result.rootCauses).toEqual([]);
    expect(result.narrative).toContain(
      'No supported root cause emerged from the available evidence',
    );
    expect(result.narrative).not.toContain('No structural issues detected');
    expect(engine.confidence(result)).toBeLessThan(0.5);
  });

  it('infers creative fatigue only when CTR decay corroborates frequency', async () => {
    const result = await engine.run(
      deps([signal('frequency_ceiling', 0.9), signal('ctr_decay', 0.8)]),
    );

    expect(result.rootCauses).toEqual([
      expect.objectContaining({
        hypothesis: 'Creative fatigue driven by over-frequency',
        targetType: 'campaign',
        targetId: 'campaign-1',
        evidenceSignals: ['ctr_decay', 'frequency_ceiling'],
        suggestedFocus: 'creative',
      }),
    ]);
  });

  it('keeps a singleton hook-burn hypothesis scoped to the exact video ad', async () => {
    const result = await engine.run(
      deps([signal('hook_burn', 0.8, 'ad', 'ad-video-1')]),
    );

    expect(result.rootCauses).toEqual([
      expect.objectContaining({
        hypothesis: 'Weak video-opening engagement on this ad',
        targetType: 'ad',
        targetId: 'ad-video-1',
        evidenceSignals: ['hook_burn'],
        confidence: 0.8,
        suggestedFocus: 'creative',
      }),
    ]);
    expect(result.narrative).toContain('target=ad:ad-video-1');
  });

  it('infers audience exhaustion only when saturation corroborates frequency', async () => {
    const result = await engine.run(
      deps([
        signal('frequency_ceiling', 0.9),
        signal('audience_saturation', 0.8),
      ]),
    );

    expect(result.rootCauses).toEqual([
      expect.objectContaining({
        hypothesis: 'Audience pool exhausted',
        targetType: 'campaign',
        targetId: 'campaign-1',
        evidenceSignals: ['audience_saturation', 'frequency_ceiling'],
        suggestedFocus: 'audience',
      }),
    ]);
  });

  it('does not combine corroborating signals from different ad sets', async () => {
    const result = await engine.run(
      deps([
        signal('frequency_ceiling', 0.9, 'adset', 'adset-a'),
        signal('ctr_decay', 0.8, 'adset', 'adset-b'),
      ]),
    );

    expect(result.rootCauses).toEqual([]);
  });

  it('persists one target-scoped diagnosis per independently corroborated ad set', async () => {
    const result = await engine.run(
      deps([
        signal('frequency_ceiling', 0.9, 'adset', 'adset-a'),
        signal('ctr_decay', 0.8, 'adset', 'adset-a'),
        signal('frequency_ceiling', 0.7, 'adset', 'adset-b'),
        signal('ctr_decay', 0.6, 'adset', 'adset-b'),
      ]),
    );

    expect(result.rootCauses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetType: 'adset',
          targetId: 'adset-a',
          evidenceSignals: ['ctr_decay', 'frequency_ceiling'],
        }),
        expect.objectContaining({
          targetType: 'adset',
          targetId: 'adset-b',
          evidenceSignals: ['ctr_decay', 'frequency_ceiling'],
        }),
      ]),
    );
  });

  it('keeps an ad-set goal-efficiency lag explicitly cause-unresolved', async () => {
    const result = await engine.run(
      deps([
        goalSignal('optimization_goal_efficiency_lagging', 'adset', 'adset-a'),
        signal('ctr_decay', 0.8, 'adset', 'adset-a'),
      ]),
    );
    const diagnosis = result.rootCauses.find((candidate) =>
      candidate.evidenceSignals.includes(
        'optimization_goal_efficiency_lagging',
      ),
    );

    expect(diagnosis).toMatchObject({
      targetType: 'adset',
      targetId: 'adset-a',
      suggestedFocus: 'delivery_efficiency',
      evidenceSignals: ['optimization_goal_efficiency_lagging'],
      goalEvidence: {
        optimizationGoal: 'LANDING_PAGE_VIEWS',
        causalClaim: false,
        expectedUplift: null,
      },
    });
    expect(diagnosis?.hypothesis).toContain('Cause remains unresolved');
    expect(diagnosis?.hypothesis).toContain('does not establish creative');
    expect(diagnosis?.hypothesis).toContain('no uplift is predicted');
  });

  it('adds a bounded creative hypothesis only for the exact ad with corroborating creative evidence', async () => {
    const result = await engine.run(
      deps([
        goalSignal('optimization_goal_efficiency_lagging', 'ad', 'ad-a'),
        signal('hook_burn', 0.7, 'ad', 'ad-a'),
        signal('hook_burn', 0.9, 'ad', 'ad-b'),
      ]),
    );
    const diagnosis = result.rootCauses.find((candidate) =>
      candidate.evidenceSignals.includes(
        'optimization_goal_efficiency_lagging',
      ),
    );

    expect(diagnosis).toMatchObject({
      targetType: 'ad',
      targetId: 'ad-a',
      suggestedFocus: 'creative',
      evidenceSignals: ['optimization_goal_efficiency_lagging', 'hook_burn'],
    });
    expect(diagnosis?.hypothesis).toContain(
      'creative contribution is plausible, not proven',
    );
    expect(
      result.rootCauses.filter(
        (candidate) =>
          candidate.targetId === 'ad-a' &&
          candidate.evidenceSignals.includes('hook_burn'),
      ),
    ).toHaveLength(1);
  });

  it('describes a leader as observational, not confirmed or causal', async () => {
    const result = await engine.run(
      deps([
        goalSignal('optimization_goal_efficiency_leading', 'adset', 'adset-a'),
      ]),
    );

    expect(result.rootCauses).toEqual([
      expect.objectContaining({
        suggestedFocus: 'delivery_efficiency',
        hypothesis: expect.stringContaining(
          'no causal driver, scale outcome, or future uplift is established',
        ),
      }),
    ]);
  });
});
