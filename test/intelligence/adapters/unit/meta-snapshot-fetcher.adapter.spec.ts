import { MetaSnapshotFetcherAdapter } from '../../../../src/intelligence/adapters/meta-snapshot-fetcher.adapter';
import { SnapshotBuilder } from '../../../../src/intelligence/snapshot/snapshot-builder.service';

// [CONSOLIDATED 2026-07-23] This adapter used to live-fetch Meta directly
// via MetaMetricsService. It now reads campaign-sync.service.ts's persisted
// Campaign doc (the sole Meta fetcher for active campaigns — see the
// data-consolidation plan). These tests mock Mongoose query chains instead
// of a MetaMetricsService client.

function buildFindOneQuery(returnValue: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(returnValue) }) };
}

function buildFindQuery(returnValue: unknown) {
  return {
    select: () => ({
      lean: () => ({ exec: () => Promise.resolve(returnValue) }),
    }),
  };
}

function makeCampaignModel(
  campaignDoc: unknown,
  productResolverDocs: unknown[] = [],
) {
  return {
    findOne: jest.fn().mockReturnValue(buildFindOneQuery(campaignDoc)),
    find: jest.fn().mockReturnValue(buildFindQuery(productResolverDocs)),
  };
}

function makeBriefModel(briefs: unknown[] = []) {
  return {
    find: jest.fn().mockReturnValue(buildFindQuery(briefs)),
  };
}

function makeCompanies(company: unknown) {
  return { findByTenantId: jest.fn().mockResolvedValue(company) };
}

const baseCampaign = {
  _id: 'c',
  tenantId: 'astro',
  metaCampaignId: 'mc1',
  name: 'Kundli Summer',
  productName: 'Kundli Reading',
  status: 'active',
  effectiveStatus: 'ACTIVE',
  objective: 'OUTCOME_SALES',
  metaAccountId: 'act_x',
  spend: 1500,
  impressions: 30000,
  reach: 20000,
  clicks: 600,
  ctr: 2,
  cpc: 2.5,
  cpm: 50,
  frequency: 1.5,
  conversions: 20,
  revenue: 2850, // NET — persisted, refund-haircut already applied at write time
  syncedAt: new Date('2026-07-23T10:00:00Z'),
  launchedAt: new Date('2026-06-01T00:00:00Z'),
  metaAdSets: [
    {
      id: 'as1',
      name: 'India Cold',
      audienceType: 'lookalike',
      status: 'active',
      effectiveStatus: 'ACTIVE',
      optimizationGoal: 'OFFSITE_CONVERSIONS',
      spend: 600,
      impressions: 12000,
      reach: 8000,
      clicks: 240,
      ctr: 2,
      cpc: 2.5,
      cpm: 50,
      frequency: 1.5,
      conversions: 8,
      revenue: 1140, // net
      addToCart: 19,
      initiateCheckout: 12,
      landingPageView: 180,
      ads: [
        {
          id: 'ad1',
          name: 'Hook A',
          hookStyle: 'testimonial',
          format: 'video',
          status: 'active',
          effectiveStatus: 'ACTIVE',
          creativeId: 'creative-1',
          creativeName: 'Kundli testimonial',
          creativeBody: 'Understand your birth chart',
          creativeTitle: 'Your Kundli, explained',
          creativeCta: 'LEARN_MORE',
          creativeLinkUrl: 'https://example.test/kundli',
          creativeVideoId: 'video-1',
          creativeImageHash: 'image-hash-1',
          thumbnailUrl: 'https://example.test/thumb.jpg',
          isDynamicCreative: false,
          spend: 300,
          impressions: 6000,
          reach: 4000,
          clicks: 120,
          ctr: 2,
          cpc: 2.5,
          cpm: 50,
          frequency: 1.2,
          conversions: 4,
          revenue: 570, // net
          addToCart: 9,
          initiateCheckout: 6,
          landingPageView: 90,
          inlineLinkClicks: 105,
          outboundClicks: 92,
          video3s: 2100,
          thruplay: 740,
          qualityRanking: 'ABOVE_AVERAGE',
          engagementRanking: 'AVERAGE',
          conversionRanking: 'AVERAGE',
          videoP25: 3000,
          videoP50: 1500,
          videoP75: 800,
          videoP100: 400,
          last7d: {
            spend: 70,
            impressions: 1200,
            clicks: 31,
            ctr: 2.5833,
            conversions: 2,
            revenue: 285,
            cpa: 35,
          },
        },
      ],
    },
  ],
};

