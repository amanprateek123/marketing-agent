import { buildReport, ReportInput } from './pm-findings';
import { PmEntityRow, PmMetrics } from './pm-analysis.types';
import { targetOf, toMetrics, ZERO_META } from './pm-stats';

const metrics = (spend: number, orders: number, revenue: number, more = {}) =>
  toMetrics(
    {
      ...ZERO_META,
      spend,
      impressions: spend * 40,
      linkClicks: spend / 10,
      freqImp: spend * 40 * 1.3,
      ...more,
    },
    { orders, revenue, newCustomers: orders },
    { visitors: spend / 12, ctaClicks: 0, paymentsStarted: 0 },
  );

const adset = (id: string, m: PmMetrics): PmEntityRow => ({
  level: 'adset',
  id,
  name: `Ad set ${id}`,
  campaignId: 'c',
  adsetId: id,
  accountId: 'a',
  product: 'nadi-report-premium',
  status: 'ACTIVE',
  effectiveStatus: 'ACTIVE',
  budgetLevel: 'adset',
  dailyBudget: 1000,
  metrics: m,
  target: targetOf(m),
  activeDays: 7,
});

function input(o: {
  cur?: PmMetrics;
  pri?: PmMetrics;
  adsets?: PmEntityRow[];
  metaThrough?: string | null;
  coverage?: [number, number];
  priorCoverage?: [number, number];
  metaPurchases?: number;
  missing?: { meta: string[]; orders: string[]; visitors: string[] };
}): ReportInput {
  const cur = o.cur ?? metrics(20000, 25, 24000);
  const pri = o.pri ?? metrics(20000, 25, 24000);
  const w = (from: string, to: string) => ({ from, to });
  const last7 = w('2026-10-18', '2026-10-24');
  const prior7 = w('2026-10-11', '2026-10-17');
  const cov = o.coverage ?? [0.98, 0.6];
  const pcov = o.priorCoverage ?? cov;
  return {
    date: '2026-10-24',
    window: { last7, prior7, last30: w('2026-09-25', '2026-10-24') },
    summary: {
      query: last7,
      previous: prior7,
      current: cur,
      prior: pri,
      change: {},
      target: targetOf(cur),
      allOrders: { orders: 60, revenue: 80000, webOrders: 58, adminOrders: 2 },
      attributionCoverage: { linkedToVisit: cov[0], linkedToMetaAd: cov[1] },
      dataFreshness: {
        metaThrough: o.metaThrough === undefined ? '2026-10-24' : o.metaThrough,
        ordersThrough: '2026-10-24',
        visitorsThrough: '2026-10-24',
        missingDays: o.missing,
      },
    },
    priorCoverage: { linkedToVisit: pcov[0], linkedToMetaAd: pcov[1] },
    byProduct: [],
    scopeName: 'All covered products',
    adsets: { query: { ...last7, level: 'adset' }, rows: o.adsets ?? [] },
    decompose: {
      query: { ...last7, level: 'account' },
      previous: prior7,
      cpa: { current: null, prior: null, change: null },
      factors: [],
      read: '',
      confidence: 'low',
    },
    fatigue: { query: last7, rows: [] },
    budget: { query: last7, rows: [], caveat: '' },
    geo: { query: last7, rows: [], caveat: '' },
    reconcile: {
      query: last7,
      rows: [],
      totals: {
        metaPurchases: o.metaPurchases ?? 30,
        firstPartyOrders: cur.firstPartyOrders,
        allConfirmedOrders: 60,
      },
      notes: [],
    },
    changes: { query: last7, rows: [] },
    generatedAt: '2026-10-25T00:00:00Z',
  };
}

const titles = (i: ReportInput) => buildReport(i).findings.map((f) => f.title);

