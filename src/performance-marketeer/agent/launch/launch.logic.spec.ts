import { z } from 'zod';
import {
  checklistMissing,
  checkPlan,
  cleanReviewFiles,
  economics,
  ratioLabel,
  readiness,
  ruleIsPurchase,
  ruleMatchesProduct,
  toManualDto,
} from './launch.logic';
import {
  LaunchPlanOutput as PlanSchema,
  LaunchResearch,
  LaunchReview,
  LaunchVerify,
} from './launch.types';
import type {
  LaunchAdSet,
  LaunchCreativeFile,
  LaunchPlanOutput,
  LaunchReview as ReviewShape,
} from './launch.types';

const money = (over = {}) =>
  economics({
    price: 1799,
    desiredRoas: 2,
    roasType: 'meta',
    dailySpend: 5000,
    ...over,
  });

const file = (n: number, ratio: string): LaunchCreativeFile => ({
  url: `https://b.s3.amazonaws.com/t/${n}.jpg`,
  file: `C${n}.jpg`,
  width: 1080,
  height: 1080,
  ratio,
});
const reviewed = (n: number, designId: string, over = {}) => ({
  file: `C${n}.jpg`,
  designId,
  summary: '',
  hook: '',
  language: 'en',
  angle: '',
  firstLook: {
    viewer: '',
    noticesFirst: '',
    thinks: '',
    reaction: 'stops_and_taps' as const,
    why: '',
  },
  verdict: '',
  policyRisk: 'low' as const,
  finalStatus: 'ready' as const,
  strengths: [],
  changes: [],
  tests: [],
  promise: { adPromises: '', pageDelivers: 'yes' as const, note: '' },
  resizeAdvice: [],
  claimsToVerify: [],
  ...over,
});
const review = (creatives = [reviewed(1, 'D1')], pageClaims: string[] = []) =>
  ({
    markdown: '',
    creatives,
    missingAngles: [],
    landing: {
      summary: '',
      mainButton: '',
      directPurchase: 'yes',
      path: [],
      whatWorks: [],
      issues: [],
      claimsToVerify: pageClaims,
    },
  }) as ReviewShape;
const adSet = (over: Partial<LaunchAdSet> = {}): LaunchAdSet => ({
  name: 'Broad',
  budgetPercent: 100,
  audienceType: 'advantage_plus',
  excludeAudienceIds: [],
  ageMin: 18,
  ageMax: 65,
  gender: 'all',
  geoLocations: ['IN'],
  geoStates: [],
  geoCities: [],
  locales: [],
  interests: [],
  placementPreset: 'vertical_feed',
  designIds: ['D1'],
  reason: '',
  label: 'assumption',
  ...over,
});
const plan = (over: Partial<LaunchPlanOutput> = {}): LaunchPlanOutput => ({
  markdown: '',
  targetVerdict: 'unknown',
  targetNote: '',
  campaignName: 'Career launch',
  campaignType: 'custom',
  adSets: [adSet()],
  copy: [
    {
      designId: 'D1',
      primaryText: 'Job or business?',
      headline: 'Know when',
      cta: 'LEARN_MORE',
    },
  ],
  analysis: {
    headline: '',
    summary: '',
    whySetup: [],
    creativeTakeaway: '',
    competitorTakeaway: '',
    creativeCalls: [
      { designId: 'D1', call: 'run', why: '', replacements: [] },
      { designId: 'D2', call: 'run', why: '', replacements: [] },
      {
        designId: 'D3',
        call: 'replace',
        why: '',
        replacements: [
          { topic: 'x', hook: '', format: '', forWho: '', why: '' },
        ],
      },
    ],
    todo: [],
    risks: [],
    newCreativeIdeas: [],
  },
  decisions: [],
  unknowns: [],
  reviewPlan: { beforeLive: [], day1: [], day3: [], day7: [], rules: [] },
  sources: [],
  ...over,
});
const known = (over = {}) => ({
  regions: new Set<string>(),
  cities: new Set<string>(),
  interests: new Set<string>(),
  audiences: new Set<string>(),
  ...over,
});
const check = (p = plan(), r = review(), c = [file(1, '9:16')], k = known()) =>
  checkPlan({ plan: p, review: r, creatives: c, economics: money(), known: k });

