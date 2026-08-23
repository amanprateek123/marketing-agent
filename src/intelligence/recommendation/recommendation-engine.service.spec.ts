import { RecommendationEngine } from './recommendation-engine.service';
import { SliceRepository } from '../shared/slice-repository.service';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { EngineContext } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import {
  DiagnosisData,
  LifecycleData,
  ObjectiveData,
  ObjectiveKey,
  Signal,
} from '../orchestrator/decision-context';

class TestableRecommendationEngine extends RecommendationEngine {
  run(
    deps: ComputeDeps<'recommendation'>,
    cycleId = 'cycle-1',
    identity = { tenantId: 'tenant-1', campaignId: 'campaign-1' },
  ) {
    return this.compute(deps, cycleId, identity);
  }
}

const context = <T>(data: T, confidence = 0.9): EngineContext<T> => ({
  data,
  confidence,
  evidence: [],
  version: 'test@1',
  computedAt: new Date('2026-08-23T00:00:00.000Z'),
  ms: 1,
  deterministic: true,
});

const objective = (goal: ObjectiveKey): ObjectiveData => ({
  objective: goal,
  source: 'campaign_field',
  primaryKPI: goal === 'awareness' ? 'reach' : 'roas',
  supportingKPIs:
    goal === 'awareness' ? ['cpm', 'impressions', 'frequency'] : ['cvr', 'ctr'],
  weights: goal === 'awareness' ? { reach: 0.6, cpm: 0.4 } : { roas: 1 },
  thresholds: {
    healthy: goal === 'awareness' ? { cpm: 400 } : { roas: 1.5 },
    warning: goal === 'awareness' ? { cpm: 600 } : { roas: 1 },
    critical: goal === 'awareness' ? { cpm: 900 } : { roas: 0.7 },
  },
  policy: {
    scaleBudgetIf: '',
    pauseIf: '',
    refreshCreativeIf: '',
    ignoreSignals:
      goal === 'awareness' ? ['cvr_collapse', 'unprofitable_run'] : [],
  },
});

const lifecycle = (
  allowedActions: string[],
  gateOverrides: Partial<LifecycleData['gates']> = {},
  stage: LifecycleData['stage'] = 'growing',
): LifecycleData => ({
  stage,
  ageHours: 240,
  progressionScore: 0.8,
  nextExpectedStage: 'scaling',
  allowedActions,
  blockedActions: [],
  monitoringCadenceMinutes: 60,
  gates: {
    canPause: false,
    canScale: true,
    canReduceBudget: false,
    canReplaceCreative: true,
    canAddAudience: true,
    ...gateOverrides,
  },
});

const signal = (
  kind: Signal['kind'],
  strength = 1,
  reasoning = `${kind} observed from goal-compatible evidence`,
  targetType: Signal['targetType'] = 'adset',
  targetId = 'adset-1',
): Signal => ({
  kind,
  severity: 'warn',
  targetType,
  targetId,
  metricEvidence: {},
  trigger: kind,
  strength,
  reasoning,
  firstSeenAt: new Date('2026-08-23T00:00:00.000Z'),
});

const goalSignal = (input: {
  kind:
    | 'optimization_goal_efficiency_lagging'
    | 'optimization_goal_efficiency_leading';
  targetType?: 'adset' | 'ad';
  targetId: string;
  currentEfficiency: number | null;
  baselineEfficiency: number;
  peerIds?: string[];
  optimizationGoal?: string;
  efficiencyMetric?: string;
  lowerIsBetter?: boolean;
}): Signal => ({
  ...signal(
    input.kind,
    0.9,
    `Observed exact same-window ${input.optimizationGoal ?? 'IMPRESSIONS'} peer gap; no causal uplift claimed.`,
    input.targetType ?? 'adset',
    input.targetId,
  ),
  goalEvidence: {
    optimizationGoal: input.optimizationGoal ?? 'IMPRESSIONS',
    resultMetric: 'impressions',
    efficiencyMetric: input.efficiencyMetric ?? 'cpm',
    efficiencyUnit: 'currency',
    lowerIsBetter: input.lowerIsBetter ?? true,
    current: {
      spend: 1000,
      result: 100000,
      efficiency: input.currentEfficiency,
    },
    pooledSiblingBaseline: {
      peerCount: 2,
      peerIds: input.peerIds ?? ['adset-2', 'adset-3'],
      spend: 2000,
      result: 400000,
      efficiency: input.baselineEfficiency,
    },
    observedGap: {
      thresholdMultiple: 1.5,
      multiple:
        input.currentEfficiency === null
          ? null
          : Math.max(
              input.currentEfficiency / input.baselineEfficiency,
              input.baselineEfficiency / input.currentEfficiency,
            ),
      unbounded: input.currentEfficiency === null,
      direction:
        input.kind === 'optimization_goal_efficiency_lagging'
          ? 'worse'
          : 'better',
    },
    window: {
      dateStart: '2026-08-01',
      dateStop: '2026-08-22',
      metricScope: 'lifetime',
    },
    sourceFingerprint: 'meta-query-v1',
    currency: 'INR',
    claimScope: 'observational_same_window_peer_comparison',
    causalClaim: false,
    expectedUplift: null,
  },
});

