import { ForecastEngine } from '../../../../src/intelligence/forecast/forecast-engine.service';
import { ObjectiveKey } from '../../../../src/intelligence/orchestrator/decision-context';
import { EngineEventBus } from '../../../../src/intelligence/shared/engine-event-bus.service';
import { EngineRegistry } from '../../../../src/intelligence/shared/engine-registry';
import { ComputeDeps } from '../../../../src/intelligence/shared/engine.interface';
import { SliceRepository } from '../../../../src/intelligence/shared/slice-repository.service';

class ForecastHarness extends ForecastEngine {
  run(deps: ComputeDeps<'forecast'>) {
    return this.compute(deps);
  }
}

const slice = (data: unknown) => ({
  data,
  confidence: 0.9,
  evidence: [],
  version: 'test@1',
  computedAt: new Date('2026-08-23T00:00:00.000Z'),
  ms: 1,
  deterministic: true,
});

function deps(
  objective: ObjectiveKey,
  metrics: Record<string, number>,
  trendOverrides: Record<
    string,
    { vsBaseline: number; windowSize: number }
  > = {},
  historyOverrides?: {
    observationCount: number;
    windowElapsedDays: number;
    trendReady: boolean;
    recentCoverageDays?: number;
    recentCoverageRatio?: number;
    maxGapDays?: number;
  },
): ComputeDeps<'forecast'> {
  const reading = (vsBaseline = 1, windowSize = 15) => ({
    vsBaseline,
    windowSize,
  });
  const resultMetric =
    objective === 'awareness' || objective === 'video_views'
      ? 'impressions'
      : ['traffic', 'engagement', 'app_installs'].includes(objective)
        ? 'clicks'
        : 'purchases';
  const observationCount =
    historyOverrides?.observationCount ??
    trendOverrides[resultMetric]?.windowSize ??
    15;
  return {
    snapshot: slice({ metrics: { campaignLevel: metrics } }),
    objective: slice({ objective }),
    trend: slice({
      observationCount,
      windowElapsedDays:
        historyOverrides?.windowElapsedDays ?? observationCount - 1,
      trendReady: historyOverrides?.trendReady ?? true,
      recentCoverageDays: historyOverrides?.recentCoverageDays ?? 7,
      recentCoverageRatio: historyOverrides?.recentCoverageRatio ?? 1,
      maxGapDays: historyOverrides?.maxGapDays ?? 1,
      perMetric: {
        spend: reading(),
        revenue: reading(),
        purchases: reading(),
        impressions: reading(),
        clicks: reading(),
        ...trendOverrides,
      },
    }),
    portfolio: slice({}),
    lifecycle: slice({ ageHours: 240 }),
  } as unknown as ComputeDeps<'forecast'>;
}

describe('ForecastEngine objective projections', () => {
  const engine = new ForecastHarness(
    {} as SliceRepository,
    {} as EngineEventBus,
    {} as EngineRegistry,
  );

  it('retains revenue, ROAS, and purchase forecasts for sales', async () => {
    const result = await engine.run(
      deps('sales', {
        spend: 1000,
        revenue: 2000,
        purchases: 20,
      }),
    );

    expect(result.horizons.next7d).toMatchObject({
      spend: 700,
      revenue: 1400,
      roas: 2,
      conversions: 14,
    });
    expect(result.horizons.next7d.band).toMatchObject({
      lowRevenue: 980,
      highRevenue: 1820,
    });
    expect(result.method).toBe('ema_projection');
  });

  it('forecasts awareness impressions without fabricating revenue or ROAS', async () => {
    const result = await engine.run(
      deps(
        'awareness',
        {
          spend: 1000,
          revenue: 50_000,
          roas: 50,
          purchases: 100,
          impressions: 100_000,
        },
        {
          // A rising impression curve should affect projected awareness
          // results; the monetary revenue curve must not.
          impressions: { vsBaseline: 2, windowSize: 15 },
          revenue: { vsBaseline: 0.5, windowSize: 15 },
        },
      ),
    );

    expect(result.horizons.next7d).toMatchObject({
      spend: 700,
      revenue: 0,
      roas: 0,
      conversions: 84_000,
    });
    expect(result.horizons.next7d.band).toMatchObject({
      lowRevenue: 0,
      highRevenue: 0,
    });
  });

  it('forecasts traffic clicks from the click trend, not purchases', async () => {
    const result = await engine.run(
      deps(
        'traffic',
        {
          spend: 1000,
          revenue: 30_000,
          roas: 30,
          purchases: 500,
          clicks: 1000,
        },
        {
          clicks: { vsBaseline: 0.5, windowSize: 8 },
          purchases: { vsBaseline: 2, windowSize: 15 },
        },
      ),
    );

    expect(result.horizons.next7d).toMatchObject({
      spend: 700,
      revenue: 0,
      roas: 0,
      conversions: 630,
    });
    expect(result.method).toBe('linear');
  });

  it('does not let three intraday snapshots unlock a trend forecast', async () => {
    const result = await engine.run(
      deps(
        'sales',
        { spend: 1000, revenue: 2000, purchases: 20 },
        {
          spend: { vsBaseline: 2, windowSize: 3 },
          revenue: { vsBaseline: 2, windowSize: 3 },
          purchases: { vsBaseline: 2, windowSize: 3 },
        },
        {
          observationCount: 3,
          windowElapsedDays: 0.25,
          trendReady: false,
        },
      ),
    );

    expect(result.method).toBe('insufficient_history');
    expect(result.history).toMatchObject({
      observationCount: 3,
      elapsedDays: 0.25,
      minimumObservationCount: 3,
      minimumElapsedDays: 2,
    });
    // The 2x intraday ratios must not nudge the age-normalised base pace.
    expect(result.horizons.next7d).toMatchObject({
      spend: 700,
      revenue: 1400,
      conversions: 14,
    });
  });

  it('uses real elapsed daily history to unlock a linear forecast', async () => {
    const result = await engine.run(
      deps(
        'sales',
        { spend: 1000, revenue: 2000, purchases: 20 },
        {},
        {
          observationCount: 3,
          windowElapsedDays: 2,
          trendReady: true,
        },
      ),
    );

    expect(result.method).toBe('linear');
  });

  it('withholds a forecast when elapsed history is sparse and discontinuous', async () => {
    const result = await engine.run(
      deps(
        'sales',
        { spend: 1000, revenue: 2000, purchases: 20 },
        {},
        {
          observationCount: 3,
          windowElapsedDays: 40,
          trendReady: true,
          recentCoverageDays: 2,
          recentCoverageRatio: 1,
          maxGapDays: 39,
        },
      ),
    );

    expect(result.method).toBe('insufficient_history');
  });
});
