import {
  compareGoalEfficiencyPeers,
  GoalEfficiencyMetrics,
  GoalEfficiencyProvenance,
  GoalEfficiencyRow,
  measureGoalEfficiency,
} from './goal-efficiency';

type RowOptions = {
  entityId?: string;
  parentId?: string;
  level?: 'adset' | 'ad';
  effectiveStatus?: string;
  objective?: string;
  optimizationGoal?: string;
  metrics?: GoalEfficiencyMetrics;
  provenance?: Partial<GoalEfficiencyProvenance>;
  attribution?: Partial<
    NonNullable<GoalEfficiencyProvenance['attribution']>
  > | null;
};

const OBJECTIVES: Record<string, string> = {
  VALUE: 'OUTCOME_SALES',
  OFFSITE_CONVERSIONS: 'OUTCOME_SALES',
  REACH: 'OUTCOME_AWARENESS',
  IMPRESSIONS: 'OUTCOME_AWARENESS',
  LANDING_PAGE_VIEWS: 'OUTCOME_TRAFFIC',
  LINK_CLICKS: 'OUTCOME_TRAFFIC',
  THRUPLAY: 'OUTCOME_ENGAGEMENT',
};

function makeRow(options: RowOptions = {}): GoalEfficiencyRow {
  const optimizationGoal = options.optimizationGoal ?? 'LANDING_PAGE_VIEWS';
  const attribution =
    options.attribution === null
      ? null
      : {
          attributionSource: 'custom_conversion',
          conversionEventIdentity: 'nadi-leaf-purchase',
          actionTypes: ['offsite_conversion.custom.123'],
          attributionSpecHash: 'attr-7dc-1dv',
          valueBasis:
            optimizationGoal === 'VALUE' ? 'meta_action_value' : undefined,
          ...options.attribution,
        };
  return {
    entityId: options.entityId ?? 'target',
    parentId: options.parentId ?? 'campaign-1',
    level: options.level ?? 'adset',
    effectiveStatus: options.effectiveStatus ?? 'ACTIVE',
    objective:
      options.objective ?? OBJECTIVES[optimizationGoal] ?? 'OUTCOME_TRAFFIC',
    optimizationGoal,
    metrics: options.metrics ?? { spend: 300, landingPageViews: 30 },
    provenance: {
      rowObserved: true,
      responseComplete: true,
      dateStart: '2026-08-01',
      dateStop: '2026-08-07',
      metricScope: 'window',
      metricsSyncedAt: '2026-08-07T12:00:00.000Z',
      freshnessSec: 300,
      source: 'meta_insights',
      sourceFingerprint: 'meta-query-v1',
      currency: 'INR',
      attribution,
      ...options.provenance,
    },
  };
}

