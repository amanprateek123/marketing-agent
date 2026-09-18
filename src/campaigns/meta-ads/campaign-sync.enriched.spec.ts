import {
  buildMetricsSourceFingerprint,
  CampaignSyncService,
  collectGoalResultInputs,
  reconcileCampaignTopLineMetrics,
  resolveConfiguredAccountCurrency,
} from './campaign-sync.service';

type TopLineMetrics = Parameters<typeof reconcileCampaignTopLineMetrics>[0];

function topLine(overrides: Partial<TopLineMetrics> = {}): TopLineMetrics {
  return {
    spend: 500,
    impressions: 1000,
    clicks: 100,
    reach: 800,
    conversions: 0,
    roas: 0,
    ctr: 10,
    cpc: 5,
    cpm: 500,
    frequency: 1.25,
    revenue: 0,
    revenueBasis: 'no_attributed_revenue',
    revenueAttributionSource: 'standard_event',
    revenueAttributionActionTypes: [
      'purchase',
      'offsite_conversion.fb_pixel_purchase',
    ],
    dataAsOf: '2026-08-20',
    ...overrides,
  };
}

function queryReturning<T>(value: T) {
  const query: any = {};
  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn().mockResolvedValue(value);
  return query;
}

function setup(options?: {
  resolverDocs?: any[];
  existingByMetaId?: Record<string, any>;
  briefs?: any[];
}) {
  const resolverDocs = options?.resolverDocs ?? [];
  const existingByMetaId = options?.existingByMetaId ?? {};
  const campaignModel = {
    find: jest.fn(() => queryReturning(resolverDocs)),
    findOne: jest.fn((filter: any) =>
      queryReturning(existingByMetaId[filter.metaCampaignId] ?? null),
    ),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    create: jest.fn().mockImplementation(async (value) => value),
  };
  const briefModel = {
    find: jest.fn(() => queryReturning(options?.briefs ?? [])),
  };
  return {
    campaignModel,
    service: new CampaignSyncService(campaignModel as any, briefModel as any),
  };
}

function enrichedCampaign(
  id: string,
  detectedProduct: string,
  values: {
    spend?: number;
    conversions?: number;
    actionValue?: number;
    dateStop?: string;
  } = {},
) {
  const conversions = values.conversions ?? 1;
  return {
    id,
    name: id,
    detectedProduct,
    status: 'PAUSED',
    objective: 'OUTCOME_SALES',
    adSets: [],
    adSetInsights: [],
    adInsights: [],
    ads: [],
    insights: {
      spend: String(values.spend ?? 500),
      impressions: '1000',
      clicks: '100',
      actions:
        conversions > 0
          ? [{ action_type: 'purchase', value: String(conversions) }]
          : [],
      action_values:
        values.actionValue != null
          ? [{ action_type: 'purchase', value: String(values.actionValue) }]
          : undefined,
      date_stop: values.dateStop,
    },
  };
}