const diagnosis = (
  evidenceSignals: Signal['kind'][],
  confidence = 1,
  focus: DiagnosisData['rootCauses'][number]['suggestedFocus'] = 'budget',
  targetType: Signal['targetType'] = 'adset',
  targetId = 'adset-1',
): DiagnosisData => ({
  rootCauses: [
    {
      hypothesis: 'Goal evidence supports this lever',
      targetType,
      targetId,
      evidenceSignals,
      supportingTrends: [],
      confidence,
      suggestedFocus: focus,
    },
  ],
  leakDiagnosis: 'none',
  narrative: 'Goal evidence supports this lever.',
});

function deps(input?: {
  goal?: ObjectiveKey;
  signals?: Signal[];
  diagnosis?: DiagnosisData;
  lifecycle?: LifecycleData;
  economicsAvailable?: boolean;
  revenueEvidenceAvailable?: boolean;
  roas?: number;
  spend?: number;
  purchases?: number;
  adSetLevel?: Record<string, Record<string, number>>;
  adLevel?: Record<string, Record<string, number>>;
  confidence?: {
    overall: number;
    snapshot: number;
    statisticalPower: number;
    okToRecommend: boolean;
  };
  /** null deliberately omits freshness metadata; undefined uses fresh default. */
  freshnessSec?: number | null;
  budgetModel?: 'abo' | 'cbo' | 'asc';
}): ComputeDeps<'recommendation'> {
  const goal = input?.goal ?? 'sales';
  const roas = input?.roas ?? 3;

  return {
    snapshot: context({
      snapshotId: 'snapshot-1',
      collectedAt: new Date('2026-08-23T00:00:00.000Z'),
      ...(input?.freshnessSec === null
        ? {}
        : { freshnessSec: input?.freshnessSec ?? 60 }),
      metrics: {
        campaignLevel: {
          spend: input?.spend ?? 1000,
          revenue: roas * (input?.spend ?? 1000),
          roas,
          purchases: input?.purchases ?? 30,
          impressions: 10000,
          reach: 6000,
          clicks: 200,
          ctr: 2,
          cpc: 5,
          cpm: 100,
          cvr: 0.15,
          frequency: 1.67,
        },
        adSetLevel: input?.adSetLevel ?? {},
        adLevel: input?.adLevel ?? {},
      },
      entities: {
        campaign: {
          id: 'campaign-1',
          name: 'Campaign',
          budgetModel: input?.budgetModel,
        },
      },
    }),
    objective: context(objective(goal)),
    lifecycle: context(
      input?.lifecycle ?? lifecycle(['scale_adset'], {}, 'growing'),
    ),
    trend: context({
      perMetric: {},
      overallDirection: 'stable' as const,
      stabilityScore: 0.9,
      anomalies: [],
    }),
    revenue: context({
      grossRevenue: roas * 1000,
      netRevenue: roas * 1000,
      contributionMargin: roas * 500,
      economicsAvailable: input?.economicsAvailable !== false,
      revenueEvidenceAvailable: input?.revenueEvidenceAvailable !== false,
      financialDataAvailable:
        input?.economicsAvailable !== false &&
        input?.revenueEvidenceAvailable !== false,
      attributedByAdSet: {},
      attributedByProduct: {},
      roasDecomposition: {
        ctr: { contribution: 0, delta: 0 },
        cvr: { contribution: 0, delta: 0 },
        aov: { contribution: 0, delta: 0 },
        frequency: { contribution: 0, delta: 0 },
      },
      breakeven: { roas: 1, isProfitable: roas >= 1, daysSinceBreakeven: 5 },
      targetROAS: 2,
      derivation: {
        method: input?.economicsAvailable === false ? 'unavailable' : 'product',
        marginPct: 0.5,
        breakevenROAS: 1,
      },
    }),
    signal: context({ signals: input?.signals ?? [] }),
    diagnosis: context(
      input?.diagnosis ?? diagnosis(['winner_confirmed'], 1, 'budget'),
    ),
    business: context({
      activePromotions: [],
      seasonalContext: '',
      competitorPressure: 'low' as const,
      budgetPolicy: {
        weeklyCapINR: 100000,
        weeklyCapUsedINR: 1000,
        weeklyCapRemainingINR: 99000,
        perCampaignCapINR: 50000,
      },
      forbiddenTopics: [],
    }),
    portfolio: context({
      budgetProposals: [],
      ranking: [],
      totalPortfolioROAS: 0,
      concentration: 0,
    }),
    forecast: context({
      horizons: {
        next24h: forecastPoint(roas),
        next72h: forecastPoint(roas),
        next7d: forecastPoint(roas),
        next30d: forecastPoint(roas),
      },
      method: 'linear' as const,
    }),
    confidence: context({
      overall: input?.confidence?.overall ?? 0.9,
      perEngine: { snapshot: input?.confidence?.snapshot ?? 0.9 },
      quality: {
        dataFreshnessSec: 60,
        snapshotCoverage: 1,
        historyDepthDays: 7,
        statisticalPower: input?.confidence?.statisticalPower ?? 1,
      },
      gates: {
        okToRecommend: input?.confidence?.okToRecommend ?? true,
        okToExecute: false,
        reasonsBlocked: [],
      },
    }),
    memory: context({
      pastActions: [],
      causalInsights: [],
      similarPastCycles: [],
      companyLearnings: {
        winningHooks: [],
        losingHooks: [],
        winningExemplars: [],
        audienceHookSaturation: {},
      },
    }),
  } as unknown as ComputeDeps<'recommendation'>;
}

