import { SignalEngine } from '../../../../src/intelligence/signal/signal-engine.service';
import { EngineEventBus } from '../../../../src/intelligence/shared/engine-event-bus.service';
import { EngineRegistry } from '../../../../src/intelligence/shared/engine-registry';
import { ComputeDeps } from '../../../../src/intelligence/shared/engine.interface';
import {
  SliceIdentity,
  SliceRepository,
} from '../../../../src/intelligence/shared/slice-repository.service';

const ctx = (data: unknown) => ({ data }) as any;

class SignalHarness extends SignalEngine {
  public compute(
    input: ComputeDeps<'signal'>,
    cycleId: string,
    identity = { tenantId: 'tenant-1', campaignId: 'campaign-1' },
  ) {
    return super.compute(input, cycleId, identity);
  }
}

function makeEngine(): SignalHarness {
  return new SignalHarness(null as any, null as any, null as any, null, null);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class RacingSignalHarness extends SignalEngine {
  private identityCalls = 0;

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
    private readonly firstIdentityRead: { resolve: () => void },
    private readonly releaseFirst: { promise: Promise<void> },
  ) {
    super(sliceRepo, eventBus, registry, null, null);
  }

  protected async identityFromDeps(cycleId: string): Promise<SliceIdentity> {
    const identity = await super.identityFromDeps(cycleId);
    this.identityCalls += 1;
    if (this.identityCalls === 1) {
      this.firstIdentityRead.resolve();
      await this.releaseFirst.promise;
    }
    return identity;
  }
}