describe('economics', () => {
  it('keeps Meta and first-party targets apart', () => {
    const m = money();
    expect(m.allowedCpaMeta).toBe(899.5);
    expect(m.allowedCpaFirstParty).toBe(762.29);
    expect(m.allowedCpa).toBe(899.5);
    expect(money({ roasType: 'first_party' }).allowedCpa).toBe(762.29);
  });

  it("uses the admin's maximum only when lower", () => {
    expect(money({ maxCpa: 500 }).allowedCpa).toBe(500);
    expect(money({ maxCpa: 5000 }).allowedCpa).toBe(899.5);
  });

  it('gives a weekly ceiling from spend and the allowed cost', () => {
    expect(
      money({ roasType: 'first_party', desiredRoas: 1 }).ordersPerWeekAtTarget,
    ).toBe(22.96);
  });
});

it('scenarios show what each cost per order would mean', () => {
  const m = money({ roasType: 'first_party', desiredRoas: 1 });
  expect(m.scenarios.map((s) => s.costPerOrder)).toEqual([
    762.29, 1143.43, 1524.58, 2286.86, 3049.15,
  ]);
  const atTarget = m.scenarios[2];
  expect(atTarget).toMatchObject({
    firstPartyRoas: 1,
    metaRoas: 1.18,
    meetsTarget: true,
  });
  expect(m.scenarios[3].meetsTarget).toBe(false);
});

describe('ratioLabel', () => {
  it('names standard sizes and leaves others as pixels', () => {
    expect(ratioLabel(1080, 1920)).toBe('9:16');
    expect(ratioLabel(1080, 1350)).toBe('4:5');
    expect(ratioLabel(1080, 1080)).toBe('1:1');
    expect(ratioLabel(800, 1000)).toBe('4:5');
    expect(ratioLabel(1080, 1900)).toBe('1080x1900'); // launch's own check rejects this as 9:16
    expect(ratioLabel(1000, 300)).toBe('1000x300');
  });
});

describe('checkPlan', () => {
  it('passes a clean one-ad-set plan', () => {
    expect(check().problems).toEqual([]);
  });

  it('requires multi ad set budgets to add up', () => {
    const p = plan({
      adSets: [
        adSet({ budgetPercent: 50 }),
        adSet({ name: 'B', budgetPercent: 40 }),
      ],
    });
    expect(check(p).problems).toContain(
      'ad set budgets add up to 90%, not 100%',
    );
  });

  it('rejects invented location, interest and audience ids', () => {
    const p = plan({
      adSets: [
        adSet({
          geoLocations: [],
          geoStates: ['999'],
          audienceType: 'interest',
          interests: [{ id: '5', name: 'x' }],
          excludeAudienceIds: ['7'],
        }),
      ],
    });
    expect(check(p).problems).toHaveLength(3);
    const k = known({
      regions: new Set(['999']),
      interests: new Set(['5']),
      audiences: new Set(['7']),
    });
    expect(check(p, review(), [file(1, '9:16')], k).problems).toEqual([]);
  });

  it('rejects excluded designs and vertical without 9:16', () => {
    const excluded = review([reviewed(1, 'D1', { finalStatus: 'excluded' })]);
    expect(check(plan(), excluded).problems[0]).toContain('excluded design');
    const vertical = plan({ adSets: [adSet({ placementPreset: 'vertical' })] });
    expect(check(vertical, review(), [file(1, '1:1')]).problems[0]).toContain(
      'no 9:16',
    );
  });

  it('warns, not blocks, when a good design only misses a size', () => {
    const r = check(plan(), review(), [file(1, '1:1')]);
    expect(r.problems).toEqual([]);
    expect(r.warnings.join()).toContain('no 9:16');
  });

  it('rejects copy that repeats an unverified claim', () => {
    const p = plan({
      copy: [
        {
          designId: 'D1',
          primaryText: 'Trusted by 100,000+ people',
          headline: 'x',
          cta: 'LEARN_MORE',
        },
      ],
    });
    const r = check(p, review([reviewed(1, 'D1')], ['100,000+ people']));
    expect(r.problems[0]).toContain('unverified claim');
  });

  it('flags two images of the same size in one design', () => {
    const r = review([reviewed(1, 'D1'), reviewed(2, 'D1')]);
    expect(
      check(plan(), r, [file(1, '1:1'), file(2, '1:1')]).problems[0],
    ).toContain('two images');
  });
});

