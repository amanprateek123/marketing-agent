import { ConfigService } from '@nestjs/config';
import { CreativeImageService } from './creative-image.service';
import { FoundryBridgeService } from './foundry-bridge.service';
import {
  buildPlanView,
  cleanPlanSummary,
  planDecisionIds,
} from './plan-gate.mapper';

/** The shape commit_decisions.py writes for a plan gate (draft 2.12.0). */
const SLACK_SUMMARY = [
  'PLAN 2026-09-25 — daily total ₹4000 of ₹5000 governed; ₹1000 left unspent · 2 run(s) to release',
  'Run #94 saathi_report / test / ₹2500 per day · 6 creatives · 2 ad set(s)',
  '  PROVEN: creative hook_type=question -> ctr_pct better 0.1 vs campaign_siblings, 7d [H123]',
  '  VARIANT (Δ angle pain_point→gain of saathi_report|creative|angle|pain_point): creative angle=gain -> ctr_pct better 0.1 vs parent_hypothesis, 7d [H124]',
  '  ad set lal_1: lookalike, advantage_audience=false, ₹1500/day → H123',
  'Run #95 nadi_reading / evergreen / ₹1500 per day · 4 creatives · 1 ad set(s) (already open; returned, not re-opened)',
  '  (no hypothesis recorded for this run)',
  'Mix today: 1 proven / 1 variant (50%) — required ≥1 variant at 30%',
  'Why: Saathi is converting; Nadi holds.',
  'Reply: approve · approve at <amount> · approve <slug> only · reject <reason>',
].join('\n');

