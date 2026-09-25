import { ConfigService } from '@nestjs/config';
import { CreativeImageService } from './creative-image.service';
import { mapCampaignCreative, mapCampaignRun } from './campaign-run.mapper';
import {
  attributeLabel,
  carriedBy,
  expectedSentence,
  mapBet,
  mapBets,
  mapExperiment,
  mapProvenCatalogue,
  parseLinks,
  renderChange,
  renderClaim,
  renderProgress,
  valueLabel,
} from './experiments.mapper';
import { FoundryBridgeService } from './foundry-bridge.service';
import { mapDecision } from './mappers';

const NOW = new Date('2026-09-25T09:40:00+05:30');
const names = new Map([['saathi_report', 'Saathi Report']]);

const base = {
  id: 200,
  level: 'creative',
  kind: 'variant',
  status: 'active',
  offering_slug: 'saathi_report',
  attribute: 'hook_type',
  value: 'statistic',
  metric: 'ctr_pct',
  direction: 'better',
  comparison: 'parent_hypothesis',
  horizon_days: 7,
  floors: {},
  parent_hypothesis_id: 123,
  activated_at: '2026-09-22T04:30:00Z',
  links: [
    { target_kind: 'creative', target_id: 'ck_a' },
    { target_kind: 'creative', target_id: 'ck_b' },
    { target_kind: 'adset', target_id: '120000001' },
    { target_kind: 'campaign', target_id: '120000009' },
    { target_kind: 'pipeline_run', target_id: '94' },
  ],
};

function expectNoInternals(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toMatch(/ck_a|ck_b|120000001|120000009|\bH\d+\b/);
  expect(text).not.toMatch(/hook_type|ctr_pct|audience_kind|price_point/);
}

describe('vocabulary gaps', () => {
  it('labels the attributes the brain uses at every level', () => {
    expect(attributeLabel('placement')).toBe('where ads show');
    expect(attributeLabel('audience_kind')).toBe('audience type');
    expect(attributeLabel('kind')).toBe('audience type');
    expect(attributeLabel('price_point')).toBe('price');
    expect(attributeLabel('offer')).toBe('offer');
    expect(attributeLabel('campaign_type')).toBe('campaign type');
  });

  it('renders their values and claims in words', () => {
    expect(valueLabel('price_point', '899')).toBe('₹899');
    expect(valueLabel('placement', 'facebook+instagram')).toBe(
      'Facebook and Instagram',
    );
    expect(valueLabel('campaign_type', 'always_on')).toBe('always-on');
    const claim = (attribute: string, value: string) =>
      renderClaim({
        attribute,
        value,
        metric: 'roas',
        direction: 'better',
        comparison: 'product_baseline',
      });
    expect(claim('audience_kind', 'lookalike')).toBe(
      "Ad sets aimed at people similar to past buyers will earn a better return on ad spend than this product's usual ads.",
    );
    expect(claim('price_point', '899')).toMatch(/^Selling at ₹899 /);
    expect(claim('offer', 'discount')).toMatch(/^Leading with a discount /);
    expect(claim('campaign_type', 'test')).toMatch(
      /^Running it as a test campaign /,
    );
    expect(claim('placement', 'reels')).toMatch(/^Showing ads in Reels /);
    expect(claim('kind', 'retargeting')).toMatch(
      /^Ad sets aimed at people who already visited /,
    );
  });
});

describe('floors come from the row', () => {
  it('uses the row floors, then the judge floors, then the default', () => {
    const own = renderProgress(
      { ...base, floors: { min_spend_inr: 900, min_impressions: 3000 } },
      null,
      NOW,
    );
    expect(own.neededInr).toBe(900);
    expect(own.neededImpressions).toBe(3000);
    const asText = renderProgress(
      { ...base, floors: '{"min_spend_inr": 750}' },
      null,
      NOW,
    );
    expect(asText.neededInr).toBe(750);
    const judged = renderProgress(
      base,
      { with: {}, judgement: { floors: { min_spend_inr: 1200 } } },
      NOW,
    );
    expect(judged.neededInr).toBe(1200);
    expect(renderProgress(base, null, NOW).neededInr).toBe(500);
  });
});

describe('links', () => {
  it('reads full-row objects and compact "kind:id" strings alike', () => {
    expect(parseLinks(['creative:ck_a', 'pipeline_run:94', 'junk'])).toEqual([
      { kind: 'creative', id: 'ck_a' },
      { kind: 'pipeline_run', id: '94' },
    ]);
    expect(parseLinks(base.links)).toHaveLength(5);
    expect(parseLinks(null)).toEqual([]);
  });

  it('counts what carries a bet, never naming it', () => {
    expect(carriedBy(base)).toEqual({
      ads: 2,
      adSets: 1,
      campaigns: 1,
      sentence: 'Carried by 2 ads, 1 ad set and 1 live campaign.',
    });
    expect(
      carriedBy({ ...base, links: ['creative:ck_a'], creative_key: 'ck_c' })!
        .ads,
    ).toBe(2);
    expect(carriedBy({ ...base, links: ['pipeline_run:94'] })).toBeNull();
  });
});

