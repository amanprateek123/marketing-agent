import { ConfigService } from '@nestjs/config';
import { CreativeImageService } from './creative-image.service';
import {
  attributeLabel,
  dayLabel,
  humanDate,
  mapExperiment,
  mixSentence,
  renderClaim,
  renderProgress,
  renderResult,
  stripInternalIds,
  summariseExperiments,
  valueLabel,
} from './experiments.mapper';
import { FoundryBridgeService } from './foundry-bridge.service';

const NOW = new Date('2026-09-25T09:40:00+05:30');

const base = {
  id: 123,
  level: 'creative',
  kind: 'proven',
  status: 'active',
  offering_slug: 'saathi_report',
  attribute: 'hook_type',
  value: 'question',
  metric: 'ctr_pct',
  direction: 'better',
  threshold: 0.1,
  comparison: 'campaign_siblings',
  horizon_days: 7,
  floors: {},
  statement:
    'PROVEN: On saathi_report, creative hook_type=question: ctr_pct better than its campaign siblings by ≥10% within 7 days.',
  activated_at: '2026-09-22T04:30:00Z',
  judged_at: null,
  verdict: null,
  created_at: '2026-09-21T04:30:00Z',
};

/** Nothing internal may appear anywhere in what the page receives. */
function expectNoInternals(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toMatch(/\bH\d+\b/);
  expect(text).not.toMatch(
    /hook_type|ctr_pct|campaign_siblings|saathi_report"/,
  );
  expect(text).not.toMatch(
    /"(proposed|active|confirmed|refuted|inconclusive|retired)"/,
  );
}

describe('vocabulary', () => {
  it('names attributes the way the brief does', () => {
    expect(attributeLabel('angle')).toBe('message angle');
    expect(attributeLabel('hook_type')).toBe('opening hook');
    expect(attributeLabel('placement_mode')).toBe('where ads show');
    expect(attributeLabel('advantage_audience')).toBe(
      "Meta's automatic audience",
    );
    expect(attributeLabel('some_new_thing')).toBe('some new thing');
  });

  it('humanises values', () => {
    expect(valueLabel('angle', 'pain_point')).toBe('pain point');
    expect(valueLabel('hook_type', 'question')).toBe('a question');
    expect(valueLabel('angle', 'price_led')).toBe('price-led');
    expect(
      valueLabel(
        'placement_mode',
        'audience_network+facebook+instagram+messenger+threads',
      ),
    ).toBe('all placements');
    expect(valueLabel('placement_mode', 'facebook+instagram')).toBe(
      'Facebook and Instagram',
    );
    expect(valueLabel('age_band', '25_44')).toBe('25–44');
    expect(valueLabel('language', 'hindi')).toBe('Hindi');
  });
});

describe('renderClaim', () => {
  it('renders a plain sentence from the fields, never the stored statement', () => {
    expect(renderClaim(base)).toBe(
      'Ads that open with a question will get more clicks than the other ads in the same campaign.',
    );
  });

  it('handles at-least claims, other metrics and comparisons', () => {
    expect(
      renderClaim({
        ...base,
        attribute: 'angle',
        value: 'pain_point',
        metric: 'roas',
        direction: 'at_least',
        comparison: 'parent_hypothesis',
      }),
    ).toBe(
      'Ads using the pain point message angle will earn at least as good a return on ad spend as the proven idea it builds on.',
    );
    expect(
      renderClaim({
        ...base,
        attribute: 'placement_mode',
        value: 'audience_network+facebook+instagram+messenger+threads',
        metric: 'cost_per_purchase',
        comparison: 'product_baseline',
      }),
    ).toBe(
      "Showing ads in all placements will get sales more cheaply than this product's usual ads.",
    );
    expect(
      renderClaim({
        ...base,
        comparison: 'cohort_without_attribute',
      }),
    ).toBe(
      'Ads that open with a question will get more clicks than ads with a different opening hook.',
    );
  });
});

describe('renderProgress', () => {
  it('reads spend and impressions against the level floors and counts days left', () => {
    const progress = renderProgress(
      base,
      {
        with: { spend: 312.4, impressions: 1500 },
        judgement: { outcome: 'active', code: 'waiting' },
      },
      NOW,
    );
    expect(progress).toEqual({
      spentInr: 312,
      neededInr: 500,
      impressions: 1500,
      neededImpressions: 2000,
      daysLeft: 5,
      note: 'Still collecting results.',
    });
  });

  it('a planned test has no clock yet', () => {
    const progress = renderProgress(
      { ...base, status: 'proposed', activated_at: null },
      null,
      NOW,
    );
    expect(progress.daysLeft).toBeNull();
    expect(progress.spentInr).toBe(0);
    expect(progress.note).toBe('Starts when its ads go live.');
  });
});

describe('renderResult', () => {
  it('states a confirmed result with figures and a confidence label', () => {
    expect(
      renderResult({
        ...base,
        status: 'confirmed',
        verdict: {
          outcome: 'confirmed',
          code: 'confirmed',
          confidence: 'medium',
          with_rate: 2.1,
          baseline_rate: 1.4,
          with: { creatives: 4 },
          baseline: { creatives: 4 },
        },
      }),
    ).toEqual({
      sentence: 'It worked: 2.1% vs 1.4% click rate across 4 vs 4 ads.',
      confidenceLabel: 'Fairly sure',
    });
  });

  it('explains an inconclusive verdict without its code', () => {
    const result = renderResult({
      ...base,
      status: 'inconclusive',
      verdict: {
        outcome: 'inconclusive',
        code: 'floors_unmet',
        confidence: null,
      },
    });
    expect(result).toEqual({
      sentence: 'Not enough was spent in time to tell either way.',
      confidenceLabel: null,
    });
  });
});

