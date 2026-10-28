import {
  confoundersOf,
  decisionQualityOf,
  diagnosisOf,
  diffInDiff,
  gradeOutcome,
  insideRange,
  isDue,
  PmWindowSums,
  ruleFor,
  seasonEdges,
  windowsFor,
} from './grading.logic';

const w = (orders: number, revenue: number, spend: number): PmWindowSums => ({ from: 'a', to: 'b', orders, revenue, spend });

describe('windows', () => {
  it('excludes the change day and waits for full after-days', () => {
    expect(windowsFor('2026-10-10', 'early')).toEqual({
      before: { from: '2026-10-03', to: '2026-10-09' },
      after: { from: '2026-10-11', to: '2026-10-13' },
    });
    expect(windowsFor('2026-10-10', 'settled').after.to).toBe('2026-10-17');
    expect(isDue('2026-10-10', '2026-10-13', 'early')).toBe(false);
    expect(isDue('2026-10-10', '2026-10-14', 'early')).toBe(true);
    expect(isDue('2026-10-10', '2026-10-18', 'settled')).toBe(true);
  });
});

describe('diffInDiff', () => {
  it('nets out the baseline move with a Poisson interval', () => {
    // entity 0.5 → 1.0, baseline 1.0 → 1.1: d = 0.4
    const r = diffInDiff(w(25, 50_000, 100_000), w(50, 100_000, 100_000), w(400, 1e6, 1e6), w(440, 1.1e6, 1e6));
    expect(r.baseline).toEqual({ roasBefore: 1, roasAfter: 1.1 });
    expect(r.diffInDiff.roas).toBeCloseTo(0.4, 6);
    // se = √(0.25/25 + 1/50 + 1/400 + 1.21/440) ≈ 0.1879
    expect(r.diffInDiff.low).toBeCloseTo(0.4 - 1.96 * 0.18793, 3);
  });
  it('drops an empty baseline', () => {
    const r = diffInDiff(w(10, 5_000, 10_000), w(10, 8_000, 10_000), w(0, 0, 0), w(0, 0, 0));
    expect(r.baseline.roasBefore).toBeNull();
    expect(r.diffInDiff.roas).toBeCloseTo(0.3, 6);
  });
});

describe('verdicts', () => {
  const base = { baseBefore: w(400, 1e6, 1e6), baseAfter: w(400, 1e6, 1e6), confounders: [] as string[], quality: null, read: 'settled' as const };
  const grade = (type: string, before: PmWindowSums, after: PmWindowSums, o: Partial<typeof base> = {}, direction?: 'up' | 'down') =>
    gradeOutcome({ decision: { type, direction }, before, after, ...base, ...o });

  it('budget cut on a loser works when ROAS rises clearly', () => {
    expect(grade('budget', w(40, 20_000, 40_000), w(40, 40_000, 40_000), {}, 'down').verdict).toBe('worked');
    expect(grade('budget', w(40, 40_000, 40_000), w(40, 20_000, 40_000), {}, 'down').verdict).toBe('hurt');
    expect(grade('budget', w(40, 40_000, 40_000), w(42, 42_000, 40_000), {}, 'down').verdict).toBe('no_effect');
  });
  it('hold and budget up only need no deterioration', () => {
    expect(ruleFor('hold')).toBe('no_worse');
    expect(ruleFor('budget', 'up')).toBe('no_worse');
    expect(grade('hold', w(40, 40_000, 40_000), w(42, 42_000, 40_000)).verdict).toBe('worked');
  });
  it('is inconclusive under 8 orders and contaminated with confounders', () => {
    expect(grade('creative', w(7, 20_000, 40_000), w(40, 40_000, 40_000)).verdict).toBe('inconclusive');
    expect(grade('creative', w(40, 20_000, 40_000), w(40, 40_000, 40_000), { confounders: ['other_edit'] }).verdict).toBe('contaminated');
  });
});

describe('prediction and quality', () => {
  it('compares expected ranges on ROAS / CPA, absolute or relative', () => {
    const b = { roas: 0.5, cpa: 2000 };
    const a = { roas: 0.6, cpa: 1800 };
    expect(insideRange({ metric: 'first-party ROAS', low: 0.55, high: 0.7 }, b, a)).toBe(true);
    expect(insideRange({ metric: 'ROAS change %', low: 5, high: 15 }, b, a)).toBe(false);
    expect(insideRange({ metric: 'cpa_change', low: -0.2, high: -0.05 }, b, a)).toBe(true);
    expect(insideRange({ metric: 'CTR', low: 1, high: 2 }, b, a)).toBeNull();
    expect(insideRange(undefined, b, a)).toBeNull();
  });
  it('scores the call, not the luck', () => {
    expect(decisionQualityOf({ checksFailed: [], causeVerdicts: ['confirmed', 'weakened'], disputed: false })).toBe('good');
    expect(decisionQualityOf({ checksFailed: ['budget_step'], causeVerdicts: ['confirmed'], disputed: false })).toBe('poor');
    expect(decisionQualityOf({ checksFailed: [], causeVerdicts: ['rejected'], disputed: false })).toBe('poor');
    expect(decisionQualityOf({ checksFailed: [], causeVerdicts: ['confirmed'], disputed: true })).toBe('unknown');
    expect(decisionQualityOf(null)).toBe('unknown');
  });
});

describe('confounders', () => {
  it('lists each kind once', () => {
    expect(confoundersOf({ otherEdits: 2, resetByOther: true, missingDays: 1, coverageBefore: 0.6, coverageAfter: 0.45, seasonEdges: 1 })).toEqual([
      'learning_reset',
      'other_edit',
      'tracking_gap',
      'festival_edge',
      'missing_days',
    ]);
    expect(confoundersOf({ otherEdits: 0, resetByOther: false, missingDays: 0, coverageBefore: 0.6, coverageAfter: 0.55, seasonEdges: 0 })).toEqual([]);
  });
  it('counts only multi-day non-neutral rows that start or end inside', () => {
    const rows = [
      { id: 'pitru', start: '2026-09-27', end: '2026-10-10', mood: 'inauspicious_to_buy' as const },
      { id: 'diwali', start: '2026-10-08', end: '2026-10-08', mood: 'devotional_peak' as const },
      { id: 'retro', start: '2026-10-03', end: '2026-11-14', mood: 'neutral' as const },
      { id: 'gif', start: '2026-09-20', end: '2026-11-08', mood: 'cpm_up' as const },
    ];
    expect(seasonEdges(rows, '2026-10-01', '2026-10-13')).toEqual(['pitru']);
    expect(seasonEdges(rows, '2026-10-11', '2026-10-20')).toEqual([]);
  });
});

describe('diagnosisOf', () => {
  it('reads a fix and a persisting signal', () => {
    expect(diagnosisOf(true, 'better')).toBe('held');
    expect(diagnosisOf(true, 'worse')).toBe('not_held');
    expect(diagnosisOf(true, 'same')).toBe('unclear');
    expect(diagnosisOf(false, 'same')).toBe('held');
    expect(diagnosisOf(false, 'better')).toBe('not_held');
    expect(diagnosisOf(false, null)).toBe('unclear');
  });
});