describe('what changed from the parent', () => {
  it('prefers the brain’s delta_from', () => {
    expect(
      renderChange(
        {
          ...base,
          delta_from: {
            attribute: 'hook_type',
            from_value: 'question',
            to_value: 'statistic',
          },
        },
        null,
      ),
    ).toBe(
      'Keeps the proven idea but changes the opening hook from a question to statistic.',
    );
  });

  it('falls back to the parent row, then to a plain sentence', () => {
    expect(
      renderChange(base, {
        id: 123,
        attribute: 'hook_type',
        value: 'question',
      }),
    ).toBe(
      'Keeps the proven idea but changes the opening hook from a question to statistic.',
    );
    expect(
      renderChange(base, { id: 123, attribute: 'angle', value: 'pain_point' }),
    ).toBe(
      'Builds on “Ads using the pain point message angle” and sets the opening hook to statistic.',
    );
    expect(renderChange(base, null)).toMatch(/^Builds on an idea that worked/);
    expect(renderChange({ ...base, parent_hypothesis_id: null }, null)).toBe(
      null,
    );
  });

  it('puts change and carriers on the experiment card', () => {
    const exp = mapExperiment(base, {
      view: 'testing',
      names,
      parents: new Map([
        ['123', { id: 123, attribute: 'hook_type', value: 'question' }],
      ]),
      now: NOW,
    })!;
    expect(exp.change).toMatch(/from a question to statistic/);
    expect(exp.carriedBy!.ads).toBe(2);
    expectNoInternals(exp);
  });
});

describe('bets', () => {
  it('maps a bet in words and de-duplicates full over compact rows', () => {
    const bet = mapBet(base, { names })!;
    expect(bet).toMatchObject({
      ref: 'exp-200',
      kind: 'variant',
      kindLabel: 'New twist on a proven idea',
      levelLabel: 'Ad',
      statusLabel: 'Testing now',
      product: 'Saathi Report',
      result: null,
    });
    const bets = mapBets(
      [
        { id: 200, attribute: 'hook_type', value: 'statistic', links: [] },
        base,
        {
          ...base,
          id: 201,
          status: 'confirmed',
          verdict: { with_rate: 2.1, baseline_rate: 1.4 },
        },
      ],
      names,
    );
    expect(bets.map((b) => b.ref)).toEqual(['exp-201', 'exp-200']);
    expect(bets[1].carriedBy!.ads).toBe(2);
    expect(bets[0].result!.sentence).toBe(
      'It worked: 2.1% vs 1.4% click rate.',
    );
    expectNoInternals(bets);
  });

  it('puts the bet on a creative and on its audience', () => {
    const bet = mapBet(base, { names });
    const creative = mapCampaignCreative(
      { creative_key: 'ck_a', status: 'approved' },
      null,
      bet,
    )!;
    expect(creative.bet!.claim).toMatch(/^Ads that open with statistic/);

    const run = mapCampaignRun(
      {
        id: 94,
        offering_slug: 'saathi_report',
        status: 'open',
        stage: 'building',
        created_at: '2026-09-25T04:00:00Z',
        creative_contract: {
          audience_plan: [
            { entry_key: 'lal_1', kind: 'lookalike', hypothesis_id: 300 },
            { entry_key: 'int_1', kind: 'interest' },
          ],
        },
      },
      {
        names,
        hypotheses: [
          base,
          {
            id: 300,
            level: 'audience',
            kind: 'seed',
            status: 'proposed',
            attribute: 'audience_kind',
            value: 'lookalike',
            metric: 'roas',
          },
        ],
      },
    )!;
    expect(run.bets).toHaveLength(2);
    expect(run.audiences[0].name).toBe('People similar to past buyers');
    expect(run.audiences[0].bet!.levelLabel).toBe('Audience');
    expect(run.audiences[1].bet).toBeNull();
    expectNoInternals(run.bets);
  });
});

describe('proven catalogue', () => {
  it('maps proven and refuted ideas without codes', () => {
    const out = mapProvenCatalogue(
      {
        rows: [
          {
            catalogue_key: 'k1',
            offering_slug: 'saathi_report',
            level: 'creative',
            attribute: 'hook_type',
            value: 'question',
            tier: 'proven',
            confirmations: 3,
            refutations: 1,
          },
          {
            catalogue_key: 'k2',
            offering_slug: null,
            level: 'product',
            attribute: 'price_point',
            value: '899',
            tier: 'promising',
            confirmations: 1,
            refutations: 0,
          },
        ],
        refuted: [
          {
            catalogue_key: 'k3',
            offering_slug: 'saathi_report',
            level: 'creative',
            attribute: 'format',
            value: 'carousel',
            refutations: 2,
          },
        ],
        truncated: false,
      },
      names,
    );
    expect(out.empty).toBe(false);
    expect(out.proven[0]).toMatchObject({
      idea: 'Ads that open with a question.',
      tierLabel: 'Proven',
      tone: 'good',
      evidence: 'Worked in 3 tests, failed in 1.',
      product: 'Saathi Report',
    });
    expect(out.proven[1]).toMatchObject({
      idea: 'Selling at ₹899.',
      tierLabel: 'Promising',
      product: null,
    });
    expect(out.refuted[0].evidence).toBe(
      'Failed in 2 tests — not worth retrying.',
    );
    expectNoInternals({
      ...out,
      proven: out.proven.map((p) => ({ ...p, ref: '' })),
    });
  });

  it('is empty-safe', () => {
    expect(mapProvenCatalogue(null, names)).toEqual({
      proven: [],
      refuted: [],
      empty: true,
      truncated: false,
    });
  });
});

