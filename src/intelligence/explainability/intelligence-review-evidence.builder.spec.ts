import type {
  DecisionContext,
  ObjectiveData,
  RecommendedAction,
} from '../orchestrator/decision-context';
import type { EngineContext } from '../shared/engine-context';
import type { MetricSet, SnapshotData } from '../snapshot/snapshot.types';
import { buildIntelligenceReviewEvidence } from './intelligence-review-evidence.builder';

const metric = (overrides: Partial<MetricSet> = {}): MetricSet => ({
  spend: 1_000,
  revenue: 1_500,
  impressions: 20_000,
  reach: 14_000,
  clicks: 400,
  ctr: 2,
  cpc: 2.5,
  cpm: 50,
  cvr: 0.025,
  purchases: 10,
  addToCart: 30,
  initiateCheckout: 20,
  roas: 1.5,
  aov: 150,
  frequency: 1.43,
  provenance: {
    rowObserved: true,
    fetchComplete: true,
    state: 'observed',
    source: 'meta_insights',
    sourceFingerprint: 'meta-query-v1',
    currency: 'INR',
    metricsSyncedAt: new Date('2026-08-23T06:00:00.000Z'),
    dateStart: '2026-08-01',
    dateStop: '2026-08-22',
    attributionSpec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
    promotedObject: { custom_conversion_id: 'cc-1' },
    revenueBasis: 'meta_action_value',
    revenueAttributionSource: 'custom_conversion',
    revenueAttributionActionTypes: ['purchase'],
    rawMetaActionValueGross: 1_500,
    goalResultInputs: {
      actionCounts: { purchase: 10 },
      actionValuesGross: { purchase: 1_500 },
    },
  },
  ...overrides,
});

const slice = <T>(data: T): EngineContext<T> => ({
  data,
  confidence: 0.8,
  evidence: [],
  version: 'test@1',
  computedAt: new Date('2026-08-23T06:00:00.000Z'),
  ms: 1,
  deterministic: true,
});

const salesObjective: ObjectiveData = {
  objective: 'sales',
  source: 'meta_objective',
  primaryKPI: 'roas',
  supportingKPIs: ['cvr', 'aov', 'ctr'],
  weights: { roas: 0.5, cvr: 0.2, aov: 0.15, ctr: 0.15 },
  thresholds: { healthy: {}, warning: {}, critical: {} },
  policy: {
    scaleBudgetIf: 'roas high',
    pauseIf: 'roas low',
    refreshCreativeIf: 'ctr down',
  },
};

const action: RecommendedAction = {
  actionId: 'action-1',
  type: 'replace_creative',
  targetType: 'ad',
  targetId: 'ad-1',
  parameters: {},
  expectedImpact: { metric: 'ctr', deltaPct: 12, confidence: 0.7 },
  expectedProfitDeltaINR7d: 500,
  reasoning: 'Deterministic recommendation.',
  evidenceChain: [],
  risk: 'medium',
  implementationCost: 3,
  score: 75,
  gatedBy: [],
  requiresHumanApproval: true,
};

function snapshot(): SnapshotData {
  return {
    snapshotId: 'snap-1',
    collectedAt: new Date('2026-08-23T06:00:00.000Z'),
    freshnessSec: 120,
    metrics: {
      campaignLevel: metric(),
      adSetLevel: { 'as-1': metric({ spend: 600, revenue: 900 }) },
      adLevel: {
        'ad-1': {
          ...metric({ spend: 400, revenue: 500, roas: 1.25 }),
          format: 'video',
          videoP25: 2_500,
          thruplay: 800,
        },
      },
    },
    entities: {
      campaign: {
        id: 'campaign-1',
        name: 'Nadi Leaf',
        objective: 'OUTCOME_SALES',
      },
      adSets: {
        'as-1': {
          id: 'as-1',
          name: 'Warm audience',
          status: 'ACTIVE',
          optimizationGoal: 'VALUE',
        },
      },
      ads: {
        'ad-1': {
          id: 'ad-1',
          adSetId: 'as-1',
          name: 'Story video',
          status: 'ACTIVE',
          creative: {
            id: 'creative-1',
            name: 'Leaf story',
            title: 'Discover your story',
            thumbnailUrl: 'https://example.com/thumb.jpg',
          },
        },
      },
    },
    meta: {
      accountId: 'act-1',
      objective: 'OUTCOME_SALES',
      metricScope: 'lifetime',
    },
    missingFields: [],
  };
}

