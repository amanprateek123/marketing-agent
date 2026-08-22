import { DashboardService } from './dashboard.service';

function queryReturning<T>(value: T) {
  const query: any = {};
  query.sort = jest.fn(() => query);
  query.select = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn().mockResolvedValue(value);
  return query;
}

describe('DashboardService.getToolImpact', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('joins intelligence evidence to verified agent launches only', async () => {
    const productEconomics = {
      productName: 'Product A',
      marginPct: 0.5,
      refundPct: 0,
      netMarginPct: 0.5,
      breakevenROAS: 2,
      targetROAS: 2.4,
      method: 'product-config' as const,
      notes: [],
    };
    const tenantEconomics = {
      ...productEconomics,
      byProduct: { 'Product A': productEconomics },
      hasMixedMargins: false,
    };
    const economics = {
      forTenant: jest.fn().mockResolvedValue(tenantEconomics),
      forProduct: jest.fn().mockReturnValue(productEconomics),
    };

    const campaigns = [
      {
        _id: 'agent-launched',
        tenantId: 'tenant-1',
        source: 'agent',
        productName: 'Product A',
        name: 'Misleading legacy campaign name',
        runId: 'run-1',
        metaCampaignId: 'meta-agent',
        launchedAt: new Date('2026-08-01T12:00:00.000Z'),
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        dataAsOf: new Date('2026-08-21T10:00:00.000Z'),
        status: 'active',
        objective: 'OUTCOME_SALES',
        budget: 100,
        spend: 100,
        revenue: 120,
        revenueBasis: 'meta_action_value',
        conversions: 2,
        campaignConfig: {
          adSets: [{ optimizationGoal: 'VALUE' }],
        },
      },
      {
        _id: 'agent-not-launched',
        tenantId: 'tenant-1',
        source: 'agent',
        productName: 'Product A',
        name: 'Never launched',
        metaCampaignId: '',
        launchedAt: null,
        createdAt: new Date('2026-08-20T10:00:00.000Z'),
        status: 'pending_approval',
        objective: 'OUTCOME_SALES',
        budget: 100,
        spend: 0,
        revenue: 0,
      },
      {
        _id: 'human-launched',
        tenantId: 'tenant-1',
        source: 'human',
        productName: 'Product A',
        name: 'Dashboard authored',
        metaCampaignId: 'meta-human',
        launchedAt: new Date('2026-08-01T12:00:00.000Z'),
        status: 'active',
        objective: 'OUTCOME_SALES',
        budget: 100,
        spend: 1_000,
        revenue: 5_000,
      },
      {
        _id: 'agent-invalid-launch-date',
        tenantId: 'tenant-1',
        source: 'agent',
        productName: 'Product A',
        name: 'Malformed launch evidence',
        metaCampaignId: 'meta-invalid-date',
        launchedAt: 'not-a-date',
        createdAt: new Date('2026-08-20T10:00:00.000Z'),
        status: 'paused',
        objective: 'OUTCOME_SALES',
        budget: 100,
        spend: 0,
        revenue: 0,
      },
      {
        _id: 'agent-awareness',
        tenantId: 'tenant-1',
        source: 'agent',
        productName: 'Product A',
        name: 'Agent reach campaign',
        metaCampaignId: 'meta-awareness',
        launchedAt: new Date('2026-08-01T12:00:00.000Z'),
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        dataAsOf: new Date('2026-08-21T10:00:00.000Z'),
        status: 'active',
        objective: 'OUTCOME_AWARENESS',
        budget: 50,
        spend: 50,
        revenue: 999,
        campaignConfig: {
          adSets: [{ optimizationGoal: 'REACH' }],
        },
      },
      {
        _id: 'agent-unknown-objective',
        tenantId: 'tenant-1',
        source: 'agent',
        productName: 'Product A',
        name: 'Future objective campaign',
        metaCampaignId: 'meta-unknown-objective',
        launchedAt: new Date('2026-08-01T12:00:00.000Z'),
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        status: 'paused',
        objective: 'OUTCOME_FUTURE_UNKNOWN',
        budget: 50,
        spend: 0,
        revenue: 0,
      },
      {
        _id: 'manual-launched',
        tenantId: 'tenant-1',
        source: 'manual',
        productName: 'Product A',
        name: 'Imported from Ads Manager',
        metaCampaignId: 'meta-manual',
        launchedAt: new Date('2026-08-01T12:00:00.000Z'),
        status: 'active',
        objective: 'OUTCOME_SALES',
        budget: 100,
        spend: 5_000,
        revenue: 0,
      },
    ];

    const companyModel = {
      findOne: jest.fn(() =>
        queryReturning({ products: [{ name: 'Product A' }] }),
      ),
    };
    const campaignModel = {
      find: jest.fn(() => queryReturning(campaigns)),
    };
    const runModel = {
      find: jest.fn(() =>
        queryReturning([
          {
            runId: 'run-1',
            campaignId: 'agent-launched',
            status: 'completed',
            startedAt: new Date('2026-08-01T09:00:00.000Z'),
          },
          {
            runId: 'failed-before-campaign',
            status: 'failed',
            startedAt: new Date('2026-08-02T09:00:00.000Z'),
          },
        ]),
      ),
    };
    const decisionModel = { find: jest.fn(() => queryReturning([])) };
    const cycleModel = { find: jest.fn(() => queryReturning([])) };
    const executedActionModel = {
      find: jest.fn(() => queryReturning([])),
    };
    const timeseriesModel = {
      // Return extra rows deliberately: the service must enforce the exact
      // verified-sales Meta id set even if a model/mock over-returns.
      find: jest.fn(() =>
        queryReturning([
          {
            metaCampaignId: 'meta-agent',
            date: '2026-08-01',
            spend: 60,
            revenue: 80,
            impressions: 1_200,
            reach: 900,
            clicks: 48,
            inlineLinkClicks: 40,
            conversions: 2,
            addToCart: 8,
            initiateCheckout: 4,
            landingPageView: 32,
            revenueBasis: 'configured_conversion_value',
            revenueAttributionSource: 'custom_conversion',
            revenueAttributionActionTypes: [
              'offsite_conversion.custom.product-a',
            ],
            revenueCalculationVersion: 'product_scoped_v1',
            revenueFetchCompleteness: 'complete',
            campaignProductName: 'Product A',
            resolvedProductName: 'Product A',
            productResolutionEvidence: 'persisted_campaign_product_exact',
            revenueConfigFingerprint: 'a'.repeat(64),
          },
          {
            metaCampaignId: 'meta-agent',
            date: '2026-08-02',
            spend: 40,
            revenue: 40,
            impressions: 800,
            reach: 600,
            clicks: 20,
            inlineLinkClicks: 16,
            conversions: 1,
            // A pre-provenance row: spend is valid, return is only an
            // explicitly unverified persisted value.
          },
          {
            metaCampaignId: 'meta-human',
            date: '2026-08-01',
            spend: 1_000,
            revenue: 5_000,
            revenueBasis: 'meta_action_value',
            revenueAttributionSource: 'custom_conversion',
            revenueAttributionActionTypes: [
              'offsite_conversion.custom.product-a',
            ],
            revenueCalculationVersion: 'product_scoped_v1',
            revenueFetchCompleteness: 'complete',
            campaignProductName: 'Product A',
            resolvedProductName: 'Product A',
            productResolutionEvidence: 'persisted_campaign_product_exact',
            revenueConfigFingerprint: 'b'.repeat(64),
          },
          {
            metaCampaignId: 'meta-manual',
            date: '2026-08-01',
            spend: 5_000,
            revenue: 10_000,
          },
          {
            metaCampaignId: 'meta-awareness',
            date: '2026-08-01',
            spend: 50,
            revenue: 999,
          },
        ]),
      ),
    };

    const service = new DashboardService(
      economics as any,
      campaignModel as any,
      companyModel as any,
      timeseriesModel as any,
      runModel as any,
      {} as any,
      decisionModel as any,
      cycleModel as any,
      executedActionModel as any,
    );

    const result = await service.getToolImpact('tenant-1');

    const expectedFilter = {
      tenantId: 'tenant-1',
      campaignId: {
        $in: ['agent-launched', 'agent-awareness', 'agent-unknown-objective'],
      },
    };
    expect(decisionModel.find).toHaveBeenCalledWith(expectedFilter);
    expect(cycleModel.find).toHaveBeenCalledWith(expectedFilter);
    expect(executedActionModel.find).toHaveBeenCalledWith(expectedFilter);
    expect(runModel.find).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    expect(timeseriesModel.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      level: 'campaign',
      metaCampaignId: {
        $in: ['meta-agent', 'meta-awareness', 'meta-unknown-objective'],
      },
    });

    expect(result.scope.requested).toBe('agent');
    expect(result.scope.cohortRule).toBe(
      "actor=agent from persisted source='agent'; impact metrics require a verified Meta launch",
    );
    expect(result.methodology.verifiedLaunchRule).toBe(
      "tool ownership is recorded in persisted source='agent' or source='human' AND metaCampaignId is non-empty AND launchedAt is valid",
    );
    expect(result.methodology.warnings.join(' ')).not.toContain(
      'included as AI-owned',
    );
    expect(result.methodology.warnings.join(' ')).not.toContain(
      'name-inferred evidence',
    );
    expect(result.cohort).toMatchObject({
      created: 5,
      launched: 3,
      withSpend: 2,
      mature: 2,
    });
    expect(result.cohort.campaigns.map((campaign) => campaign.id)).toEqual([
      'agent-launched',
      'agent-not-launched',
      'agent-invalid-launch-date',
      'agent-awareness',
      'agent-unknown-objective',
    ]);
    expect(result.cohort.campaigns[2]).toMatchObject({
      launchedAt: null,
      toolImpactStage: 'created_unverified',
    });
    expect(result.launched.campaigns.map((campaign) => campaign.id)).toEqual([
      'agent-launched',
      'agent-awareness',
      'agent-unknown-objective',
    ]);
    expect(result.launched.rawOutcome).toMatchObject({
      spend: 100,
      attributedReturn: 120,
      weightedRoas: 1.2,
      returnSurplus: 20,
      metOneXActionValueThreshold: true,
    });
    expect(result.launched.matureRawOutcome).toMatchObject({
      spend: 100,
      weightedRoas: 1.2,
      returnSurplus: 20,
    });
    expect(result.automation.pipelineRuns).toEqual({
      total: 2,
      completed: 1,
      failed: 1,
      inProgress: 0,
      completionRatePct: 50,
      failureRatePct: 50,
    });
    expect(result.automation.timeToApprovalReady.sampleSize).toBe(1);
    expect(result.launched.campaigns[0]).toMatchObject({
      returnSurplus: 20,
      isRawRoasProfitable: true,
      rawRoasVerdict: 'returned_more_than_spend',
      facets: { product: 'Product A' },
    });
    expect(result.dailyPerformance).toMatchObject({
      source: 'metric_timeseries_campaign_daily',
      cohort: 'verified_sales_launches',
      coverage: {
        status: 'complete',
        eligibleCampaigns: 1,
        campaignsWithRows: 1,
        campaignsWithoutRows: 0,
        observedDates: 2,
        campaignDateRows: 2,
        observedSpend: 100,
        lifetimeSpend: 100,
        spendCoveragePct: 100,
        observedPersistedAttributedReturn: 120,
        lifetimeAttributedReturn: 120,
      },
      returnCoverage: {
        status: 'partial',
        trustedRows: 1,
        untrustedRows: 1,
        campaignsWithTrustedRows: 1,
        legacyRowsExcludedFromReturn: 1,
        returnBasis: 'mixed',
        returnNature: 'mixed',
        byBasis: [
          {
            basis: 'configured_conversion_value',
            rowCount: 1,
            persistedAttributedReturn: 80,
          },
          {
            basis: 'unknown',
            rowCount: 1,
            persistedAttributedReturn: 40,
          },
        ],
      },
      series: [
        {
          date: '2026-08-01',
          spend: 60,
          attributedReturn: 80,
          knownAttributedReturn: 80,
          persistedAttributedReturn: 80,
          weightedRoas: 1.333333,
          campaignsReporting: 1,
          trustedReturnCampaigns: 1,
          returnCoverage: 'complete',
          returnBasis: 'configured_conversion_value',
          returnNature: 'configured_conversion_estimate',
        },
        {
          date: '2026-08-02',
          spend: 40,
          attributedReturn: null,
          knownAttributedReturn: 0,
          persistedAttributedReturn: 40,
          weightedRoas: null,
          campaignsReporting: 1,
          trustedReturnCampaigns: 0,
          returnCoverage: 'none',
          returnBasis: 'unknown',
          returnNature: 'unknown',
        },
      ],
    });
    expect(
      result.dailyPerformance.byCampaign.map((campaign) => campaign.campaignId),
    ).toEqual(['agent-launched', 'agent-awareness', 'agent-unknown-objective']);
    expect(result.dailyPerformance.byCampaign[0]).toMatchObject({
      campaignId: 'agent-launched',
      optimizationGoals: ['VALUE'],
      isRevenueObjective: true,
      primaryKpi: {
        key: 'roas',
        target: 1,
        targetDisplay: '1.00x raw return threshold',
        status: 'good',
      },
      resultMetric: {
        key: 'attributedReturn',
        label: 'Attributed value',
        source: 'goal_selected_metric',
        optimizationGoal: 'VALUE',
      },
      coverage: {
        status: 'complete',
        observedDates: 2,
        observedSpend: 100,
        lifetimeSpend: 100,
        spendCoveragePct: 100,
      },
      returnCoverage: {
        status: 'partial',
        trustedRows: 1,
        untrustedRows: 1,
        returnBasis: 'mixed',
        returnNature: 'mixed',
      },
      series: [
        {
          date: '2026-08-01',
          spend: 60,
          attributedReturn: 80,
          rawRoas: 1.333333,
          conversions: 2,
          clicks: 48,
          impressions: 1200,
          reach: 900,
          primaryKpiStatus: 'good',
          objectiveResult: {
            key: 'attributedReturn',
            label: 'Attributed value',
            value: 80,
            source: 'goal_selected_metric',
          },
          returnCoverage: 'complete',
          returnBasis: 'configured_conversion_value',
          returnNature: 'configured_conversion_estimate',
        },
        {
          date: '2026-08-02',
          attributedReturn: null,
          rawRoas: null,
          primaryKpiStatus: 'neutral',
          objectiveResult: {
            key: 'attributedReturn',
            value: null,
          },
          returnCoverage: 'none',
          returnBasis: 'unknown',
          returnNature: 'unknown',
        },
      ],
    });
    expect(result.dailyPerformance.byCampaign[1]).toMatchObject({
      campaignId: 'agent-awareness',
      objectiveKey: 'awareness',
      isRevenueObjective: false,
      optimizationGoals: ['REACH'],
      resultMetric: {
        key: 'reach',
        source: 'goal_selected_metric',
        optimizationGoal: 'REACH',
      },
      returnCoverage: {
        status: 'not_applicable',
        returnBasis: 'not_applicable',
        returnNature: 'not_applicable',
      },
      series: [
        {
          spend: 50,
          attributedReturn: null,
          rawRoas: null,
          impressions: 0,
          reach: 0,
          cpm: 0,
          primaryKpiValue: 0,
          primaryKpiDisplay: '—',
          primaryKpiStatus: 'neutral',
          objectiveResult: {
            key: 'reach',
            value: null,
            source: 'goal_selected_metric',
          },
          returnCoverage: 'not_applicable',
          returnBasis: 'not_applicable',
          returnNature: 'not_applicable',
        },
      ],
    });
    expect(result.dailyPerformance.byCampaign[2]).toMatchObject({
      campaignId: 'agent-unknown-objective',
      objectiveKey: 'unknown',
      objectiveLabel: 'Unknown objective',
      isRevenueObjective: false,
      coverage: {
        status: 'none',
        campaignDateRows: 0,
        observedSpend: 0,
      },
      series: [],
    });
    expect(
      result.dailyPerformance.byCampaign.some(
        (campaign) =>
          campaign.campaignId === 'manual-launched' ||
          campaign.campaignId === 'human-launched',
      ),
    ).toBe(false);

    const managedResult = await service.getToolImpact('tenant-1', 'managed');
    expect(managedResult.scope.cohortRule).toBe(
      "actor=agent/human from persisted source='agent' or source='human'; impact metrics require a verified Meta launch",
    );
    expect(managedResult.scope.cohortRule).not.toContain('legacy');
    expect(
      new Set(
        managedResult.dailyPerformance.byCampaign.map(
          (campaign) => campaign.campaignId,
        ),
      ),
    ).toEqual(
      new Set([
        'agent-launched',
        'human-launched',
        'agent-awareness',
        'agent-unknown-objective',
      ]),
    );
    expect(
      managedResult.dailyPerformance.byCampaign.some(
        (campaign) => campaign.campaignId === 'manual-launched',
      ),
    ).toBe(false);
    const humanDaily = managedResult.dailyPerformance.byCampaign.find(
      (campaign) => campaign.campaignId === 'human-launched',
    );
    expect(humanDaily).toMatchObject({
      returnCoverage: {
        status: 'complete',
        returnBasis: 'meta_action_value',
        returnNature: 'meta_reported_action_value',
      },
      series: [
        {
          returnBasis: 'meta_action_value',
          returnNature: 'meta_reported_action_value',
        },
      ],
    });
    const timeseriesFindCalls = (timeseriesModel.find as jest.Mock).mock.calls;
    const lastTimeseriesFilter = timeseriesFindCalls[
      timeseriesFindCalls.length - 1
    ]?.[0] as any;
    expect(lastTimeseriesFilter).toMatchObject({
      tenantId: 'tenant-1',
      level: 'campaign',
    });
    expect(new Set(lastTimeseriesFilter.metaCampaignId.$in)).toEqual(
      new Set([
        'meta-agent',
        'meta-human',
        'meta-awareness',
        'meta-unknown-objective',
      ]),
    );
  });
});
