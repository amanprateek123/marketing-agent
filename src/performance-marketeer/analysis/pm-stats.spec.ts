import {
  bandIndex,
  poissonRateZ,
  missingFrom,
  withMissingMeta,
  budgetSignalOf,
  fatigueOf,
  confidenceFor,
  decomposeCpa,
  normaliseRegion,
  olsSlope,
  previousPeriod,
  ratio,
  relChange,
  SCROLL_BANDS,
  targetCheck,
  TIME_BANDS,
  toMetrics,
  weightedFrequency,
} from './pm-stats';

describe('pm-stats', () => {
  it('ratios are null on a zero denominator', () => {
    expect(ratio(5, 0)).toBeNull();
    expect(ratio(5, null)).toBeNull();
    expect(ratio(5, 2)).toBe(2.5);
    expect(relChange(12, 10)).toBeCloseTo(0.2);
    expect(relChange(12, 0)).toBeNull();
    expect(relChange(null, 10)).toBeNull();
  });

  it('previous period is the same length, right before', () => {
    expect(previousPeriod('2026-10-18', '2026-10-24')).toEqual({
      from: '2026-10-11',
      to: '2026-10-17',
    });
    expect(previousPeriod('2026-10-01', '2026-10-01')).toEqual({
      from: '2026-09-30',
      to: '2026-09-30',
    });
  });

  it('confidence thresholds', () => {
    expect(confidenceFor(4)).toBe('low');
    expect(confidenceFor(5)).toBe('medium');
    expect(confidenceFor(19)).toBe('medium');
    expect(confidenceFor(20)).toBe('high');
  });

  it('target verdicts', () => {
    expect(targetCheck(0, 0, 0).verdict).toBe('not_enough_data');
    expect(targetCheck(5000, 1500, 1).verdict).toBe('not_enough_data');
    // large spend, near-zero revenue, few orders → below anyway
    const big = targetCheck(12000, 1500, 1);
    expect(big.verdict).toBe('below_target');
    expect(big.confidence).toBe('medium');
    // the near band widens with fewer orders (rough Poisson 95% range)
    expect(targetCheck(10000, 30000, 25).verdict).toBe('above_target');
    expect(targetCheck(10000, 13000, 8).verdict).toBe('near_target');
    expect(targetCheck(10000, 9000, 8).verdict).toBe('near_target');
    expect(targetCheck(10000, 4000, 25).verdict).toBe('below_target');
    expect(targetCheck(10000, 13000, 100).verdict).toBe('above_target');
    expect(targetCheck(10000, 8000, 100).verdict).toBe('below_target');
    expect(targetCheck(10000, 9000, 100).verdict).toBe('near_target');
    expect(targetCheck(10000, 20000, 25).confidence).toBe('high');
  });

  it('CPA decomposition sums to 1 and identifies the driver', () => {
    const prior = { cpm: 100, ctr: 0.01, clickToOrderRate: 0.02 };
    const cur = { cpm: 110, ctr: 0.01, clickToOrderRate: 0.01 };
    const f = decomposeCpa(cur, prior);
    const sum = f.reduce((s, x) => s + (x.contribution ?? 0), 0);
    expect(sum).toBeCloseTo(1);
    const cvr = f.find((x) => x.name === 'clickToOrderRate')!;
    expect(cvr.contribution!).toBeGreaterThan(0.8);
    expect(f.find((x) => x.name === 'ctr')!.contribution).toBeCloseTo(0);
    // zero orders → no shares
    expect(
      decomposeCpa({ ...cur, clickToOrderRate: 0 }, prior).every(
        (x) => x.contribution === null,
      ),
    ).toBe(true);
    // unchanged CPA → no shares
    expect(decomposeCpa(prior, prior)[0].contribution).toBeNull();
    // factor moving against the total gets a negative share
    const g = decomposeCpa(
      { cpm: 200, ctr: 0.012, clickToOrderRate: 0.02 },
      prior,
    );
    expect(g.find((x) => x.name === 'ctr')!.contribution!).toBeLessThan(0);
    expect(g.reduce((s, x) => s + x.contribution!, 0)).toBeCloseTo(1);
  });

  it('OLS slope', () => {
    expect(olsSlope([1, 2, 3], [2, 4, 6])).toBeCloseTo(2);
    expect(olsSlope([1, 1, 1], [2, 4, 6])).toBeNull();
    expect(olsSlope([1], [2])).toBeNull();
  });

  it('weighted frequency', () => {
    expect(
      weightedFrequency([
        { frequency: 1, impressions: 100 },
        { frequency: 3, impressions: 300 },
      ]),
    ).toBeCloseTo(2.5);
    expect(weightedFrequency([])).toBeNull();
  });

  it('bands', () => {
    const s = (v: number) =>
      SCROLL_BANDS.labels[bandIndex(v, SCROLL_BANDS.uppers)];
    expect([0, 25, 50, 75, 100].map(s)).toEqual([
      '<25%',
      '25–49%',
      '50–74%',
      '75–99%',
      '100%',
    ]);
    const t = (v: number) => TIME_BANDS.labels[bandIndex(v, TIME_BANDS.uppers)];
    expect([0, 9.9, 10, 30, 59, 60, 179, 180, 999].map(t)).toEqual([
      '<10s',
      '<10s',
      '10–30s',
      '30–60s',
      '30–60s',
      '1–3m',
      '1–3m',
      '3m+',
      '3m+',
    ]);
  });

  it('metrics block', () => {
    const m = toMetrics(
      {
        spend: 1000,
        impressions: 50000,
        clicks: 900,
        linkClicks: 500,
        landingPageViews: 400,
        freqImp: 60000,
        metaPurchases: 4,
        metaPurchaseValue: 5200,
      },
      { orders: 2, revenue: 3000, newCustomers: 1 },
      { visitors: 300, ctaClicks: 60, paymentsStarted: 10 },
    );
    expect(m.cpm).toBe(20);
    expect(m.ctr).toBe(0.01);
    expect(m.frequency).toBeCloseTo(1.2);
    expect(m.firstPartyRoas).toBe(3);
    expect(m.firstPartyCpa).toBe(500);
    expect(m.clickToOrderRate).toBe(0.004);
    expect(toMetrics().firstPartyRoas).toBeNull();
  });

  it('region names', () => {
    expect(normaliseRegion('National Capital Territory of Delhi')).toBe(
      'Delhi',
    );
    expect(normaliseRegion('Delhi')).toBe('Delhi');
    expect(normaliseRegion(null)).toBe('Unknown');
    expect(normaliseRegion('Karnataka')).toBe('Karnataka');
  });

  it('fatigue rules', () => {
    const w = (o: Partial<Parameters<typeof fatigueOf>[1]>) => ({
      spend: 7000,
      impressions: 100000,
      linkClicks: 1000,
      freqImp: 120000, // frequency 1.2
      orders: 10,
      ...o,
    });
    expect(fatigueOf(10, w({}), w({})).status).toBe('not_enough_data');
    expect(fatigueOf(20, w({}), w({ impressions: 2000 })).status).toBe(
      'not_enough_data',
    );
    expect(fatigueOf(20, w({}), w({})).status).toBe('healthy');
    // frequency up 50% and CTR down 30% → fatigued
    const tired = fatigueOf(20, w({}), w({ freqImp: 180000, linkClicks: 700 }));
    expect(tired.status).toBe('fatigued');
    expect(tired.reasons.join(' ')).toMatch(/daily frequency 1.20 → 1.80/);
    // CTR is not compared on fewer than 100 link clicks per window
    expect(
      fatigueOf(
        20,
        w({ linkClicks: 90 }),
        w({ freqImp: 180000, linkClicks: 50 }),
      ).status,
    ).toBe('healthy');
    // CTR down alone → watch
    expect(fatigueOf(20, w({}), w({ linkClicks: 700 })).status).toBe('watch');
    // frequency up alone, still low → healthy
    expect(fatigueOf(20, w({}), w({ freqImp: 150000 })).status).toBe('healthy');
    // CPA up with frequency up → fatigued; but not with too few orders
    expect(fatigueOf(20, w({}), w({ freqImp: 150000, orders: 6 })).status).toBe(
      'fatigued',
    );
    expect(
      fatigueOf(20, w({ orders: 4 }), w({ freqImp: 150000, orders: 2 })).status,
    ).toBe('healthy');
  });

  it('budget rules', () => {
    const base: Parameters<typeof budgetSignalOf>[0] = {
      activeDays: 20,
      spend: 50000,
      revenue: 80000,
      orders: 40,
      marginalRoas: 1.4,
      frequencyTrend: 0.05,
      reachTrend: 0.1,
      recentChange: null,
    };
    const sig = (o: Partial<typeof base>) =>
      budgetSignalOf({ ...base, ...o }).signal;
    expect(sig({})).toBe('room_to_scale');
    expect(sig({ activeDays: 5 })).toBe('not_enough_data');
    expect(sig({ orders: 3, revenue: 6000, spend: 5000 })).toBe(
      'not_enough_data',
    );
    expect(sig({ recentChange: 'budget 2026-10-23' })).toBe('hold');
    expect(sig({ frequencyTrend: 0.3, reachTrend: 0 })).toBe('saturating');
    // reach not comparable (different ads) → frequency alone is not saturation
    expect(sig({ frequencyTrend: 0.3, reachTrend: null })).toBe('hold');
    expect(sig({ marginalRoas: 0.4 })).toBe('saturating');
    expect(sig({ marginalRoas: 0.4, activeDays: 10 })).toBe('hold');
    expect(sig({ orders: 10 })).toBe('hold'); // above target, medium confidence
    // reduce only for laggards vs the account
    const lag = { revenue: 30000, accountRoas: 1.0, marginalRoas: 0.5 };
    expect(sig(lag)).toBe('reduce');
    expect(sig({ ...lag, marginalRoas: null })).toBe('hold');
    expect(sig({ ...lag, marginalRoas: 1.5 })).toBe('hold');
    // whole account below target → hold
    const flat = budgetSignalOf({ ...base, ...lag, accountRoas: 0.65 });
    expect(flat.signal).toBe('hold');
    expect(flat.reasons.join(' ')).toMatch(/Whole account below target/);
    // Meta-reported ROAS above target → not below → no reduce
    expect(sig({ ...lag, metaRoas: 1.3 })).not.toBe('reduce');
    expect(sig({ revenue: 48000 })).toBe('hold'); // near target
  });

  it('missing days downgrade the verdict', () => {
    expect(
      missingFrom(['2026-10-22', '2026-10-23', '2026-10-24'], ['2026-10-23']),
    ).toEqual(['2026-10-22', '2026-10-24']);
    const t = targetCheck(10000, 20000, 25);
    expect(withMissingMeta(t, [])).toBe(t);
    expect(withMissingMeta(t, ['2026-10-24'])).toMatchObject({
      verdict: 'not_enough_data',
      confidence: 'low',
      note: 'Meta data missing for 2026-10-24',
    });
  });

  it('Poisson rate z', () => {
    expect(poissonRateZ(20, 20000, 40, 20000)!).toBeLessThan(-1.96);
    expect(Math.abs(poissonRateZ(20, 20000, 25, 20000)!)).toBeLessThan(1.96);
    expect(poissonRateZ(0, 20000, 25, 20000)).toBeNull();
  });
});
