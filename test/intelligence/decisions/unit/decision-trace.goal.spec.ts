import { buildDecisionTrace } from '../../../../src/intelligence/decisions/decision-trace.builder';

const slice = (data: unknown) =>
  ({
    data,
    confidence: 0.8,
    evidence: [],
    version: 'test@1',
    computedAt: new Date('2026-08-23T00:00:00.000Z'),
    ms: 1,
    deterministic: true,
  }) as any;

const forecast = {
  method: 'linear',
  horizons: {
    next24h: {},
    next72h: {},
    next7d: {
      spend: 7_000,
      revenue: 0,
      roas: 0,
      conversions: 70_000,
      band: {
        lowSpend: 5_600,
        highSpend: 8_400,
        lowRevenue: 0,
        highRevenue: 0,
      },
    },
    next30d: {},
  },
};

describe('decision trace objective wording', () => {
  it.each([
    ['canonical', { signalKind: 'winner_confirmed' }],
    ['legacy malformed', { kind: 'winner_confirmed' }],
  ])(
    'marks the causal signal decisive for %s evidence snapshots',
    (_label, evidenceSnapshot) => {
      const steps = buildDecisionTrace({
        slices: {
          signal: slice({
            signals: [
              {
                kind: 'winner_confirmed',
                severity: 'info',
                targetType: 'adset',
                targetId: 'adset-1',
                metricEvidence: { roas: 3 },
                trigger: 'winner',
                strength: 0.9,
                reasoning: 'This ad group is a confirmed winner.',
                firstSeenAt: new Date('2026-08-23T00:00:00.000Z'),
              },
            ],
          }),
        } as any,
        decision: {
          actionId: 'a1',
          actionType: 'scale_adset',
          targetId: 'adset-1',
          expectedProfitDeltaINR7d: 500,
          evidenceSnapshot,
        },
      });

      const signal = steps.find((step) => step.step === 6);
      expect(signal?.decisive).toBe(true);
      expect(signal?.details.join(' ')).toContain('triggered this suggestion');
    },
  );

  it('describes awareness portfolio, forecast and recommendation using its goal', () => {
    const action = {
      actionId: 'a1',
      type: 'replace_creative',
      targetType: 'ad',
      targetId: 'ad-1',
      parameters: {},
      expectedImpact: { metric: 'cpm', deltaPct: -12, confidence: 0.8 },
      expectedProfitDeltaINR7d: 0,
      reasoning: 'Reduce the cost of qualified reach.',
      evidenceChain: [],
      risk: 'low',
      implementationCost: 1,
      score: 0.72,
      gatedBy: [],
      requiresHumanApproval: true,
    };
    const steps = buildDecisionTrace({
      slices: {
        objective: slice({
          objective: 'awareness',
          source: 'campaign_field',
          primaryKPI: 'reach',
          supportingKPIs: ['cpm'],
          policy: {},
        }),
        portfolio: slice({
          budgetProposals: [],
          ranking: [],
          totalPortfolioROAS: 0,
          concentration: 0.4,
        }),
        forecast: slice(forecast),
        recommendation: slice({ actions: [action], candidatesConsidered: 1 }),
      } as any,
      decision: {
        actionId: 'a1',
        actionType: 'replace_creative',
        targetId: 'ad-1',
        expectedProfitDeltaINR7d: 0,
      },
    });

    expect(steps.find((step) => step.step === 9)?.headline).toContain(
      'ROAS is not used',
    );
    expect(steps.find((step) => step.step === 10)?.headline).toContain(
      '70,000 impressions',
    );
    const recommendation = steps.find((step) => step.step === 13)?.headline;
    expect(recommendation).toContain('cpm');
    expect(recommendation).not.toContain('profit');
  });

  it('states when sales economics are deliberately unavailable', () => {
    const steps = buildDecisionTrace({
      slices: {
        objective: slice({
          objective: 'sales',
          source: 'campaign_field',
          primaryKPI: 'roas',
          supportingKPIs: [],
          policy: {},
        }),
        revenue: slice({
          grossRevenue: 10_000,
          netRevenue: 10_000,
          contributionMargin: 0,
          economicsAvailable: false,
          revenueEvidenceAvailable: false,
          financialDataAvailable: false,
          attributedByAdSet: {},
          attributedByProduct: {},
          roasDecomposition: {},
          breakeven: { roas: 0, isProfitable: false, daysSinceBreakeven: 0 },
          targetROAS: 0,
        }),
      } as any,
    });

    expect(steps.find((step) => step.step === 5)?.headline).toContain(
      'Profit judgment withheld',
    );
  });

  it('separates net return from costs and labels the 2x threshold as a heuristic', () => {
    const steps = buildDecisionTrace({
      slices: {
        objective: slice({
          objective: 'sales',
          source: 'campaign_field',
          primaryKPI: 'roas',
          supportingKPIs: [],
          policy: {},
        }),
        revenue: slice({
          grossRevenue: 10_000,
          netRevenue: 9_000,
          contributionMargin: 3_000,
          economicsAvailable: true,
          revenueEvidenceAvailable: true,
          financialDataAvailable: true,
          attributedByAdSet: {},
          attributedByProduct: {},
          roasDecomposition: {},
          breakeven: { roas: 2, isProfitable: true, daysSinceBreakeven: 1 },
          targetROAS: 4,
        }),
      } as any,
    });

    const details = steps.find((step) => step.step === 5)?.details.join(' ');
    expect(details).toContain('after configured refunds');
    expect(details).toContain('Product costs and ad spend are not deducted');
    expect(details).not.toContain('after refunds and costs');
    expect(details).toContain('scale-planning heuristic');
    expect(details).toContain('not an observed company target');
    expect(details).not.toContain('above break-even for 1 day');
  });

  it('withholds trend and forecast claims for repeated intraday observations', () => {
    const steps = buildDecisionTrace({
      slices: {
        trend: slice({
          perMetric: {
            spend: {
              slope7d: 100,
              slope3d: 100,
              ema7d: 200,
              ema3d: 200,
              velocity: 1,
              acceleration: 1,
              volatility: 0,
              vsBaseline: 2,
              windowSize: 3,
            },
          },
          overallDirection: 'improving',
          stabilityScore: 1,
          anomalies: [],
          observationCount: 3,
          windowElapsedDays: 0.25,
          historyDepthDays: 30,
          trendReady: false,
        }),
        forecast: slice({
          method: 'insufficient_history',
          horizons: {},
          history: {
            observationCount: 3,
            elapsedDays: 0.25,
            minimumObservationCount: 3,
            minimumElapsedDays: 2,
          },
        }),
      } as any,
    });

    const trend = steps.find((step) => step.step === 4);
    expect(trend?.headline).toContain('Trend withheld');
    expect(trend?.details.join(' ')).toContain(
      'Repeated intraday runs do not count as extra days',
    );
    expect(trend?.headline).not.toContain('getting better');

    const forecastStep = steps.find((step) => step.step === 10);
    expect(forecastStep?.headline).toContain(
      'Too little elapsed daily history',
    );
    expect(forecastStep?.details.join(' ')).toContain(
      'Intraday reruns do not advance this clock',
    );
  });

  it('withholds a sparse long-gap trend even if a legacy ready flag says true', () => {
    const steps = buildDecisionTrace({
      slices: {
        trend: slice({
          perMetric: {},
          overallDirection: 'improving',
          stabilityScore: 1,
          anomalies: [],
          observationCount: 3,
          windowElapsedDays: 40,
          recentCoverageDays: 2,
          recentCoverageRatio: 1,
          maxGapDays: 39,
          trendReady: true,
        }),
      } as any,
    });

    const trend = steps.find((step) => step.step === 4);
    expect(trend?.headline).toContain('Trend withheld');
    expect(trend?.details.join(' ')).toContain('largest gap 39 day(s)');
    expect(trend?.headline).not.toContain('getting better');
  });

  it('distinguishes analysis assembly time from stale persisted Meta metrics', () => {
    const steps = buildDecisionTrace({
      slices: {
        snapshot: slice({
          snapshotId: 'snapshot-1',
          collectedAt: new Date('2026-08-23T12:00:00.000Z'),
          freshnessSec: 7200,
          metrics: {
            campaignLevel: { spend: 10_000 },
            adSetLevel: {},
            adLevel: {},
          },
          meta: { accountId: 'account-1', metricScope: 'lifetime' },
          missingFields: [],
        }),
      } as any,
    });

    const snapshot = steps.find((step) => step.step === 1);
    expect(snapshot?.headline).toContain('Analysis snapshot assembled');
    expect(snapshot?.headline).toContain('source metrics are stale');
    expect(snapshot?.headline).not.toContain('captured from Meta');
    expect(snapshot?.details.join(' ')).toContain(
      'last synchronized from Meta',
    );
    expect(snapshot?.details.join(' ')).toContain(
      'Lifetime-to-date campaign spend: ₹10,000',
    );
    expect(snapshot?.details.join(' ')).toContain(
      'not daily or seven-day totals',
    );
  });

  it('does not say an approval is pending when no action was proposed', () => {
    const steps = buildDecisionTrace({
      slices: {
        execution: slice({ applied: [], deferred: [], failed: [] }),
      } as any,
    });

    expect(steps.find((step) => step.step === 15)?.headline).toBe(
      'Nothing was proposed, so nothing was changed.',
    );
  });

  it('counts completed no-signal and no-action explanation steps as real output', () => {
    const steps = buildDecisionTrace({
      slices: {
        signal: slice({ signals: [] }),
        explainability: slice({ perAction: {} }),
      } as any,
    });

    const signal = steps.find((step) => step.step === 6);
    expect(signal?.status).toBe('ok');
    expect(signal?.headline).toContain('Nothing crossed a threshold');

    const explanation = steps.find((step) => step.step === 14);
    expect(explanation?.status).toBe('ok');
    expect(explanation?.headline).toContain(
      'No action-specific explanation was needed',
    );
  });

  it('labels portfolio rupees as budget and keeps an awareness forecast goal-specific', () => {
    const steps = buildDecisionTrace({
      slices: {
        objective: slice({
          objective: 'awareness',
          source: 'campaign_field',
          primaryKPI: 'reach',
          supportingKPIs: ['cpm'],
          policy: {},
        }),
        portfolio: slice({
          budgetProposals: [
            {
              campaignId: 'awareness-1',
              currentINR: 2_000,
              proposedINR: 2_000,
              delta: 0,
              reason: 'No budget change proposed; compared by CPM.',
            },
          ],
          ranking: [],
          totalPortfolioROAS: 0,
          concentration: 1,
        }),
        forecast: slice({ method: 'insufficient_history', horizons: {} }),
      } as any,
    });

    expect(steps.find((step) => step.step === 9)?.details[0]).toContain(
      'Budget for awareness-1 held at ₹2,000',
    );
    const forecastStep = steps.find((step) => step.step === 10);
    expect(forecastStep?.details.join(' ')).toContain('modeled reach change');
    expect(forecastStep?.details.join(' ')).not.toContain('₹ estimate');
  });

  it('describes execution confidence as a human-review threshold, never autonomy', () => {
    const steps = buildDecisionTrace({
      slices: {
        confidence: slice({
          overall: 0.9,
          perEngine: {},
          quality: {
            dataFreshnessSec: 60,
            snapshotCoverage: 1,
            historyDepthDays: 7,
            statisticalPower: 1,
          },
          gates: {
            okToRecommend: true,
            okToExecute: true,
            reasonsBlocked: [],
          },
        }),
      } as any,
    });

    const confidenceStep = steps.find((step) => step.step === 11);
    expect(confidenceStep?.headline).toContain('ready for human review');
    expect(confidenceStep?.details.join(' ')).toContain(
      'Automatic application is disabled',
    );
    expect(confidenceStep?.details.join(' ')).not.toContain('act on its own');
  });

  it('never describes stale source metrics as ready even if legacy gates say true', () => {
    const steps = buildDecisionTrace({
      slices: {
        confidence: slice({
          overall: 0.9,
          perEngine: {},
          quality: {
            dataFreshnessSec: 7200,
            sourceDataFresh: false,
            snapshotCoverage: 1,
            historyDepthDays: 7,
            statisticalPower: 1,
          },
          gates: {
            okToRecommend: true,
            okToExecute: true,
            reasonsBlocked: [],
          },
        }),
      } as any,
    });

    const confidence = steps.find((step) => step.step === 11);
    expect(confidence?.headline).toContain('action readiness is withheld');
    expect(confidence?.headline).not.toContain('ready for human review');
    expect(confidence?.details.join(' ')).toContain('Allowed to suggest: no');
  });

  it('keeps account-wide memory concise, scoped, and non-causal', () => {
    const steps = buildDecisionTrace({
      slices: {
        memory: slice({
          pastActions: [],
          causalInsights: [
            {
              finding: 'Creative hooks improved attention.',
              confidence: 0.8,
              isolatedVariable: 'creative hook',
            },
            {
              finding: 'Budget increases hurt efficiency.',
              confidence: 0.9,
              isolatedVariable: 'budget',
            },
          ],
          similarPastCycles: [],
          companyLearnings: {
            winningHooks: [],
            losingHooks: [],
            winningExemplars: [],
            audienceHookSaturation: {},
          },
        }),
      } as any,
      decision: {
        actionId: 'a1',
        actionType: 'replace_creative',
        targetId: 'ad-1',
        expectedProfitDeltaINR7d: 0,
      },
    });

    const memory = steps.find((step) => step.step === 12);
    expect(memory?.headline).toContain(
      'has not been tried on this campaign before',
    );
    expect(memory?.details.join(' ')).toContain(
      'Account-wide context (not causal proof for this campaign)',
    );
    expect(memory?.details.join(' ')).toContain(
      '1 unrelated account-wide learning(s) were withheld',
    );
    expect(memory?.details.join(' ')).not.toContain(
      'Budget increases hurt efficiency',
    );
    expect(memory?.decisive).toBe(false);
  });
});
