import { deriveEconomics } from '../common/economics/economics';
import { evaluateObjective } from './objective-evaluation';

describe('objective-aware dashboard evaluation', () => {
  it('keeps modern Meta app-promotion spend out of sales ROAS', () => {
    const result = evaluateObjective({
      objectiveRaw: 'OUTCOME_APP_PROMOTION',
      metrics: {
        spend: 1_000,
        revenue: 5_000,
        conversions: 50,
        clicks: 100,
        impressions: 10_000,
      },
      econ: deriveEconomics({ marginPct: 0.8 }),
      ageHours: 168,
      status: 'active',
    });

    expect(result.objectiveKey).toBe('app_installs');
    expect(result.objectiveLabel).toBe('App promotion');
    expect(result.isRevenueObjective).toBe(false);
    expect(result.primaryKpi.key).toBe('cpc');
  });

  it('keeps CPM neutral and unavailable when there are no impressions', () => {
    const result = evaluateObjective({
      objectiveRaw: 'OUTCOME_AWARENESS',
      metrics: {
        spend: 500,
        revenue: 0,
        conversions: 0,
        clicks: 0,
        impressions: 0,
        reach: 0,
      },
      econ: deriveEconomics({ marginPct: 0.8 }),
      ageHours: 168,
      status: 'active',
    });

    expect(result.primaryKpi).toMatchObject({
      key: 'cpm',
      value: 0,
      display: '—',
      status: 'neutral',
    });
    expect(result.verdict).toBe('attribution_pending');
    expect(result.severity).toBe('neutral');
  });

  it('keeps CPC neutral and unavailable when there are no clicks', () => {
    const result = evaluateObjective({
      objectiveRaw: 'OUTCOME_TRAFFIC',
      metrics: {
        spend: 500,
        revenue: 0,
        conversions: 0,
        clicks: 0,
        impressions: 10_000,
      },
      econ: deriveEconomics({ marginPct: 0.8 }),
      ageHours: 168,
      status: 'active',
    });

    expect(result.primaryKpi).toMatchObject({
      key: 'cpc',
      value: 0,
      display: '—',
      status: 'neutral',
    });
    expect(result.verdict).toBe('attribution_pending');
    expect(result.severity).toBe('neutral');
  });
});