describe('cleanPlanSummary', () => {
  it('drops the Slack reply grammar line', () => {
    const out = cleanPlanSummary(SLACK_SUMMARY);
    expect(out).not.toMatch(/Reply:/);
    expect(out).not.toMatch(/approve at <amount>/);
  });

  it('strips [H…] tags, → H… pointers and run ids', () => {
    const out = cleanPlanSummary(SLACK_SUMMARY);
    expect(out).not.toMatch(/\bH\d+\b/);
    expect(out).not.toMatch(/\[H/);
    expect(out).not.toMatch(/Run #\d+/);
    expect(out).not.toMatch(/already open/);
    expect(out).not.toMatch(/no hypothesis recorded/);
    expect(out.split('\n')[1]).toBe(
      'saathi_report / test / ₹2500 per day · 6 creatives · 2 ad set(s)',
    );
    expect(out).toContain(
      'ad set lal_1: lookalike, advantage_audience=false, ₹1500/day',
    );
    expect(out).toContain('Why: Saathi is converting; Nadi holds.');
  });

  it('is empty-safe', () => {
    expect(cleanPlanSummary(null)).toBe('');
    expect(cleanPlanSummary('Reply: approve')).toBe('');
  });
});

describe('planDecisionIds', () => {
  it('prefers the gate snapshot, then the plan, else unknown', () => {
    expect(
      planDecisionIds({ decision_ids: [7, 8] }, { decision_ids: [9] }),
    ).toEqual(new Set(['7', '8']));
    expect(
      planDecisionIds({ decision_ids: null }, { decision_ids: '[9]' }),
    ).toEqual(new Set(['9']));
    expect(planDecisionIds({}, null)).toBeNull();
  });
});

const approval = {
  id: 48,
  gate: 'plan',
  plan_date: '2026-09-25',
  summary: SLACK_SUMMARY,
  decision_ids: [7, 8],
};
const dailyPlan = {
  plan_date: '2026-09-25',
  budget_inr: 5000,
  allocations: [
    { offering_slug: 'saathi_report', amount_inr: 2500, reason: 'converting' },
    { offering_slug: 'nadi_reading', amount_inr: 1500, reason: 'holds' },
  ],
  reasoning: 'Saathi is converting [H123]; Nadi holds (run 95 stays).',
  decision_ids: [7, 8],
};
const runs = [
  {
    id: 94,
    offering_slug: 'saathi_report',
    campaign_type: 'test',
    target_creative_count: 6,
    decision_id: 7,
    creative_contract: {
      audience_plan: [
        { entry_key: 'lal_1', budget_value_inr: 1500 },
        { entry_key: 'int_1', budget_value_inr: 1000 },
      ],
    },
  },
  {
    id: 95,
    offering_slug: 'nadi_reading',
    campaign_type: 'evergreen',
    target_creative_count: 4,
    decision_id: 8,
  },
  // Same date, another decision: not this gate's to release.
  {
    id: 96,
    offering_slug: 'other',
    campaign_type: 'launch',
    target_creative_count: 2,
    decision_id: 99,
  },
];
const hypotheses = [
  {
    id: 123,
    kind: 'proven',
    level: 'creative',
    status: 'proposed',
    offering_slug: 'saathi_report',
    attribute: 'hook_type',
    value: 'question',
    metric: 'ctr_pct',
    direction: 'better',
    comparison: 'campaign_siblings',
  },
  {
    id: 124,
    kind: 'variant',
    level: 'creative',
    status: 'proposed',
    offering_slug: 'saathi_report',
    attribute: 'angle',
    value: 'gain',
    metric: 'ctr_pct',
    direction: 'better',
    comparison: 'parent_hypothesis',
  },
  {
    id: 125,
    kind: 'seed',
    level: 'creative',
    status: 'retired',
    offering_slug: 'saathi_report',
    attribute: 'format',
    value: 'video',
    metric: 'ctr_pct',
    direction: 'better',
    comparison: 'campaign_siblings',
  },
];
const names = new Map([
  ['saathi_report', 'Saathi Report'],
  ['nadi_reading', 'Nadi Reading'],
]);

describe('buildPlanView', () => {
  it('builds the plan from brain rows, not the Slack text', () => {
    const view = buildPlanView({
      approval,
      dailyPlan,
      runs,
      hypotheses,
      names,
    });
    expect(view.structured).toBe(true);
    expect(view.dateLabel).toBe('Friday, 25 Sep');
    expect(view.totalDailyInr).toBe(4000);
    expect(view.budgetInr).toBe(5000);
    expect(view.unspentInr).toBe(1000);
    expect(view.runs).toEqual([
      {
        product: 'Saathi Report',
        typeLabel: 'Test',
        dailyBudgetInr: 2500,
        creatives: 6,
        adSets: 2,
      },
      {
        product: 'Nadi Reading',
        typeLabel: 'Always-on',
        dailyBudgetInr: 1500,
        creatives: 4,
        adSets: null,
      },
    ]);
    expect(view.testing).toHaveLength(2);
    expect(view.testing[0]).toEqual({
      claim:
        'Ads that open with a question will get more clicks than the other ads in the same campaign.',
      kindLabel: 'Proven idea',
      levelLabel: 'Ad',
      product: 'Saathi Report',
    });
    expect(view.mix).toBe('1 proven idea, 1 new twist');
    expect(view.why).toBe('Saathi is converting; Nadi holds (run 95 stays).');
    expect(JSON.stringify(view.testing)).not.toMatch(
      /\bH\d+\b|hook_type|ctr_pct/,
    );
  });

  it('falls back to the cleaned text when the day plan is missing', () => {
    const view = buildPlanView({
      approval,
      dailyPlan: null,
      runs: [],
      hypotheses: [],
      names,
    });
    expect(view.structured).toBe(false);
    expect(view.runs).toEqual([]);
    expect(view.summaryText).not.toMatch(/Reply:|\[H\d+\]/);
    expect(view.dateLabel).toBe('Friday, 25 Sep');
  });
});

describe('FoundryBridgeService.getGates plan enrichment', () => {
  it('attaches a structured plan read by plan_date and decision_id', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const answers: Record<string, (args: Record<string, unknown>) => unknown> =
      {
        approvals_pending: () => ({ rows: [{ ...approval, slack_ts: '1.2' }] }),
        approvals_unposted: () => ({ rows: [] }),
        brain_read: (args) => {
          if (args.table === 'daily_plans') return { rows: [dailyPlan] };
          if (args.table === 'pipeline_runs') return { rows: runs };
          if (args.table === 'offerings')
            return {
              rows: [...names].map(([slug, display_name]) => ({
                slug,
                display_name,
              })),
            };
          return { rows: [] };
        },
        hypotheses_read: (args) => ({
          rows: args.decision_id === 7 ? hypotheses : [],
        }),
      };
    const respond = (tool: string, args: Record<string, unknown> = {}) => {
      calls.push({ tool, args });
      return Promise.resolve(answers[tool] ? answers[tool](args) : null);
    };
    const svc = new FoundryBridgeService(
      { get: () => undefined } as unknown as ConfigService,
      {} as unknown as CreativeImageService,
    );
    Object.assign(svc as unknown as Record<string, unknown>, {
      brain: { isConfigured: () => true, call: respond, tryCall: respond },
    });

    const gates = await svc.getGates();
    const plan = gates.find((g) => g.spendGate === 'plan')!.plan!;
    expect(plan.structured).toBe(true);
    expect(plan.runs.map((r) => r.product)).toEqual([
      'Saathi Report',
      'Nadi Reading',
    ]);
    expect(plan.mix).toBe('1 proven idea, 1 new twist');
    const gate = gates.find((g) => g.spendGate === 'plan')!;
    expect(gate.summary).toBe(
      '2 campaigns · ₹4,000 a day of ₹5,000 · 2 ideas to test',
    );
    expect(gate.title).toBe('Day plan for Friday, 25 Sep');
    const hypCalls = calls.filter((c) => c.tool === 'hypotheses_read');
    expect(hypCalls.map((c) => c.args.decision_id)).toEqual([7, 8]);
    expect(hypCalls.every((c) => c.args.compact === false)).toBe(true);
  });

  it('degrades to structured:false when the brain rows are unreadable', async () => {
    const respond = (tool: string) =>
      Promise.resolve(
        tool === 'approvals_pending'
          ? { rows: [{ ...approval, slack_ts: '1.2' }] }
          : tool === 'approvals_unposted'
            ? { rows: [] }
            : null,
      );
    const svc = new FoundryBridgeService(
      { get: () => undefined } as unknown as ConfigService,
      {} as unknown as CreativeImageService,
    );
    Object.assign(svc as unknown as Record<string, unknown>, {
      brain: { isConfigured: () => true, call: respond, tryCall: respond },
    });
    const gates = await svc.getGates();
    const plan = gates[0].plan!;
    expect(plan.structured).toBe(false);
    expect(plan.summaryText).not.toMatch(/Reply:/);
  });
});