describe('goal efficiency measurement', () => {
  it('maps VALUE only from exact raw Meta value and its matching conversions', () => {
    const measured = measureGoalEfficiency(
      makeRow({
        optimizationGoal: 'VALUE',
        metrics: {
          spend: 100,
          rawMetaActionValue: 250,
          exactConversions: 5,
        },
      }),
    );

    expect(measured).toMatchObject({
      status: 'measured',
      measurement: {
        result: {
          metric: 'raw_meta_action_value',
          value: 250,
        },
        supportingExactConversions: 5,
        efficiency: {
          metric: 'raw_roas',
          value: 2.5,
          lowerIsBetter: false,
        },
      },
    });
  });

  it('does not substitute generic revenue for missing raw Meta value', () => {
    const metrics = {
      spend: 100,
      exactConversions: 5,
      revenue: 999,
    } as GoalEfficiencyMetrics;
    const measured = measureGoalEfficiency(
      makeRow({ optimizationGoal: 'VALUE', metrics }),
    );

    expect(measured).toMatchObject({
      status: 'unavailable',
      code: 'metric_missing',
    });
  });

  it('rejects configured-value revenue provenance for VALUE', () => {
    const measured = measureGoalEfficiency(
      makeRow({
        optimizationGoal: 'VALUE',
        metrics: {
          spend: 100,
          rawMetaActionValue: 250,
          exactConversions: 5,
        },
        attribution: { valueBasis: 'configured_conversion_value' },
      }),
    );

    expect(measured).toMatchObject({
      status: 'unavailable',
      code: 'invalid_value_basis',
    });
  });

  it('maps OFFSITE_CONVERSIONS only from an exact proven conversion count', () => {
    const measured = measureGoalEfficiency(
      makeRow({
        optimizationGoal: 'OFFSITE_CONVERSIONS',
        metrics: { spend: 600, exactConversions: 6 },
      }),
    );

    expect(measured).toMatchObject({
      status: 'measured',
      measurement: {
        result: { metric: 'exact_conversions', value: 6 },
        supportingExactConversions: 6,
        efficiency: {
          metric: 'cost_per_exact_conversion',
          value: 100,
          lowerIsBetter: true,
        },
      },
    });
  });

  it.each([
    {
      goal: 'REACH',
      metrics: { spend: 1000, reach: 10_000 },
      resultMetric: 'reach',
      efficiencyMetric: 'cost_per_thousand_people_reached',
      value: 100,
    },
    {
      goal: 'IMPRESSIONS',
      metrics: { spend: 1000, impressions: 20_000 },
      resultMetric: 'impressions',
      efficiencyMetric: 'cpm',
      value: 50,
    },
    {
      goal: 'LANDING_PAGE_VIEWS',
      metrics: { spend: 500, landingPageViews: 100 },
      resultMetric: 'landing_page_views',
      efficiencyMetric: 'cost_per_landing_page_view',
      value: 5,
    },
    {
      goal: 'LINK_CLICKS',
      metrics: { spend: 300, inlineLinkClicks: 100 },
      resultMetric: 'inline_link_clicks',
      efficiencyMetric: 'cost_per_inline_link_click',
      value: 3,
    },
    {
      goal: 'THRUPLAY',
      metrics: { spend: 200, thruplay: 100 },
      resultMetric: 'thruplays',
      efficiencyMetric: 'cost_per_thruplay',
      value: 2,
    },
  ])(
    'maps $goal to its exact result and efficiency',
    ({ goal, metrics, resultMetric, efficiencyMetric, value }) => {
      const measured = measureGoalEfficiency(
        makeRow({ optimizationGoal: goal, metrics }),
      );

      expect(measured).toMatchObject({
        status: 'measured',
        measurement: {
          result: { metric: resultMetric },
          efficiency: { metric: efficiencyMetric, value },
        },
      });
    },
  );

  it('distinguishes a missing field from an explicitly observed zero', () => {
    const missing = measureGoalEfficiency(makeRow({ metrics: { spend: 100 } }));
    const zero = measureGoalEfficiency(
      makeRow({ metrics: { spend: 100, landingPageViews: 0 } }),
    );

    expect(missing).toMatchObject({
      status: 'unavailable',
      code: 'metric_missing',
    });
    expect(zero).toMatchObject({
      status: 'measured',
      measurement: {
        result: { value: 0 },
        efficiency: { value: null },
      },
    });
  });

  it.each([
    [{ rowObserved: false }, 'row_not_observed'],
    [{ responseComplete: false }, 'response_incomplete'],
    [{ dateStart: '2026-02-30' }, 'invalid_window'],
    [{ dateStart: '2026-08-08', dateStop: '2026-08-07' }, 'invalid_window'],
    [{ metricScope: 'unknown' }, 'invalid_metric_scope'],
    [{ metricsSyncedAt: 'not-a-date' }, 'invalid_sync_provenance'],
    [{ freshnessSec: -1 }, 'invalid_sync_provenance'],
    [{ freshnessSec: 3600 }, 'stale_source'],
    [{ source: 'database_fallback' }, 'invalid_source_provenance'],
    [{ sourceFingerprint: '' }, 'invalid_source_provenance'],
    [{ currency: 'inr' }, 'invalid_currency'],
  ])('fails closed on provenance %p', (provenance, code) => {
    const measured = measureGoalEfficiency(makeRow({ provenance }));
    expect(measured).toMatchObject({ status: 'unavailable', code });
  });

  it.each([
    [{ attribution: null }, 'missing_attribution_identity'],
    [
      { attribution: { attributionSource: 'account_fallback' } },
      'untrusted_attribution_source',
    ],
    [{ attribution: { actionTypes: [] } }, 'invalid_action_type_identity'],
    [
      {
        attribution: {
          actionTypes: [
            'offsite_conversion.custom.123',
            'offsite_conversion.custom.123',
          ],
        },
      },
      'invalid_action_type_identity',
    ],
  ])('fails closed on conversion attribution %p', (options, code) => {
    const measured = measureGoalEfficiency(
      makeRow({
        optimizationGoal: 'OFFSITE_CONVERSIONS',
        metrics: { spend: 100, exactConversions: 1 },
        ...(options as RowOptions),
      }),
    );
    expect(measured).toMatchObject({ status: 'unavailable', code });
  });

  it.each([
    ['reach', 'unsupported_optimization_goal'],
    ['POST_ENGAGEMENT', 'unsupported_optimization_goal'],
    ['APP_INSTALLS', 'unsupported_optimization_goal'],
  ])('does not alias unsupported goal %s', (optimizationGoal, code) => {
    expect(measureGoalEfficiency(makeRow({ optimizationGoal }))).toMatchObject({
      status: 'unavailable',
      code,
    });
  });

  it('fails closed on an objective/goal mismatch', () => {
    expect(
      measureGoalEfficiency(
        makeRow({ optimizationGoal: 'REACH', objective: 'OUTCOME_SALES' }),
      ),
    ).toMatchObject({ status: 'unavailable', code: 'objective_goal_mismatch' });
  });
});