describe('readiness', () => {
  const base = {
    tracking: {
      conversionId: '1',
      accountId: '1',
      blocks: [],
      warnings: [],
      facts: [],
    },
    creatives: [{ ...file(1, '1:1') }],
    review: review(),
    planProblems: [],
    planWarnings: [],
    openIssues: [],
    reviewerBlocks: [],
    economics: money({ dailySpend: 10000 }),
    landingOk: true,
  };

  it('is ready with nothing wrong', () => {
    expect(readiness(base)).toMatchObject({ ready: true, blocks: [] });
  });

  it('blocks on tracking, page, token, small images and policy', () => {
    const r = readiness({
      ...base,
      tracking: { ...base.tracking, blocks: ['bad event'] },
      landingOk: false,
      tokenBlock: 'no token',
      creatives: [{ ...file(1, '1:1'), width: 300, height: 300 }],
      review: review([reviewed(1, 'D1', { policyRisk: 'block' })]),
    });
    expect(r.ready).toBe(false);
    expect(r.blocks).toHaveLength(5);
  });

  it('only warns when the budget is under the learning benchmark', () => {
    const r = readiness({ ...base, economics: money({ dailySpend: 2000 }) });
    expect(r.ready).toBe(true);
    expect(r.warnings.join()).toContain('Learning may stay limited');
  });
});

describe('toManualDto', () => {
  it('maps one variant per design and tags sizes only when a design has several', () => {
    const r = review([
      reviewed(1, 'D1'),
      reviewed(2, 'D1'),
      reviewed(3, 'D2'),
      reviewed(4, 'D3', { finalStatus: 'excluded' }),
    ]);
    const p = plan({
      adSets: [adSet({ designIds: ['D2', 'D1'] })],
      copy: [
        {
          designId: 'D1',
          primaryText: 'one',
          headline: 'h1',
          cta: 'LEARN_MORE',
        },
        {
          designId: 'D2',
          primaryText: 'two',
          headline: 'h2',
          cta: 'LEARN_MORE',
        },
      ],
    });
    const dto = toManualDto({
      plan: p,
      review: r,
      creatives: [
        file(1, '1:1'),
        file(2, '9:16'),
        file(3, '4:5'),
        file(4, '1:1'),
      ],
      input: { productName: 'Career Report', dailySpend: 5000 },
      accountId: '123',
    });
    expect(dto.creative.copyVariants.map((c) => c.primaryText)).toEqual([
      'two',
      'one',
    ]);
    expect(dto.adSets[0].ads).toEqual([0, 1]);
    expect(dto.creative.images).toEqual([
      expect.objectContaining({ variantIndex: 1, aspectRatio: '1:1' }),
      expect.objectContaining({ variantIndex: 1, aspectRatio: '9:16' }),
      { variantIndex: 0, imageUrl: file(3, '4:5').url },
    ]);
    expect(dto.budget).toBe(5000);
  });
});

it('checklistMissing needs every box ticked', () => {
  expect(checklistMissing({ testPurchase: true })).toEqual([
    'deduplicated',
    'mobilePath',
    'claimsVerified',
  ]);
  expect(
    checklistMissing({
      testPurchase: true,
      deduplicated: true,
      mobilePath: true,
      claimsVerified: true,
    }),
  ).toBeNull();
});

it('ruleIsPurchase reads the Purchase event rule', () => {
  expect(
    ruleIsPurchase('{"and":[{"event":{"eq":"Purchase"}},{"or":[]}]}'),
  ).toBe(true);
  expect(ruleIsPurchase('{"event":{"eq":"Lead"}}')).toBe(false);
});

