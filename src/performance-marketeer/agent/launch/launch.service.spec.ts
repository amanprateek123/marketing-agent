import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runStructured } from '../pipeline/phase-runner';
import { knownIds, PmLaunchService } from './launch.service';

jest.mock('sharp', () => () => ({
  metadata: async () => ({ width: 1080, height: 1920 }),
  rotate() {
    return this;
  },
  resize() {
    return this;
  },
  flatten() {
    return this;
  },
  jpeg() {
    return this;
  },
  toFile: async () => undefined,
}));
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (url: string) =>
      url.includes('permissions')
        ? {
            data: {
              data: [{ permission: 'ads_management', status: 'granted' }],
            },
          }
        : { status: 200, data: new ArrayBuffer(4) },
    ),
  },
}));
jest.mock('../pipeline/phase-runner', () => ({
  EvidenceLog: class {
    constructor(readonly file: string) {}
  },
  runStructured: jest.fn(),
}));

const CHECKLIST = {
  testPurchase: true,
  deduplicated: true,
  mobilePath: true,
  claimsVerified: true,
};
const REVIEW = {
  markdown: '',
  creatives: [
    {
      file: 'C1.jpg',
      designId: 'D1',
      summary: '',
      hook: '',
      language: '',
      angle: '',
      policyRisk: 'low',
      finalStatus: 'ready',
      resizeAdvice: [],
      claimsToVerify: [],
    },
  ],
  missingAngles: [],
  landing: {
    summary: '',
    mainButton: '',
    directPurchase: 'yes',
    issues: [],
    claimsToVerify: [],
  },
};
const PLAN = {
  markdown: '',
  analysis: {
    creativeCalls: [{ designId: 'D1', call: 'run', why: '', replacements: [] }],
  },
  targetVerdict: 'unknown',
  targetNote: '',
  campaignName: 'Launch',
  campaignType: 'custom',
  adSets: [
    {
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
    },
  ],
  copy: [
    {
      designId: 'D1',
      primaryText: 'Text',
      headline: 'Head',
      cta: 'LEARN_MORE',
    },
  ],
  decisions: [],
  unknowns: [],
  reviewPlan: { beforeLive: [], day1: [], day3: [], day7: [], rules: [] },
  sources: [],
};
const ECONOMICS = {
  price: 1799,
  netPrice: 1524.58,
  roasType: 'meta',
  desiredRoas: 1,
  allowedCpaMeta: 1799,
  allowedCpaFirstParty: 1524.58,
  allowedCpa: 1799,
  dailySpend: 20000,
  ordersPerWeekAtTarget: 77.8,
  learningBenchmark: 50,
};

function setup(metaOver: Record<string, unknown> = {}) {
  const doc: Record<string, any> = {
    _id: 'p1',
    tenantId: 't',
    status: 'done',
    createStatus: '',
    campaignId: '',
    costUsd: 0,
    input: {
      productName: 'Career Report',
      dailySpend: 20000,
      creativeUrls: ['u'],
      desiredRoas: 1,
      roasType: 'meta',
      launchDate: '2026-11-10',
    },
    plan: PLAN,
    review: REVIEW,
    economics: ECONOMICS,
    creatives: [
      { url: 'u', file: 'C1.jpg', width: 1080, height: 1920, ratio: '9:16' },
    ],
    planProblems: [],
    planWarnings: [],
    openIssues: [],
    reviewerBlocks: [],
  };
  const plans = {
    findOneAndUpdate: jest.fn(() => ({
      lean: async () => {
        if (!['', 'failed'].includes(doc.createStatus)) return null;
        doc.createStatus = 'creating';
        return { ...doc };
      },
    })),
    updateOne: jest.fn(async (_k: unknown, u: { $set: object }) => {
      Object.assign(doc, u.$set);
      return { matchedCount: 1 };
    }),
  };
  const meta = {
    get: jest.fn(async (path: string) =>
      path === 'cc1'
        ? {
            name: 'Purchase',
            account_id: '123',
            custom_event_type: 'PURCHASE',
            rule: '{"and":[{"event":{"eq":"Purchase"}},{"content_ids":{"i_contains":"career report"}}]}',
            last_fired_time: 'x',
            pixel: { id: 'px' },
            ...metaOver,
          }
        : { status: 'PAUSED' },
    ),
    getAll: jest.fn(async (path: string) =>
      path.includes('insights')
        ? [
            {
              actions: [
                { action_type: 'offsite_conversion.custom.cc1', value: '10' },
              ],
              action_values: [
                {
                  action_type: 'offsite_conversion.custom.cc1',
                  value: '17990',
                },
              ],
            },
          ]
        : [{ status: 'PAUSED' }],
    ),
  };
  const campaigns = {
    findOne: jest.fn(() => ({
      lean: () => ({ exec: async () => campaignDoc() }),
    })),
  };
  let existingCampaign: Record<string, unknown> | null = null;
  const campaignDoc = () => existingCampaign;
  const company = {
    products: [
      {
        name: 'Career Report',
        price: 1799,
        landingUrl: 'https://x/y',
        customConversionId: 'cc1',
      },
    ],
    meta: { accessToken: 'tok', accountIds: ['act_123'], pixelId: 'px' },
  };
  const manual = { create: jest.fn(async () => ({ _id: 'camp1' })) };
  const creator = { launch: jest.fn(async () => ({ metaCampaignId: 'm1' })) };
  const service = new PmLaunchService(
    plans as never,
    campaigns as never,
    { tenantId: 't', meta: { apiVersion: 'v21.0' } } as never,
    meta as never,
    { root: mkdtempSync(join(tmpdir(), 'launch-')) } as never,
    { capUsd: 100, spentOn: async () => 0 } as never,
    { defs: () => [] } as never,
    { defs: () => [] } as never,
    { defs: () => [] } as never,
    { findByTenantId: async () => company } as never,
    manual as never,
    creator as never,
    {
      isOwnBucketUrl: () => true,
      presignIfOwnBucket: async (u: string) => u,
    } as never,
  );
  return {
    service,
    doc,
    meta,
    manual,
    creator,
    setCampaign: (c: Record<string, unknown>) => (existingCampaign = c),
  };
}

