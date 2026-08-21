import { DashboardCampaignRow } from './dashboard.types';
import {
  buildRawRoasOutcome,
  buildToolImpactCohort,
  durationStats,
  isVerifiedToolLaunch,
  classifyToolOwnership,
  isNameCoincidenceWorthReviewing,
} from './tool-impact.helpers';

describe('tool impact cohort', () => {
  const now = new Date('2026-08-21T12:00:00.000Z');

  const campaigns = [
    {
      _id: 'agent-mature',
      source: 'agent',
      metaCampaignId: 'meta-1',
      launchedAt: '2026-08-01T12:00:00.000Z',
      spend: 100,
    },
    {
      _id: 'agent-immature',
      source: 'agent',
      metaCampaignId: 'meta-2',
      launchedAt: '2026-08-20T12:00:00.000Z',
      spend: 50,
    },
    {
      _id: 'agent-zero-spend',
      source: 'agent',
      metaCampaignId: 'meta-3',
      launchedAt: '2026-08-01T12:00:00.000Z',
      spend: 0,
    },
    {
      _id: 'agent-no-meta',
      source: 'agent',
      metaCampaignId: '',
      launchedAt: '2026-08-01T12:00:00.000Z',
      spend: 10,
    },
    {
      _id: 'agent-no-date',
      source: 'agent',
      metaCampaignId: 'meta-4',
      launchedAt: null,
      spend: 10,
    },
    {
      _id: 'human-mature',
      source: 'human',
      metaCampaignId: 'meta-5',
      launchedAt: '2026-08-01T12:00:00.000Z',
      spend: 80,
    },
    {
      _id: 'manual',
      source: 'manual',
      name: 'Marketing team campaign',
      metaCampaignId: 'meta-6',
      launchedAt: '2026-08-01T12:00:00.000Z',
      spend: 1_000,
    },
    {
      _id: 'legacy-agent',
      source: 'manual',
      name: 'AGENT_WISH_LETTER_2026-08-01-TAT',
      metaCampaignId: 'meta-7',
      launchedAt: '2026-08-01T12:00:00.000Z',
      spend: 25,
    },
  ];

  it('requires both Meta id and launch timestamp for verified launch', () => {
    expect(isVerifiedToolLaunch(campaigns[0])).toBe(true);
    expect(isVerifiedToolLaunch(campaigns[3])).toBe(false);
    expect(isVerifiedToolLaunch(campaigns[4])).toBe(false);
    expect(isVerifiedToolLaunch(campaigns[6])).toBe(false);
  });

  it('never credits a manual campaign as tool-owned, even on a name coincidence', () => {
    // Real example: a marketing-team campaign named
    // "AGENT_LANDING_PAGE_TEST_NADI_REPORT_2026-06-29" (source='manual',
    // never launched by this tool) — a name match is not provenance.
    expect(classifyToolOwnership(campaigns[7])).toBeNull();
    expect(isVerifiedToolLaunch(campaigns[7])).toBe(false);
    expect(
      classifyToolOwnership({
        source: 'manual',
        name: 'AGENT_WISH_LETTER_2026-08-01_2026-08-02',
      }),
    ).toBeNull();
    expect(isNameCoincidenceWorthReviewing(campaigns[7])).toBe(true);
    expect(isNameCoincidenceWorthReviewing(campaigns[6])).toBe(false);
  });

  it('defaults the evidence cohort to autonomous agent campaigns', () => {
    const result = buildToolImpactCohort(campaigns, 'agent', now);

    expect(result.summary).toMatchObject({
      created: 5,
      launched: 3,
      withSpend: 2,
      mature: 1,
      bySource: {
        agent: { created: 5, launched: 3, withSpend: 2, mature: 1 },
        human: { created: 0, launched: 0, withSpend: 0, mature: 0 },
      },
      ownershipEvidence: {
        persistedAgentSource: 5,
        persistedHumanSource: 0,
        legacyAgentName: 0,
      },
    });
    expect(result.launched.map((campaign) => campaign._id)).toEqual([
      'agent-mature',
      'agent-immature',
      'agent-zero-spend',
    ]);
    expect(
      Object.fromEntries(
        result.summary.exclusions.map(({ code, count }) => [code, count]),
      ),
    ).toEqual({
      manual_source: 2,
      manual_source_name_coincidence: 1,
      unrecognized_source: 0,
      human_outside_agent_scope: 1,
      missing_meta_campaign_id: 1,
      missing_launched_at: 1,
      zero_spend: 1,
      not_mature: 1,
    });
    // manual_source_name_coincidence overlaps manual_source by design (see
    // the comment above the exclusions block) — excluded from this sum.
    expect(
      result.summary.exclusions
        .filter(
          (exclusion) => exclusion.code !== 'manual_source_name_coincidence',
        )
        .reduce((total, exclusion) => total + exclusion.count, 0) +
        result.summary.mature,
    ).toBe(campaigns.length);
  });

  it('adds dashboard-authored human campaigns only in managed scope', () => {
    const result = buildToolImpactCohort(campaigns, 'managed', now);

    expect(result.summary).toMatchObject({
      created: 6,
      launched: 4,
      withSpend: 3,
      mature: 2,
      bySource: {
        agent: { created: 5, launched: 3, withSpend: 2, mature: 1 },
        human: { created: 1, launched: 1, withSpend: 1, mature: 1 },
      },
    });
    expect(
      result.summary.exclusions.find(
        (exclusion) => exclusion.code === 'human_outside_agent_scope',
      )?.count,
    ).toBe(0);
  });
});