describe('campaign-sync goal evidence helpers', () => {
  it('resolves normalized and legacy-bare account currency keys without guessing', () => {
    expect(
      resolveConfiguredAccountCurrency(
        { act_123: 'inr', '456': 'usd' },
        'act_123',
      ),
    ).toBe('INR');
    expect(
      resolveConfiguredAccountCurrency(
        { act_123: 'inr', '456': 'usd' },
        'act_456',
      ),
    ).toBe('USD');
    expect(
      resolveConfiguredAccountCurrency({ act_123: 'invalid' }, 'act_123'),
    ).toBeUndefined();
  });

  it('retains exact action aliases and gross values without relabeling them', () => {
    expect(
      collectGoalResultInputs(
        [
          { action_type: 'lead', value: '2' },
          { action_type: 'lead', value: '1' },
          { action_type: 'mobile_app_install', value: '7' },
        ],
        [{ action_type: 'offsite_conversion.custom.sale', value: '1499.5' }],
      ),
    ).toEqual({
      actionCounts: { lead: 3, mobile_app_install: 7 },
      actionValuesGross: {
        'offsite_conversion.custom.sale': 1499.5,
      },
    });
  });

  it('fingerprints query provenance deterministically and changes on window or attribution drift', () => {
    const base = {
      source: 'meta_insights',
      apiVersion: 'v21.0',
      accountId: 'act_123',
      level: 'adset' as const,
      datePreset: 'maximum',
      useUnifiedAttributionSetting: true,
      dateStart: '2026-07-01',
      dateStop: '2026-08-20',
      attributionSpec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
      revenueAttributionActionTypes: ['purchase', 'omni_purchase'],
    };
    const reordered = {
      ...base,
      revenueAttributionActionTypes: ['omni_purchase', 'purchase'],
    };
    expect(buildMetricsSourceFingerprint(base)).toBe(
      buildMetricsSourceFingerprint(reordered),
    );
    expect(buildMetricsSourceFingerprint(base)).not.toBe(
      buildMetricsSourceFingerprint({ ...base, dateStop: '2026-08-21' }),
    );
  });

  it('builds ad-set and ad rows with exact goal inputs, windows, and distinct revenue bases', () => {
    const { service } = setup();
    const rows = (service as any).buildMetaAdSets(
      {
        adSets: [
          {
            id: 'as-1',
            name: 'Sales set',
            status: 'ACTIVE',
            optimization_goal: 'OFFSITE_CONVERSIONS',
            attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
            promoted_object: { custom_conversion_id: 'cc-1' },
          },
        ],
        adSetInsights: [
          {
            adset_id: 'as-1',
            adset_name: 'Sales set',
            spend: '500',
            impressions: '10000',
            clicks: '200',
            inline_link_clicks: '160',
            actions: [{ action_type: 'purchase', value: '4' }],
            action_values: [{ action_type: 'purchase', value: '1200' }],
            video_thruplay_watched_actions: [{ value: '90' }],
            date_start: '2026-07-01',
            date_stop: '2026-08-20',
          },
        ],
        adInsights: [
          {
            adset_id: 'as-1',
            ad_id: 'ad-1',
            ad_name: 'Lead proof',
            spend: '100',
            impressions: '2000',
            clicks: '40',
            inline_link_clicks: '31',
            actions: [{ action_type: 'purchase', value: '2' }],
            video_thruplay_watched_actions: [{ value: '20' }],
            date_start: '2026-07-02',
            date_stop: '2026-08-19',
          },
        ],
        ads: [{ name: 'Lead proof', status: 'ACTIVE', creative: {} }],
      },
      new Set(['purchase']),
      {
        revenueAttributionSource: 'standard_event',
        refundFactor: 0.9,
        effectiveConversionValue: 250,
        metricsSyncedAt: new Date('2026-08-20T10:00:00Z'),
        accountId: 'act_123',
        currency: 'INR',
      },
    );

    expect(rows[0]).toMatchObject({
      optimizationGoal: 'OFFSITE_CONVERSIONS',
      inlineLinkClicks: 160,
      thruplay: 90,
      dateStart: '2026-07-01',
      dateStop: '2026-08-20',
      metricsRowObserved: true,
      metricsSource: 'meta_enriched_import',
      metricsCurrency: 'INR',
      revenueBasis: 'meta_action_value',
      rawMetaActionValueGross: 1200,
      rawMetaActionValueNet: 1080,
      configuredRevenueEstimateNet: null,
      attributionSpec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
      promotedObject: { custom_conversion_id: 'cc-1' },
      goalResultInputs: {
        actionCounts: { purchase: 4 },
        actionValuesGross: { purchase: 1200 },
      },
    });
    expect(rows[0].ads[0]).toMatchObject({
      inlineLinkClicks: 31,
      thruplay: 20,
      dateStart: '2026-07-02',
      dateStop: '2026-08-19',
      revenueBasis: 'configured_conversion_value',
      rawMetaActionValueGross: null,
      configuredRevenueEstimateNet: 500,
      metricsRowObserved: true,
      metricsCurrency: 'INR',
    });
  });
});