function deps(objective = salesObjective): Partial<DecisionContext> {
  return {
    snapshot: slice(
      snapshot() as unknown as DecisionContext['snapshot'] extends EngineContext<
        infer T
      >
        ? T
        : never,
    ),
    objective: slice(objective),
    lifecycle: slice({
      stage: 'stable',
      ageHours: 240,
      progressionScore: 0.8,
      nextExpectedStage: 'stable',
      allowedActions: ['replace_creative'],
      blockedActions: [],
      monitoringCadenceMinutes: 180,
      gates: {
        canPause: true,
        canScale: true,
        canReduceBudget: true,
        canReplaceCreative: true,
        canAddAudience: true,
      },
    }),
    trend: slice({
      perMetric: {},
      overallDirection: 'stable',
      stabilityScore: 0.8,
      anomalies: [],
      observationCount: 8,
      windowElapsedDays: 8,
      trendReady: true,
    }),
    revenue: slice({
      grossRevenue: 1_500,
      netRevenue: 1_500,
      contributionMargin: 600,
      economicsAvailable: true,
      revenueEvidenceAvailable: true,
      financialDataAvailable: true,
      attributedByAdSet: { 'as-1': 900 },
      attributedByProduct: { Nadi: 1_500 },
      roasDecomposition: {
        ctr: { contribution: 0, delta: 0 },
        cvr: { contribution: 0, delta: 0 },
        aov: { contribution: 0, delta: 0 },
        frequency: { contribution: 0, delta: 0 },
      },
      breakeven: { roas: 1.03, isProfitable: true, daysSinceBreakeven: 1 },
      targetROAS: 2.06,
    }),
    signal: slice({
      signals: [
        {
          kind: 'hook_burn',
          severity: 'warn',
          targetType: 'ad',
          targetId: 'ad-1',
          metricEvidence: { hookRate: 0.1, ctr: 0.8 },
          trigger: 'hook low',
          strength: 0.7,
          reasoning: 'The opening underperformed.',
          firstSeenAt: new Date(),
        },
        {
          kind: 'hook_burn',
          severity: 'warn',
          targetType: 'ad',
          targetId: 'sibling-ad',
          metricEvidence: { hookRate: 0.05, ctr: 0.3 },
          trigger: 'hook low',
          strength: 0.9,
          reasoning: 'Sibling evidence must not cross targets.',
          firstSeenAt: new Date(),
        },
      ],
    }),
    diagnosis: slice({
      rootCauses: [
        {
          hypothesis: 'Weak opening hook',
          targetType: 'ad',
          targetId: 'ad-1',
          evidenceSignals: ['hook_burn'],
          supportingTrends: [],
          confidence: 0.7,
          suggestedFocus: 'creative',
        },
      ],
      leakDiagnosis: 'creative_leak',
      narrative: 'Exact target diagnosis.',
    }),
    business: slice({
      activePromotions: [],
      seasonalContext: '',
      competitorPressure: 'low',
      budgetPolicy: {
        weeklyCapINR: 10_000,
        weeklyCapUsedINR: 2_000,
        weeklyCapRemainingINR: 8_000,
        perCampaignCapINR: 5_000,
      },
      forbiddenTopics: [],
    }),
    portfolio: slice({
      budgetProposals: [],
      ranking: [{ campaignId: 'campaign-1', score: 75, tier: 'B' }],
      totalPortfolioROAS: 1.2,
      concentration: 0.2,
    }),
    forecast: slice({
      horizons: {
        next24h: forecastPoint(),
        next72h: forecastPoint(),
        next7d: forecastPoint(),
        next30d: forecastPoint(),
      },
      method: 'insufficient_history',
    }),
    confidence: slice({
      overall: 0.72,
      perEngine: {},
      quality: {
        dataFreshnessSec: 120,
        sourceDataFresh: true,
        snapshotCoverage: 1,
        historyDepthDays: 8,
        statisticalPower: 0.7,
      },
      gates: { okToRecommend: true, okToExecute: false, reasonsBlocked: [] },
    }),
    memory: slice({
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
    recommendation: slice({ actions: [action] }),
  };
}

describe('buildIntelligenceReviewEvidence', () => {
  it('builds an exact campaign → ad set → ad → creative path and isolates signals', () => {
    const result = buildIntelligenceReviewEvidence({
      deps: deps(),
      cycleId: 'cycle-1',
      identity: { tenantId: 'tenant-1', campaignId: 'campaign-1' },
      action,
    });

    expect(result.hierarchy.nodes.map((node) => node.level)).toEqual([
      'campaign',
      'adset',
      'ad',
      'creative',
    ]);
    expect(
      result.hierarchy.nodes.find((node) => node.level === 'ad')?.parentId,
    ).toBe('as-1');
    expect(
      result.packet.facts.some((fact) =>
        fact.statement.includes('Sibling evidence'),
      ),
    ).toBe(false);
    expect(
      result.packet.facts.every((fact) => fact.ref.match(/^s\d+\.f\d+$/)),
    ).toBe(true);
    expect(result.packet.facts.some((fact) => fact.kind === 'observed')).toBe(
      true,
    );
    expect(result.packet.facts.find((fact) => fact.unit === 'roas')?.kind).toBe(
      'derived',
    );
    expect(
      result.unknowns.some((unknown) =>
        unknown.code.includes('gallery_lineage'),
      ),
    ).toBe(true);
    expect(result.packet.unknowns).toEqual(result.unknowns);
    expect(
      result.packet.unknowns.find((unknown) =>
        unknown.code.includes('gallery_lineage'),
      )?.effect,
    ).toBe('blocks_execution');
  });

  it('does not block a non-creative action on unresolved Gallery lineage', () => {
    const result = buildIntelligenceReviewEvidence({
      deps: deps(),
      cycleId: 'cycle-budget',
      identity: { tenantId: 'tenant-1', campaignId: 'campaign-1' },
      action: { ...action, type: 'pause_ad' },
    });

    expect(
      result.packet.unknowns.find((unknown) =>
        unknown.code.includes('gallery_lineage'),
      )?.effect,
    ).toBe('reduces_confidence');
  });

  it('uses the exact awareness optimization goal and never substitutes ROAS', () => {
    const awareness: ObjectiveData = {
      ...salesObjective,
      objective: 'awareness',
      primaryKPI: 'reach',
      supportingKPIs: ['cpm', 'impressions', 'frequency'],
    };
    const evidenceDeps = deps(awareness);
    const snap = evidenceDeps.snapshot!.data as unknown as SnapshotData;
    snap.entities!.campaign.objective = 'OUTCOME_AWARENESS';
    snap.meta.objective = 'OUTCOME_AWARENESS';
    snap.entities!.adSets['as-1'].optimizationGoal = 'REACH';
    const result = buildIntelligenceReviewEvidence({
      deps: evidenceDeps,
      cycleId: 'cycle-2',
      identity: { tenantId: 'tenant-1', campaignId: 'campaign-1' },
      action: {
        ...action,
        expectedImpact: {
          metric: 'cost_per_thousand_people_reached',
          deltaPct: 0,
          confidence: 0.7,
          basis: 'not_estimated',
        },
      },
    });

    const targetNode = result.hierarchy.nodes.find(
      (node) => node.level === 'ad',
    );
    expect(
      targetNode?.metrics.some(
        (item) => item.key === 'reach' && item.value === 14_000,
      ),
    ).toBe(true);
    expect(result.packet.facts.some((fact) => fact.unit === 'roas')).toBe(
      false,
    );
  });

  it('withholds economic ROAS but preserves independently proven raw Meta goal evidence', () => {
    const evidenceDeps = deps();
    evidenceDeps.revenue!.data.financialDataAvailable = false;
    evidenceDeps.revenue!.data.revenueEvidenceAvailable = false;
    const result = buildIntelligenceReviewEvidence({
      deps: evidenceDeps,
      cycleId: 'cycle-3',
      identity: { tenantId: 'tenant-1', campaignId: 'campaign-1' },
      action,
    });

    expect(result.packet.facts.some((fact) => fact.unit === 'roas')).toBe(
      false,
    );
    expect(
      result.hierarchy.nodes
        .find((node) => node.level === 'ad')
        ?.metrics.find((metric) => metric.key === 'raw_roas'),
    ).toMatchObject({ status: 'available', value: 3.75 });
    expect(
      result.unknowns.some(
        (unknown) => unknown.code === 'financial_evidence_withheld',
      ),
    ).toBe(true);
  });

  it('fails validation closed when the exact target row has no action-grade provenance', () => {
    const evidenceDeps = deps();
    const snap = evidenceDeps.snapshot!.data as unknown as SnapshotData;
    delete snap.metrics.adLevel['ad-1'].provenance;

    const result = buildIntelligenceReviewEvidence({
      deps: evidenceDeps,
      cycleId: 'cycle-missing-provenance',
      identity: { tenantId: 'tenant-1', campaignId: 'campaign-1' },
      action,
    });

    expect(
      result.hierarchy.nodes.find((node) => node.level === 'ad')?.metrics[0],
    ).toMatchObject({
      key: 'goal_efficiency',
      status: 'unavailable',
      value: null,
    });
    expect(
      result.packet.unknowns.some(
        (unknown) =>
          unknown.effect === 'blocks_validation' &&
          unknown.code.startsWith('exact_goal_metric_unavailable:'),
      ),
    ).toBe(true);
    expect(result.packet.goal.optimizationMetric).toBeNull();
  });

  it('shows both donor and verified recipient in a goal-specific budget shift', () => {
    const evidenceDeps = deps();
    const snap = evidenceDeps.snapshot!.data as unknown as SnapshotData;
    snap.metrics.adSetLevel['as-2'] = metric({ spend: 500, revenue: 1_500 });
    snap.entities!.adSets['as-2'] = {
      id: 'as-2',
      name: 'Peer leader',
      status: 'ACTIVE',
      optimizationGoal: 'VALUE',
    };
    const shift: RecommendedAction = {
      ...action,
      actionId: 'shift-1',
      type: 'shift_budget_between_adsets',
      targetType: 'adset',
      targetId: 'as-1',
      parameters: {
        fromAdSetId: 'as-1',
        toAdSetId: 'as-2',
        shiftPercent: 10,
        optimizationGoal: 'VALUE',
        validationMetric: 'raw_roas',
      },
      expectedImpact: {
        metric: 'raw_roas',
        deltaPct: 0,
        confidence: 0.8,
        basis: 'observed_gap',
        currentValue: 2.5,
        siblingBaselineValue: 3,
        observedGapPct: 20,
      },
      expectedProfitDeltaINR7d: 0,
    };

    const result = buildIntelligenceReviewEvidence({
      deps: evidenceDeps,
      cycleId: 'cycle-shift',
      identity: { tenantId: 'tenant-1', campaignId: 'campaign-1' },
      action: shift,
    });

    const adSetNodes = result.hierarchy.nodes.filter(
      (node) => node.level === 'adset',
    );
    expect(adSetNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'as-1', role: 'action_target' }),
        expect.objectContaining({ id: 'as-2', role: 'comparison' }),
      ]),
    );
    expect(result.hierarchy.coverage.adSetsIncluded).toBe(2);
  });
});

function forecastPoint() {
  return {
    spend: 100,
    revenue: 150,
    roas: 1.5,
    conversions: 1,
    band: { lowSpend: 80, highSpend: 120, lowRevenue: 100, highRevenue: 180 },
  };
}