describe('tool impact raw return math', () => {
  function row(values: Partial<DashboardCampaignRow>): DashboardCampaignRow {
    return values as DashboardCampaignRow;
  }

  it('uses weighted totals across every verified campaign with spend', () => {
    const result = buildRawRoasOutcome([
      row({
        isRevenueObjective: true,
        spend: 100,
        revenue: 150,
        revenueBasis: 'meta_action_value',
      }),
      row({
        isRevenueObjective: true,
        spend: 900,
        revenue: 450,
        revenueBasis: 'configured_conversion_value',
      }),
      row({
        isRevenueObjective: false,
        spend: 2_000,
        revenue: 10_000,
        revenueBasis: 'meta_action_value',
      }),
    ]);

    expect(result).toEqual({
      campaigns: 3,
      campaignsWithSpend: 3,
      spend: 3_000,
      attributedReturn: 10_600,
      revenueBasis: [
        {
          basis: 'meta_action_value',
          campaignCount: 2,
          spend: 2_100,
          revenue: 10_150,
          weightedRoas: 4.833333,
        },
        {
          basis: 'configured_conversion_value',
          campaignCount: 1,
          spend: 900,
          revenue: 450,
          weightedRoas: 0.5,
        },
        {
          basis: 'no_attributed_revenue',
          campaignCount: 0,
          spend: 0,
          revenue: 0,
          weightedRoas: 0,
        },
        {
          basis: 'unknown',
          campaignCount: 0,
          spend: 0,
          revenue: 0,
          weightedRoas: 0,
        },
      ],
      containsModeledOrUnknownRevenue: true,
      weightedRoas: 3.533333,
      returnSurplus: 7_600,
      returnPosition: 'above',
      metOneXActionValueThreshold: true,
      thresholdRule: 'weighted_attributed_roas_gte_1',
      nonSalesCampaigns: 1,
      nonSalesSpend: 2_000,
    });
  });

  it('meets the action-value threshold exactly at 1.0x', () => {
    const result = buildRawRoasOutcome([
      row({
        isRevenueObjective: true,
        spend: 250,
        revenue: 250,
        revenueBasis: 'meta_action_value',
      }),
    ]);

    expect(result.weightedRoas).toBe(1);
    expect(result.returnSurplus).toBe(0);
    expect(result.returnPosition).toBe('equal');
    expect(result.metOneXActionValueThreshold).toBe(true);
  });

  it('does not let a zero-spend row inflate return or evade provenance', () => {
    const result = buildRawRoasOutcome([
      row({
        isRevenueObjective: true,
        spend: 100,
        revenue: 90,
        revenueBasis: 'meta_action_value',
      }),
      row({
        isRevenueObjective: true,
        spend: 0,
        revenue: 10_000,
        revenueBasis: 'unknown',
      }),
    ]);

    expect(result).toMatchObject({
      campaigns: 2,
      campaignsWithSpend: 1,
      spend: 100,
      attributedReturn: 90,
      weightedRoas: 0.9,
      returnSurplus: -10,
      returnPosition: 'below',
      metOneXActionValueThreshold: false,
    });
    expect(
      result.revenueBasis.find((entry) => entry.basis === 'unknown'),
    ).toMatchObject({ campaignCount: 0, spend: 0, revenue: 0 });
  });
});

describe('tool impact duration stats', () => {
  it('reports sample size, median, and interpolated p90', () => {
    expect(durationStats([1, 2, 3, 4, 10], 'test basis')).toEqual({
      sampleSize: 5,
      medianHours: 3,
      p90Hours: 7.6,
      basis: 'test basis',
    });
  });

  it('does not invent timings when no valid sample exists', () => {
    expect(durationStats([Number.NaN, -1], 'test basis')).toEqual({
      sampleSize: 0,
      medianHours: null,
      p90Hours: null,
      basis: 'test basis',
    });
  });
});