describe('decisions', () => {
  it('says what a decision expected', () => {
    expect(
      expectedSentence({ summary: 'CTR lifts on [H12] question hooks' }),
    ).toBe('CTR lifts on question hooks');
    expect(expectedSentence({ metric: 'roas', target: 1.8 })).toBe(
      'Expected return on ad spend of at least 1.80x.',
    );
    expect(expectedSentence('{"text":"More sales"}')).toBe('More sales');
    expect(expectedSentence(null)).toBeNull();
    expect(
      mapDecision({ id: 7, chosen: {}, expected_outcome: { text: 'x' } })!
        .expected,
    ).toBe('x');
  });
});

describe('FoundryBridgeService bets', () => {
  function service(
    answers: Record<string, (args: Record<string, unknown>) => unknown>,
  ) {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
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
    return { svc, calls };
  }

  it('re-reads a truncated shelf per level and says when it is still cut', async () => {
    const { svc, calls } = service({
      hypotheses_read: (args) =>
        args.level
          ? {
              rows: [
                {
                  ...base,
                  id: args.level === 'creative' ? 1 : 2,
                  level: args.level,
                },
              ],
              truncated: args.level === 'creative',
            }
          : { rows: [{ ...base, id: 3 }], truncated: true },
      brain_read: () => ({ rows: [] }),
    });
    const page = await svc.getExperimentPage('learned', null);
    expect(page.truncated).toBe(true);
    expect(page.experiments.length).toBeGreaterThanOrEqual(3);
    const levels = calls
      .filter((c) => c.tool === 'hypotheses_read' && c.args.level)
      .map((c) => c.args.level);
    expect(new Set(levels).size).toBe(5);
  });

  it('protects a live campaign until its judge-from date', async () => {
    const { svc, calls } = service({
      campaign_intent: () => ({ found: true, pipeline_run_id: 94 }),
      monitor_thresholds: () => ({ judge_from: '2099-10-02' }),
      hypotheses_read: (args) =>
        args.pipeline_run_id ? { rows: [base] } : { rows: [] },
      brain_read: () => ({
        rows: [{ slug: 'saathi_report', display_name: 'Saathi Report' }],
      }),
    });
    const out = await svc.getCampaignBets('120000009');
    expect(out.found).toBe(true);
    expect(out.bets).toHaveLength(1);
    expect(out.protectedUntil).toMatch(/2 Oct/);
    expect(out.note).toMatch(/will not pause/);
    expect(
      calls.some(
        (c) =>
          c.tool === 'hypotheses_read' &&
          c.args.meta_campaign_id === '120000009',
      ),
    ).toBe(true);
    expectNoInternals(out.bets);
  });

  it('says a campaign the Brain did not build carries no bets', async () => {
    const { svc } = service({
      campaign_intent: () => ({ found: false }),
      hypotheses_read: () => ({ rows: [] }),
    });
    const out = await svc.getCampaignBets('555');
    expect(out).toMatchObject({ found: false, bets: [], protectedUntil: null });
  });

  it('reads a decision’s bets and expectation', async () => {
    const { svc, calls } = service({
      hypotheses_read: () => ({ rows: [base] }),
      brain_read: (args) =>
        args.table === 'decisions'
          ? { rows: [{ id: 7, expected_outcome: { text: 'More clicks' } }] }
          : { rows: [] },
    });
    const out = await svc.getDecisionBets('7');
    expect(out.expected).toBe('More clicks');
    expect(out.bets).toHaveLength(1);
    expect(
      calls.find((c) => c.tool === 'hypotheses_read')!.args.decision_id,
    ).toBe(7);
    await expect(svc.getDecisionBets('abc')).rejects.toThrow();
  });

  it('maps the proven catalogue through the route', async () => {
    const { svc, calls } = service({
      proven_catalogue: () => ({ rows: [], refuted: [], empty: true }),
      brain_read: () => ({ rows: [] }),
    });
    const out = await svc.getProven('saathi_report', 'creative');
    expect(out.empty).toBe(true);
    expect(
      calls.find((c) => c.tool === 'proven_catalogue')!.args,
    ).toMatchObject({
      offering_slug: 'saathi_report',
      level: 'creative',
      compact: true,
    });
  });
});