describe('createPaused', () => {
  it('creates once, paused, and records what was approved', async () => {
    const { service, doc, manual, creator } = setup();
    const r = await service.createPaused('t', 'p1', CHECKLIST, 'me');
    expect(r.metaCampaignId).toBe('m1');
    expect(manual.create).toHaveBeenCalledTimes(1);
    expect(creator.launch).toHaveBeenCalledWith(
      'camp1',
      expect.anything(),
      'act_123',
      { launchPaused: true, strictPlan: true },
    );
    expect(doc.createStatus).toBe('paused');
    expect(doc.approved).toMatchObject({ by: 'me', checklist: CHECKLIST });
  });

  it('refuses a second create', async () => {
    const { service, manual } = setup();
    await service.createPaused('t', 'p1', CHECKLIST, 'me');
    await expect(
      service.createPaused('t', 'p1', CHECKLIST, 'me'),
    ).rejects.toThrow('already created');
    expect(manual.create).toHaveBeenCalledTimes(1);
  });

  it('needs every checklist box', async () => {
    const { service, manual } = setup();
    await expect(
      service.createPaused(
        't',
        'p1',
        { ...CHECKLIST, testPurchase: false },
        'me',
      ),
    ).rejects.toThrow('testPurchase');
    expect(manual.create).not.toHaveBeenCalled();
  });

  it('blocks on a fresh tracking failure', async () => {
    const { service, doc, manual } = setup({ custom_event_type: 'LEAD' });
    await expect(
      service.createPaused('t', 'p1', CHECKLIST, 'me'),
    ).rejects.toThrow('not a Purchase');
    expect(manual.create).not.toHaveBeenCalled();
    expect(doc.createStatus).toBe('failed');
  });

  it('blocks when plan problems remain', async () => {
    const { service, doc, manual } = setup();
    doc.planProblems = ['bad plan'];
    await expect(
      service.createPaused('t', 'p1', CHECKLIST, 'me'),
    ).rejects.toThrow('bad plan');
    expect(manual.create).not.toHaveBeenCalled();
  });

  it('a retry after a failed launch reuses the same campaign', async () => {
    const { service, manual, creator, doc, setCampaign } = setup();
    creator.launch.mockRejectedValueOnce(new Error('Meta down'));
    await expect(
      service.createPaused('t', 'p1', CHECKLIST, 'me'),
    ).rejects.toThrow('Meta down');
    setCampaign({ _id: 'camp1', status: 'pending_approval' });
    await service.createPaused('t', 'p1', CHECKLIST, 'me');
    expect(manual.create).toHaveBeenCalledTimes(1);
    expect(creator.launch).toHaveBeenLastCalledWith(
      'camp1',
      expect.anything(),
      'act_123',
      { launchPaused: true, strictPlan: true },
    );
    expect(doc.createStatus).toBe('paused');
  });

  it('adopts a campaign already in Meta instead of launching again', async () => {
    const { service, manual, creator, doc, setCampaign } = setup();
    setCampaign({ _id: 'camp1', status: 'paused', metaCampaignId: 'm9' });
    await service.createPaused('t', 'p1', CHECKLIST, 'me');
    expect(manual.create).not.toHaveBeenCalled();
    expect(creator.launch).not.toHaveBeenCalled();
    expect(doc).toMatchObject({ createStatus: 'paused', metaCampaignId: 'm9' });
  });

  it('never retries a create that stopped part-way', async () => {
    const { service, creator, setCampaign } = setup();
    setCampaign({ _id: 'camp1', status: 'launching' });
    await expect(
      service.createPaused('t', 'p1', CHECKLIST, 'me'),
    ).rejects.toThrow('Check Ads Manager');
    expect(creator.launch).not.toHaveBeenCalled();
  });

  it('keeps the Meta id when the status read fails after launch', async () => {
    const { service, meta, doc } = setup();
    const real = meta.get.getMockImplementation()!;
    meta.get.mockImplementation(async (path: string) => {
      if (path === 'm1') throw new Error('read failed');
      return real(path);
    });
    await expect(
      service.createPaused('t', 'p1', CHECKLIST, 'me'),
    ).rejects.toThrow('read failed');
    expect(doc).toMatchObject({ createStatus: 'failed', metaCampaignId: 'm1' });
  });

  it('fails when an ad set or ad is not paused', async () => {
    const { service, meta } = setup();
    const real = meta.getAll.getMockImplementation()!;
    meta.getAll.mockImplementation(async (path: string) =>
      path === 'm1/ads' ? ([{ status: 'ACTIVE' }] as never) : real(path),
    );
    await expect(
      service.createPaused('t', 'p1', CHECKLIST, 'me'),
    ).rejects.toThrow('Check Ads Manager');
  });

  it('fails loudly when Meta does not report the campaign paused', async () => {
    const { service, meta, doc } = setup();
    meta.get.mockImplementation(async (path: string) =>
      path === 'cc1'
        ? {
            name: 'Purchase',
            account_id: '123',
            custom_event_type: 'PURCHASE',
            rule: '{"event":{"eq":"Purchase"},"x":"career report"}',
            last_fired_time: 'x',
            pixel: { id: 'px' },
          }
        : ({ status: 'ACTIVE' } as never),
    );
    await expect(
      service.createPaused('t', 'p1', CHECKLIST, 'me'),
    ).rejects.toThrow('Check Ads Manager');
    expect(doc.createStatus).toBe('failed');
  });
});

