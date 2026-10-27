import {
  anomalies,
  calc,
  changepoint,
  compareProportions,
  comparePoisson,
  impactRupees,
} from './maths.logic';

describe('calc', () => {
  it('follows precedence, unary minus and functions', () => {
    expect(calc('1 + 2 * 3')).toBe(7);
    expect(calc('(1 + 2) * 3')).toBe(9);
    expect(calc('-2^2')).toBe(-4);
    expect(calc('2^3^2')).toBe(512);
    expect(calc('max(1, 5, 3) - min(4, 2)')).toBe(3);
    expect(calc('round(10 / 3, 2)')).toBe(3.33);
    expect(calc('sqrt(16) + abs(-1.5e1)')).toBe(19);
  });
  it('rejects anything that is not arithmetic', () => {
    expect(() => calc('process.exit()')).toThrow();
    expect(() => calc('1 / 0')).toThrow('Division by zero');
    expect(() => calc('(1 + 2')).toThrow();
    expect(() => calc('1 2')).toThrow();
  });
});

describe('stat_compare', () => {
  it('calls a big CTR gap significant and a small one noise', () => {
    expect(
      compareProportions({ k: 300, n: 10000 }, { k: 150, n: 10000 }).verdict,
    ).toBe('significant');
    expect(
      compareProportions({ k: 11, n: 1000 }, { k: 10, n: 1000 }).verdict,
    ).toBe('not distinguishable from noise');
  });
  it('handles zero counts and Poisson rates', () => {
    const r = compareProportions({ k: 0, n: 50 }, { k: 2, n: 50 });
    expect(r.diff95.low).toBeLessThan(0);
    expect(r.diff95.high).toBeGreaterThan(0);
    expect(
      comparePoisson(
        { count: 40, exposure: 20000 },
        { count: 10, exposure: 20000 },
      ).verdict,
    ).toBe('significant');
    expect(
      comparePoisson(
        { count: 6, exposure: 10000 },
        { count: 5, exposure: 10000 },
      ).verdict,
    ).toBe('not distinguishable from noise');
  });
});

describe('impact_rupees', () => {
  it('is spend × share × ROAS gap', () => {
    expect(
      impactRupees({ spendPerDay: 10000, roasNow: 0.6 }).impactRupeesPerDay,
    ).toBe(4000);
    expect(
      impactRupees({
        spendPerDay: 10000,
        roasNow: 0.5,
        roasIfFixed: 0.9,
        shareAffected: 0.25,
      }).impactRupeesPerDay,
    ).toBe(1000);
  });
});

describe('anomaly / changepoint', () => {
  it('flags a spike, ignores a flat series', () => {
    const r = anomalies([10, 11, 9, 10, 12, 10, 50]);
    expect(r.flagged.map((p) => p.index)).toEqual([6]);
    expect(anomalies([5, 5, 5, 5, 5]).flagged).toEqual([]);
  });
  it('finds a level shift and calls noise noise', () => {
    const c = changepoint([10, 11, 10, 9, 10, 20, 21, 19, 20, 20]);
    expect(c.index).toBe(5);
    expect(c.verdict).toBe('large shift');
    expect(changepoint([10, 12, 9, 11, 10, 12, 9, 11]).verdict).toBe(
      'within noise',
    );
  });
});