describe('CampaignSyncService.syncFromEnrichedData revenue', () => {
  const conversionTypes = new Set(['purchase']);

  it('uses the enriched campaign account currency as observed provenance', async () => {
    const { campaignModel, service } = setup();
    const campaign = {
      ...enrichedCampaign('currency-campaign', 'Reading'),
      account_id: '123',
      account_currency: 'inr',
    };

    await service.syncFromEnrichedData(
      'tenant-1',
      [campaign],
      conversionTypes,
      [{ name: 'Reading', active: true, conversionEvent: 'Purchase' }],
    );

    expect(campaignModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metaCampaignId: 'currency-campaign',
        metricsCurrency: 'INR',
      }),
    );
  });

  it('applies each detected product refund factor to fresh Meta action value', async () => {
    const { campaignModel, service } = setup();
    const products = [
      {
        name: 'Refundable',
        active: true,
        conversionEvent: 'Purchase',
        refundRatePercent: 30,
      },
      {
        name: 'No refunds',
        active: false,
        conversionEvent: 'Purchase',
        refundRatePercent: 0,
      },
    ];

    await service.syncFromEnrichedData(
      'tenant-1',
      [
        enrichedCampaign('campaign-a', 'Refundable', {
          spend: 500,
          actionValue: 1000,
          dateStop: '2026-08-20',
        }),
        enrichedCampaign('campaign-b', 'No refunds', {
          spend: 500,
          actionValue: 1000,
        }),
      ],
      conversionTypes,
      products,
    );

    const created = campaignModel.create.mock.calls.map(([value]) => value);
    const refundable = created.find(
      (campaign) => campaign.metaCampaignId === 'campaign-a',
    );
    const noRefunds = created.find(
      (campaign) => campaign.metaCampaignId === 'campaign-b',
    );
    expect(refundable).toMatchObject({
      productName: 'Refundable',
      revenue: 700,
      roas: 1.4,
      revenueBasis: 'meta_action_value',
      dataAsOf: new Date('2026-08-20'),
    });
    expect(noRefunds).toMatchObject({
      productName: 'No refunds',
      revenue: 1000,
      roas: 2,
      revenueBasis: 'meta_action_value',
    });
  });

  it('falls back to configured effective conversion value without a second refund haircut', async () => {
    const { campaignModel, service } = setup();

    await service.syncFromEnrichedData(
      'tenant-1',
      [
        enrichedCampaign('fallback', 'Reading', {
          spend: 800,
          conversions: 2,
        }),
      ],
      conversionTypes,
      [
        {
          name: 'Reading',
          active: true,
          conversionEvent: 'Purchase',
          conversionValue: 1000,
          refundRatePercent: 20,
        },
      ],
    );

    expect(campaignModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        revenue: 1600,
        roas: 2,
        revenueBasis: 'configured_conversion_value',
      }),
    );
  });

  it('does not count or price another product conversion in the same Meta row', async () => {
    const { campaignModel, service } = setup();
    const campaign = enrichedCampaign('mixed-actions', 'Product A', {
      spend: 500,
      conversions: 0,
    });
    campaign.insights.actions = [
      {
        action_type: 'offsite_conversion.custom.product-a',
        value: '2',
      },
      {
        action_type: 'offsite_conversion.custom.product-b',
        value: '9',
      },
    ];

    await service.syncFromEnrichedData(
      'tenant-1',
      [campaign],
      new Set([
        'offsite_conversion.custom.product-a',
        'offsite_conversion.custom.product-b',
      ]),
      [
        {
          name: 'Product A',
          active: true,
          customConversionId: 'product-a',
          conversionValue: 100,
        },
        {
          name: 'Product B',
          customConversionId: 'product-b',
          conversionValue: 1000,
        },
      ],
    );

    expect(campaignModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        conversions: 2,
        revenue: 200,
        roas: 0.4,
        revenueBasis: 'configured_conversion_value',
        revenueAttributionSource: 'custom_conversion',
        revenueAttributionActionTypes: ['offsite_conversion.custom.product-a'],
      }),
    );
  });

  it('preserves existing observed Meta revenue rather than downgrading it to a model', async () => {
    const existing = {
      _id: 'internal-id',
      metaCampaignId: 'existing-observed',
      productName: 'Reading',
      revenue: 2500,
      roas: 2.5,
      revenueBasis: 'meta_action_value',
      dataAsOf: '2026-08-10',
    };
    const { campaignModel, service } = setup({
      resolverDocs: [existing],
      existingByMetaId: { 'existing-observed': existing },
    });

    await service.syncFromEnrichedData(
      'tenant-1',
      [
        enrichedCampaign('existing-observed', 'Reading', {
          spend: 1200,
          conversions: 2,
        }),
      ],
      conversionTypes,
      [
        {
          name: 'Reading',
          active: true,
          conversionEvent: 'Purchase',
          conversionValue: 1000,
          refundRatePercent: 20,
        },
      ],
    );

    const set = campaignModel.updateOne.mock.calls[0][1].$set;
    expect(set).not.toHaveProperty('revenue');
    expect(set).not.toHaveProperty('revenueBasis');
    expect(set.roas).toBeCloseTo(2500 / 1200);
    expect(set).not.toHaveProperty('dataAsOf');
  });

  it('preserves existing unresolved revenue fields when no fallback is possible', async () => {
    const existing = {
      _id: 'internal-id',
      metaCampaignId: 'legacy',
      productName: 'Unknown value',
      revenue: 400,
      roas: 0.8,
      revenueBasis: 'unknown',
      dataAsOf: '2026-08-10',
    };
    const { campaignModel, service } = setup({
      resolverDocs: [existing],
      existingByMetaId: { legacy: existing },
    });

    await service.syncFromEnrichedData(
      'tenant-1',
      [
        enrichedCampaign('legacy', 'Unknown value', {
          conversions: 0,
          dateStop: 'not-a-date',
        }),
      ],
      conversionTypes,
      [{ name: 'Unknown value', active: true, conversionValue: 0, price: 0 }],
    );

    const set = campaignModel.updateOne.mock.calls[0][1].$set;
    expect(set).toMatchObject({
      revenue: 400,
      revenueBasis: 'unknown',
      revenueAttributionSource: 'unresolved',
      revenueAttributionActionTypes: [],
      roas: 0.8,
    });
    expect(set).not.toHaveProperty('dataAsOf');
  });

  it('preserves a prior positive value but downgrades provenance when product resolution becomes ambiguous', async () => {
    const existing = {
      _id: 'internal-id',
      metaCampaignId: 'ambiguous-legacy',
      name: 'Generic Legacy Campaign',
      productName: '',
      revenue: 2500,
      roas: 2.5,
      revenueBasis: 'meta_action_value',
      revenueAttributionSource: 'custom_conversion',
      revenueAttributionActionTypes: ['offsite_conversion.custom.old-id'],
    };
    const { campaignModel, service } = setup({
      resolverDocs: [existing],
      existingByMetaId: { 'ambiguous-legacy': existing },
    });
    const campaign = enrichedCampaign('ambiguous-legacy', 'unknown', {
      spend: 1200,
      conversions: 0,
    });
    campaign.insights.actions = [
      { action_type: 'offsite_conversion.custom.wish', value: '3' },
      { action_type: 'offsite_conversion.custom.nadi', value: '4' },
    ];

    await service.syncFromEnrichedData(
      'tenant-1',
      [campaign],
      new Set([
        'offsite_conversion.custom.wish',
        'offsite_conversion.custom.nadi',
      ]),
      [
        {
          name: 'Wish Letter',
          active: true,
          customConversionId: 'wish',
          conversionValue: 100,
        },
        {
          name: 'Nadi Report',
          active: true,
          customConversionId: 'nadi',
          conversionValue: 1000,
        },
      ],
    );

    expect(campaignModel.updateOne.mock.calls[0][1].$set).toMatchObject({
      conversions: 0,
      revenue: 2500,
      revenueBasis: 'unknown',
      revenueAttributionSource: 'unresolved',
      revenueAttributionActionTypes: ['offsite_conversion.custom.old-id'],
    });
    expect(campaignModel.updateOne.mock.calls[0][1].$set.roas).toBeCloseTo(
      2500 / 1200,
    );
  });

  it('writes an explicit no-attributed-revenue zero only for a new unresolved campaign', async () => {
    const { campaignModel, service } = setup();

    await service.syncFromEnrichedData(
      'tenant-1',
      [enrichedCampaign('new-unresolved', 'unknown', { conversions: 0 })],
      conversionTypes,
      [],
    );

    expect(campaignModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        revenue: 0,
        roas: 0,
        revenueBasis: 'no_attributed_revenue',
      }),
    );
  });
});