describe('planning run', () => {
  it('sends the plan back on a code problem, then finishes', async () => {
    const { service, doc } = setup();
    Object.assign(doc, {
      status: 'running',
      plan: null,
      review: null,
      creatives: [],
      economics: null,
    });
    const bad = { ...PLAN, copy: [] };
    const outputs: Record<string, unknown> = {
      '01-review': REVIEW,
      '02-research': {
        markdown: '',
        audience: [],
        locations: [],
        dates: [],
        competitors: [],
        gaps: [],
      },
      '01-review-draft': REVIEW,
      '03-plan.v1': bad,
      '03-plan.v2': PLAN,
      '04-verify.v1': { markdown: '', issues: [], confirmedRight: [] },
      '04-verify.v2': { markdown: '', issues: [], confirmedRight: [] },
    };
    const calls: { name: string; msg: string }[] = [];
    (runStructured as jest.Mock).mockImplementation(
      async (a: { file: string; userMessage: string }) => {
        const name = a.file.split('/').pop()!.replace('.md', '');
        calls.push({ name, msg: a.userMessage });
        return { output: outputs[name], costUsd: 1, reused: false };
      },
    );
    await (service as unknown as { run(d: unknown): Promise<void> }).run(doc);
    expect(doc.status).toBe('done');
    expect(doc.plan).toEqual(PLAN);
    expect(doc.costUsd).toBe(7);
    expect(calls.find((c) => c.name === '03-plan.v2')!.msg).toContain(
      'D1 has no ad copy',
    );
    expect(doc.readiness.ready).toBe(true);
  });

  it('records a failure and what it cost', async () => {
    const { service, doc } = setup();
    Object.assign(doc, { status: 'running' });
    (runStructured as jest.Mock).mockRejectedValue(
      Object.assign(new Error('boom'), { costUsd: 2 }),
    );
    await (service as unknown as { run(d: unknown): Promise<void> }).run(doc);
    expect(doc).toMatchObject({ status: 'failed', error: 'boom', costUsd: 2 });
  });
});

it('knownIds reads ids only from the matching Meta tools', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'ev-')), 'e.jsonl');
  writeFileSync(
    f,
    [
      {
        tool: 'meta_geo_search',
        result: {
          rows: [
            { key: '1735', type: 'region' },
            { key: '22', type: 'city' },
          ],
        },
      },
      { tool: 'meta_interest_search', result: { rows: [{ id: '6' }] } },
      { tool: 'ad_account_audiences', result: { rows: [{ id: '9' }] } },
      { tool: 'other', result: { rows: [{ id: '7', key: '8' }] } },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n{cut',
  );
  const k = knownIds(f);
  expect([...k.regions]).toEqual(['1735']);
  expect([...k.cities]).toEqual(['22']);
  expect([...k.interests]).toEqual(['6']);
  expect([...k.audiences]).toEqual(['9']);
});
