import {
  clampConfidence,
  weightedConfidence,
} from '../../../src/intelligence/shared/engine-context';

describe('engine-context: clampConfidence', () => {
  it('returns value inside [0,1] unchanged', () => {
    expect(clampConfidence(0)).toBe(0);
    expect(clampConfidence(0.5)).toBe(0.5);
    expect(clampConfidence(1)).toBe(1);
  });
  it('clamps values outside [0,1]', () => {
    expect(clampConfidence(-0.3)).toBe(0);
    expect(clampConfidence(2.1)).toBe(1);
  });
  it('handles NaN by returning 0', () => {
    expect(clampConfidence(NaN)).toBe(0);
  });
});

describe('engine-context: weightedConfidence', () => {
  it('returns 0 when weights sum to 0', () => {
    expect(weightedConfidence([])).toBe(0);
    expect(weightedConfidence([{ value: 0.9, weight: 0 }])).toBe(0);
  });

  it('computes correct weighted average', () => {
    const c = weightedConfidence([
      { value: 1, weight: 1 },
      { value: 0, weight: 1 },
    ]);
    expect(c).toBeCloseTo(0.5);
  });

  it('respects unequal weights', () => {
    // 0.9 * 0.75 + 0.5 * 0.25 = 0.8
    const c = weightedConfidence([
      { value: 0.9, weight: 0.75 },
      { value: 0.5, weight: 0.25 },
    ]);
    expect(c).toBeCloseTo(0.8);
  });

  it('clamps individual inputs before weighting', () => {
    const c = weightedConfidence([
      { value: 1.5, weight: 1 },
      { value: -0.5, weight: 1 },
    ]);
    // clamped to (1 + 0) / 2 = 0.5
    expect(c).toBeCloseTo(0.5);
  });
});