describe('reconcileCampaignTopLineMetrics', () => {
  it('preserves only prior return evidence for a present row and recomputes ROAS', () => {
    const result = reconcileCampaignTopLineMetrics(
      topLine({ spend: 1200, impressions: 3000 }),
      topLine({
        spend: 1000,
        impressions: 2000,
        revenue: 2500,
        revenueBasis: 'meta_action_value',
        roas: 2.5,
      }),
      true,
    );

    expect(result).toMatchObject({
      spend: 1200,
      impressions: 3000,
      revenue: 2500,
      revenueBasis: 'meta_action_value',
    });
    expect(result.roas).toBeCloseTo(2500 / 1200);
  });

  it('preserves every prior top-line metric when a partial response omits the campaign', () => {
    const previous = topLine({
      spend: 900,
      impressions: 4200,
      clicks: 210,
      conversions: 3,
      revenue: 1800,
      revenueBasis: 'unknown',
      roas: 2,
      dataAsOf: '2026-08-19',
    });

    expect(reconcileCampaignTopLineMetrics(topLine(), previous, false)).toEqual(
      previous,
    );
  });

  it('keeps a genuine zero for new and prior-zero campaigns', () => {
    const fresh = topLine({ spend: 300 });

    expect(reconcileCampaignTopLineMetrics(fresh, undefined, true)).toEqual(
      fresh,
    );
    expect(
      reconcileCampaignTopLineMetrics(
        fresh,
        topLine({ revenue: 0, revenueBasis: 'unknown' }),
        true,
      ),
    ).toEqual(fresh);
  });

  it('keeps prior value but marks it unknown when current attribution is unresolved', () => {
    const result = reconcileCampaignTopLineMetrics(
      topLine({
        spend: 1200,
        revenueAttributionSource: 'unresolved',
        revenueAttributionActionTypes: [],
      }),
      topLine({
        revenue: 2500,
        roas: 2.5,
        revenueBasis: 'meta_action_value',
        revenueAttributionSource: 'custom_conversion',
        revenueAttributionActionTypes: ['offsite_conversion.custom.old-id'],
      }),
      true,
    );

    expect(result).toMatchObject({
      revenue: 2500,
      revenueBasis: 'unknown',
      revenueAttributionSource: 'unresolved',
      revenueAttributionActionTypes: ['offsite_conversion.custom.old-id'],
    });
    expect(result.roas).toBeCloseTo(2500 / 1200);
  });
});

