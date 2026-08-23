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
});
