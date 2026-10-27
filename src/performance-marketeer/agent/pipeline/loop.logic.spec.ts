import type {
  Action,
  Cause,
  InvestigateOutput,
  Issue,
  PlanOutput,
  PlanVerifyOutput,
  VerifyOutput,
} from '../pm-agent.types';
import {
  accuracyCap,
  decisionShape,
  finalActions,
  hitRateFactor,
  lessonsUsed,
  mergeContradictions,
  mergeCauses,
  runChecks,
  shouldSendBackInvestigation,
  shouldSendBackPlan,
  stopEarly,
  unresolvedOf,
} from './loop.logic';

const cause = (
  id: string,
  impact: number,
  confidence: 0.2 | 0.5 | 0.8,
  ev = ['ev-1'],
): Cause => ({
  id,
  title: `cause ${id}`,
  category: 'creative',
  confidence,
  impactRupeesPerDay: impact,
  impactEvidence: 'ev-9',
  evidence: ev,
  evidenceStrength: 'data',
  disproofTried: '',
  lessonIds: [],
});
const issue = (
  id: string,
  severity: Issue['severity'],
  target = '',
): Issue => ({
  id,
  severity,
  target,
  claim: 'c',
  checked: '',
  evidence: [],
  requiredChange: 'r',
});
const inv = (causes: Cause[]): InvestigateOutput => ({
  summary: '',
  causes,
  ruledOut: [],
  issueReplies: [],
  dataGaps: [],
  lessonsContradicted: [],
  markdown: '',
});
const ver = (p: Partial<VerifyOutput>): VerifyOutput => ({
  blindList: [],
  causeVerdicts: [],
  addedCauses: [],
  issues: [],
  confirmedRight: [],
  lessonsContradicted: [],
  markdown: '',
  ...p,
});
const action = (id: string, p: Partial<Action> = {}): Action => ({
  id,
  type: 'budget',
  title: id,
  causeIds: ['C1'],
  entityLevel: 'adset',
  entityId: 'as1',
  entityName: 'Ad set 1',
  change: { field: 'daily_budget', from: 10000, to: 8000 },
  expectedEffect: { metric: 'roas', low: 0.1, high: 0.2, evidence: ['ev-1'] },
  impactRupeesPerDay: 1000,
  confidence: 0.5,
  resetsLearning: false,
  risk: '',
  judgeOn: '2026-10-30',
  stopCondition: '',
  lessonIds: [],
  ...p,
});
const plan = (actions: Action[]): PlanOutput => ({
  summary: '',
  pathToTarget: 'possible',
  actions,
  issueReplies: [],
  lessonsContradicted: [],
  markdown: '',
});
const pv = (p: Partial<PlanVerifyOutput>): PlanVerifyOutput => ({
  actionVerdicts: [],
  issues: [],
  confirmedRight: [],
  lessonsContradicted: [],
  markdown: '',
  ...p,
});

describe('send-back rules', () => {
  const i = inv([cause('C1', 1000, 0.8), cause('C2', 5000, 0.2)]);

  it('investigation: blocker, 3 majors, or top cause rejected', () => {
    expect(shouldSendBackInvestigation(ver({}), i).sendBack).toBe(false);
    expect(
      shouldSendBackInvestigation(ver({ issues: [issue('I1', 'blocker')] }), i)
        .sendBack,
    ).toBe(true);
    expect(
      shouldSendBackInvestigation(
        ver({ issues: [issue('I1', 'major'), issue('I2', 'major')] }),
        i,
      ).sendBack,
    ).toBe(false);
    expect(
      shouldSendBackInvestigation(
        ver({
          issues: [
            issue('I1', 'major'),
            issue('I2', 'major'),
            issue('I3', 'major'),
          ],
        }),
        i,
      ).sendBack,
    ).toBe(true);
    // top by impact × confidence is C2 (5000 × 0.2 = 1000) vs C1 (800)
    const rej = (id: string) =>
      ver({
        causeVerdicts: [
          {
            causeId: id,
            verdict: 'rejected',
            confidence: 0.2,
            evidence: ['ev-2'],
            note: '',
          },
        ],
      });
    expect(shouldSendBackInvestigation(rej('C2'), i).sendBack).toBe(true);
    expect(shouldSendBackInvestigation(rej('C1'), i).sendBack).toBe(false);
  });

  it('plan: blocker, 2 majors, or more than a third rejected', () => {
    const p = plan([action('A1'), action('A2'), action('A3')]);
    expect(
      shouldSendBackPlan(pv({ issues: [issue('I1', 'major')] }), p).sendBack,
    ).toBe(false);
    expect(
      shouldSendBackPlan(
        pv({ issues: [issue('I1', 'major'), issue('I2', 'major')] }),
        p,
      ).sendBack,
    ).toBe(true);
    const rej = (ids: string[]) =>
      pv({
        actionVerdicts: ids.map((actionId) => ({
          actionId,
          verdict: 'reject' as const,
          note: '',
          evidence: [],
        })),
      });
    expect(shouldSendBackPlan(rej(['A1']), p).sendBack).toBe(false); // exactly 1/3
    expect(shouldSendBackPlan(rej(['A1', 'A2']), p).sendBack).toBe(true);
  });

  it('stops early when the issue count does not fall', () => {
    expect(stopEarly(3, undefined)).toBe(false);
    expect(stopEarly(2, 3)).toBe(false);
    expect(stopEarly(3, 3)).toBe(true);
    expect(
      unresolvedOf('verify', 2, [
        issue('I1', 'minor'),
        issue('I2', 'major', 'C1'),
      ]),
    ).toEqual(['verify v2 I2 (major on C1): c — required: r']);
  });
});