describe('CampaignSyncService reconciliation safety', () => {
  const company = {
    tenantId: 'tenant-1',
    meta: { accessToken: 'token', accountId: '123' },
    products: [],
  } as any;

  it('skips the account when the ACTIVE campaign listing is incomplete', async () => {
    const campaignModel = {
      find: jest.fn(),
      updateOne: jest.fn(),
      updateMany: jest.fn(),
    };
    const service = new CampaignSyncService(campaignModel as any, {} as any);
    jest.spyOn(service as any, 'fetchAllPages').mockResolvedValue({
      data: { data: [{ id: 'only-partial-row', status: 'ACTIVE' }] },
      complete: false,
    });
    const chunked = jest.spyOn(service as any, 'fetchAllPagesChunked');

    await expect(service.syncActiveCampaigns(company)).resolves.toEqual({
      synced: 0,
    });
    expect(campaignModel.find).not.toHaveBeenCalled();
    expect(chunked).not.toHaveBeenCalled();
    expect(campaignModel.updateMany).not.toHaveBeenCalled();
  });

  it('does not mark omitted stale IDs completed when reconciliation is incomplete', async () => {
    const campaignModel = {
      find: jest.fn(() =>
        queryReturning([
          { metaCampaignId: 'stale-campaign', metaAccountId: 'act_123' },
        ]),
      ),
      updateOne: jest.fn(),
      updateMany: jest.fn(),
    };
    const service = new CampaignSyncService(campaignModel as any, {} as any);
    jest.spyOn(service as any, 'fetchAllPages').mockResolvedValue({
      data: { data: [] },
      complete: true,
    });
    jest.spyOn(service as any, 'fetchAllPagesChunked').mockResolvedValue({
      data: { data: [] },
      complete: false,
    });

    await expect(service.syncActiveCampaigns(company)).resolves.toEqual({
      synced: 0,
    });
    expect(campaignModel.updateMany).not.toHaveBeenCalled();
  });
});