function deps(input: {
  objective: 'sales' | 'awareness' | 'traffic';
  economicsAvailable: boolean;
  metrics?: Record<string, number>;
  adSetLevel?: Record<string, Record<string, number>>;
  adLevel?: Record<string, Record<string, unknown>>;
  adEntities?: Record<string, { status?: string; effectiveStatus?: string }>;
  lifecycleStage?: 'learning' | 'stable';
  trend?: {
    observationCount: number;
    windowElapsedDays: number;
    trendReady: boolean;
    recentCoverageDays?: number;
    recentCoverageRatio?: number;
    maxGapDays?: number;
    perMetric?: Record<string, Record<string, number>>;
  };
  snapshotData?: Record<string, unknown>;
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
    snapshot: ctx(
      input.snapshotData ?? {
        metrics: {
          campaignLevel: metrics,
          adSetLevel: input.adSetLevel ?? {},
          adLevel: input.adLevel ?? {},
        },
        entities: { ads: input.adEntities ?? {} },
      },
    ),
    objective: ctx({
      objective: input.objective,
      policy: { ignoreSignals: [] },
    }),
    lifecycle: ctx({
      stage: input.lifecycleStage ?? 'stable',
      metaLearningStage:
        input.lifecycleStage === 'learning' ? 'LEARNING' : 'ACTIVE',
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
      breakeven: {
        roas: input.economicsAvailable ? 1.5 : 0,
        isProfitable: false,
      },
      targetROAS: input.economicsAvailable ? 3 : 0,
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

  it('still emits ad-set delivery and creative observations for a non-revenue goal', async () => {
    const result = await makeEngine().compute(
      deps({
        objective: 'awareness',
        economicsAvailable: false,
        metrics: { frequency: 1, ctr: 2, purchases: 0, roas: 0 },
        adSetLevel: {
          'awareness-adset': {
            spend: 1_000,
            impressions: 5_000,
            clicks: 25,
            ctr: 0.5,
            cpc: 40,
            purchases: 0,
            roas: 0,
            frequency: 6,
          },
        },
        trend: {
          observationCount: 7,
          windowElapsedDays: 7,
          trendReady: true,
          perMetric: {
            ctr: { ema7d: 2, slope3d: -0.1, windowSize: 7 },
            frequency: { ema7d: 1, windowSize: 7 },
          },
        },
      }),
      'awareness-adset-cycle',
    );

    const adSetKinds = result.signals
      .filter((candidate) => candidate.targetId === 'awareness-adset')
      .map((candidate) => candidate.kind);
    expect(adSetKinds).toEqual(
      expect.arrayContaining([
        'frequency_ceiling',
        'ctr_decay',
        'creative_fatigue',
      ]),
    );
    expect(adSetKinds).not.toEqual(
      expect.arrayContaining([
        'cvr_collapse',
        'budget_saturation',
        'unprofitable_run',
        'winner_emerging',
        'winner_confirmed',
      ]),
    );
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

  it('reports verified financial loss during learning without unlocking causal trend rules', async () => {
    const result = await makeEngine().compute(
      deps({
        objective: 'sales',
        economicsAvailable: true,
        lifecycleStage: 'learning',
        metrics: {
          spend: 10_000,
          roas: 0.5,
          purchases: 12,
          clicks: 400,
          frequency: 3,
          ctr: 0.5,
        },
        trend: {
          observationCount: 7,
          windowElapsedDays: 7,
          trendReady: true,
          perMetric: {
            ctr: { ema7d: 1.5, slope3d: -0.2, windowSize: 7 },
            frequency: { ema7d: 1, windowSize: 7 },
          },
        },
      }),
      'learning-loss',
    );

    expect(result.signals.map((signal) => signal.kind)).toContain(
      'unprofitable_run',
    );
    expect(result.signals.map((signal) => signal.kind)).not.toEqual(
      expect.arrayContaining(['creative_fatigue', 'ctr_decay']),
    );
  });

  it('uses a higher frequency monitoring threshold for stored custom audiences', async () => {
    const exec = jest.fn().mockResolvedValue({
      metaCampaignId: 'meta-1',
      metaAdSets: [
        {
          id: 'warm-adset',
          status: 'active',
          audienceType: 'other',
          targetingDetail: { customAudiences: [{ id: 'aud-1' }] },
        },
      ],
    });
    const lean = jest.fn().mockReturnValue({ exec });
    const select = jest.fn().mockReturnValue({ lean });
    const findById = jest.fn().mockReturnValue({ select });
    const engine = new SignalHarness(
      null as any,
      null as any,
      null as any,
      { findById } as never,
      null,
    );

    const result = await engine.compute(
      deps({
        objective: 'sales',
        economicsAvailable: true,
        lifecycleStage: 'learning',
        metrics: { roas: 2, purchases: 20, frequency: 1 },
        adSetLevel: {
          'warm-adset': {
            spend: 1_000,
            roas: 2,
            purchases: 10,
            frequency: 6.5,
            impressions: 5_000,
          },
        },
      }),
      'warm-frequency',
    );

    expect(
      result.signals.some(
        (signal) =>
          signal.kind === 'frequency_ceiling' &&
          signal.targetId === 'warm-adset',
      ),
    ).toBe(false);
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

describe('SignalEngine exact optimization-goal peer evidence', () => {
  const baseMetrics = (overrides: Record<string, unknown> = {}) => ({
    spend: 100,
    revenue: 0,
    impressions: 10_000,
    reach: 8_000,
    clicks: 100,
    ctr: 1,
    cpc: 1,
    cpm: 10,
    cvr: 0,
    purchases: 999,
    addToCart: 0,
    initiateCheckout: 0,
    roas: 0,
    aov: 0,
    frequency: 1.25,
    ...overrides,
  });

  const rowProvenance = (overrides: Record<string, unknown> = {}) => ({
    rowObserved: true,
    fetchComplete: true,
    state: 'observed',
    source: 'meta_insights',
    sourceFingerprint: 'same-query',
    currency: 'INR',
    metricsSyncedAt: new Date('2026-08-23T09:55:00.000Z'),
    dateStart: '2026-08-01',
    dateStop: '2026-08-22',
    ...overrides,
  });

  function trafficSnapshot(input?: {
    targetProvenance?: Record<string, unknown>;
    peerTwoProvenance?: Record<string, unknown>;
  }) {
    return {
      snapshotId: 'snap-goal',
      collectedAt: new Date('2026-08-23T10:00:00.000Z'),
      freshnessSec: 300,
      metrics: {
        campaignLevel: baseMetrics(),
        adSetLevel: {
          target: baseMetrics({
            spend: 450,
            landingPageViews: 30,
            provenance: rowProvenance(input?.targetProvenance),
          }),
          'peer-1': baseMetrics({
            spend: 250,
            landingPageViews: 50,
            provenance: rowProvenance(),
          }),
          'peer-2': baseMetrics({
            spend: 250,
            landingPageViews: 50,
            provenance: rowProvenance(input?.peerTwoProvenance),
          }),
        },
        adLevel: {},
      },
      entities: {
        campaign: {
          id: 'campaign-1',
          name: 'Traffic',
          objective: 'OUTCOME_TRAFFIC',
          effectiveStatus: 'ACTIVE',
        },
        adSets: Object.fromEntries(
          ['target', 'peer-1', 'peer-2'].map((id) => [
            id,
            {
              id,
              name: id,
              effectiveStatus: 'ACTIVE',
              optimizationGoal: 'LANDING_PAGE_VIEWS',
            },
          ]),
        ),
        ads: {},
      },
      meta: {
        accountId: 'act-1',
        objective: 'OUTCOME_TRAFFIC',
        metricScope: 'lifetime',
      },
      missingFields: [],
    };
  }

  it('emits a structured lagging observation from exact active same-window siblings', async () => {
    const result = await makeEngine().compute(
      deps({
        objective: 'traffic',
        economicsAvailable: false,
        snapshotData: trafficSnapshot(),
      }),
      'goal-lag',
    );
    const signal = result.signals.find(
      (candidate) =>
        candidate.kind === 'optimization_goal_efficiency_lagging' &&
        candidate.targetId === 'target',
    );

    expect(signal).toMatchObject({
      targetType: 'adset',
      severity: 'critical',
      metricEvidence: {
        currentEfficiency: 15,
        currentResult: 30,
        siblingBaselineEfficiency: 5,
        siblingBaselineResult: 100,
        observedGapMultiple: 3,
        peerCount: 2,
      },
      goalEvidence: {
        optimizationGoal: 'LANDING_PAGE_VIEWS',
        efficiencyMetric: 'cost_per_landing_page_view',
        current: { efficiency: 15, result: 30 },
        pooledSiblingBaseline: { efficiency: 5, result: 100, peerCount: 2 },
        observedGap: { multiple: 3, direction: 'worse' },
        causalClaim: false,
        expectedUplift: null,
      },
    });
    expect(signal?.reasoning).toContain('Observed same-window comparison');
    expect(signal?.reasoning).toContain('does not establish');
    expect(signal?.reasoning).toContain('predicts no uplift');
  });

  it('fails closed when currency or an identical peer window is missing', async () => {
    const missingCurrency = trafficSnapshot({
      targetProvenance: { currency: undefined },
    });
    const mixedWindow = trafficSnapshot({
      peerTwoProvenance: { dateStop: '2026-08-21' },
    });

    for (const [cycleId, snapshotData] of [
      ['missing-currency', missingCurrency],
      ['mixed-window', mixedWindow],
    ] as const) {
      const result = await makeEngine().compute(
        deps({
          objective: 'traffic',
          economicsAvailable: false,
          snapshotData,
        }),
        cycleId,
      );
      expect(
        result.signals.some((candidate) =>
          candidate.kind.startsWith('optimization_goal_efficiency_'),
        ),
      ).toBe(false);
    }
  });

  it('derives ad-level conversion evidence only from exact attributed action counts', async () => {
    const conversionProvenance = (counts?: Record<string, number>) =>
      rowProvenance({
        attributionSpec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
        promotedObject: { custom_conversion_id: 'cc-1' },
        revenueBasis: 'meta_action_value',
        revenueAttributionSource: 'custom_conversion',
        revenueAttributionActionTypes: ['offsite_conversion.custom.1'],
        goalResultInputs: counts ? { actionCounts: counts } : undefined,
      });
    const ad = (spend: number, count: number, includeExactCounts = true) =>
      baseMetrics({
        spend,
        purchases: 9_999,
        provenance: conversionProvenance(
          includeExactCounts
            ? { 'offsite_conversion.custom.1': count, lead: 500 }
            : undefined,
        ),
      });
    const snapshotData = {
      snapshotId: 'snap-sales',
      collectedAt: new Date('2026-08-23T10:00:00.000Z'),
      freshnessSec: 300,
      metrics: {
        campaignLevel: baseMetrics(),
        adSetLevel: { 'as-1': baseMetrics() },
        adLevel: {
          target: ad(1500, 5),
          'peer-1': ad(500, 5),
          'peer-2': ad(500, 5),
        },
      },
      entities: {
        campaign: {
          id: 'campaign-1',
          name: 'Sales',
          objective: 'OUTCOME_SALES',
          effectiveStatus: 'ACTIVE',
        },
        adSets: {
          'as-1': {
            id: 'as-1',
            name: 'Sales ad set',
            effectiveStatus: 'ACTIVE',
            optimizationGoal: 'OFFSITE_CONVERSIONS',
          },
        },
        ads: Object.fromEntries(
          ['target', 'peer-1', 'peer-2'].map((id) => [
            id,
            { id, adSetId: 'as-1', name: id, effectiveStatus: 'ACTIVE' },
          ]),
        ),
      },
      meta: {
        accountId: 'act-1',
        objective: 'OUTCOME_SALES',
        metricScope: 'lifetime',
      },
      missingFields: [],
    };

    const measured = await makeEngine().compute(
      deps({
        objective: 'sales',
        economicsAvailable: false,
        snapshotData,
      }),
      'exact-conversions',
    );
    expect(
      measured.signals.find(
        (candidate) =>
          candidate.kind === 'optimization_goal_efficiency_lagging' &&
          candidate.targetId === 'target',
      ),
    ).toMatchObject({
      targetType: 'ad',
      metricEvidence: {
        currentResult: 5,
        currentEfficiency: 300,
        siblingBaselineEfficiency: 100,
      },
    });

    snapshotData.metrics.adLevel.target = ad(1500, 5, false);
    const withoutExactCounts = await makeEngine().compute(
      deps({
        objective: 'sales',
        economicsAvailable: false,
        snapshotData,
      }),
      'generic-purchases-only',
    );
    expect(
      withoutExactCounts.signals.some(
        (candidate) =>
          candidate.kind === 'optimization_goal_efficiency_lagging' &&
          candidate.targetId === 'target',
      ),
    ).toBe(false);
  });
});

describe('SignalEngine ad-level hook evidence', () => {
  const videoAd = (overrides: Record<string, unknown> = {}) => ({
    format: 'video',
    impressions: 2_000,
    ctr: 0.5,
    ...overrides,
  });

  it.each([
    ['missing', {}],
    ['non-finite', { videoP25: Number.NaN }],
  ])(
    'does not turn %s videoP25 evidence into an observed zero',
    async (_, extra) => {
      const result = await makeEngine().compute(
        deps({
          objective: 'awareness',
          economicsAvailable: false,
          adLevel: { 'ad-1': videoAd(extra) },
          adEntities: { 'ad-1': { status: 'active' } },
        }),
        'hook-evidence',
      );

      expect(
        result.signals.some(
          (candidate) =>
            candidate.kind === 'hook_burn' && candidate.targetId === 'ad-1',
        ),
      ).toBe(false);
    },
  );

  it('accepts an explicitly observed zero and records the raw videoP25 proof', async () => {
    const result = await makeEngine().compute(
      deps({
        objective: 'awareness',
        economicsAvailable: false,
        adLevel: { 'ad-1': videoAd({ videoP25: 0 }) },
        adEntities: {
          'ad-1': { status: 'active', effectiveStatus: 'ACTIVE' },
        },
      }),
      'hook-zero',
    );

    expect(
      result.signals.find(
        (candidate) =>
          candidate.kind === 'hook_burn' && candidate.targetId === 'ad-1',
      ),
    ).toMatchObject({
      targetType: 'ad',
      metricEvidence: {
        videoP25: 0,
        hookRate: 0,
        impressions: 2_000,
        ctr: 0.5,
      },
    });
  });

  it.each([
    ['configured status', { status: 'paused' }],
    [
      'effective status',
      { status: 'active', effectiveStatus: 'CAMPAIGN_PAUSED' },
    ],
  ])('ignores a non-active ad from its %s', async (_, entity) => {
    const result = await makeEngine().compute(
      deps({
        objective: 'awareness',
        economicsAvailable: false,
        adLevel: { 'ad-1': videoAd({ videoP25: 100 }) },
        adEntities: { 'ad-1': entity },
      }),
      'hook-paused',
    );

    expect(
      result.signals.some(
        (candidate) =>
          candidate.kind === 'hook_burn' && candidate.targetId === 'ad-1',
      ),
    ).toBe(false);
  });
});

describe('SignalEngine duplicate same-cycle identity', () => {
  it('keeps computed campaign targets scoped after an overlapping listener deletes its map entry', async () => {
    const firstIdentityRead = deferred();
    const releaseFirst = deferred();
    const persistedIdentity = {
      tenantId: 'tenant-1',
      campaignId: 'campaign-1',
    };
    const input = deps({
      objective: 'awareness',
      economicsAvailable: false,
      metrics: { spend: 100, impressions: 0 },
    });
    const write = jest.fn().mockResolvedValue(undefined);
    const sliceRepo = {
      loadManyWithIdentity: jest.fn().mockResolvedValue({
        slices: input,
        identity: persistedIdentity,
      }),
      identityForCycle: jest.fn(),
      write,
    } as unknown as SliceRepository;
    const eventBus = {
      emitCompleted: jest.fn(),
      emitFailed: jest.fn(),
      emitSkipped: jest.fn(),
    } as unknown as EngineEventBus;
    const engine = new RacingSignalHarness(
      sliceRepo,
      eventBus,
      {} as EngineRegistry,
      firstIdentityRead,
      releaseFirst,
    );
    const payload = { cycleId: 'cycle-1', ...persistedIdentity };

    const first = engine.onRevenueCompleted(payload);
    await firstIdentityRead.promise;
    await engine.onRevenueCompleted(payload);
    releaseFirst.resolve();
    await first;

    expect(write).toHaveBeenCalledTimes(2);
    for (const [writeIdentity, , slice] of write.mock.calls) {
      expect(writeIdentity).toEqual({
        cycleId: 'cycle-1',
        ...persistedIdentity,
      });
      const deliverySignal = slice.data.signals.find(
        (signal: { kind: string }) => signal.kind === 'delivery_stalled',
      );
      expect(deliverySignal).toMatchObject({
        targetType: 'campaign',
        targetId: 'campaign-1',
      });
    }
  });
});