describe('mergeCauses', () => {
  it('scores, disputes, drops and adds per doc 09', () => {
    const i = inv([
      cause('C1', 1000, 0.8),
      cause('C2', 1000, 0.8),
      cause('C3', 1000, 0.5),
      cause('C4', 1000, 0.5),
    ]);
    const v = ver({
      causeVerdicts: [
        {
          causeId: 'C1',
          verdict: 'weakened',
          confidence: 0.2,
          evidence: ['ev-3'],
          note: '',
        }, // evidence → verifier's, disputed
        {
          causeId: 'C2',
          verdict: 'confirmed',
          confidence: 0.5,
          evidence: [],
          note: '',
        }, // no evidence → lower
        {
          causeId: 'C3',
          verdict: 'rejected',
          confidence: 0.2,
          evidence: ['ev-4'],
          note: '',
        }, // dropped
        {
          causeId: 'C4',
          verdict: 'rejected',
          confidence: 0.2,
          evidence: [],
          note: '',
        }, // kept, lower
      ],
      addedCauses: [cause('C5', 4000, 0.5)],
    });
    const { causes, dropped } = mergeCauses(i, v);
    expect(dropped.map((c) => c.id)).toEqual(['C3']);
    expect(causes.map((c) => c.id)).toEqual(['C5', 'C2', 'C1', 'C4']);
    const by = Object.fromEntries(causes.map((c) => [c.id, c]));
    expect(by.C1).toMatchObject({ confidence: 0.2, disputed: true });
    expect(by.C2).toMatchObject({
      confidence: 0.5,
      disputed: false,
      rank: 500,
    });
    expect(by.C4).toMatchObject({ confidence: 0.2, verdict: 'rejected' });
    expect(by.C5).toMatchObject({
      verdict: 'added',
      investigatorConfidence: null,
      rank: 2000,
    });
  });
});