describe('CampaignSyncService recurring per-product attribution', () => {
  it.each([
    {
      label: 'standard Purchase',
      objective: 'OUTCOME_SALES',
      product: { conversionEvent: 'Purchase', conversionValue: 100 },
      actions: [
        { action_type: 'purchase', value: '2' },
        { action_type: 'lead', value: '7' },
      ],
      expectedConversions: 2,
      expectedRevenue: 200,
      expectedSource: 'standard_event',
    },
    {
      label: 'custom event',
      objective: 'OUTCOME_SALES',
      product: {
        conversionEvent: 'CustomEvent',
        customEventName: 'BOOKING_SUCCESS',
        conversionValue: 300,
      },
      actions: [
        { action_type: 'BOOKING_SUCCESS', value: '2' },
        { action_type: 'purchase', value: '7' },
      ],
      expectedConversions: 2,
      expectedRevenue: 600,
      expectedSource: 'custom_event',
    },
    {
      label: 'app Purchase without install inflation',
      objective: 'OUTCOME_APP_PROMOTION',
      product: {
        metaAppId: 'app-id',
        conversionEvent: 'Purchase',
        conversionValue: 500,
      },
      actions: [
        { action_type: 'mobile_app_purchase', value: '2' },
        { action_type: 'mobile_app_install', value: '10' },
        { action_type: 'purchase', value: '7' },
      ],
      expectedConversions: 2,
      expectedRevenue: 1000,
      expectedSource: 'app_event',
    },
  ])(
    'uses only the resolved $label action for configured-value fallback',
    async ({
      objective,
      product,
      actions,
      expectedConversions,
      expectedRevenue,
      expectedSource,
    }) => {
      const existing = {
        _id: 'internal-id',
        metaCampaignId: 'active-campaign',
        metaAccountId: 'act_123',
        productName: 'Resolved Product',
        revenue: 0,
        revenueBasis: 'no_attributed_revenue',
      };
      const campaignModel = {
        find: jest.fn(() => queryReturning([existing])),
        findOne: jest.fn(() => queryReturning(null)),
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        updateMany: jest.fn(),
      };
      const briefModel = { find: jest.fn(() => queryReturning([])) };
      const service = new CampaignSyncService(
        campaignModel as any,
        briefModel as any,
      );
      jest.spyOn(service as any, 'fetchAllPages').mockResolvedValue({
        data: {
          data: [
            {
              id: 'active-campaign',
              name: 'Active campaign',
              status: 'ACTIVE',
              objective,
            },
          ],
        },
        complete: true,
      });
      const chunkedFetch = jest
        .spyOn(service as any, 'fetchAllPagesChunked')
        .mockImplementation(async (...args: any[]) =>
          String(args[4]).startsWith('Campaign insights')
            ? {
                data: {
                  data: [
                    {
                      campaign_id: 'active-campaign',
                      spend: '1000',
                      impressions: '2000',
                      clicks: '100',
                      actions,
                      date_stop: '2026-08-20',
                    },
                  ],
                },
                complete: true,
              }
            : { data: { data: [] }, complete: true },
        );
      const timeout = jest.spyOn(global, 'setTimeout').mockImplementation(((
        callback: () => void,
      ) => {
        callback();
        return 0 as any;
      }) as any);

      try {
        await service.syncActiveCampaigns({
          tenantId: 'tenant-1',
          meta: { accessToken: 'token', accountId: '123' },
          products: [{ name: 'Resolved Product', active: true, ...product }],
        } as any);
      } finally {
        timeout.mockRestore();
      }

      const finalSet = campaignModel.updateOne.mock.calls.at(-1)?.[1].$set;
      expect(finalSet).toMatchObject({
        conversions: expectedConversions,
        revenue: expectedRevenue,
        revenueBasis: 'configured_conversion_value',
        revenueAttributionSource: expectedSource,
      });
      expect(finalSet.roas).toBe(expectedRevenue / 1000);
      const adSetInsightsCall = chunkedFetch.mock.calls.find((args: any[]) =>
        String(args[4]).startsWith('AdSet insights'),
      );
      const adSetInsightsParams = (adSetInsightsCall?.[1] ?? {}) as any;
      expect(adSetInsightsParams.fields).toContain('inline_link_clicks');
      expect(adSetInsightsParams.fields).toContain(
        'video_thruplay_watched_actions',
      );
      expect(adSetInsightsParams.use_unified_attribution_setting).toBe('true');
    },
  );

  it('preserves prior ad-set/ad values but marks omitted insight rows non-observed', async () => {
    const oldMetricsSyncedAt = new Date('2026-08-20T08:00:00Z');
    const existing = {
      _id: 'internal-id',
      tenantId: 'tenant-1',
      metaCampaignId: 'active-campaign',
      metaAccountId: 'act_123',
      productName: 'Resolved Product',
      status: 'active',
      spend: 900,
      revenue: 1000,
      revenueBasis: 'meta_action_value',
      metricsCurrency: 'USD',
      metricsSyncedAt: oldMetricsSyncedAt,
      metaAdSets: [
        {
          id: 'as-1',
          spend: 321,
          revenue: 444,
          metricsCurrency: 'USD',
          dateStart: '2026-07-01',
          dateStop: '2026-08-20',
          metricsSyncedAt: oldMetricsSyncedAt,
          metricsSourceFingerprint: 'sha256:previous-adset',
          ads: [
            {
              id: 'ad-1',
              spend: 123,
              revenue: 222,
              metricsCurrency: 'USD',
              dateStart: '2026-07-02',
              dateStop: '2026-08-19',
              metricsSyncedAt: oldMetricsSyncedAt,
              metricsSourceFingerprint: 'sha256:previous-ad',
              last7d: {
                spend: 40,
                metricsCurrency: 'USD',
                metricsSyncedAt: oldMetricsSyncedAt,
              },
            },
          ],
        },
      ],
    };
    const campaignModel = {
      find: jest.fn(() => queryReturning([existing])),
      findOne: jest.fn(() => queryReturning(null)),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      updateMany: jest.fn(),
    };
    const service = new CampaignSyncService(
      campaignModel as any,
      { find: jest.fn(() => queryReturning([])) } as any,
    );
    jest.spyOn(service as any, 'fetchAllPages').mockResolvedValue({
      data: {
        data: [
          {
            id: 'active-campaign',
            name: 'Active campaign',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            objective: 'OUTCOME_SALES',
          },
        ],
      },
      complete: true,
    });
    jest
      .spyOn(service as any, 'fetchAllPagesChunked')
      .mockImplementation(async (...args: any[]) => {
        const label = String(args[4]);
        if (label.startsWith('Campaign insights')) {
          return {
            data: {
              data: [
                {
                  campaign_id: 'active-campaign',
                  spend: '950',
                  impressions: '10000',
                  clicks: '200',
                  actions: [{ action_type: 'purchase', value: '5' }],
                  action_values: [{ action_type: 'purchase', value: '1100' }],
                  date_start: '2026-07-01',
                  date_stop: '2026-08-21',
                },
              ],
            },
            complete: true,
          };
        }
        if (label.startsWith('AdSets')) {
          return {
            data: {
              data: [
                {
                  id: 'as-1',
                  campaign_id: 'active-campaign',
                  name: 'Sales set',
                  status: 'ACTIVE',
                  effective_status: 'ACTIVE',
                  optimization_goal: 'OFFSITE_CONVERSIONS',
                  attribution_spec: [
                    { event_type: 'CLICK_THROUGH', window_days: 7 },
                  ],
                },
              ],
            },
            complete: true,
          };
        }
        if (label.startsWith('Ads ')) {
          return {
            data: {
              data: [
                {
                  id: 'ad-1',
                  adset_id: 'as-1',
                  name: 'Proof ad',
                  status: 'ACTIVE',
                  effective_status: 'ACTIVE',
                  creative: {},
                },
              ],
            },
            complete: true,
          };
        }
        return { data: { data: [] }, complete: false };
      });
    const timeout = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: () => void,
    ) => {
      callback();
      return 0 as any;
    }) as any);

    try {
      await service.syncActiveCampaigns({
        tenantId: 'tenant-1',
        meta: {
          accessToken: 'token',
          accountId: '123',
          accountCurrencies: { act_123: 'inr' },
        },
        products: [
          {
            name: 'Resolved Product',
            active: true,
            conversionEvent: 'Purchase',
            conversionValue: 100,
            refundRatePercent: 0,
          },
        ],
      } as any);
    } finally {
      timeout.mockRestore();
    }

    const finalSet = campaignModel.updateOne.mock.calls.at(-1)?.[1].$set;
    expect(finalSet.metricsCurrency).toBe('INR');
    const adSet = finalSet.metaAdSets[0];
    expect(adSet).toMatchObject({
      spend: 321,
      revenue: 444,
      dateStart: '2026-07-01',
      dateStop: '2026-08-20',
      metricsRowObserved: false,
      metricsFetchComplete: false,
      metricsState: 'preserved',
      metricsSyncedAt: oldMetricsSyncedAt,
      metricsSourceFingerprint: 'sha256:previous-adset',
      metricsCurrency: 'INR',
    });
    expect(adSet.ads[0]).toMatchObject({
      spend: 123,
      revenue: 222,
      dateStart: '2026-07-02',
      dateStop: '2026-08-19',
      metricsRowObserved: false,
      metricsFetchComplete: false,
      metricsState: 'preserved',
      metricsSyncedAt: oldMetricsSyncedAt,
      metricsSourceFingerprint: 'sha256:previous-ad',
      metricsCurrency: 'INR',
      last7d: {
        spend: 40,
        metricsCurrency: 'INR',
        metricsSyncedAt: oldMetricsSyncedAt,
      },
    });
  });
});
