import { SignalEngine } from '../../../../src/intelligence/signal/signal-engine.service';

const ctx = (data: unknown) => ({ data }) as any;

function makeEngine(): SignalEngine {
  return new SignalEngine(null as any, null as any, null as any, null, null);
}

function deps(input: {
  objective: 'sales' | 'awareness' | 'traffic';
  economicsAvailable: boolean;
  metrics?: Record<string, number>;
  trend?: {
    observationCount: number;
    windowElapsedDays: number;
    trendReady: boolean;
    recentCoverageDays?: number;
    recentCoverageRatio?: number;
    maxGapDays?: number;
    perMetric?: Record<string, Record<string, number>>;
  };
}) {
  const metrics = {
    spend: 1_000,
    revenue: 0,
    impressions: 10_000,
    reach: 8_000,
    clicks: 300,
    ctr: 3,
    cpc: 40,
    cpm: 100,
    cvr: 0,
    purchases: 0,
    roas: 0.8,
    frequency: 1.25,
    ...input.metrics,
  };
  return {
    snapshot: ctx({
      metrics: { campaignLevel: metrics, adSetLevel: {}, adLevel: {} },
    }),
    objective: ctx({
      objective: input.objective,
      policy: { ignoreSignals: [] },
    }),
    lifecycle: ctx({
      stage: 'stable',
      metaLearningStage: 'ACTIVE',
    }),
    trend: ctx({
      observationCount: input.trend?.observationCount ?? 7,
      windowElapsedDays: input.trend?.windowElapsedDays ?? 6,
      trendReady: input.trend?.trendReady ?? true,
      recentCoverageDays: input.trend?.recentCoverageDays ?? 7,
      recentCoverageRatio: input.trend?.recentCoverageRatio ?? 1,
      maxGapDays: input.trend?.maxGapDays ?? 1,
      perMetric: {
        ctr: { ema7d: metrics.ctr, slope3d: 0, windowSize: 7 },
        frequency: { ema7d: metrics.frequency, windowSize: 7 },
        reach: { ema7d: metrics.reach, slope7d: 0, windowSize: 7 },
        roas: { slope7d: 0, windowSize: 7 },
        spend: { slope7d: 0, windowSize: 7 },
        ...input.trend?.perMetric,
      },
    }),
    revenue: ctx({
      breakeven: { roas: 1.5, isProfitable: false },
      targetROAS: 3,
      financialDataAvailable: input.economicsAvailable,
      derivation: {
        method: input.economicsAvailable ? 'observed' : 'unavailable',
        breakevenROAS: input.economicsAvailable ? 1.5 : 0,
        marginPct: input.economicsAvailable ? 0.4 : 0,
      },
    }),
  } as any;
}

describe('SignalEngine objective and economics gates', () => {
  it.each(['awareness', 'traffic'] as const)(
    'does not emit purchase/ROAS signals for a %s campaign',
    async (objective) => {
      const result = await (makeEngine() as any).compute(
        deps({ objective, economicsAvailable: true }),
        'cycle-1',
      );

      expect(result.signals.map((signal: any) => signal.kind)).toEqual([]);
    },
  );

  it('does not interpret unresolved sales attribution as poor performance', async () => {
    const result = await (makeEngine() as any).compute(
      deps({ objective: 'sales', economicsAvailable: false }),
      'cycle-1',
    );

    expect(result.signals.map((signal: any) => signal.kind)).toEqual([]);
  });

  it('keeps the same sales evidence actionable when economics are verified', async () => {
    const result = await (makeEngine() as any).compute(
      deps({ objective: 'sales', economicsAvailable: true }),
      'cycle-1',
    );

    expect(result.signals.map((signal: any) => signal.kind)).toEqual(
      expect.arrayContaining([
        'cvr_collapse',
        'unprofitable_run',
        'budget_saturation',
      ]),
    );
  });

  it('does not let three snapshots within hours unlock trend-derived signals', async () => {
    const result = await (makeEngine() as any).compute(
      deps({
        objective: 'awareness',
        economicsAvailable: false,
        metrics: {
          spend: 100,
          impressions: 10_000,
          reach: 5_000,
          clicks: 50,
          ctr: 0.5,
          cpc: 2,
          purchases: 0,
          roas: 0,
          frequency: 3,
        },
        trend: {
          observationCount: 3,
          windowElapsedDays: 0.25,
          trendReady: false,
          perMetric: {
            ctr: { ema7d: 1, slope3d: -0.1, windowSize: 3 },
            frequency: { ema7d: 1, windowSize: 3 },
          },
        },
      }),
      'cycle-1',
    );

    expect(result.signals.map((signal: any) => signal.kind)).not.toEqual(
      expect.arrayContaining(['creative_fatigue', 'ctr_decay']),
    );
  });

  it('allows the same trend evidence after enough real calendar history', async () => {
    const result = await (makeEngine() as any).compute(
      deps({
        objective: 'awareness',
        economicsAvailable: false,
        metrics: {
          spend: 100,
          impressions: 10_000,
          reach: 5_000,
          clicks: 50,
          ctr: 0.5,
          cpc: 2,
          purchases: 0,
          roas: 0,
          frequency: 3,
        },
        trend: {
          observationCount: 3,
          windowElapsedDays: 2,
          trendReady: true,
          perMetric: {
            ctr: { ema7d: 1, slope3d: -0.1, windowSize: 3 },
            frequency: { ema7d: 1, windowSize: 3 },
          },
        },
      }),
      'cycle-1',
    );

    expect(result.signals.map((signal: any) => signal.kind)).toEqual(
      expect.arrayContaining(['creative_fatigue', 'ctr_decay']),
    );
    expect(result.signals[0].reasoning).toContain('elapsed days');
    expect(result.signals[0].reasoning).not.toContain('per day');
  });

  it('does not unlock trend signals from sparse observations across a long gap', async () => {
    const result = await (makeEngine() as any).compute(
      deps({
        objective: 'awareness',
        economicsAvailable: false,
        metrics: {
          spend: 100,
          impressions: 10_000,
          reach: 5_000,
          clicks: 50,
          ctr: 0.5,
          frequency: 3,
        },
        trend: {
          observationCount: 3,
          windowElapsedDays: 40,
          trendReady: true,
          recentCoverageDays: 2,
          recentCoverageRatio: 1,
          maxGapDays: 39,
          perMetric: {
            ctr: { ema7d: 1, slope3d: -0.1, windowSize: 3 },
            frequency: { ema7d: 1, windowSize: 3 },
          },
        },
      }),
      'cycle-1',
    );

    expect(result.signals.map((signal: any) => signal.kind)).not.toEqual(
      expect.arrayContaining(['creative_fatigue', 'ctr_decay']),
    );
  });

  it('grades near-breakeven loss as warn and material loss as critical', async () => {
    const near = await (makeEngine() as any).compute(
      deps({
        objective: 'sales',
        economicsAvailable: true,
        metrics: { roas: 1.4 },
      }),
      'near-cycle',
    );
    const material = await (makeEngine() as any).compute(
      deps({
        objective: 'sales',
        economicsAvailable: true,
        metrics: { roas: 0.9 },
      }),
      'material-cycle',
    );

    expect(
      near.signals.find(
        (signal: any) =>
          signal.kind === 'unprofitable_run' &&
          signal.targetType === 'campaign',
      )?.severity,
    ).toBe('warn');
    expect(
      material.signals.find(
        (signal: any) =>
          signal.kind === 'unprofitable_run' &&
          signal.targetType === 'campaign',
      )?.severity,
    ).toBe('critical');
  });
});
