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

  it('renders a learning-stage loss-containment decision without claiming causal uplift', () => {
    const action = {
      actionId: 'contain-1',
      type: 'reduce_total_budget',
      targetType: 'campaign',
      targetId: 'campaign-1',
      parameters: { reductionPercent: 20 },
      expectedImpact: {
        metric: 'losses_avoided',
        deltaPct: 20,
        confidence: 0.55,
      },
      expectedProfitDeltaINR7d: 3_585,
      reasoning:
        'This is loss containment for human review, not an optimization-uplift claim.',
      evidenceChain: [
        {
          step: 'Containment guard: bounded 20% human-review throttle.',
          source: 'safety_policy',
        },
      ],
      risk: 'low',
      implementationCost: 1,
      score: 0.5,
      gatedBy: ['causal_diagnosis_unresolved'],
      requiresHumanApproval: true,
    };

    const steps = buildDecisionTrace({
      slices: {
        objective: slice({
          objective: 'sales',
          source: 'campaign_field',
          primaryKPI: 'roas',
          supportingKPIs: ['purchases'],
          policy: {},
        }),
        lifecycle: slice({
          stage: 'learning',
          ageHours: 240,
          progressionScore: 0.5,
          nextExpectedStage: 'growing',
          allowedActions: ['add_creative'],
          blockedActions: [],
          monitoringCadenceMinutes: 180,
          gates: {
            canPause: false,
            canScale: false,
            canReduceBudget: false,
            canReplaceCreative: false,
            canAddAudience: true,
          },
        }),
        signal: slice({
          signals: [
            {
              kind: 'unprofitable_run',
              severity: 'critical',
              targetType: 'campaign',
              targetId: 'campaign-1',
              metricEvidence: { roas: 0.51 },
              trigger: 'below_breakeven',
              strength: 0.9,
              reasoning: 'Campaign ROAS is below verified breakeven.',
              firstSeenAt: new Date('2026-08-23T00:00:00.000Z'),
            },
            {
              kind: 'unprofitable_run',
              severity: 'warn',
              targetType: 'adset',
              targetId: 'adset-1',
              metricEvidence: { roas: 0.7 },
              trigger: 'below_breakeven',
              strength: 0.8,
              reasoning: 'A sibling ad set is also below breakeven.',
              firstSeenAt: new Date('2026-08-23T00:00:00.000Z'),
            },
          ],
        }),
        diagnosis: slice({
          rootCauses: [],
          leakDiagnosis: 'none',
          narrative: 'The cause is unresolved.',
        }),
        confidence: slice({
          overall: 0.55,
          perEngine: {},
          quality: {
            dataFreshnessSec: 60,
            sourceDataFresh: true,
            snapshotCoverage: 1,
            historyDepthDays: 10,
            statisticalPower: 0.7,
          },
          gates: {
            okToRecommend: false,
            okToExecute: false,
            reasonsBlocked: ['causal_diagnosis_unresolved'],
          },
        }),
        memory: slice({
          pastActions: [],
          causalInsights: [
            {
              finding: 'A historic budget increase was followed by lower ROAS.',
              confidence: 0.8,
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
        recommendation: slice({ actions: [action], candidatesConsidered: 1 }),
        explainability: slice({
          perAction: {
            'contain-1': {
              summary: 'Expected 20% losses_avoided.',
              reasoning: action.reasoning,
              evidenceChain: action.evidenceChain,
            },
          },
        }),
        execution: slice({
          applied: [],
          failed: [],
          deferred: [{ actionId: 'contain-1', reason: 'shadow mode' }],
        }),
        learning: slice({ measurements: [], calibrations: [], updates: [] }),
      } as any,
      decision: {
        actionId: 'contain-1',
        actionType: 'reduce_total_budget',
        targetType: 'campaign',
        targetId: 'campaign-1',
        campaignSource: 'manual',
        expectedImpact: action.expectedImpact,
        expectedProfitDeltaINR7d: 3_585,
        evidenceSnapshot: { signalKind: 'unprofitable_run' },
      },
    });

    const lifecycle = steps.find((step) => step.step === 3);
    expect(lifecycle?.headline).toContain('strict loss-containment exception');
    expect(lifecycle?.headline).not.toContain('is allowed');
    expect(lifecycle?.details.join(' ')).toContain(
      'budget reductions are not ordinarily permitted',
    );

    const signal = steps.find((step) => step.step === 6);
    const triggered = signal?.details.filter((line) =>
      line.includes('triggered this suggestion'),
    );
    expect(triggered).toHaveLength(1);
    expect(triggered?.[0]).toContain('campaign campaign-1');
    expect(triggered?.[0]).not.toContain('adset-1');

    expect(steps.find((step) => step.step === 7)?.headline).toContain(
      'No supported root cause emerged for this exact target',
    );

    const confidence = steps.find((step) => step.step === 11);
    expect(confidence?.headline).toContain('causal optimization is held');
    expect(confidence?.details.join(' ')).toContain(
      'Strict verified-loss containment',
    );
    expect(confidence?.details.join(' ')).not.toContain(
      'Allowed to suggest: no',
    );
    expect(confidence?.details.join(' ')).toContain('enough roas observations');

    const memory = steps.find((step) => step.step === 12);
    expect(memory?.details.join(' ')).toContain(
      'justified by verified loss, not an inferred cause',
    );
    expect(memory?.details.join(' ')).not.toContain('historic budget increase');

    const recommendation = steps.find((step) => step.step === 13);
    expect(recommendation?.headline).toContain(
      'modeled to avoid about ₹3,585 of additional contribution loss',
    );
    expect(recommendation?.headline).toContain(
      'if the current spend pace and economics persist',
    );
    expect(recommendation?.headline).not.toContain('extra profit');
    expect(recommendation?.details.join(' ')).toContain(
      'not revenue earned or realized profit',
    );

    const explanation = steps.find((step) => step.step === 14);
    expect(explanation?.headline).toContain('no performance uplift');
    expect(explanation?.headline).toContain('no root cause is claimed');
    expect(explanation?.details.join(' ')).toContain(
      'modeled proposal rather than a measured result',
    );
    expect(explanation?.details.join(' ')).not.toContain('score');

    expect(steps.find((step) => step.step === 15)?.headline).toContain(
      'Read-only diagnostic',
    );
    expect(steps.find((step) => step.step === 16)?.headline).toContain(
      'No post-action evidence yet',
    );
  });

  it('does not invent a containment exception for a legacy reduction without safety-policy evidence', () => {
    const steps = buildDecisionTrace({
      slices: {
        lifecycle: slice({
          stage: 'learning',
          ageHours: 240,
          nextExpectedStage: 'growing',
          allowedActions: [],
          blockedActions: [],
          monitoringCadenceMinutes: 180,
          gates: {
            canPause: false,
            canScale: false,
            canReduceBudget: false,
          },
        }),
        recommendation: slice({
          actions: [
            {
              actionId: 'legacy-1',
              type: 'reduce_total_budget',
              targetType: 'campaign',
              targetId: 'campaign-1',
              expectedImpact: {
                metric: 'losses_avoided',
                deltaPct: 20,
                confidence: 0.5,
              },
              evidenceChain: [],
            },
          ],
        }),
      } as any,
      decision: {
        actionId: 'legacy-1',
        actionType: 'reduce_total_budget',
        targetType: 'campaign',
        targetId: 'campaign-1',
        expectedProfitDeltaINR7d: 700,
      },
    });

    const lifecycle = steps.find((step) => step.step === 3);
    expect(lifecycle?.headline).toContain('not ordinarily permitted');
    expect(lifecycle?.headline).not.toContain('containment exception');
  });

  it('does not attribute a same-kind signal from a sibling target to the decision', () => {
    const steps = buildDecisionTrace({
      slices: {
        signal: slice({
          signals: [
            {
              kind: 'unprofitable_run',
              severity: 'critical',
              targetType: 'adset',
              targetId: 'adset-2',
              metricEvidence: { roas: 0.5 },
              trigger: 'below_breakeven',
              strength: 0.9,
              reasoning: 'Only the sibling target fired.',
              firstSeenAt: new Date('2026-08-23T00:00:00.000Z'),
            },
          ],
        }),
      } as any,
      decision: {
        actionId: 'a1',
        actionType: 'pause_adset',
        targetType: 'adset',
        targetId: 'adset-1',
        expectedProfitDeltaINR7d: 0,
        evidenceSnapshot: { signalKind: 'unprofitable_run' },
      },
    });

    const signal = steps.find((step) => step.step === 6);
    expect(signal?.decisive).toBe(false);
    expect(signal?.details.join(' ')).not.toContain(
      'triggered this suggestion',
    );
  });

  it('describes measured action memory as observational rather than causal', () => {
    const steps = buildDecisionTrace({
      slices: {
        memory: slice({
          pastActions: [
            {
              actionType: 'reduce_total_budget',
              targetId: 'campaign-1',
              executedAt: new Date('2026-08-20T00:00:00.000Z'),
              outcomeLabel: 'improved',
              context: 'ROAS was higher at the 72h checkpoint.',
            },
          ],
          causalInsights: [],
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
        actionType: 'reduce_total_budget',
        targetType: 'campaign',
        targetId: 'campaign-1',
        expectedProfitDeltaINR7d: 0,
      },
    });

    const memory = steps.find((step) => step.step === 12);
    expect(memory?.headline).toContain('observationally');
    expect(memory?.details.join(' ')).toContain('not causal proof');
    expect(memory?.headline).not.toContain('helped');
    expect(memory?.headline).not.toContain('backfired');
  });
});
