import { PmReportService } from './pm-report.service';

const metrics = (o: Record<string, number | null> = {}) => ({
  spend: 7269,
  impressions: 11400,
  clicks: 120,
  linkClicks: 97,
  landingPageViews: 74,
  cpm: 638,
  ctr: 0.0085,
  cpc: 75,
  frequency: 1.21,
  metaPurchases: 3,
  metaPurchaseValue: 5397,
  metaRoas: 0.74,
  siteVisitors: 0,
  siteCtaClicks: 0,
  sitePaymentsStarted: 0,
  firstPartyOrders: 0,
  firstPartyRevenue: 0,
  firstPartyRoas: 0,
  firstPartyCpa: null,
  newCustomerOrders: 0,
  clickToOrderRate: null,
  visitToOrderRate: null,
  averageOrderValue: null,
  ...o,
});
const lean = <T>(v: T) => ({
  sort: () => ({ lean: async () => v }),
  lean: async () => v,
});

describe('PmReportService', () => {
  const run = {
    date: '2026-11-06',
    status: 'done',
    costUsd: 4.1,
    finishedAt: null,
    unresolved: [],
    causes: [{ id: 'C1', title: 'Tracking', confidence: 0.8 }],
    actions: [{ id: 'A1', title: 'Fix' }],
    files: {
      '01-investigate.v1.md': '## Verdict\nOld\n',
      '01-investigate.v2.md':
        '## Verdict\nROAS about 0.63×.\n\n## C1 — Tracking\n- 0 visitors\n',
      '01-investigate.v2.md.json': JSON.stringify({
        summary: 's',
        ruledOut: [{ title: 'Festive CPM', evidence: [] }],
        dataGaps: ['Landing page'],
      }),
      '03-plan.v1.md.json': JSON.stringify({
        summary: 'Hold, add creatives',
        pathToTarget: 'unlikely',
        creativeIdeas: [{ title: 'Layoffs hook' }],
      }),
    },
  };
  const camp = {
    entityId: 'c1',
    name: 'Career Report',
    product: 'career-report',
    createdTime: '2026-11-03T05:00:00Z',
    objective: 'OUTCOME_SALES',
    effectiveStatus: 'ACTIVE',
    budgetLevel: 'adset',
  };
  const svc = new PmReportService(
    { findOne: () => lean(run) } as never,
    {
      findOne: () => lean(camp),
      find: () =>
        lean([
          {
            entityId: 'ad1',
            creative: {
              thumbnailUrl: 'https://x/t.jpg',
              title: 'Mehnat meri',
              body: 'b',
              cta: 'SHOP_NOW',
            },
          },
        ]),
    } as never,
    {
      scopeMetrics: async () => metrics(),
      entities: async () => ({
        rows: [
          {
            id: 'ad1',
            name: 'Variant 4',
            effectiveStatus: 'ACTIVE',
            metrics: metrics({
              spend: 1800,
              impressions: 3000,
              ctr: 0.0103,
              metaPurchases: 2,
              metaRoas: 2.11,
            }),
          },
          {
            id: 'ad2',
            name: 'Variant 0 spend',
            effectiveStatus: 'PAUSED',
            metrics: metrics({ spend: 0 }),
          },
        ],
      }),
      trend: async () => ({
        points: [
          {
            date: '2026-11-05',
            spend: 919,
            cpm: 194,
            ctr: 0.02,
            metaPurchases: 1,
            firstPartyOrders: 0,
          },
        ],
      }),
    } as never,
    {
      defs: () =>
        ['funnel', 'payment_health', 'breakdowns'].map((name) => ({
          name,
          run: async () =>
            name === 'payment_health'
              ? { people: { campaign: { people: 3, paid: 2 } } }
              : { steps: [], rows: [{ key: 'female|35-44' }], missingDays: [] },
        })),
    } as never,
    {
      goal: async () => ({ source: 'Meta', currentDailyBudget: 3000 }),
      metaBasis: async () => 'untracked',
    } as never,
    { tenantId: '91astrology' } as never,
  );

  it('puts the AI conclusions next to the numbers', async () => {
    const r = await svc.report('c1');
    expect(r.window).toEqual({ from: '2026-10-30', to: '2026-11-05' });
    expect(r.verdict).toBe('ROAS about 0.63×.'); // latest round
    expect(r.causes[0].narrative).toBe('- 0 visitors');
    expect(r.ruledOut).toEqual(['Festive CPM']);
    expect(r.pathToTarget).toBe('unlikely');
    expect(r.creativeIdeas).toHaveLength(1);
    expect(r.basis).toBe('untracked');
    expect(r.last7?.costPerPurchase).toBe(2423);
    expect(r.sinceLaunch?.from).toBe('2026-11-03');
    expect(
      r.creatives.map((c) => [c.name, c.verdict.tag, c.thumbnailUrl]),
    ).toEqual([['Variant 4', 'scale', 'https://x/t.jpg']]);
    expect(r.funnel.payments).toEqual({ campaign: { people: 3, paid: 2 } });
    expect(r.breakdowns.ageGender?.rows[0].key).toBe('female|35-44');
  });
});