describe('pm-findings', () => {
  it('flags missing Meta data first, as critical', () => {
    const r = buildReport(input({ metaThrough: null }));
    expect(r.findings[0]).toMatchObject({
      severity: 'critical',
      area: 'tracking',
    });
  });

  it('few orders → hold, never a ROAS warning', () => {
    const r = buildReport(input({ cur: metrics(3000, 2, 900) }));
    const roas = r.findings.filter((f) => f.area === 'roas');
    expect(roas).toHaveLength(1);
    expect(roas[0]).toMatchObject({ severity: 'info', confidence: 'low' });
    expect(roas[0].title).toMatch(/Hold/);
  });

  it('below target: warning at medium confidence, critical when far below with high', () => {
    expect(
      buildReport(input({ cur: metrics(20000, 10, 5000) })).findings.find(
        (f) => f.area === 'roas',
      )!.severity,
    ).toBe('warning');
    const crit = buildReport(input({ cur: metrics(40000, 22, 20000) }));
    expect(crit.findings[0]).toMatchObject({
      severity: 'critical',
      area: 'roas',
    });
    expect(crit.findings[0].evidence).toMatch(/lower bound/);
    expect(crit.findings[0].evidence).toMatch(/2026-10-18 to 2026-10-24/);
  });

  it('tracking: Meta purchases far above first-party, coverage drop', () => {
    expect(titles(input({ metaPurchases: 80 }))).toContain(
      'Meta reports far more purchases than we can attribute',
    );
    expect(titles(input({ metaPurchases: 40 }))).not.toContain(
      'Meta reports far more purchases than we can attribute',
    );
    expect(
      titles(input({ coverage: [0.97, 0.45], priorCoverage: [0.98, 0.62] })),
    ).toContain('Share of orders linked to a Meta ad click dropped');
    expect(titles(input({ coverage: [0.7, 0.5] }))).toContain(
      'Many web orders not linked to a website visit',
    );
  });

  it('ad sets: only flagged with enough orders; big spend with ~no revenue is flagged', () => {
    const t = titles(
      input({
        adsets: [
          adset('tiny', metrics(2000, 1, 0)),
          adset('bad', metrics(8000, 6, 4000)),
          adset('burn', metrics(15000, 1, 1500)),
        ],
      }),
    );
    expect(t).toContain('Ad set below target: Ad set bad');
    expect(t).toContain('Ad set below target: Ad set burn');
    expect(t.some((x) => x.includes('tiny'))).toBe(false);
  });

  it('orders findings by severity and writes a headline', () => {
    const r = buildReport(input({ metaThrough: null, metaPurchases: 80 }));
    const sev = r.findings.map((f) => f.severity);
    const rank = { critical: 0, warning: 1, positive: 2, info: 3 };
    expect([...sev].sort((a, b) => rank[a] - rank[b])).toEqual(sev);
    expect(r.headline).toMatch(/lower bound/);
  });

  it('every finding carries an action', () => {
    const r = buildReport(
      input({
        metaThrough: null,
        metaPurchases: 80,
        adsets: [
          adset('bad', metrics(8000, 6, 4000)),
          adset('burn', metrics(15000, 1, 1500)),
        ],
      }),
    );
    expect(r.findings.every((f) => !!f.action)).toBe(true);
    const by = (t: string) => r.findings.find((f) => f.title.includes(t))!;
    expect(by('No Meta data').action).toBe('fix_tracking');
    expect(by('Meta reports far more').action).toBe('fix_tracking');
    expect(by('Ad set bad').action).toBe('investigate');
    expect(by('Ad set burn').action).toBe('investigate');
    const hold = buildReport(input({ cur: metrics(3000, 2, 900) }));
    expect(hold.findings.find((f) => f.area === 'roas')!.action).toBe('hold');
  });

  it('product report: scoped entity, no repeated per-product findings, prior7 kept', () => {
    const base = input({});
    const p = 'nadi-report';
    const m = metrics(20000, 10, 15000);
    const r = buildReport({
      ...base,
      scopeName: 'Nadi Report',
      window: {
        last7: { ...base.window.last7, product: p },
        prior7: { ...base.window.prior7, product: p },
        last30: { ...base.window.last30, product: p },
      },
      byProduct: [{ product: p, label: 'Nadi Report', last7: m, prior7: m }],
    });
    expect(r.byProduct).toHaveLength(1);
    expect(r.byProduct[0].prior7).toBe(m);
    expect(r.findings.every((f) => !f.title.startsWith('Nadi Report:'))).toBe(
      true,
    );
    expect(r.findings.find((f) => f.area === 'roas')!.entity).toMatchObject({
      id: p,
      name: 'Nadi Report',
    });
  });

  it('missing days: warning for one, critical for two or more; product verdict withheld', () => {
    const one = buildReport(
      input({ missing: { meta: ['2026-10-24'], orders: [], visitors: [] } }),
    ).findings.find((f) => f.title === 'Data missing for some days')!;
    expect(one).toMatchObject({ severity: 'warning', action: 'fix_tracking' });
    const two = buildReport(
      input({
        missing: { meta: ['2026-10-24'], orders: [], visitors: ['2026-10-23'] },
      }),
    ).findings.find((f) => f.title === 'Data missing for some days')!;
    expect(two.severity).toBe('critical');
    expect(two.evidence).toMatch(
      /Website visitors: missing or partial on 2026-10-23/,
    );
    const m = metrics(20000, 25, 40000);
    const r = buildReport({
      ...input({}),
      byProduct: [
        {
          product: 'nadi-report',
          label: 'Nadi Report',
          last7: m,
          prior7: m,
          metaMissing: ['2026-10-24'],
        },
      ],
    });
    expect(r.byProduct[0].target).toMatchObject({
      verdict: 'not_enough_data',
      note: 'Meta data missing for 2026-10-24',
    });
    expect(r.byProduct[0]).not.toHaveProperty('metaMissing');
    expect(r.findings.some((f) => f.title.startsWith('Nadi Report:'))).toBe(
      false,
    );
    // spend-based ad set findings wait while Meta days are missing
    const withAdsets = (missing?: string[]) =>
      titles(
        input({
          adsets: [adset('bad', metrics(8000, 6, 4000))],
          missing: missing && { meta: missing, orders: [], visitors: [] },
        }),
      );
    expect(withAdsets()).toContain('Ad set below target: Ad set bad');
    expect(withAdsets(['2026-10-24'])).not.toContain(
      'Ad set below target: Ad set bad',
    );
  });

  it('ad sets in learning or edited are not judged', () => {
    const base = input({ adsets: [adset('bad', metrics(8000, 6, 4000))] });
    expect(titles({ ...base, adsetsOnHold: ['bad'] })).not.toContain(
      'Ad set below target: Ad set bad',
    );
  });

  it('CPA trend needs a significant change, not just a big ratio', () => {
    const decompose = (change: number): ReportInput['decompose'] => ({
      ...input({}).decompose,
      cpa: { current: 1000 * (1 + change), prior: 1000, change },
      factors: [
        { name: 'cpm', current: 1, prior: 1, change: 0, contribution: 0 },
        { name: 'ctr', current: 1, prior: 1, change: 0, contribution: 0 },
        {
          name: 'clickToOrderRate',
          current: 1,
          prior: 1,
          change: 0,
          contribution: 1,
        },
      ],
      confidence: 'medium',
    });
    // 8 vs 10 orders on the same spend: +25% CPA, not significant
    const noisy = input({
      cur: metrics(10000, 8, 12000),
      pri: metrics(10000, 10, 15000),
    });
    expect(
      titles({ ...noisy, decompose: decompose(0.25) }).some((t) =>
        t.startsWith('First-party CPA'),
      ),
    ).toBe(false);
    // 40 vs 80 orders: +100% CPA, significant
    const real = input({
      cur: metrics(40000, 40, 60000),
      pri: metrics(40000, 80, 120000),
    });
    const f = buildReport({ ...real, decompose: decompose(1) }).findings.find(
      (x) => x.area === 'trend',
    )!;
    expect(f.action).toBe('fix_funnel');
  });

  it('30-day Meta gaps withhold fatigue/budget; scope leaks are noted', () => {
    const base = input({});
    const withFatigue: ReportInput = {
      ...base,
      fatigue: {
        query: base.window.last30,
        rows: [
          {
            adId: 'a1',
            adName: 'Tired ad',
            campaignName: '',
            product: 'nadi-report-premium',
            daysLive: 30,
            spend: 20000,
            frequencyFirst7: 1.2,
            frequencyLast7: 1.8,
            ctrFirst7: 0.01,
            ctrLast7: 0.006,
            cpaFirst7: null,
            cpaLast7: null,
            status: 'fatigued',
            reasons: [],
            creative: null,
          },
        ],
      },
    };
    expect(titles(withFatigue)).toContain('Creative fatigue: Tired ad');
    const gapped = titles({ ...withFatigue, missing30: ['2026-10-01'] });
    expect(gapped).not.toContain('Creative fatigue: Tired ad');
    expect(gapped).toContain('Data missing for some days');
    expect(
      titles({
        ...base,
        leaks: { untaggedOrders: 3, untaggedRevenue: 4500, otherSpend: 900 },
      }),
    ).toContain('Some Meta orders or spend fall outside the covered products');
  });

  it('geo: no findings with breakdown gaps or implausible totals', () => {
    const base = input({ cur: metrics(20000, 25, 30000) }); // account ROAS 1.5
    const geoRow = (state: string, spend: number, revenue: number) => ({
      state,
      spend,
      linkClicks: 0,
      siteVisitors: 100,
      firstPartyOrders: 10,
      firstPartyRevenue: revenue,
      roasEstimate: revenue / spend,
      visitToOrderRate: 0.1,
      confidence: 'medium' as const,
    });
    const geo = (rows: ReturnType<typeof geoRow>[]) => ({
      ...base,
      geo: { query: base.window.last30, rows, caveat: '' },
    });
    const ok = geo([geoRow('Delhi', 1000, 4000), geoRow('Goa', 1000, 500)]);
    expect(titles(ok).some((t) => t.startsWith('Delhi'))).toBe(true);
    const gapped = buildReport({ ...ok, breakdownMissing30: ['2026-10-01'] });
    expect(gapped.findings.some((f) => f.area === 'geo')).toBe(false);
    expect(
      gapped.findings.find((f) => f.title === 'Data missing for some days')!
        .evidence,
    ).toMatch(/Meta breakdowns missing for 2026-10-01/);
    // ₹50 of region spend against 30 days of orders: overall 30× account
    const silly = geo([geoRow('Delhi', 50, 3000), geoRow('Goa', 50, 100)]);
    expect(buildReport(silly).findings.some((f) => f.area === 'geo')).toBe(
      false,
    );
  });

  it('account below target: one account finding with entities as evidence', () => {
    const r = buildReport(
      input({
        cur: metrics(40000, 22, 20000),
        adsets: [adset('bad', metrics(8000, 6, 4000))],
      }),
    );
    const roas = r.findings.filter((f) => f.area === 'roas');
    expect(roas).toHaveLength(1);
    expect(roas[0]).toMatchObject({
      severity: 'critical',
      action: 'investigate',
    });
    expect(roas[0].evidence).toMatch(/Also below target: ad set Ad set bad/);
  });

  it('first-party below but Meta above → near target, not below', () => {
    const m = metrics(20000, 10, 5000, { metaPurchaseValue: 30000 });
    const t = targetOf(m);
    expect(t.verdict).toBe('near_target');
    expect(t.note).toMatch(
      /attribution gap; true ROAS likely between 0.25 and 1.50/,
    );
    expect(titles(input({ cur: m }))).not.toContain(
      'ROAS below target across the account (last 7 days) — investigate funnel, offer and creative',
    );
  });

  it('budget: at most 3 reductions, worst by spend × shortfall', () => {
    const base = input({});
    const row = (id: string, spend: number, roas: number) => ({
      level: 'adset' as const,
      id,
      name: id,
      budgetLevel: 'adset' as const,
      dailyBudget: null,
      learningStage: '',
      spend,
      firstPartyRoas: roas,
      marginalRoas: 0.2,
      frequencyTrend: 0,
      reachTrend: 0,
      signal: 'reduce' as const,
      reasons: [],
    });
    const t = titles({
      ...base,
      budget: {
        query: base.window.last30,
        caveat: '',
        rows: [
          row('a', 1000, 0.1),
          row('b', 50000, 0.5),
          row('c', 20000, 0.2),
          row('d', 30000, 0.6),
          row('e', 5000, 0.5),
        ],
      },
    }).filter((x) => x.startsWith('Consider reducing'));
    expect(t).toEqual([
      'Consider reducing budget: b',
      'Consider reducing budget: c',
      'Consider reducing budget: d',
    ]);
  });
});
