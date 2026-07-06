import {
  DEFAULT_FEATURE_FLAGS,
  ENGINE_SLICE_KEYS,
  ENGINE_STEP,
  assertHas,
  createDecisionContext,
  isEngineSliceKey,
} from '../../../src/intelligence/orchestrator/decision-context';

describe('decision-context: types + factory', () => {
  it('createDecisionContext returns a fully initialised DecisionContext', () => {
    const dc = createDecisionContext({
      cycleId: 'c-1',
      tenantId: 't-1',
      campaignId: 'cam-1',
    });
    expect(dc.cycleId).toBe('c-1');
    expect(dc.tenantId).toBe('t-1');
    expect(dc.campaignId).toBe('cam-1');
    expect(dc.startedAt).toBeInstanceOf(Date);
    expect(dc.timings).toEqual({});
    expect(dc.errors).toEqual([]);
    expect(dc.skipped).toEqual([]);
    expect(dc.audit).toEqual([]);
    expect(dc.featureFlags).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('createDecisionContext accepts feature flag overrides', () => {
    const dc = createDecisionContext({
      cycleId: 'c-1',
      tenantId: 't-1',
      campaignId: 'cam-1',
      featureFlags: { intelligenceV2: true, contextsEnabled: 5 },
    });
    expect(dc.featureFlags.intelligenceV2).toBe(true);
    expect(dc.featureFlags.contextsEnabled).toBe(5);
    // Others fall back to defaults
    expect(dc.featureFlags.executeEnabled).toBe(false);
  });

  it('exports all 16 slice keys in step order', () => {
    expect(ENGINE_SLICE_KEYS).toHaveLength(16);
    // ENGINE_STEP maps each slice to a monotonic 1..16 index
    const steps = ENGINE_SLICE_KEYS.map((k) => ENGINE_STEP[k]);
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('isEngineSliceKey narrows unknown strings', () => {
    expect(isEngineSliceKey('snapshot')).toBe(true);
    expect(isEngineSliceKey('objective')).toBe(true);
    expect(isEngineSliceKey('learning')).toBe(true);
    expect(isEngineSliceKey('nonsense')).toBe(false);
    expect(isEngineSliceKey('')).toBe(false);
  });
});

describe('decision-context: assertHas', () => {
  it('throws when required slice missing', () => {
    const dc = createDecisionContext({ cycleId: 'c', tenantId: 't', campaignId: 'cam' });
    expect(() => assertHas(dc, 'snapshot')).toThrow(/missing required engine output: snapshot/);
  });

  it('passes when slice is populated', () => {
    const dc = createDecisionContext({ cycleId: 'c', tenantId: 't', campaignId: 'cam' });
    dc.snapshot = {
      data: { snapshotId: 's1', collectedAt: new Date() },
      confidence: 0.9,
      evidence: [],
      version: 'snapshot@1.0.0',
      computedAt: new Date(),
      ms: 12,
      deterministic: false,
    };
    expect(() => assertHas(dc, 'snapshot')).not.toThrow();
  });
});
