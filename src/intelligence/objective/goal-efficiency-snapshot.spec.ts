import type {
  MetricProvenance,
  MetricSet,
  SnapshotData,
} from '../snapshot/snapshot.types';
import { measureGoalEfficiency } from './goal-efficiency';
import {
  buildSnapshotGoalEfficiencyRow,
  buildSnapshotGoalEfficiencyRows,
} from './goal-efficiency-snapshot';

function provenance(
  overrides: Partial<MetricProvenance> = {},
): MetricProvenance {
  return {
    rowObserved: true,
    fetchComplete: true,
    state: 'observed',
    source: 'meta_insights',
    sourceFingerprint: 'query-fingerprint',
    currency: 'INR',
    metricsSyncedAt: new Date('2026-08-23T09:55:00.000Z'),
    dateStart: '2026-08-01',
    dateStop: '2026-08-22',
    attributionSpec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
    promotedObject: { custom_conversion_id: 'cc-1' },
    revenueBasis: 'meta_action_value',
    revenueAttributionSource: 'custom_conversion',
    revenueAttributionActionTypes: ['offsite_conversion.custom.1', 'purchase'],
    rawMetaActionValueGross: 500,
    goalResultInputs: {
      actionCounts: {
        'offsite_conversion.custom.1': 2,
        purchase: 3,
        lead: 100,
      },
      actionValuesGross: {
        'offsite_conversion.custom.1': 200,
        purchase: 300,
      },
    },
    ...overrides,
  };
}

function metrics(
  overrides: Partial<MetricSet> = {},
  metricProvenance = provenance(),
): MetricSet {
  return {
    spend: 100,
    revenue: 99_999,
    impressions: 10_000,
    reach: 8_000,
    clicks: 1_000,
    ctr: 10,
    cpc: 0.1,
    cpm: 10,
    cvr: 0.9,
    purchases: 999,
    addToCart: 0,
    initiateCheckout: 0,
    roas: 999.99,
    aov: 100,
    frequency: 1.25,
    landingPageViews: 100,
    inlineLinkClicks: 200,
    thruplay: 300,
    provenance: metricProvenance,
    ...overrides,
  };
}

function snapshot(input?: {
  objective?: string;
  goal?: string;
  adSetMetrics?: Record<string, MetricSet>;
  adMetrics?: Record<string, MetricSet>;
}): SnapshotData {
  const adSetMetrics = input?.adSetMetrics ?? { 'as-1': metrics() };
  const adMetrics = input?.adMetrics ?? { 'ad-1': metrics() };
  return {
    snapshotId: 'snap-1',
    collectedAt: new Date('2026-08-23T10:00:00.000Z'),
    freshnessSec: 300,
    metrics: {
      campaignLevel: metrics(),
      adSetLevel: adSetMetrics,
      adLevel: adMetrics,
    },
    entities: {
      campaign: {
        id: 'campaign-1',
        name: 'Campaign',
        objective: input?.objective ?? 'OUTCOME_TRAFFIC',
        effectiveStatus: 'ACTIVE',
      },
      adSets: Object.fromEntries(
        Object.keys(adSetMetrics).map((id) => [
          id,
          {
            id,
            name: id,
            effectiveStatus: 'ACTIVE',
            optimizationGoal: input?.goal ?? 'LANDING_PAGE_VIEWS',
          },
        ]),
      ),
      ads: Object.fromEntries(
        Object.keys(adMetrics).map((id) => [
          id,
          {
            id,
            adSetId: 'as-1',
            name: id,
            effectiveStatus: 'ACTIVE',
          },
        ]),
      ),
    },
    meta: {
      accountId: 'act-1',
      objective: input?.objective ?? 'OUTCOME_TRAFFIC',
      metricScope: 'lifetime',
    },
    missingFields: [],
  };
}