function forecastPoint(roas: number) {
  return {
    spend: 700,
    revenue: 700 * roas,
    roas,
    conversions: 20,
    band: {
      lowSpend: 600,
      highSpend: 800,
      lowRevenue: 600 * roas,
      highRevenue: 800 * roas,
    },
  };
}

describe('RecommendationEngine goal and reliability gates', () => {
  let engine: TestableRecommendationEngine;

  beforeEach(() => {
    engine = new TestableRecommendationEngine(
      {} as SliceRepository,
      {} as EngineEventBus,
      {} as EngineRegistry,
      null,
      null,
    );
  });

  it('preserves a valid, economically grounded sales scale recommendation', async () => {
    const result = await engine.run(
      deps({ signals: [signal('winner_confirmed')] }),
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'scale_adset',
      expectedImpact: { metric: 'roas' },
    });
    expect(result.actions[0].score).toBeGreaterThan(0);
    expect(result.actions[0].reasoning).toMatch(/ROAS|profit/i);
  });

  it('derives action identity from each concurrent compute invocation', async () => {
    const input = deps({ signals: [signal('winner_confirmed')] });

    const [cycleA, cycleB] = await Promise.all([
      engine.run(input, 'cycle-a'),
      engine.run(input, 'cycle-b'),
    ]);

    expect(cycleA.actions).toHaveLength(1);
    expect(cycleB.actions).toHaveLength(1);
    expect(cycleA.actions[0].actionId).not.toBe(cycleB.actions[0].actionId);
  });

  it('persists the exact source snapshot pointer on a shadow decision', async () => {
    const insertMany = jest.fn().mockResolvedValue([]);
    const persistenceEngine = new TestableRecommendationEngine(
      {} as SliceRepository,
      {} as EngineEventBus,
      {} as EngineRegistry,
      { insertMany } as never,
      null,
    );

    await persistenceEngine.run(
      deps({ signals: [signal('winner_confirmed')] }),
    );

    expect(insertMany).toHaveBeenCalledTimes(1);
    const insertedDocuments = insertMany.mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(insertedDocuments).toHaveLength(1);
    expect(insertedDocuments[0]).toMatchObject({
      snapshotId: 'snapshot-1',
      decisionContractVersion: 'goal_aware_v1',
      objective: 'sales',
      primaryKPI: 'roas',
      expectedImpact: {
        metric: 'roas',
        deltaPct: 15,
        confidence: 1,
      },
      financialDataAvailable: true,
      evidenceSnapshot: {
        signalKind: 'winner_confirmed',
        signalReasoning:
          'winner_confirmed observed from goal-compatible evidence',
        metrics: {},
      },
      status: 'shadow_review',
      shadowModeOnly: true,
    });
  });

  it('does not let a legacy open row suppress the first goal-aware decision', async () => {
    const insertMany = jest.fn().mockResolvedValue([]);
    const exec = jest.fn().mockResolvedValue([]);
    const select = jest.fn().mockReturnValue({ lean: () => ({ exec }) });
    const find = jest.fn().mockReturnValue({ select });
    const persistenceEngine = new TestableRecommendationEngine(
      {} as SliceRepository,
      {} as EngineEventBus,
      {} as EngineRegistry,
      { find, insertMany } as never,
      null,
    );
    await persistenceEngine.run(
      deps({ signals: [signal('winner_confirmed')] }),
    );

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        decisionContractVersion: 'goal_aware_v1',
      }),
    );
    expect(insertMany).toHaveBeenCalledTimes(1);
  });

  it('filters sales-only signals from an awareness campaign', async () => {
    const result = await engine.run(
      deps({
        goal: 'awareness',
        signals: [signal('winner_confirmed'), signal('placement_leak')],
      }),
    );

    expect(result.actions).toEqual([]);
    expect(result.candidatesConsidered).toBe(0);
  });

  it('independently rejects stale source metrics even if legacy confidence says ready', async () => {
    const result = await engine.run(
      deps({
        signals: [signal('winner_confirmed')],
        freshnessSec: 7200,
      }),
    );

    expect(result.actions).toEqual([]);
    expect(result.gateReasonCounts?.['source_metrics:stale_or_unknown']).toBe(
      1,
    );
  });

  it('independently rejects source metrics with unknown freshness', async () => {
    const result = await engine.run(
      deps({
        signals: [signal('winner_confirmed')],
        freshnessSec: null,
      }),
    );

    expect(result.actions).toEqual([]);
    expect(result.gateReasonCounts?.['source_metrics:stale_or_unknown']).toBe(
      1,
    );
  });

  it('builds a strong awareness problem suggestion around its goal KPI only', async () => {
    const signals = [signal('creative_fatigue', 0.9), signal('hook_burn', 0.9)];
    const result = await engine.run(
      deps({
        goal: 'awareness',
        signals,
        diagnosis: diagnosis(
          ['creative_fatigue', 'hook_burn'],
          0.9,
          'creative',
        ),
        lifecycle: lifecycle(
          ['add_creative', 'narrow_placement', 'shift_budget_between_adsets'],
          {},
          'stable',
        ),
      }),
    );

    expect(result.actions.length).toBeGreaterThan(0);
    for (const action of result.actions) {
      expect(action.expectedImpact.metric).toBe('cpm');
      expect(action.expectedImpact).toMatchObject({
        deltaPct: 0,
        basis: 'not_estimated',
      });
      expect(action.expectedProfitDeltaINR7d).toBe(0);
      expect(action.score).toBeGreaterThan(0);
      expect(action.reasoning).not.toMatch(/ROAS|revenue|profit|breakeven/i);
      expect(
        action.evidenceChain.map((item) => item.step).join(' '),
      ).not.toMatch(/ROAS|revenue|profit|breakeven/i);
    }
  });

  it('scales an exact same-window goal leader without inventing uplift or profit', async () => {
    const leading = goalSignal({
      kind: 'optimization_goal_efficiency_leading',
      targetId: 'adset-1',
      currentEfficiency: 5,
      baselineEfficiency: 10,
    });
    const result = await engine.run(
      deps({
        goal: 'awareness',
        signals: [leading],
        diagnosis: diagnosis(
          ['optimization_goal_efficiency_leading'],
          0.75,
          'delivery_efficiency',
        ),
        lifecycle: lifecycle(['scale_adset'], { canScale: true }, 'stable'),
        budgetModel: 'abo',
        adSetLevel: {
          'adset-1': { spend: 1000, impressions: 200000, cpm: 5 },
        },
      }),
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'scale_adset',
      targetId: 'adset-1',
      parameters: {
        scalePercent: 10,
        optimizationGoal: 'IMPRESSIONS',
        validationMetric: 'cpm',
        claimScope: 'observational_same_window_peer_comparison',
      },
      expectedImpact: {
        metric: 'cpm',
        deltaPct: 0,
        basis: 'observed_gap',
        currentValue: 5,
        siblingBaselineValue: 10,
        observedGapPct: 100,
      },
      expectedProfitDeltaINR7d: 0,
      requiresHumanApproval: true,
    });
    expect(result.actions[0].reasoning).toMatch(/no causal uplift/i);
    expect(result.actions[0].reasoning).not.toMatch(
      /profit gain|will improve/i,
    );
  });

  it('withholds exact-goal scaling when ABO budget topology is not verified', async () => {
    const result = await engine.run(
      deps({
        goal: 'awareness',
        signals: [
          goalSignal({
            kind: 'optimization_goal_efficiency_leading',
            targetId: 'adset-1',
            currentEfficiency: 5,
            baselineEfficiency: 10,
          }),
        ],
        diagnosis: diagnosis(
          ['optimization_goal_efficiency_leading'],
          0.75,
          'delivery_efficiency',
        ),
        lifecycle: lifecycle(['scale_adset'], { canScale: true }, 'stable'),
        budgetModel: 'cbo',
        adSetLevel: {
          'adset-1': { spend: 1000, impressions: 200000, cpm: 5 },
        },
      }),
    );

    expect(result.actions).toEqual([]);
    expect(
      result.gateReasonCounts?.[
        'action:goal_scale_requires_verified_abo_budget'
      ],
    ).toBe(1);
  });

  it('offers a severe exact-goal ad laggard for human pause review', async () => {
    const lagging = goalSignal({
      kind: 'optimization_goal_efficiency_lagging',
      targetType: 'ad',
      targetId: 'ad-1',
      currentEfficiency: 20,
      baselineEfficiency: 10,
    });
    const result = await engine.run(
      deps({
        goal: 'awareness',
        signals: [lagging],
        diagnosis: diagnosis(
          ['optimization_goal_efficiency_lagging'],
          0.75,
          'delivery_efficiency',
          'ad',
          'ad-1',
        ),
        lifecycle: lifecycle(['pause_ad'], { canPause: true }, 'stable'),
        adLevel: {
          'ad-1': { spend: 1000, impressions: 50000, cpm: 20 },
        },
      }),
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'pause_ad',
      targetType: 'ad',
      targetId: 'ad-1',
      expectedImpact: {
        metric: 'cpm',
        basis: 'observed_gap',
        deltaPct: 0,
      },
      expectedProfitDeltaINR7d: 0,
      requiresHumanApproval: true,
    });
    expect(result.actions[0].reasoning).toMatch(/observed evidence/i);
  });

  it('requires same-ad creative corroboration before replacing a goal laggard creative', async () => {
    const lagging = goalSignal({
      kind: 'optimization_goal_efficiency_lagging',
      targetType: 'ad',
      targetId: 'ad-1',
      currentEfficiency: 20,
      baselineEfficiency: 10,
    });
    const hook = signal(
      'hook_burn',
      0.8,
      'Observed low hook depth on this exact video ad.',
      'ad',
      'ad-1',
    );
    const result = await engine.run(
      deps({
        goal: 'awareness',
        signals: [lagging, hook],
        diagnosis: diagnosis(
          ['optimization_goal_efficiency_lagging', 'hook_burn'],
          0.75,
          'creative',
          'ad',
          'ad-1',
        ),
        lifecycle: lifecycle(
          ['replace_creative'],
          { canPause: false, canReplaceCreative: true },
          'stable',
        ),
        adLevel: {
          'ad-1': { spend: 1000, impressions: 50000, cpm: 20 },
        },
      }),
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'replace_creative',
      targetId: 'ad-1',
      expectedImpact: { metric: 'cpm', basis: 'observed_gap' },
    });
    expect(
      result.actions[0].evidenceChain.map((item) => item.step).join(' '),
    ).toMatch(/hook/i);
  });

  it('builds only a bounded same-goal ABO reallocation from a verified leader and laggard', async () => {
    const lagging = goalSignal({
      kind: 'optimization_goal_efficiency_lagging',
      targetId: 'adset-lag',
      currentEfficiency: 20,
      baselineEfficiency: 10,
      peerIds: ['adset-lead', 'adset-peer'],
    });
    const leading = goalSignal({
      kind: 'optimization_goal_efficiency_leading',
      targetId: 'adset-lead',
      currentEfficiency: 5,
      baselineEfficiency: 10,
      peerIds: ['adset-lag', 'adset-peer'],
    });
    const result = await engine.run(
      deps({
        goal: 'awareness',
        signals: [lagging, leading],
        diagnosis: diagnosis(
          ['optimization_goal_efficiency_lagging'],
          0.75,
          'delivery_efficiency',
          'adset',
          'adset-lag',
        ),
        lifecycle: lifecycle(['shift_budget_between_adsets'], {}, 'stable'),
        budgetModel: 'abo',
        adSetLevel: {
          'adset-lag': { spend: 1000, impressions: 50000, cpm: 20 },
          'adset-lead': { spend: 1000, impressions: 200000, cpm: 5 },
          'adset-peer': { spend: 1000, impressions: 100000, cpm: 10 },
        },
      }),
    );

    const shift = result.actions.find(
      (action) => action.type === 'shift_budget_between_adsets',
    );
    expect(shift).toMatchObject({
      targetId: 'adset-lag',
      parameters: {
        fromAdSetId: 'adset-lag',
        toAdSetId: 'adset-lead',
        shiftPercent: 10,
        optimizationGoal: 'IMPRESSIONS',
        validationMetric: 'cpm',
      },
      expectedImpact: {
        metric: 'cpm',
        deltaPct: 0,
        basis: 'observed_gap',
        currentValue: 20,
        siblingBaselineValue: 5,
        observedGapPct: 300,
      },
      expectedProfitDeltaINR7d: 0,
      requiresHumanApproval: true,
    });
    expect(shift?.reasoning).toMatch(/does not claim|promise future uplift/i);
  });

  it('uses the exact ad row for ad-target loss and creative math', async () => {
    const result = await engine.run(
      deps({
        goal: 'sales',
        roas: 3,
        spend: 10_000,
        signals: [
          signal(
            'hook_burn',
            0.9,
            'Observed low P25 depth and CTR on this active video ad.',
            'ad',
            'ad-video-1',
          ),
        ],
        diagnosis: diagnosis(
          ['hook_burn'],
          0.9,
          'creative',
          'ad',
          'ad-video-1',
        ),
        lifecycle: lifecycle(
          ['replace_creative', 'pause_ad'],
          { canPause: true, canReplaceCreative: true },
          'stable',
        ),
        adLevel: {
          'ad-video-1': {
            spend: 100,
            revenue: 20,
            roas: 0.2,
            purchases: 1,
            impressions: 2_000,
            clicks: 10,
            ctr: 0.5,
          },
        },
      }),
    );

    const pause = result.actions.find((action) => action.type === 'pause_ad');
    expect(pause).toMatchObject({
      targetType: 'ad',
      targetId: 'ad-video-1',
      expectedProfitDeltaINR7d: 28,
      requiresHumanApproval: true,
    });
    expect(pause?.reasoning).toContain('Ad ad-video-1');
    expect(pause?.reasoning).toContain('0.20× ROAS');
    expect(pause?.evidenceChain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'snapshot',
          step: expect.stringContaining('₹10/day'),
        }),
      ]),
    );

    const replace = result.actions.find(
      (action) => action.type === 'replace_creative',
    );
    expect(replace?.targetId).toBe('ad-video-1');
    expect(replace?.expectedProfitDeltaINR7d).toBe(6);
  });

  it('fails closed when an ad-target signal has no exact ad metric row', async () => {
    const result = await engine.run(
      deps({
        signals: [
          signal('hook_burn', 0.9, 'Observed hook issue.', 'ad', 'missing-ad'),
        ],
        diagnosis: diagnosis(
          ['hook_burn'],
          0.9,
          'creative',
          'ad',
          'missing-ad',
        ),
        lifecycle: lifecycle(
          ['replace_creative', 'pause_ad'],
          { canPause: true, canReplaceCreative: true },
          'stable',
        ),
      }),
    );

    expect(result.actions).toEqual([]);
    expect(
      result.gateReasonCounts?.['evidence:target_metrics_unavailable'],
    ).toBe(2);
  });

  it('does not turn frequency or audience evidence into an unsupported placement change', async () => {
    const result = await engine.run(
      deps({
        goal: 'awareness',
        signals: [
          signal('frequency_ceiling', 0.9),
          signal('audience_saturation', 0.9),
        ],
        diagnosis: {
          rootCauses: [
            {
              hypothesis: 'Creative fatigue driven by over-frequency',
              targetType: 'adset',
              targetId: 'adset-1',
              evidenceSignals: ['frequency_ceiling'],
              supportingTrends: [],
              confidence: 0.9,
              suggestedFocus: 'creative',
            },
            {
              hypothesis: 'Audience pool exhausted',
              targetType: 'adset',
              targetId: 'adset-1',
              evidenceSignals: ['frequency_ceiling', 'audience_saturation'],
              supportingTrends: [],
              confidence: 0.9,
              suggestedFocus: 'audience',
            },
          ],
          leakDiagnosis: 'fragmentation',
          narrative: 'Frequency is high, but no placement leak was measured.',
        },
        lifecycle: lifecycle(
          ['add_creative', 'narrow_placement', 'shift_budget_between_adsets'],
          {},
          'stable',
        ),
      }),
    );

    expect(result.actions).toEqual([]);
    expect(
      result.gateReasonCounts?.['evidence:placement_breakdown_required'],
    ).toBe(1);
  });

  it('withholds placement optimization until measured platforms are available', async () => {
    const result = await engine.run(
      deps({
        signals: [signal('placement_leak', 0.9)],
        diagnosis: diagnosis(['placement_leak'], 0.9, 'placement'),
        lifecycle: lifecycle(['narrow_placement'], {}, 'stable'),
      }),
    );

    expect(result.actions).toEqual([]);
    expect(
      result.gateReasonCounts?.['action:publisher_platforms_unresolved'],
    ).toBe(1);
  });

  it('does not advertise add_adset while its launch contract is incomplete', async () => {
    const result = await engine.run(
      deps({
        signals: [
          signal(
            'audience_exhaustion',
            0.9,
            'The current audience is exhausted.',
            'campaign',
            'campaign-1',
          ),
        ],
        diagnosis: diagnosis(
          ['audience_exhaustion'],
          0.9,
          'audience',
          'campaign',
          'campaign-1',
        ),
        lifecycle: lifecycle(['add_adset'], { canAddAudience: true }, 'stable'),
      }),
    );

    expect(result.actions).toEqual([]);
    expect(
      result.gateReasonCounts?.['action:add_adset_launch_contract_incomplete'],
    ).toBe(1);
  });

  it('emits executable percentage parameters for a cross-adset budget shift', async () => {
    const result = await engine.run(
      deps({
        signals: [],
        adSetLevel: {
          'winner-adset': { spend: 600, roas: 2, purchases: 12 },
          'loser-adset': { spend: 400, roas: 0.5, purchases: 2 },
        },
        lifecycle: lifecycle(['shift_budget_between_adsets'], {}, 'stable'),
      }),
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'shift_budget_between_adsets',
      targetType: 'adset',
      targetId: 'loser-adset',
      parameters: {
        fromAdSetId: 'loser-adset',
        toAdSetId: 'winner-adset',
        shiftPercent: 30,
      },
    });
    expect(result.actions[0].parameters).not.toHaveProperty('shiftFraction');
  });

  it('emits the executor-required percentage for a total budget cut', async () => {
    const result = await engine.run(
      deps({
        roas: 0.5,
        signals: [
          signal(
            'unprofitable_run',
            0.9,
            'Campaign is below verified breakeven.',
            'campaign',
            'campaign-1',
          ),
        ],
        diagnosis: diagnosis(
          ['unprofitable_run'],
          0.9,
          'budget',
          'campaign',
          'campaign-1',
        ),
        lifecycle: lifecycle(
          ['reduce_total_budget'],
          { canReduceBudget: true },
          'stable',
        ),
      }),
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'reduce_total_budget',
      targetType: 'campaign',
      parameters: { reductionPercent: 20 },
      expectedImpact: {
        metric: 'losses_avoided',
        deltaPct: 20,
      },
      expectedProfitDeltaINR7d: 35,
    });
    expect(result.actions[0].reasoning).toContain(
      'does not assume ROAS will improve',
    );
  });

  it('offers only a bounded human-review loss throttle for evidence-mature learning', async () => {
    const learningLifecycle: LifecycleData = {
      ...lifecycle(['add_creative'], { canReduceBudget: false }, 'learning'),
      ageHours: 240,
      blockedActions: [],
    };
    const result = await engine.run(
      deps({
        roas: 0.5,
        spend: 10_000,
        purchases: 14,
        signals: [
          signal(
            'unprofitable_run',
            0.6,
            'Verified return remains materially below breakeven.',
            'campaign',
            'campaign-1',
          ),
        ],
        diagnosis: {
          rootCauses: [],
          leakDiagnosis: 'chronic_unprofitable',
          narrative: 'No supported causal root cause yet.',
        },
        lifecycle: learningLifecycle,
        confidence: {
          overall: 0.6,
          snapshot: 0.9,
          statisticalPower: 0.56,
          okToRecommend: false,
        },
      }),
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'reduce_total_budget',
      targetType: 'campaign',
      parameters: { reductionPercent: 20 },
      requiresHumanApproval: true,
      expectedImpact: { metric: 'losses_avoided', deltaPct: 20 },
    });
    expect(result.actions[0].reasoning).toMatch(
      /loss containment for human review/i,
    );
    expect(result.actions[0].reasoning).toMatch(
      /not an optimization-uplift claim/i,
    );
  });

  it('keeps young learning campaigns behind the containment safety gates', async () => {
    const youngLearning: LifecycleData = {
      ...lifecycle(['add_creative'], { canReduceBudget: false }, 'learning'),
      ageHours: 72,
      blockedActions: [],
    };
    const result = await engine.run(
      deps({
        roas: 0.5,
        spend: 10_000,
        purchases: 14,
        signals: [
          signal(
            'unprofitable_run',
            0.8,
            'Verified loss, but the campaign is young.',
            'campaign',
            'campaign-1',
          ),
        ],
        diagnosis: {
          rootCauses: [],
          leakDiagnosis: 'chronic_unprofitable',
          narrative: 'No supported causal root cause yet.',
        },
        lifecycle: youngLearning,
        confidence: {
          overall: 0.6,
          snapshot: 0.9,
          statisticalPower: 0.56,
          okToRecommend: false,
        },
      }),
    );

    expect(result.actions).toEqual([]);
    expect(result.gateReasonCounts).toMatchObject({
      'lifecycle:learning:not_allowed': 1,
      'confidence:not_okToRecommend': 1,
      'diagnosis:no_matching_root_cause': 1,
    });
  });

  it('enforces the lifecycle allow-list even when a capability gate is true', async () => {
    const result = await engine.run(
      deps({
        signals: [signal('winner_confirmed')],
        lifecycle: lifecycle(
          ['add_creative', 'narrow_placement', 'shift_budget_between_adsets'],
          { canScale: true },
          'stable',
        ),
      }),
    );

    expect(result.actions).toEqual([]);
    expect(result.gateReasonCounts?.['lifecycle:stable:not_allowed']).toBe(1);
  });

  it('enforces the lifecycle capability gate even when the action is allowed', async () => {
    const result = await engine.run(
      deps({
        signals: [signal('winner_confirmed')],
        lifecycle: lifecycle(['scale_adset'], { canScale: false }, 'growing'),
      }),
    );

    expect(result.actions).toEqual([]);
    expect(result.gateReasonCounts?.['lifecycle:growing:can_scale=false']).toBe(
      1,
    );
  });

  it('rejects a weak signal even when the diagnosis is strong', async () => {
    const result = await engine.run(
      deps({ signals: [signal('winner_confirmed', 0.2)] }),
    );

    expect(result.actions).toEqual([]);
    expect(
      Object.keys(result.gateReasonCounts ?? {}).some((reason) =>
        reason.startsWith('signal:weak'),
      ),
    ).toBe(true);
  });

  it('does not let several individually weak signals inflate into reliability', async () => {
    const weakSignals = [
      signal('frequency_ceiling', 0.3),
      signal('audience_saturation', 0.3),
    ];
    const result = await engine.run(
      deps({
        goal: 'awareness',
        signals: weakSignals,
        diagnosis: diagnosis(
          ['frequency_ceiling', 'audience_saturation'],
          0.9,
          'audience',
        ),
        lifecycle: lifecycle(
          ['narrow_placement', 'shift_budget_between_adsets'],
          {},
          'stable',
        ),
      }),
    );

    expect(result.actions).toEqual([]);
    expect(
      Object.keys(result.gateReasonCounts ?? {}).some((reason) =>
        reason.startsWith('signal:weak'),
      ),
    ).toBe(true);
  });

  it('rejects a weak matching diagnosis even when the signal is strong', async () => {
    const result = await engine.run(
      deps({
        signals: [signal('winner_confirmed')],
        diagnosis: diagnosis(['winner_confirmed'], 0.2, 'budget'),
      }),
    );

    expect(result.actions).toEqual([]);
    expect(
      Object.keys(result.gateReasonCounts ?? {}).some((reason) =>
        reason.startsWith('diagnosis:weak'),
      ),
    ).toBe(true);
  });

  it('does not borrow a corroborated diagnosis from another ad set', async () => {
    const result = await engine.run(
      deps({
        signals: [signal('winner_confirmed', 1, undefined, 'adset', 'adset-a')],
        diagnosis: diagnosis(
          ['winner_confirmed'],
          1,
          'budget',
          'adset',
          'adset-b',
        ),
      }),
    );

    expect(result.actions).toEqual([]);
    expect(result.gateReasonCounts?.['diagnosis:no_matching_root_cause']).toBe(
      1,
    );
  });

  it('rejects a zero-score action instead of persisting a hollow suggestion', async () => {
    const result = await engine.run(
      deps({ signals: [signal('winner_confirmed')], roas: 1.1 }),
    );

    expect(result.actions).toEqual([]);
    expect(result.gateReasonCounts?.['quality:zero_score']).toBe(1);
  });

  it('fails closed when sales economics provenance is unavailable', async () => {
    const result = await engine.run(
      deps({
        signals: [signal('winner_confirmed')],
        economicsAvailable: false,
      }),
    );

    expect(result.actions).toEqual([]);
    expect(result.gateReasonCounts?.['economics:unavailable']).toBe(1);
  });

  it('fails closed when campaign-scoped revenue evidence is unavailable', async () => {
    const result = await engine.run(
      deps({
        signals: [signal('winner_confirmed')],
        revenueEvidenceAvailable: false,
      }),
    );

    expect(result.actions).toEqual([]);
    expect(result.gateReasonCounts?.['revenue:evidence_unavailable']).toBe(1);
  });
});