describe('MetaSnapshotFetcherAdapter', () => {
  it('throws when campaign not found', async () => {
    const campaignModel = makeCampaignModel(null);
    const briefModel = makeBriefModel();
    const companies = makeCompanies({ tenantId: 'astro', products: [] });
    const adapter = new MetaSnapshotFetcherAdapter(
      companies as any,
      campaignModel as any,
      briefModel as any,
    );
    await expect(
      adapter.fetch({
        tenantId: 'astro',
        campaignId: 'missing',
        metaCampaignId: 'mc1',
      }),
    ).rejects.toThrow(/campaign not found/);
  });

  it('throws when tenant not found', async () => {
    const campaignModel = makeCampaignModel(baseCampaign);
    const briefModel = makeBriefModel();
    const companies = makeCompanies(null);
    const adapter = new MetaSnapshotFetcherAdapter(
      companies as any,
      campaignModel as any,
      briefModel as any,
    );
    await expect(
      adapter.fetch({
        tenantId: 'astro',
        campaignId: 'c',
        metaCampaignId: 'mc1',
      }),
    ).rejects.toThrow(/tenant not found/);
  });

  it('emits a well-formed RawMetaBundle with campaign + adSet + ad tiers, no Meta calls', async () => {
    const campaignModel = makeCampaignModel(baseCampaign, []); // no briefId on the doc → falls back to first active product
    const briefModel = makeBriefModel();
    const companies = makeCompanies({
      tenantId: 'astro',
      products: [
        {
          name: 'Kundli',
          active: true,
          conversionValue: 999,
          refundRatePercent: 0,
        },
      ],
    });
    const adapter = new MetaSnapshotFetcherAdapter(
      companies as any,
      campaignModel as any,
      briefModel as any,
    );
    const bundle = await adapter.fetch({
      tenantId: 'astro',
      campaignId: 'c',
      metaCampaignId: 'mc1',
    });

    expect(bundle.campaign.id).toBe('mc1');
    expect(bundle.campaign.name).toBe('Kundli Summer');
    expect(bundle.campaign.productName).toBe('Kundli Reading');
    expect(bundle.campaign.account_id).toBe('act_x');
    expect(bundle.campaign.effective_status).toBe('ACTIVE');
    expect(bundle.campaign.insights?.spend).toBe('1500');
    expect(bundle.campaign.insights?.reach).toBe('20000');
    expect(bundle.campaign.insights?.cpm).toBe('50');
    // refundRatePercent=0 → refundFactor=1 → gross === net
    expect(bundle.campaign.insights?.action_values).toEqual([
      { action_type: 'purchase', value: 2850 },
    ]);

    expect(bundle.adSets['as1']).toBeDefined();
    expect(bundle.adSets['as1'].audienceType).toBe('lookalike');
    expect(bundle.adSets['as1'].status).toBe('active');
    expect(bundle.adSets['as1'].effectiveStatus).toBe('ACTIVE');
    expect(bundle.adSets['as1'].optimizationGoal).toBe('OFFSITE_CONVERSIONS');
    expect(bundle.adSets['as1'].landingPageViews).toBe(180);
    expect(bundle.adSets['as1'].insights?.spend).toBe('600');
    expect(bundle.adSets['as1'].insights?.action_values).toEqual([
      { action_type: 'purchase', value: 1140 },
    ]);

    expect(bundle.ads['ad1']).toBeDefined();
    expect(bundle.ads['ad1'].hookStyle).toBe('testimonial');
    expect(bundle.ads['ad1'].adSetId).toBe('as1');
    expect(bundle.ads['ad1'].status).toBe('active');
    expect(bundle.ads['ad1'].effectiveStatus).toBe('ACTIVE');
    expect(bundle.ads['ad1'].creativeId).toBe('creative-1');
    expect(bundle.ads['ad1'].creativeTitle).toBe('Your Kundli, explained');
    expect(bundle.ads['ad1'].creativeCta).toBe('LEARN_MORE');
    expect(bundle.ads['ad1'].isDynamicCreative).toBe(false);
    expect(bundle.ads['ad1'].landingPageViews).toBe(90);
    expect(bundle.ads['ad1'].inlineLinkClicks).toBe(105);
    expect(bundle.ads['ad1'].outboundClicks).toBe(92);
    expect(bundle.ads['ad1'].video3s).toBe(2100);
    expect(bundle.ads['ad1'].thruplay).toBe(740);
    expect(bundle.ads['ad1'].quality_ranking).toBe('ABOVE_AVERAGE');
    expect(bundle.ads['ad1'].insights?.action_values).toEqual([
      { action_type: 'purchase', value: 570 },
    ]);
    expect(bundle.ads['ad1'].insights?.video_p25_watched_actions).toEqual([
      { value: 3000 },
    ]);
    expect(bundle.ads['ad1'].last7d?.spend).toBe('70');
    expect(bundle.ads['ad1'].last7d?.actions).toEqual([
      { action_type: 'purchase', value: 2 },
    ]);
    expect(bundle.ads['ad1'].last7d?.action_values).toEqual([
      { action_type: 'purchase', value: 285 },
    ]);

    // metaWindowEnd is the real campaign.syncedAt now, not a synthesized "now"
    expect(bundle.metaWindowEnd).toEqual(baseCampaign.syncedAt);
    expect(bundle.metaWindowStart).toEqual(baseCampaign.launchedAt);
    expect(bundle.sourceMetricsSyncedAt).toEqual(baseCampaign.syncedAt);
    expect(bundle.metricScope).toBe('lifetime');
  });

  it('does not synthesize optional creative evidence when persisted fields are absent', async () => {
    const sparseCampaign = {
      ...baseCampaign,
      productName: undefined,
      metaAdSets: [
        {
          id: 'as-sparse',
          name: 'Sparse ad set',
          spend: 0,
          revenue: 0,
          ads: [{ id: 'ad-sparse', name: 'Sparse ad', spend: 0, revenue: 0 }],
        },
      ],
    };
    const adapter = new MetaSnapshotFetcherAdapter(
      makeCompanies({ tenantId: 'astro', products: [] }) as any,
      makeCampaignModel(sparseCampaign, []) as any,
      makeBriefModel() as any,
    );

    const result = await adapter.fetch({
      tenantId: 'astro',
      campaignId: 'c',
      metaCampaignId: 'mc1',
    });
    const ad = result.ads['ad-sparse'];

    expect(result.campaign.productName).toBeUndefined();
    expect(result.adSets['as-sparse'].optimizationGoal).toBeUndefined();
    expect(ad.creativeId).toBeUndefined();
    expect(ad.inlineLinkClicks).toBeUndefined();
    expect(ad.video3s).toBeUndefined();
    expect(ad.last7d).toBeUndefined();
    expect(ad.insights?.video_p25_watched_actions).toBeUndefined();
  });

  it('marks persisted source freshness unknown when syncedAt is absent', async () => {
    const campaignModel = makeCampaignModel(
      { ...baseCampaign, syncedAt: undefined },
      [],
    );
    const adapter = new MetaSnapshotFetcherAdapter(
      makeCompanies({ tenantId: 'astro', products: [] }) as any,
      campaignModel as any,
      makeBriefModel() as any,
    );

    const bundle = await adapter.fetch({
      tenantId: 'astro',
      campaignId: 'c',
      metaCampaignId: 'mc1',
    });

    expect(bundle.sourceMetricsSyncedAt).toBeNull();
    const snapshot = new SnapshotBuilder().build({
      bundle,
      products: [],
      now: new Date('2026-07-23T12:00:00Z'),
    });
    expect(snapshot.freshnessSec).toBe(-1);
  });

  it('reverses the refund haircut so SnapshotBuilder — which applies its own — lands on the right net figure', async () => {
    // Persisted revenue is NET (Phase 0 haircut at write time). The adapter
    // must reverse it to GROSS before handing off, because SnapshotBuilder
    // unconditionally haircuts again from products[0].refundRatePercent.
    const campaignModel = makeCampaignModel(baseCampaign, []);
    const briefModel = makeBriefModel();
    const companies = makeCompanies({
      tenantId: 'astro',
      products: [
        {
          name: 'Kundli',
          active: true,
          conversionValue: 999,
          refundRatePercent: 5,
        },
      ],
    });
    const adapter = new MetaSnapshotFetcherAdapter(
      companies as any,
      campaignModel as any,
      briefModel as any,
    );
    const bundle = await adapter.fetch({
      tenantId: 'astro',
      campaignId: 'c',
      metaCampaignId: 'mc1',
    });

    // net=2850, refundFactor=0.95 → gross = 2850/0.95 = 3000
    const grossValue = Number(
      bundle.campaign.insights?.action_values?.[0].value,
    );
    expect(grossValue).toBeCloseTo(3000, 2);
    // Round-trip check: SnapshotBuilder would then do gross * 0.95 = 2850 = the original net figure.
    expect(grossValue * 0.95).toBeCloseTo(2850, 2);
  });

  it('round-trips inactive Nadi Leaf revenue as net exactly once', async () => {
    const campaign = {
      ...baseCampaign,
      name: 'Nadi Leaf - New Batch_2026-07-20 - TAT',
      productName: '',
    };
    const campaignModel = makeCampaignModel(campaign, [
      {
        metaCampaignId: 'mc1',
        name: campaign.name,
        productName: '',
      },
    ]);
    const briefModel = makeBriefModel();
    const nadiLeaf = {
      name: 'Nadi Leaf Reading',
      active: false,
      conversionValue: 10000,
      contributionMargin: 0.45,
      refundRatePercent: 12,
    };
    const companies = makeCompanies({
      tenantId: 'astro',
      products: [
        { name: 'Nadi Report', active: true, refundRatePercent: 0 },
        nadiLeaf,
      ],
    });
    const adapter = new MetaSnapshotFetcherAdapter(
      companies as any,
      campaignModel as any,
      briefModel as any,
    );

    const bundle = await adapter.fetch({
      tenantId: 'astro',
      campaignId: 'c',
      metaCampaignId: 'mc1',
    });
    const snapshot = new SnapshotBuilder().build({
      bundle,
      products: [nadiLeaf],
      now: baseCampaign.syncedAt,
    });

    // Persisted ₹2,850 is already refund-net. Adapter reverses the 12%
    // haircut only as a transport detail; SnapshotBuilder applies it once,
    // yielding the original ₹2,850 rather than ₹2,508.
    expect(snapshot.metrics.campaignLevel.revenue).toBe(2850);
    expect(snapshot.metrics.campaignLevel.revenue).not.toBe(2508);
  });

  it('uses refundFactor=1 (no discount) when there is no active product', async () => {
    const campaignModel = makeCampaignModel(baseCampaign, []);
    const briefModel = makeBriefModel();
    const companies = makeCompanies({ tenantId: 'astro', products: [] });
    const adapter = new MetaSnapshotFetcherAdapter(
      companies as any,
      campaignModel as any,
      briefModel as any,
    );
    const bundle = await adapter.fetch({
      tenantId: 'astro',
      campaignId: 'c',
      metaCampaignId: 'mc1',
    });
    expect(bundle.campaign.insights?.action_values).toEqual([
      { action_type: 'purchase', value: 2850 },
    ]);
  });

  it('resolves the product via the campaign brief when one is set, not just the first active product', async () => {
    const campaignWithBrief = { ...baseCampaign, briefId: 'brief-1' };
    // buildProductResolver's own campaignModel.find() call (separate from
    // the findOne() that loads the main doc) returns the briefId mapping.
    const campaignModel = makeCampaignModel(campaignWithBrief, [
      { metaCampaignId: 'mc1', briefId: 'brief-1' },
    ]);
    const briefModel = makeBriefModel([
      { briefId: 'brief-1', product: 'Nadi' },
    ]);
    const companies = makeCompanies({
      tenantId: 'astro',
      products: [
        {
          name: 'Kundli',
          active: true,
          conversionValue: 999,
          refundRatePercent: 0,
        },
        {
          name: 'Nadi',
          active: true,
          conversionValue: 1799,
          refundRatePercent: 10,
        },
      ],
    });
    const adapter = new MetaSnapshotFetcherAdapter(
      companies as any,
      campaignModel as any,
      briefModel as any,
    );
    const bundle = await adapter.fetch({
      tenantId: 'astro',
      campaignId: 'c',
      metaCampaignId: 'mc1',
    });
    // Nadi's 10% haircut, not Kundli's 0% — confirms brief-based resolution, not "first active".
    const grossValue = Number(
      bundle.campaign.insights?.action_values?.[0].value,
    );
    expect(grossValue).toBeCloseTo(2850 / 0.9, 2);
  });

  it('keeps configured fallback separate from raw Meta value and carries row provenance', async () => {
    const adSet = {
      ...baseCampaign.metaAdSets[0],
      dateStart: '2026-07-01',
      dateStop: '2026-08-20',
      attributionSpec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
      promotedObject: { custom_conversion_id: 'cc-1' },
      metricsRowObserved: true,
      metricsFetchComplete: true,
      metricsState: 'observed',
      metricsSource: 'meta_insights',
      metricsSourceFingerprint: 'sha256:adset',
      metricsCurrency: 'INR',
      metricsSyncedAt: new Date('2026-08-20T10:00:00Z'),
      revenueBasis: 'configured_conversion_value',
      revenueAttributionSource: 'custom_event',
      revenueAttributionActionTypes: ['BOOKING_SUCCESS'],
      rawMetaActionValueGross: null,
      rawMetaActionValueNet: null,
      configuredRevenueEstimateNet: 1140,
      goalResultInputs: {
        actionCounts: { BOOKING_SUCCESS: 8 },
        actionValuesGross: {},
      },
      inlineLinkClicks: 201,
      thruplay: 81,
      ads: [
        {
          ...baseCampaign.metaAdSets[0].ads[0],
          dateStart: '2026-07-02',
          dateStop: '2026-08-19',
          attributionSpec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
          metricsRowObserved: true,
          metricsFetchComplete: true,
          metricsState: 'observed',
          metricsSource: 'meta_insights',
          metricsSourceFingerprint: 'sha256:ad',
          metricsCurrency: 'INR',
          metricsSyncedAt: new Date('2026-08-20T10:00:00Z'),
          revenueBasis: 'configured_conversion_value',
          revenueAttributionSource: 'custom_event',
          revenueAttributionActionTypes: ['BOOKING_SUCCESS'],
          rawMetaActionValueGross: null,
          rawMetaActionValueNet: null,
          configuredRevenueEstimateNet: 570,
          goalResultInputs: {
            actionCounts: { BOOKING_SUCCESS: 4 },
            actionValuesGross: {},
          },
        },
      ],
    };
    const configuredCampaign = {
      ...baseCampaign,
      metricsRowObserved: true,
      metricsFetchComplete: true,
      metricsState: 'observed',
      metricsSource: 'meta_insights',
      metricsSourceFingerprint: 'sha256:campaign',
      metricsCurrency: 'INR',
      metricsSyncedAt: new Date('2026-08-20T10:00:00Z'),
      metricsDateStart: '2026-07-01',
      metricsDateStop: '2026-08-20',
      revenueBasis: 'configured_conversion_value',
      revenueAttributionSource: 'custom_event',
      revenueAttributionActionTypes: ['BOOKING_SUCCESS'],
      rawMetaActionValueGross: null,
      rawMetaActionValueNet: null,
      configuredRevenueEstimateNet: 2850,
      goalResultInputs: {
        actionCounts: { BOOKING_SUCCESS: 20 },
        actionValuesGross: {},
      },
      metaAdSets: [adSet],
    };
    const adapter = new MetaSnapshotFetcherAdapter(
      makeCompanies({
        tenantId: 'astro',
        products: [
          {
            name: 'Kundli Reading',
            active: true,
            conversionValue: 999,
            refundRatePercent: 10,
          },
        ],
      }) as any,
      makeCampaignModel(configuredCampaign, []) as any,
      makeBriefModel() as any,
    );

    const bundle = await adapter.fetch({
      tenantId: 'astro',
      campaignId: 'c',
      metaCampaignId: 'mc1',
    });
    expect(bundle.campaign.insights?.actions).toEqual([
      { action_type: 'BOOKING_SUCCESS', value: 20 },
    ]);
    expect(bundle.campaign.insights?.action_values).toBeUndefined();
    expect(bundle.campaign.metricProvenance).toMatchObject({
      rowObserved: true,
      fetchComplete: true,
      sourceFingerprint: 'sha256:campaign',
      currency: 'INR',
      revenueBasis: 'configured_conversion_value',
      canonicalRevenueNet: 2850,
      configuredRevenueEstimateNet: 2850,
    });
    expect(
      bundle.campaign.metricProvenance?.rawMetaActionValueGross,
    ).toBeUndefined();
    expect(bundle.adSets.as1).toMatchObject({
      inlineLinkClicks: 201,
      thruplay: 81,
      metricProvenance: {
        dateStart: '2026-07-01',
        dateStop: '2026-08-20',
        attributionSpec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
        sourceFingerprint: 'sha256:adset',
      },
    });

    const snapshot = new SnapshotBuilder().build({
      bundle,
      products: [
        {
          name: 'Kundli Reading',
          conversionValue: 999,
          refundRatePercent: 10,
        },
      ],
      now: new Date('2026-08-20T11:00:00Z'),
    });
    expect(snapshot.metrics.campaignLevel.revenue).toBe(2850);
    expect(snapshot.metrics.campaignLevel.purchases).toBe(20);
    expect(
      snapshot.metrics.campaignLevel.provenance?.rawMetaActionValueGross,
    ).toBeUndefined();
  });
});