describe('review findings', () => {
  it('never ships an excluded file of a usable design', () => {
    const r = review([
      reviewed(1, 'D1'),
      reviewed(2, 'D1', { finalStatus: 'excluded', policyRisk: 'block' }),
    ]);
    const c = [file(1, '1:1'), file(2, '9:16')];
    const dto = toManualDto({
      plan: plan(),
      review: r,
      creatives: c,
      input: { productName: 'Career Report', dailySpend: 5000 },
      accountId: '123',
    });
    expect(dto.creative.images.map((i) => i.imageUrl)).toEqual([c[0].url]);
    // ...and its 9:16 doesn't satisfy a vertical-only ad set.
    const vertical = plan({ adSets: [adSet({ placementPreset: 'vertical' })] });
    expect(check(vertical, r, c).problems[0]).toContain('no 9:16');
  });

  it('keeps the worst status of the usable files', () => {
    const r = review([
      reviewed(1, 'D1'),
      reviewed(2, 'D1', { finalStatus: 'needs_fixes' }),
    ]);
    expect(
      check(plan(), r, [file(1, '9:16'), file(2, '1:1')]).warnings.join(),
    ).toContain('needs fixes');
  });

  it('rejects settings launch would silently drop', () => {
    const narrowed = plan({
      adSets: [adSet({ ageMin: 25, ageMax: 45, gender: 'female' })],
    });
    expect(check(narrowed).problems[0]).toContain('ignores age and gender');
    const mixed = plan({
      campaignType: 'advantage_plus',
      adSets: [adSet({ audienceType: 'retarget', metaAudienceId: '1' })],
    });
    expect(
      check(
        mixed,
        review(),
        [file(1, '9:16')],
        known({ audiences: new Set(['1']) }),
      ).problems.join(),
    ).toContain('only takes audienceType');
  });

  it('rejects language filters, other countries and a city key used as a region', () => {
    expect(
      check(plan({ adSets: [adSet({ locales: [53] })] })).problems[0],
    ).toContain('language filter');
    expect(
      check(plan({ adSets: [adSet({ geoLocations: ['US'] })] })).problems[0],
    ).toContain('must target India');
    const asRegion = plan({
      adSets: [adSet({ geoLocations: [], geoStates: ['5'] })],
    });
    expect(
      check(
        asRegion,
        review(),
        [file(1, '9:16')],
        known({ cities: new Set(['5']) }),
      ).problems[0],
    ).toContain('region key');
  });

  it('runs the copy safety check', () => {
    const p = plan({
      copy: [
        {
          designId: 'D1',
          primaryText: 'Guaranteed results, 100% guaranteed cure',
          headline: 'x',
          cta: 'LEARN_MORE',
        },
      ],
    });
    expect(check(p).problems.join()).toContain('safety check');
  });

  it('blocks on reviewer blockers and over-budget plans, and ignores small excluded images', () => {
    const base = {
      tracking: {
        conversionId: '1',
        accountId: '1',
        blocks: [],
        warnings: [],
        facts: [],
      },
      creatives: [{ ...file(1, '1:1'), width: 100, height: 100 }],
      review: review([reviewed(1, 'D1', { finalStatus: 'excluded' })]),
      planProblems: [],
      planWarnings: [],
      openIssues: [],
      reviewerBlocks: [],
      economics: money({ dailySpend: 10000 }),
      landingOk: true,
    };
    expect(readiness(base).ready).toBe(true);
    const r = readiness({
      ...base,
      reviewerBlocks: ['misleading'],
      budgetBlock: 'over cap',
    });
    expect(r.blocks).toEqual(['misleading', 'over cap']);
  });

  it('ruleMatchesProduct needs the product in the rule', () => {
    const p = {
      name: 'Career Report',
      landingUrl: 'https://x.com/career-report',
    };
    expect(
      ruleMatchesProduct('{"content_ids":{"i_contains":"career-report"}}', p),
    ).toBe(true);
    expect(
      ruleMatchesProduct('{"content_ids":{"i_contains":"nadi-report"}}', p),
    ).toBe(false);
  });
});

it('every AI output schema converts to JSON schema for the SDK', () => {
  for (const schema of [LaunchReview, LaunchResearch, PlanSchema, LaunchVerify])
    expect(z.toJSONSchema(schema, { target: 'draft-7' })).toHaveProperty(
      'properties.markdown',
    );
});

describe('cleanReviewFiles', () => {
  it('matches a review that names files with their folder', () => {
    const c = { file: 'creatives/C1.jpg' } as ReviewShape['creatives'][number];
    const out = cleanReviewFiles({ creatives: [c] } as ReviewShape);
    expect(out.creatives[0].file).toBe('C1.jpg');
  });
});

describe('creative calls', () => {
  const base = {
    review: review(),
    creatives: [file(1, '1:1')],
    economics: money(),
    known: {} as never,
  };
  const withCalls = (
    creativeCalls: LaunchPlanOutput['analysis']['creativeCalls'],
  ) => {
    const p = plan();
    return { ...p, analysis: { ...p.analysis, creativeCalls } };
  };
  it('needs a call for every design', () => {
    expect(
      checkPlan({ ...base, plan: withCalls([]) } as never).problems,
    ).toContain('D1 has no creative call');
  });
  it('refuses a replaced design in an ad set', () => {
    const replacements = [
      { topic: 'x', hook: '', format: '', forWho: '', why: '' },
    ];
    expect(
      checkPlan({
        ...base,
        plan: withCalls([
          { designId: 'D1', call: 'replace', why: '', replacements },
        ]),
      } as never).problems,
    ).toContain('D1 is marked replace but is in an ad set');
  });
});
