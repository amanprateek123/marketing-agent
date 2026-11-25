import {
  creativeVerdict,
  mergeAdRows,
  latestFile,
  mdSections,
  sectionBody,
} from './report.logic';

const md = `---
phase: "investigate"
round: 1
---
## Verdict
ROAS is 0.63× inferred.

Second paragraph.

## C1 — Tracking is broken (confidence 0.8)
- 0 tracked visitors

## C10 — Other
- x

## Ruled out
- Festive CPM
`;

describe('report markdown', () => {
  const s = mdSections(md);

  it('splits sections and drops front matter', () => {
    expect(s.map((x) => x.heading)).toEqual([
      'Verdict',
      'C1 — Tracking is broken (confidence 0.8)',
      'C10 — Other',
      'Ruled out',
    ]);
    expect(sectionBody(s, 'Verdict')).toBe(
      'ROAS is 0.63× inferred.\n\nSecond paragraph.',
    );
  });

  it('matches a cause id exactly (C1 is not C10)', () => {
    expect(sectionBody(s, 'C1')).toBe('- 0 tracked visitors');
    expect(sectionBody(s, 'C10')).toBe('- x');
    expect(sectionBody(s, 'C2')).toBe('');
  });

  it('reads the latest round of a phase', () => {
    const files = {
      '01-investigate.v1.md': 'one',
      '01-investigate.v2.md': 'two',
      '01-investigate.v2.md.json': '{}',
      '03-plan.v1.md.json': '{"a":1}',
    };
    expect(latestFile(files, '01-investigate')).toBe('two');
    expect(latestFile(files, '03-plan', '.md.json')).toBe('{"a":1}');
    expect(latestFile(files, '02-verify')).toBe('');
  });
});

describe('creativeVerdict', () => {
  // Career Report, 3–5 Nov: ₹7,269 spend, 3 Meta purchases, CTR 0.85%.
  const camp = {
    spend: 7269,
    impressions: 11400,
    ctr: 0.0085,
    metaPurchases: 3,
    metaRoas: 0.74,
  };

  it('too early under 1,500 impressions with no purchase', () => {
    expect(
      creativeVerdict(
        {
          spend: 51,
          impressions: 45,
          ctr: 0,
          metaPurchases: 0,
          metaRoas: null,
        },
        camp,
      ).tag,
    ).toBe('too_early');
  });

  it('scale when purchases come cheaper than the campaign', () => {
    const v = creativeVerdict(
      {
        spend: 1800,
        impressions: 3000,
        ctr: 0.0103,
        metaPurchases: 2,
        metaRoas: 2.11,
      },
      camp,
    );
    expect(v.tag).toBe('scale');
    expect(v.reason).toContain('₹900 each');
  });

  it('cut after twice the campaign cost per purchase with none', () => {
    expect(
      creativeVerdict(
        {
          spend: 5000,
          impressions: 8000,
          ctr: 0.009,
          metaPurchases: 0,
          metaRoas: 0,
        },
        camp,
      ).tag,
    ).toBe('cut');
  });

  it('cut sooner when CTR is weak too', () => {
    const v = creativeVerdict(
      {
        spend: 3700,
        impressions: 6000,
        ctr: 0.005,
        metaPurchases: 0,
        metaRoas: 0,
      },
      camp,
    );
    expect(v.tag).toBe('cut');
    expect(v.reason).toContain('CTR 0.50% vs 0.85%');
  });

  it('keep otherwise', () => {
    expect(
      creativeVerdict(
        {
          spend: 1142,
          impressions: 2200,
          ctr: 0.005,
          metaPurchases: 0,
          metaRoas: 0,
        },
        camp,
      ).tag,
    ).toBe('keep');
    expect(
      creativeVerdict(
        {
          spend: 2500,
          impressions: 4000,
          ctr: 0.008,
          metaPurchases: 1,
          metaRoas: 0.7,
        },
        camp,
      ).tag,
    ).toBe('keep');
  });

  it('with no purchases in the campaign, judges spend against 15% of it', () => {
    const none = { ...camp, metaPurchases: 0, metaRoas: 0 };
    expect(
      creativeVerdict(
        {
          spend: 2200,
          impressions: 4000,
          ctr: 0.008,
          metaPurchases: 0,
          metaRoas: 0,
        },
        none,
      ).tag,
    ).toBe('cut');
  });
});

describe('ads without purchases', () => {
  const camp = { spend: 3040, impressions: 64039, ctr: 0.0026, metaPurchases: 0, metaRoas: 0, landingPageViews: 13 };
  it('cuts on a weak click rate or a dear page view once there are 3,000+ impressions', () => {
    // "Job Vs Business Video": 1 click from 3,237 impressions.
    const weak = creativeVerdict({ spend: 106, impressions: 3237, ctr: 0.0003, metaPurchases: 0, metaRoas: 0, landingPageViews: 0, hookRate: 0.037 }, camp);
    expect(weak.tag).toBe('cut');
    expect(weak.reason).toMatch(/CTR 0\.03% vs 0\.26%/);
    expect(weak.reason).toMatch(/3\.7% watch past 3 s/);
  });
  it('marks the best early click rate and leaves the rest to keep or too early', () => {
    const best = creativeVerdict({ spend: 125, impressions: 5000, ctr: 0.0052, metaPurchases: 0, metaRoas: 0, landingPageViews: 2 }, camp);
    expect(best).toEqual({ tag: 'keep', reason: expect.stringMatching(/^Best early signal: CTR 0\.52%/) });
    expect(creativeVerdict({ spend: 30, impressions: 900, ctr: 0.001, metaPurchases: 0, metaRoas: 0 }, camp).tag).toBe('too_early');
  });
});

describe('mergeAdRows', () => {
  it('sums the same creative across ad sets', () => {
    const row = (id: string, name: string, spend: number) => ({
      id, name, format: 'image', title: 'Get Your Career Report', spend, impressions: 1000,
      linkClicks: 3, landingPageViews: 1, metaPurchases: 0, metaPurchaseValue: 0, firstPartyOrders: 0, plays3s: 0,
    });
    const out = mergeAdRows([row('a', 'Career Memes 2', 457), row('b', 'Career Memes 2 ', 113), row('c', 'Career Question', 185)]);
    expect(out.map((r) => [r.name, r.ids, r.spend, r.impressions])).toEqual([
      ['Career Memes 2', ['a', 'b'], 570, 2000],
      ['Career Question', ['c'], 185, 1000],
    ]);
  });
});