describe('finalActions + checks', () => {
  const p = plan([
    action('A1', { impactRupeesPerDay: 100 }),
    action('A2', { impactRupeesPerDay: 5000 }),
    action('A3'),
    action('A4'),
  ]);
  const v = pv({
    actionVerdicts: [
      { actionId: 'A1', verdict: 'approve', note: '', evidence: [] },
      { actionId: 'A2', verdict: 'change', note: 'smaller', evidence: [] },
      { actionId: 'A3', verdict: 'reject', note: '', evidence: [] },
    ],
  });

  it('drops rejected, keeps change with note, flags unresolved, ranks', () => {
    const disputedC1 = {
      ...cause('C1', 1, 0.2),
      investigatorConfidence: 0.8,
      verifierConfidence: 0.2,
      verdict: 'weakened',
      disputed: true,
      rank: 0.2,
    } as const;
    const f = finalActions(p, v, [disputedC1], [issue('I1', 'major', 'A1')]);
    expect(f.map((a) => [a.id, a.verdict, a.rank])).toEqual([
      ['A2', 'change', 1],
      ['A4', 'unresolved', 2],
      ['A1', 'unresolved', 3],
    ]);
    expect(f[0].notes).toEqual(['verifier (change): smaller']);
    expect(f[0].disputed).toBe(true);
  });

  it('marks failures without deleting actions', () => {
    const actions = finalActions(
      plan([
        action('A1', {
          change: { field: 'daily_budget', from: 10000, to: 21000 },
        }), // +110%, over the +100% cap, raises spend
        action('A2', {
          type: 'creative',
          entityLevel: 'ad',
          entityId: 'gone',
          change: { field: 'status', from: 'ACTIVE', to: 'PAUSED' },
        }),
        action('A3', {
          entityId: 'settling',
          causeIds: ['C2'],
          expectedEffect: { metric: 'x', low: 0, high: 1, evidence: ['ev-77'] },
        }),
        action('A5', {
          type: 'hold',
          judgeOn: '2026-10-26',
          change: { field: 'none', from: null, to: null },
        }),
        action('A4', {
          type: 'hold',
          entityId: 'settling',
          change: { field: 'none', from: null, to: null },
        }),
      ]),
      pv({}),
      [],
    );
    const results = runChecks({
      evidence: [
        { id: 'ev-1', tool: 'campaign_overview' },
        { id: 'ev-9', tool: 'impact_rupees' },
        { id: 'ev-8', tool: 'calc' },
      ],
      causes: [
        cause('C1', 1, 0.5),
        { ...cause('C2', 1, 0.5), impactEvidence: 'ev-8' },
      ],
      actions,
      entityIds: new Set(['as1', 'settling']),
      settling: new Set(['settling']),
      campaignRoas: 0.6,
      date: '2026-10-27',
    });
    expect(actions).toHaveLength(5);
    expect(results.map((r) => `${r.target}:${r.check}`).sort()).toEqual([
      'A1:budget_step',
      'A1:no_spend_increase_below_target',
      'A2:entity_exists',
      'A3:cause_checks',
      'A3:evidence_exists',
      'A3:settling',
      'A5:judge_on',
      'C2:impact_from_tool',
    ]);
    const a3 = actions.find((a) => a.id === 'A3')!;
    expect(a3.checksFailed).toEqual([
      'evidence_exists',
      'cause_checks',
      'settling',
    ]);
    expect(a3.checkMessages).toHaveLength(3);
    // a -20% budget cut passes the step check
    expect(
      results.some((r) => r.target === 'A3' && r.check === 'budget_step'),
    ).toBe(false);
  });

  it('allows up to +100% and −20%, and follows an open purchase target', () => {
    const run = (to: number, purchaseTarget?: { targetPurchases: number; remaining: number }) => {
      const actions = finalActions(
        plan([action('A1', { change: { field: 'daily_budget', from: 10000, to } })]),
        pv({}),
        [],
      );
      return runChecks({
        evidence: [
          { id: 'ev-1', tool: 'campaign_overview' },
          { id: 'ev-9', tool: 'impact_rupees' },
        ],
        causes: [cause('C1', 1, 0.5)],
        actions,
        entityIds: new Set(['as1']),
        settling: new Set(),
        campaignRoas: 0.6,
        purchaseTarget,
        date: '2026-10-27',
      }).map((r) => r.check);
    };
    expect(run(20000)).toEqual(['no_spend_increase_below_target']); // +100% ok
    expect(run(7000)).toEqual(['budget_step']); // −30% too big
    const open = { targetPurchases: 500, remaining: 120 };
    expect(run(20000, open)).toEqual([]); // scaling towards the target is fine below ROAS 1
    expect(run(8000, open)).toEqual(['cut_below_purchase_target']);
    expect(run(8000, { targetPurchases: 500, remaining: 0 })).toEqual([]); // reached
  });
});