describe('mapExperiment', () => {
  it('strips ids and enum codes from the page model', () => {
    const names = new Map([['saathi_report', 'Saathi Report']]);
    const exp = mapExperiment(base, {
      view: 'testing',
      names,
      perf: new Map([
        [
          '123',
          {
            with: { spend: 100, impressions: 400 },
            judgement: { code: 'waiting' },
          },
        ],
      ]),
      now: NOW,
    });
    expect(exp).not.toBeNull();
    expect(exp!.ref).toBe('exp-123');
    expect(exp!.product).toBe('Saathi Report');
    expect(exp!.kindLabel).toBe('Proven idea');
    expect(exp!.statusLabel).toBe('Testing now');
    expect(exp!.levelLabel).toBe('Ad');
    expect(exp!.since).toBe('22 Sep');
    expect(exp!.result).toBeNull();
    // productKey and sinceAt are machine fields; everything a person reads is clean.
    const visible: Record<string, unknown> = { ...exp! };
    for (const key of ['productKey', 'sinceAt', 'ref', 'kind']) {
      delete visible[key];
    }
    expectNoInternals(visible);
  });
});

describe('summariseExperiments', () => {
  it('counts per shelf and per product', () => {
    const summary = summariseExperiments(
      {
        testing: [{ offering_slug: 'a' }, { offering_slug: 'b' }],
        learned: [{ offering_slug: 'a' }],
        dropped: [],
      },
      new Map([['a', 'Alpha']]),
      false,
    );
    expect(summary.views).toEqual({ testing: 2, learned: 1, dropped: 0 });
    expect(summary.products).toEqual([
      { productKey: 'a', product: 'Alpha', testing: 1, learned: 1, dropped: 0 },
      { productKey: 'b', product: 'B', testing: 1, learned: 0, dropped: 0 },
    ]);
  });
});

describe('small helpers', () => {
  it('mixSentence', () => {
    expect(
      mixSentence([
        'proven',
        'proven',
        'proven',
        'proven',
        'variant',
        'variant',
      ]),
    ).toBe('4 proven ideas, 2 new twists');
    expect(mixSentence(['seed'])).toBe('1 exploratory idea');
    expect(mixSentence([])).toBeNull();
  });

  it('dates are human and in IST', () => {
    expect(humanDate('2026-09-25T02:00:00Z', NOW)).toBe('Today');
    expect(humanDate('2026-09-24T02:00:00Z', NOW)).toBe('Yesterday');
    expect(humanDate('2025-01-03', NOW)).toBe('3 Jan 2025');
    expect(dayLabel('2026-09-25')).toBe('Friday, 25 Sep');
  });

  it('stripInternalIds', () => {
    expect(
      stripInternalIds('Question hooks [H12] lift clicks → H45, Run #94 ok'),
    ).toBe('Question hooks lift clicks, ok');
  });
});

describe('FoundryBridgeService experiments', () => {
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

  it('reads each status separately, chunks perf ids by 10, and returns plain rows', async () => {
    const active = Array.from({ length: 12 }, (_, i) => ({
      ...base,
      id: 100 + i,
    }));
    const { svc, calls } = service({
      hypotheses_read: (args) =>
        (args.statuses as string[])[0] === 'active'
          ? { rows: active }
          : {
              rows: [
                { ...base, id: 99, status: 'proposed', activated_at: null },
              ],
            },
      perf_by_hypothesis: (args) => ({
        rows: (args.hypothesis_ids as number[]).map((id) => ({
          hypothesis_id: id,
          with: { spend: 50, impressions: 100 },
          judgement: { code: 'waiting' },
        })),
      }),
      brain_read: () => ({
        rows: [{ slug: 'saathi_report', display_name: 'Saathi Report' }],
      }),
    });

    const out = await svc.getExperiments('testing', 'saathi_report');
    expect(out).toHaveLength(13);
    const reads = calls.filter((c) => c.tool === 'hypotheses_read');
    expect(reads.map((c) => c.args.statuses)).toEqual([
      ['proposed'],
      ['active'],
    ]);
    expect(
      reads.every(
        (c) =>
          c.args.compact === false && c.args.offering_slug === 'saathi_report',
      ),
    ).toBe(true);
    const perf = calls.filter((c) => c.tool === 'perf_by_hypothesis');
    expect(perf.map((c) => (c.args.hypothesis_ids as number[]).length)).toEqual(
      [10, 2],
    );
    expect(out.every((e) => e.product === 'Saathi Report')).toBe(true);
    expect(out.find((e) => e.ref === 'exp-100')!.progress!.spentInr).toBe(50);
  });

  it('summary declares partial when the brain truncated a read', async () => {
    const { svc } = service({
      hypotheses_read: (args) => ({
        rows: [{ offering_slug: 'x', status: (args.statuses as string[])[0] }],
        truncated: (args.statuses as string[])[0] === 'confirmed',
      }),
      brain_read: () => ({ rows: [] }),
    });
    const summary = await svc.getExperimentSummary();
    expect(summary.views).toEqual({ testing: 1, learned: 1, dropped: 1 });
    expect(summary.partial).toBe(true);
  });
});