describe('Snapshot goal-efficiency adapter', () => {
  it('maps an exact ad-set identity and direct goal metric', () => {
    const row = buildSnapshotGoalEfficiencyRow({
      snapshot: snapshot(),
      level: 'adset',
      entityId: 'as-1',
    });

    expect(row).toMatchObject({
      entityId: 'as-1',
      parentId: 'campaign-1',
      level: 'adset',
      effectiveStatus: 'ACTIVE',
      objective: 'OUTCOME_TRAFFIC',
      optimizationGoal: 'LANDING_PAGE_VIEWS',
      metrics: {
        spend: 100,
        landingPageViews: 100,
      },
      provenance: {
        rowObserved: true,
        responseComplete: true,
        metricScope: 'lifetime',
        freshnessSec: 300,
        source: 'meta_insights',
        sourceFingerprint: 'query-fingerprint',
        currency: 'INR',
      },
    });
    expect(measureGoalEfficiency(row!)).toMatchObject({
      status: 'measured',
      measurement: {
        efficiency: { metric: 'cost_per_landing_page_view', value: 1 },
      },
    });
  });

  it('inherits an ad goal only through its exact parent ad set', () => {
    const row = buildSnapshotGoalEfficiencyRow({
      snapshot: snapshot({
        objective: 'OUTCOME_SALES',
        goal: 'OFFSITE_CONVERSIONS',
      }),
      level: 'ad',
      entityId: 'ad-1',
    });

    expect(row).toMatchObject({
      entityId: 'ad-1',
      parentId: 'as-1',
      level: 'ad',
      optimizationGoal: 'OFFSITE_CONVERSIONS',
    });
    expect(row?.provenance.attribution).toMatchObject({
      attributionSource: 'custom_conversion',
      actionTypes: ['offsite_conversion.custom.1', 'purchase'],
      valueBasis: 'meta_action_value',
    });
    expect(row?.provenance.attribution?.attributionSpecHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('sums only exact attributed action types and ignores generic purchases', () => {
    const row = buildSnapshotGoalEfficiencyRow({
      snapshot: snapshot({
        objective: 'OUTCOME_SALES',
        goal: 'OFFSITE_CONVERSIONS',
      }),
      level: 'adset',
      entityId: 'as-1',
    });

    expect(row?.metrics).toMatchObject({
      exactConversions: 5,
    });
    expect(row?.metrics.exactConversions).not.toBe(999);
    expect(measureGoalEfficiency(row!)).toMatchObject({
      status: 'measured',
      measurement: {
        result: { value: 5 },
        efficiency: { value: 20 },
      },
    });
  });

  it('does not manufacture a conversion zero when one exact alias is absent', () => {
    const p = provenance({
      goalResultInputs: {
        actionCounts: { purchase: 0 },
      },
    });
    const snap = snapshot({
      objective: 'OUTCOME_SALES',
      goal: 'OFFSITE_CONVERSIONS',
      adSetMetrics: { 'as-1': metrics({}, p) },
    });
    const row = buildSnapshotGoalEfficiencyRow({
      snapshot: snap,
      level: 'adset',
      entityId: 'as-1',
    });

    expect(row?.metrics).not.toHaveProperty('exactConversions');
    expect(measureGoalEfficiency(row!)).toMatchObject({
      status: 'unavailable',
      code: 'metric_missing',
    });
  });

  it('preserves an explicit zero when every exact alias is present', () => {
    const p = provenance({
      goalResultInputs: {
        actionCounts: {
          'offsite_conversion.custom.1': 0,
          purchase: 0,
        },
      },
    });
    const snap = snapshot({
      objective: 'OUTCOME_SALES',
      goal: 'OFFSITE_CONVERSIONS',
      adSetMetrics: { 'as-1': metrics({}, p) },
    });
    const row = buildSnapshotGoalEfficiencyRow({
      snapshot: snap,
      level: 'adset',
      entityId: 'as-1',
    });

    expect(row?.metrics.exactConversions).toBe(0);
    expect(measureGoalEfficiency(row!)).toMatchObject({
      status: 'measured',
      measurement: {
        result: { value: 0 },
        efficiency: { value: null },
      },
    });
  });

  it('maps VALUE only from rawMetaActionValueGross, never canonical revenue', () => {
    const p = provenance({
      rawMetaActionValueGross: 500,
      canonicalRevenueNet: 450,
      configuredRevenueEstimateNet: 99_000,
    });
    const snap = snapshot({
      objective: 'OUTCOME_SALES',
      goal: 'VALUE',
      adSetMetrics: {
        'as-1': metrics({ spend: 250, revenue: 99_000 }, p),
      },
    });
    const row = buildSnapshotGoalEfficiencyRow({
      snapshot: snap,
      level: 'adset',
      entityId: 'as-1',
    });

    expect(row?.metrics.rawMetaActionValue).toBe(500);
    expect(measureGoalEfficiency(row!)).toMatchObject({
      status: 'measured',
      measurement: {
        result: { value: 500 },
        efficiency: { metric: 'raw_roas', value: 2 },
      },
    });
  });

  it.each([
    ['missing currency', { currency: undefined }, 'invalid_currency'],
    ['preserved row', { state: 'preserved' as const }, 'row_not_observed'],
    ['incomplete fetch', { fetchComplete: false }, 'response_incomplete'],
  ])('fails closed for %s', (_, provenanceOverride, code) => {
    const snap = snapshot({
      adSetMetrics: {
        'as-1': metrics({}, provenance(provenanceOverride)),
      },
    });
    const row = buildSnapshotGoalEfficiencyRow({
      snapshot: snap,
      level: 'adset',
      entityId: 'as-1',
    });

    expect(measureGoalEfficiency(row!)).toMatchObject({
      status: 'unavailable',
      code,
    });
  });

  it('fails hierarchy resolution when an ad has no exact parent', () => {
    const snap = snapshot();
    snap.entities!.ads['ad-1'].adSetId = 'missing-parent';

    expect(
      buildSnapshotGoalEfficiencyRow({
        snapshot: snap,
        level: 'ad',
        entityId: 'ad-1',
      }),
    ).toBeNull();
  });

  it('builds rows in deterministic entity-id order', () => {
    const snap = snapshot({
      adSetMetrics: {
        'as-z': metrics(),
        'as-a': metrics(),
      },
    });

    expect(
      buildSnapshotGoalEfficiencyRows(snap, 'adset').map((row) => row.entityId),
    ).toEqual(['as-a', 'as-z']);
  });
});
