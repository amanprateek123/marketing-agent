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
      ads: [
        {
          id: 'ad1',
          name: 'Hook A',
          hookStyle: 'testimonial',
          format: 'video',
          status: 'active',
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
          qualityRanking: 'ABOVE_AVERAGE',
          engagementRanking: 'AVERAGE',
          conversionRanking: 'AVERAGE',
          videoP25: 3000,
          videoP50: 1500,
          videoP75: 800,
          videoP100: 400,
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
    expect(bundle.adSets['as1'].insights?.spend).toBe('600');
    expect(bundle.adSets['as1'].insights?.action_values).toEqual([
      { action_type: 'purchase', value: 1140 },
    ]);

    expect(bundle.ads['ad1']).toBeDefined();
    expect(bundle.ads['ad1'].hookStyle).toBe('testimonial');
    expect(bundle.ads['ad1'].quality_ranking).toBe('ABOVE_AVERAGE');
    expect(bundle.ads['ad1'].insights?.action_values).toEqual([
      { action_type: 'purchase', value: 570 },
    ]);
    expect(bundle.ads['ad1'].insights?.video_p25_watched_actions).toEqual([
      { value: 3000 },
    ]);

    // metaWindowEnd is the real campaign.syncedAt now, not a synthesized "now"
    expect(bundle.metaWindowEnd).toEqual(baseCampaign.syncedAt);
    expect(bundle.metaWindowStart).toEqual(baseCampaign.launchedAt);
    expect(bundle.sourceMetricsSyncedAt).toEqual(baseCampaign.syncedAt);
    expect(bundle.metricScope).toBe('lifetime');
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
});
