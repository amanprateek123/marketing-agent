import {
  ConfidenceEngine,
  statisticalPowerForObjective,
} from '../../../../src/intelligence/confidence/confidence-engine.service';
import { ConfidenceData } from '../../../../src/intelligence/orchestrator/decision-context';
import { EngineEventBus } from '../../../../src/intelligence/shared/engine-event-bus.service';
import { EngineRegistry } from '../../../../src/intelligence/shared/engine-registry';
import { ComputeDeps } from '../../../../src/intelligence/shared/engine.interface';
import { SliceRepository } from '../../../../src/intelligence/shared/slice-repository.service';

class ConfidenceHarness extends ConfidenceEngine {
  run(deps: ComputeDeps<'confidence'>): Promise<ConfidenceData> {
    return this.compute(deps);
  }
}

const slice = (data: unknown, confidence = 0.8) => ({
  data,
  confidence,
  evidence: [],
  version: 'test@1',
  computedAt: new Date('2026-08-23T00:00:00.000Z'),
  ms: 1,
  deterministic: true,
});

function depsFor(input: {
  objective: string;
  metrics: Record<string, number>;
  historyDepthDays?: number;
  trendWindowSize?: number;
  revenueConfidence?: number;
  diagnosisConfidence?: number;
  /** null deliberately omits freshness metadata; undefined uses fresh default. */
  freshnessSec?: number | null;
}): ComputeDeps<'confidence'> {
  return {
    snapshot: slice(
      {
        ...(input.freshnessSec === null
          ? {}
          : { freshnessSec: input.freshnessSec ?? 60 }),
        missingFields: [],
        metrics: { campaignLevel: input.metrics },
      },
      0.9,
    ),
    objective: slice({ objective: input.objective }, 0.9),
    lifecycle: slice({ stage: 'stable' }, 0.9),
    trend: slice({
      perMetric: {
        spend: { windowSize: input.trendWindowSize ?? 30 },
        roas: { windowSize: input.trendWindowSize ?? 30 },
      },
      ...(input.historyDepthDays === undefined
        ? {}
        : { historyDepthDays: input.historyDepthDays }),
    }),
    revenue: slice({}, input.revenueConfidence ?? 0.8),
    signal: slice({}),
    diagnosis: slice({}, input.diagnosisConfidence ?? 0.8),
    business: slice({}),
    portfolio: slice({}),
    forecast: slice({}),
  } as unknown as ComputeDeps<'confidence'>;
}

describe('statisticalPowerForObjective', () => {
  it('retains conversion and impression evidence for sales', () => {
    expect(
      statisticalPowerForObjective('sales', {
        purchases: 25,
        impressions: 3000,
      }),
    ).toBe(1);
    expect(
      statisticalPowerForObjective('sales', {
        purchases: 10,
        impressions: 100_000,
      }),
    ).toBeCloseTo(0.4);
    expect(
      statisticalPowerForObjective('sales', {
        purchases: 25,
        impressions: 1500,
      }),
    ).toBeCloseTo(0.5);
  });

  it('grades awareness on reach and impressions, not purchases', () => {
    expect(
      statisticalPowerForObjective('awareness', {
        purchases: 0,
        reach: 2000,
        impressions: 3000,
      }),
    ).toBe(1);
    expect(
      statisticalPowerForObjective('awareness', {
        purchases: 100,
        reach: 1000,
        impressions: 3000,
      }),
    ).toBeCloseTo(0.5);
  });

  it('grades traffic on clicks and impressions, not purchases', () => {
    expect(
      statisticalPowerForObjective('traffic', {
        purchases: 0,
        clicks: 100,
        impressions: 3000,
      }),
    ).toBe(1);
    expect(
      statisticalPowerForObjective('traffic', {
        purchases: 500,
        clicks: 50,
        impressions: 3000,
      }),
    ).toBeCloseTo(0.5);
  });

  it('fails closed for missing, negative, or non-finite evidence', () => {
    expect(statisticalPowerForObjective('sales', {})).toBe(0);
    expect(
      statisticalPowerForObjective('traffic', {
        clicks: -1,
        impressions: Number.NaN,
      }),
    ).toBe(0);
  });
});