describe('same-window goal-efficiency peer comparison', () => {
  it('returns a laggard from a pooled LPV baseline, with no causal uplift claim', () => {
    const comparison = compareGoalEfficiencyPeers({
      target: makeRow({
        metrics: { spend: 450, landingPageViews: 30 },
      }),
      siblings: [
        makeRow({
          entityId: 'peer-1',
          metrics: { spend: 250, landingPageViews: 50 },
        }),
        makeRow({
          entityId: 'peer-2',
          metrics: { spend: 250, landingPageViews: 50 },
        }),
      ],
    });

    expect(comparison).toMatchObject({
      status: 'laggard',
      code: 'observed_relative_efficiency',
      claimScope: 'observational_same_window_peer_comparison',
      causalClaim: false,
      expectedUplift: null,
      current: {
        spend: 450,
        result: { value: 30 },
        efficiency: { value: 15 },
      },
      baseline: {
        peerCount: 2,
        peerIds: ['peer-1', 'peer-2'],
        pooledSpend: 500,
        pooledResult: { value: 100 },
        efficiency: { value: 5 },
      },
      relativeGap: {
        observedMultiple: 3,
        unbounded: false,
        direction: 'worse',
      },
    });
  });

  it('returns a leader only when it clears the target evidence floor', () => {
    const comparison = compareGoalEfficiencyPeers({
      target: makeRow({
        metrics: { spend: 150, landingPageViews: 60 },
      }),
      siblings: [
        makeRow({
          entityId: 'peer-1',
          metrics: { spend: 300, landingPageViews: 50 },
        }),
        makeRow({
          entityId: 'peer-2',
          metrics: { spend: 300, landingPageViews: 50 },
        }),
      ],
    });

    expect(comparison).toMatchObject({
      status: 'leader',
      current: { efficiency: { value: 2.5 } },
      baseline: { efficiency: { value: 6 } },
      relativeGap: { observedMultiple: 2.4, direction: 'better' },
    });
  });

  it('uses pooled totals instead of averaging peer unit costs', () => {
    const comparison = compareGoalEfficiencyPeers({
      target: makeRow({ metrics: { spend: 450, landingPageViews: 30 } }),
      siblings: [
        makeRow({
          entityId: 'cheap-low-volume',
          metrics: { spend: 20, landingPageViews: 10 },
        }),
        makeRow({
          entityId: 'expensive-high-volume',
          metrics: { spend: 1620, landingPageViews: 90 },
        }),
      ],
    });

    // Pooled = 1640 / 100 = 16.4. Mean of per-row costs would be 10.
    expect(comparison.baseline?.efficiency.value).toBeCloseTo(16.4);
  });

  it('excludes different windows, goals, parent scopes, inactive rows, and stale rows', () => {
    const comparison = compareGoalEfficiencyPeers({
      target: makeRow(),
      siblings: [
        makeRow({
          entityId: 'target',
          metrics: { spend: 100, landingPageViews: 50 },
        }),
        makeRow({
          entityId: 'window',
          provenance: { dateStop: '2026-08-08' },
          metrics: { spend: 100, landingPageViews: 50 },
        }),
        makeRow({
          entityId: 'goal',
          optimizationGoal: 'LINK_CLICKS',
          metrics: { spend: 100, inlineLinkClicks: 50 },
        }),
        makeRow({
          entityId: 'scope',
          provenance: { metricScope: 'lifetime' },
          metrics: { spend: 100, landingPageViews: 50 },
        }),
        makeRow({
          entityId: 'source-fingerprint',
          provenance: { sourceFingerprint: 'different-query' },
          metrics: { spend: 100, landingPageViews: 50 },
        }),
        makeRow({
          entityId: 'currency',
          provenance: { currency: 'USD' },
          metrics: { spend: 100, landingPageViews: 50 },
        }),
        makeRow({
          entityId: 'parent',
          parentId: 'campaign-2',
          metrics: { spend: 100, landingPageViews: 50 },
        }),
        makeRow({
          entityId: 'paused',
          effectiveStatus: 'PAUSED',
          metrics: { spend: 100, landingPageViews: 50 },
        }),
        makeRow({
          entityId: 'stale',
          provenance: { freshnessSec: 3600 },
          metrics: { spend: 100, landingPageViews: 50 },
        }),
      ],
    });

    expect(comparison).toMatchObject({
      status: 'insufficient',
      code: 'not_enough_eligible_peers',
    });
    expect(comparison.excludedPeers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityId: 'target', code: 'target_row' }),
        expect.objectContaining({
          entityId: 'window',
          code: 'provenance_mismatch',
        }),
        expect.objectContaining({
          entityId: 'goal',
          code: 'provenance_mismatch',
        }),
        expect.objectContaining({
          entityId: 'scope',
          code: 'provenance_mismatch',
        }),
        expect.objectContaining({
          entityId: 'source-fingerprint',
          code: 'provenance_mismatch',
        }),
        expect.objectContaining({
          entityId: 'currency',
          code: 'provenance_mismatch',
        }),
        expect.objectContaining({ entityId: 'parent', code: 'not_sibling' }),
        expect.objectContaining({ entityId: 'paused', code: 'not_active' }),
        expect.objectContaining({ entityId: 'stale', code: 'unavailable' }),
      ]),
    );
  });

  it('requires identical conversion attribution but canonicalizes action-type order', () => {
    const baseActions = ['offsite_conversion.custom.123', 'purchase'];
    const target = makeRow({
      optimizationGoal: 'OFFSITE_CONVERSIONS',
      metrics: { spend: 1500, exactConversions: 5 },
      attribution: { actionTypes: baseActions },
    });
    const comparison = compareGoalEfficiencyPeers({
      target,
      siblings: [
        makeRow({
          entityId: 'peer-1',
          optimizationGoal: 'OFFSITE_CONVERSIONS',
          metrics: { spend: 500, exactConversions: 5 },
          attribution: { actionTypes: [...baseActions].reverse() },
        }),
        makeRow({
          entityId: 'peer-2',
          optimizationGoal: 'OFFSITE_CONVERSIONS',
          metrics: { spend: 500, exactConversions: 5 },
          attribution: { actionTypes: baseActions },
        }),
        makeRow({
          entityId: 'wrong-event',
          optimizationGoal: 'OFFSITE_CONVERSIONS',
          metrics: { spend: 500, exactConversions: 5 },
          attribution: {
            actionTypes: ['lead'],
            conversionEventIdentity: 'lead-event',
          },
        }),
      ],
    });

    expect(comparison).toMatchObject({
      status: 'laggard',
      baseline: { peerCount: 2 },
    });
    expect(comparison.excludedPeers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: 'wrong-event',
          code: 'provenance_mismatch',
        }),
      ]),
    );
  });

  it('requires at least two eligible peers and the pooled evidence floor', () => {
    const onePeer = compareGoalEfficiencyPeers({
      target: makeRow(),
      siblings: [
        makeRow({
          entityId: 'peer-1',
          metrics: { spend: 100, landingPageViews: 50 },
        }),
      ],
    });
    const lowPool = compareGoalEfficiencyPeers({
      target: makeRow(),
      siblings: [
        makeRow({
          entityId: 'peer-1',
          metrics: { spend: 100, landingPageViews: 49 },
        }),
        makeRow({
          entityId: 'peer-2',
          metrics: { spend: 100, landingPageViews: 50 },
        }),
      ],
    });

    expect(onePeer).toMatchObject({
      status: 'insufficient',
      code: 'not_enough_eligible_peers',
    });
    expect(lowPool).toMatchObject({
      status: 'insufficient',
      code: 'peer_pool_below_evidence_floor',
      baseline: { pooledResult: { value: 99 } },
    });
  });

  it('applies the relative gap threshold at 1.5x', () => {
    const peers = [
      makeRow({
        entityId: 'peer-1',
        metrics: { spend: 250, landingPageViews: 50 },
      }),
      makeRow({
        entityId: 'peer-2',
        metrics: { spend: 250, landingPageViews: 50 },
      }),
    ];
    const exact = compareGoalEfficiencyPeers({
      target: makeRow({ metrics: { spend: 225, landingPageViews: 30 } }),
      siblings: peers,
    });
    const below = compareGoalEfficiencyPeers({
      target: makeRow({ metrics: { spend: 223.5, landingPageViews: 30 } }),
      siblings: peers,
    });

    expect(exact).toMatchObject({
      status: 'laggard',
      relativeGap: { observedMultiple: 1.5 },
    });
    expect(below).toMatchObject({
      status: 'insufficient',
      code: 'relative_gap_below_threshold',
    });
  });

  it('treats a proven zero result as lagging only after opportunity spend', () => {
    const peers = [
      makeRow({
        entityId: 'peer-1',
        metrics: { spend: 50, landingPageViews: 50 },
      }),
      makeRow({
        entityId: 'peer-2',
        metrics: { spend: 50, landingPageViews: 50 },
      }),
    ];
    const enoughOpportunity = compareGoalEfficiencyPeers({
      target: makeRow({ metrics: { spend: 30, landingPageViews: 0 } }),
      siblings: peers,
    });
    const tooEarly = compareGoalEfficiencyPeers({
      target: makeRow({ metrics: { spend: 29.99, landingPageViews: 0 } }),
      siblings: peers,
    });

    expect(enoughOpportunity).toMatchObject({
      status: 'laggard',
      current: { result: { value: 0 }, efficiency: { value: null } },
      relativeGap: {
        observedMultiple: null,
        unbounded: true,
        direction: 'worse',
      },
    });
    expect(tooEarly).toMatchObject({
      status: 'insufficient',
      code: 'target_below_evidence_floor',
      current: { result: { value: 0 } },
    });
  });

  it('uses exact conversion counts for VALUE evidence floors', () => {
    const peers = [
      makeRow({
        entityId: 'peer-1',
        optimizationGoal: 'VALUE',
        metrics: { spend: 500, rawMetaActionValue: 1000, exactConversions: 5 },
      }),
      makeRow({
        entityId: 'peer-2',
        optimizationGoal: 'VALUE',
        metrics: { spend: 500, rawMetaActionValue: 1000, exactConversions: 5 },
      }),
    ];
    const enough = compareGoalEfficiencyPeers({
      target: makeRow({
        optimizationGoal: 'VALUE',
        metrics: { spend: 500, rawMetaActionValue: 5000, exactConversions: 5 },
      }),
      siblings: peers,
    });
    const tooFew = compareGoalEfficiencyPeers({
      target: makeRow({
        optimizationGoal: 'VALUE',
        metrics: { spend: 500, rawMetaActionValue: 5000, exactConversions: 4 },
      }),
      siblings: peers,
    });

    expect(enough).toMatchObject({
      status: 'leader',
      baseline: { pooledSupportingExactConversions: 10 },
    });
    expect(tooFew).toMatchObject({
      status: 'insufficient',
      code: 'target_below_evidence_floor',
    });
  });

  it('requires 10,000 pooled and 5,000 target observations for reach', () => {
    const comparison = compareGoalEfficiencyPeers({
      target: makeRow({
        optimizationGoal: 'REACH',
        metrics: { spend: 2000, reach: 4_999 },
      }),
      siblings: [
        makeRow({
          entityId: 'peer-1',
          optimizationGoal: 'REACH',
          metrics: { spend: 1000, reach: 5_000 },
        }),
        makeRow({
          entityId: 'peer-2',
          optimizationGoal: 'REACH',
          metrics: { spend: 1000, reach: 5_000 },
        }),
      ],
    });

    expect(comparison).toMatchObject({
      status: 'insufficient',
      code: 'target_below_evidence_floor',
      baseline: { pooledResult: { value: 10_000 } },
    });
  });
});
