import { SnapshotValidator } from '../../../../src/intelligence/snapshot/snapshot-validator.service';
import { SnapshotData } from '../../../../src/intelligence/snapshot/snapshot.types';

const baseMetric = {
  spend: 100,
  revenue: 200,
  impressions: 5000,
  reach: 3000,
  clicks: 80,
  ctr: 1.6,
  cpc: 1.25,
  cpm: 20,
  cvr: 0.05,
  purchases: 4,
  addToCart: 10,
  initiateCheckout: 6,
  roas: 2,
  aov: 50,
  frequency: 1.4,
};

function makeSnapshot(overrides: Partial<SnapshotData> = {}): SnapshotData {
  return {
    snapshotId: 'snap-1',
    collectedAt: new Date(),
    freshnessSec: 0,
    metrics: {
      campaignLevel: { ...baseMetric },
      adSetLevel: {},
      adLevel: {},
    },
    meta: {
      accountId: 'act',
      learningStage: 'ACTIVE',
      deliveryStatus: 'ACTIVE',
    },
    missingFields: [],
    ...overrides,
  };
}

describe('SnapshotValidator.validate', () => {
  let v: SnapshotValidator;
  beforeEach(() => {
    v = new SnapshotValidator();
  });

  it('ok=true when nothing missing and metrics complete', () => {
    const r = v.validate(makeSnapshot());
    expect(r.ok).toBe(true);
    expect(r.missingFields).toHaveLength(0);
  });

  it('completeness score reflects fraction of expected fields missing', () => {
    const r = v.validate(
      makeSnapshot({ missingFields: ['spend', 'impressions'] }),
    );
    // 5 expected, 2 missing → completeness = 0.6
    expect(r.scores.completeness).toBeCloseTo(0.6, 3);
    expect(r.ok).toBe(false);
  });

  it('freshness=1 when < 15min old', () => {
    const r = v.validate(makeSnapshot({ freshnessSec: 300 }));
    expect(r.scores.freshness).toBe(1);
  });

  it('freshness=0 when >= 60min old', () => {
    const r = v.validate(makeSnapshot({ freshnessSec: 3600 }));
    expect(r.scores.freshness).toBe(0);
  });

  it('freshness decays linearly between 15 and 60 min', () => {
    const r = v.validate(makeSnapshot({ freshnessSec: 2250 })); // midpoint
    expect(r.scores.freshness).toBeGreaterThan(0.4);
    expect(r.scores.freshness).toBeLessThan(0.6);
  });

  it('emits stale warning at the 60-minute action boundary', () => {
    const r = v.validate(makeSnapshot({ freshnessSec: 3600 }));
    expect(r.warnings).toContain('stale_snapshot');
  });

  it('scores explicitly unknown source freshness as zero', () => {
    const r = v.validate(makeSnapshot({ freshnessSec: -1 }));
    expect(r.warnings).toContain('stale_snapshot');
    expect(r.scores.freshness).toBe(0);
  });

  it('emits ad_breakdown_missing when adset level populated but ad level empty', () => {
    const r = v.validate(
      makeSnapshot({
        metrics: {
          campaignLevel: { ...baseMetric },
          adSetLevel: { as1: { ...baseMetric } },
          adLevel: {},
        },
      }),
    );
    expect(r.warnings).toContain('ad_breakdown_missing');
  });

  it('flags revenue_zero_but_purchases_present when purchases > 0 and revenue = 0', () => {
    const r = v.validate(
      makeSnapshot({
        metrics: {
          campaignLevel: { ...baseMetric, revenue: 0 },
          adSetLevel: {},
          adLevel: {},
        },
      }),
    );
    expect(r.warnings).toContain('revenue_zero_but_purchases_present');
  });

  it('meta status = 1 when deliveryStatus ACTIVE', () => {
    expect(v.validate(makeSnapshot()).scores.metaStatus).toBe(1);
  });

  it('meta status = 0.5 for non-ACTIVE status', () => {
    const r = v.validate(
      makeSnapshot({ meta: { accountId: 'act', deliveryStatus: 'PAUSED' } }),
    );
    expect(r.scores.metaStatus).toBe(0.5);
  });
});

describe('SnapshotValidator.confidence', () => {
  const v = new SnapshotValidator();

  it('healthy snapshot scores >= 0.85', () => {
    const r = v.validate(makeSnapshot());
    expect(v.confidence(r)).toBeGreaterThanOrEqual(0.85);
  });

  it('degraded (missing 2 fields, stale) scores well below 0.5', () => {
    const r = v.validate(
      makeSnapshot({
        freshnessSec: 5400,
        missingFields: ['spend', 'impressions'],
        meta: { accountId: 'act', deliveryStatus: 'PAUSED' },
      }),
    );
    expect(v.confidence(r)).toBeLessThan(0.5);
  });

  it('weighting: 0.5*completeness + 0.3*freshness + 0.2*metaStatus', () => {
    const r = v.validate(
      makeSnapshot({
        freshnessSec: 900, // freshness=1
        missingFields: [],
        meta: { accountId: 'act', deliveryStatus: 'ACTIVE' },
      }),
    );
    // completeness 1, freshness 1, meta 1 → confidence 1
    expect(v.confidence(r)).toBeCloseTo(1, 3);
  });
});