describe('ConfidenceEngine quality inputs', () => {
  const engine = new ConfidenceHarness(
    {} as SliceRepository,
    {} as EngineEventBus,
    {} as EngineRegistry,
  );

  it('uses the objective-specific power calculation in the confidence slice', async () => {
    const data = await engine.run(
      depsFor({
        objective: 'awareness',
        metrics: {
          purchases: 0,
          reach: 3000,
          impressions: 5000,
        },
        historyDepthDays: 1.25,
      }),
    );

    expect(data.quality.statisticalPower).toBe(1);
  });

  it('uses elapsed history days instead of the snapshot window size', async () => {
    const data = await engine.run(
      depsFor({
        objective: 'sales',
        metrics: { purchases: 25, impressions: 3000 },
        historyDepthDays: 2.75,
        trendWindowSize: 30,
      }),
    );

    expect(data.quality.historyDepthDays).toBe(2.75);
    expect(data.quality.historyDepthDays).not.toBe(30);
  });

  it('fails closed for legacy trend slices without elapsed history', async () => {
    const data = await engine.run(
      depsFor({
        objective: 'sales',
        metrics: { purchases: 25, impressions: 3000 },
        trendWindowSize: 30,
      }),
    );

    expect(data.quality.historyDepthDays).toBe(0);
  });

  it('does not let irrelevant revenue confidence sink an awareness decision', async () => {
    const awareness = await engine.run(
      depsFor({
        objective: 'awareness',
        metrics: { reach: 3000, impressions: 5000 },
        historyDepthDays: 3,
        revenueConfidence: 0,
      }),
    );
    const sales = await engine.run(
      depsFor({
        objective: 'sales',
        metrics: { purchases: 25, impressions: 5000 },
        historyDepthDays: 3,
        revenueConfidence: 0,
      }),
    );

    expect(awareness.gates.okToRecommend).toBe(true);
    expect(awareness.overall).toBeGreaterThan(sales.overall);
  });

  it('blocks suggestions when objective-specific statistical power is thin', async () => {
    const data = await engine.run(
      depsFor({
        objective: 'traffic',
        metrics: { clicks: 10, impressions: 3000 },
        historyDepthDays: 3,
      }),
    );

    expect(data.quality.statisticalPower).toBeCloseTo(0.1);
    expect(data.gates.okToRecommend).toBe(false);
    expect(data.gates.reasonsBlocked).toContain('recommend:power<0.5 (0.10)');
  });

  it('blocks suggestions when the diagnosis is not credible enough', async () => {
    const data = await engine.run(
      depsFor({
        objective: 'sales',
        metrics: { purchases: 25, impressions: 5000 },
        historyDepthDays: 3,
        diagnosisConfidence: 0.4,
      }),
    );

    expect(data.gates.okToRecommend).toBe(false);
    expect(data.gates.reasonsBlocked).toContain(
      'recommend:diagnosis<0.5 (0.40)',
    );
  });

  it('fails closed when source metrics are stale even if other evidence is strong', async () => {
    const data = await engine.run(
      depsFor({
        objective: 'sales',
        metrics: { purchases: 25, impressions: 5000 },
        historyDepthDays: 7,
        freshnessSec: 7200,
      }),
    );

    expect(data.quality.sourceDataFresh).toBe(false);
    expect(data.gates.okToRecommend).toBe(false);
    expect(data.gates.okToExecute).toBe(false);
    expect(data.gates.reasonsBlocked).toContain(
      'recommend:source_metrics_stale (7200s>=3600s)',
    );
  });

  it('fails closed when source freshness is missing', async () => {
    const data = await engine.run(
      depsFor({
        objective: 'sales',
        metrics: { purchases: 25, impressions: 5000 },
        historyDepthDays: 7,
        freshnessSec: null,
      }),
    );

    expect(data.quality.dataFreshnessSec).toBe(-1);
    expect(data.quality.sourceDataFresh).toBe(false);
    expect(data.gates.okToRecommend).toBe(false);
    expect(data.gates.reasonsBlocked).toContain(
      'recommend:source_metrics_freshness_unknown',
    );
  });
});