describe('lessons in the loop', () => {
  it('needs n ≥ 5 before capping', () => {
    expect(accuracyCap({ n: 4, held: 0 })).toBeNull();
    expect(accuracyCap({ n: 5, held: 1 })).toBe(0.5); // 20%: not < 0.2, but < 0.4
  });

  it('caps at 0.5 below 40% and 0.2 below 20%, noting it', () => {
    expect(accuracyCap({ n: 10, held: 1 })).toBe(0.2);
    expect(accuracyCap({ n: 10, held: 3 })).toBe(0.5);
    expect(accuracyCap({ n: 10, held: 4 })).toBeNull();
    const { causes } = mergeCauses(
      inv([
        cause('C1', 1000, 0.8),
        { ...cause('C2', 1000, 0.8), category: 'tracking' },
      ]),
      ver({}),
      { creative: { n: 10, held: 3 }, tracking: { n: 6, held: 0 } },
    );
    const by = Object.fromEntries(causes.map((c) => [c.id, c]));
    expect(by.C1).toMatchObject({ confidence: 0.5, rank: 500 });
    expect(by.C1.capNote).toContain('3/10');
    expect(by.C2).toMatchObject({ confidence: 0.2, rank: 200 });
  });

  it('ranks by impact × confidence × Laplace hit-rate factor', () => {
    expect(hitRateFactor(undefined)).toBe(1);
    expect(hitRateFactor({ n: 0, hits: 0 })).toBe(1);
    expect(hitRateFactor({ n: 8, hits: 8 })).toBe(1.5); // 0.9/0.5 clamped
    expect(hitRateFactor({ n: 8, hits: 0 })).toBe(0.5); // 0.1/0.5 clamped
    expect(hitRateFactor({ n: 3, hits: 2 })).toBeCloseTo(1.2);
    const f = finalActions(
      plan([
        action('A1', { type: 'budget', impactRupeesPerDay: 1000 }),
        action('A2', { type: 'creative', impactRupeesPerDay: 800 }),
      ]),
      pv({}),
      [],
      [],
      { budget: { n: 8, hits: 0 }, creative: { n: 8, hits: 8 } },
    );
    expect(f.map((a) => a.id)).toEqual(['A2', 'A1']);
  });

  it('flags owner rules and predictions that disagree with a lesson', () => {
    const actions = finalActions(
      plan([
        action('A1', {
          type: 'pause',
          entityId: 'new',
          change: { field: 'status', from: 'ACTIVE', to: 'PAUSED' },
        }),
        action('A2', {
          type: 'pause',
          entityId: 'old',
          change: { field: 'status', from: 'ACTIVE', to: 'PAUSED' },
        }),
        action('A3', {
          change: { field: 'daily_budget', from: 10000, to: 11500 },
        }), // +15%
        action('A4', {
          type: 'geo',
          change: { field: 'regions', from: 'all', to: 'south' },
          expectedEffect: {
            metric: 'ROAS',
            low: 0.3,
            high: 0.5,
            evidence: ['ev-1'],
          },
        }),
        action('A5', {
          type: 'audience',
          change: { field: 'audience', from: 'a', to: 'b' },
          expectedEffect: {
            metric: 'roas',
            low: 0.1,
            high: 0.2,
            evidence: ['ev-1'],
          },
        }),
      ]),
      pv({}),
      [],
    );
    const effect = (low: number, high: number) => ({
      lessonId: 'L-3',
      effect: { metric: 'roas', median: (low + high) / 2, low, high },
    });
    const results = runChecks({
      evidence: [{ id: 'ev-1', tool: 'campaign_overview' }],
      causes: [],
      actions,
      entityIds: new Set(['as1', 'new', 'old']),
      settling: new Set(),
      campaignRoas: 1.2,
      date: '2026-10-27',
      situation: { product: 'nadi', season: ['kharmas'] },
      entityCreated: new Map([
        ['new', '2026-10-25T10:00:00Z'],
        ['old', '2026-10-01'],
      ]),
      ownerRules: [
        {
          ruleId: 'R-1',
          text: 'no pause before day 3',
          active: true,
          check: { kind: 'no_pause_before_days', days: 3 },
        },
        {
          ruleId: 'R-2',
          text: 'max 10%',
          active: true,
          check: { kind: 'max_budget_step', step: 0.1 },
        },
        {
          ruleId: 'R-3',
          text: 'no raise in kharmas',
          active: true,
          check: {
            kind: 'no_budget_increase_in_season',
            season: 'kharmas',
            product: 'NADI',
          },
        },
        {
          ruleId: 'R-4',
          text: 'no geo',
          active: true,
          check: { kind: 'no_action_type', type: 'geo', product: 'other' },
        },
        {
          ruleId: 'R-5',
          text: 'inactive',
          active: false,
          check: { kind: 'no_action_type', type: 'budget' },
        },
      ],
      lessonEffects: new Map([
        ['A4', effect(-0.1, 0.1)],
        ['A5', effect(0.15, 0.3)],
      ]),
    });
    expect(results.map((r) => `${r.target}:${r.check}`).sort()).toEqual([
      'A1:owner_rule:R-1',
      'A3:owner_rule:R-2',
      'A3:owner_rule:R-3',
      'A4:prediction_vs_lesson',
    ]);
    expect(
      results.find((r) => r.check === 'prediction_vs_lesson')!.message,
    ).toContain('L-3');
    expect(actions.find((a) => a.id === 'A1')!.checksFailed).toEqual([
      'owner_rule:R-1',
    ]);
  });
});

describe('lesson bookkeeping', () => {
  it('collects used ids and merges contradictions by id', () => {
    expect(
      lessonsUsed([{ lessonIds: ['L-10', 'L-2'] }, { lessonIds: ['L-2'] }, {}]),
    ).toEqual(['L-2', 'L-10']);
    expect(
      mergeContradictions([
        [{ id: 'L-1', evidence: ['ev-1'], note: 'a' }],
        [
          { id: 'L-1', evidence: ['ev-1', 'ev-2'], note: 'b' },
          { id: 'L-4', evidence: [], note: 'c' },
        ],
      ]),
    ).toEqual([
      { id: 'L-1', evidence: ['ev-1', 'ev-2'], note: 'a | b' },
      { id: 'L-4', evidence: [], note: 'c' },
    ]);
  });
});
