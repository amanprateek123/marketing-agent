import { MetaSnapshotFetcherAdapter } from '../../../../src/intelligence/adapters/meta-snapshot-fetcher.adapter';

const baseFullMetrics = {
  campaign: {
    campaignId: 'meta-cmp-1',
    campaignName: 'Kundli Summer',
    status: 'ACTIVE',
    spend: 1500,
    impressions: 30000,
    clicks: 600,
    conversions: 20,
    ctr: 2,
    cpc: 2.5,
    cpa: 75,
    roas: 2, // → revenue = 2 * 1500 = 3000
    frequency: 1.5,
    dataAsOf: null,
  },
  adSets: [
    {
      adSetId: 'as1',
      adSetName: 'India Cold',
      status: 'ACTIVE',
      spend: 600,
      impressions: 12000,
      clicks: 240,
      conversions: 8,
      ctr: 2,
      cpc: 2.5,
      cpa: 75,
      frequency: 1.5,
      reach: 8000,
      ads: [
        {
          adId: 'ad1',
          adName: 'Hook A',
          adSetId: 'as1',
          status: 'ACTIVE',
          spend: 300,
          impressions: 6000,
          clicks: 120,
          conversions: 4,
          ctr: 2,
          cpc: 2.5,
        },
      ],
    },
  ],
};

function makeMetrics(returnValue = baseFullMetrics) {
  return {
    fetchFullMetrics: jest.fn().mockResolvedValue(returnValue),
  };
}

function makeCompanies(company: unknown) {
  return {
    findByTenantId: jest.fn().mockResolvedValue(company),
  };
}

describe('MetaSnapshotFetcherAdapter', () => {
  it('throws when tenant not found', async () => {
    const adapter = new MetaSnapshotFetcherAdapter(
      makeMetrics() as unknown as import('../../../../src/campaigns/meta-ads/meta-metrics.service').MetaMetricsService,
      makeCompanies(null) as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    await expect(
      adapter.fetch({ tenantId: 'x', campaignId: 'c', metaCampaignId: 'mc' }),
    ).rejects.toThrow(/tenant not found/);
  });

  it('throws when access token missing', async () => {
    const company = { tenantId: 'astro', meta: {}, products: [] };
    const adapter = new MetaSnapshotFetcherAdapter(
      makeMetrics() as unknown as import('../../../../src/campaigns/meta-ads/meta-metrics.service').MetaMetricsService,
      makeCompanies(company) as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    await expect(
      adapter.fetch({ tenantId: 'astro', campaignId: 'c', metaCampaignId: 'mc' }),
    ).rejects.toThrow(/no meta.accessToken/);
  });

  it('passes refundRatePercent=0 to fetchFullMetrics so revenue is GROSS', async () => {
    const metrics = makeMetrics();
    const company = {
      tenantId: 'astro',
      meta: { accessToken: 'tok', accountId: 'act_x' },
      products: [
        {
          name: 'Kundli',
          active: true,
          conversionValue: 999,
          conversionEvent: 'Purchase',
          refundRatePercent: 5,
        },
      ],
    };
    const adapter = new MetaSnapshotFetcherAdapter(
      metrics as unknown as import('../../../../src/campaigns/meta-ads/meta-metrics.service').MetaMetricsService,
      makeCompanies(company) as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    await adapter.fetch({ tenantId: 'astro', campaignId: 'c', metaCampaignId: 'mc1' });
    expect(metrics.fetchFullMetrics).toHaveBeenCalledWith(
      'mc1',
      'tok',
      999,
      'Purchase',
      undefined,
      0, // refundRatePercent = 0 — SnapshotBuilder applies the haircut
    );
  });

  it('emits a well-formed RawMetaBundle with campaign + adSet + ad tiers', async () => {
    const company = {
      tenantId: 'astro',
      meta: { accessToken: 'tok', accountId: 'act_x' },
      products: [{ name: 'Kundli', active: true, conversionValue: 999 }],
    };
    const adapter = new MetaSnapshotFetcherAdapter(
      makeMetrics() as unknown as import('../../../../src/campaigns/meta-ads/meta-metrics.service').MetaMetricsService,
      makeCompanies(company) as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    const bundle = await adapter.fetch({ tenantId: 'astro', campaignId: 'c', metaCampaignId: 'mc1' });

    expect(bundle.campaign.id).toBe('mc1');
    expect(bundle.campaign.name).toBe('Kundli Summer');
    expect(bundle.campaign.account_id).toBe('act_x');
    expect(bundle.campaign.insights?.spend).toBe('1500');
    expect(bundle.campaign.insights?.action_values).toEqual([
      { action_type: 'purchase', value: 3000 }, // roas 2 × spend 1500
    ]);
    expect(bundle.adSets['as1']).toBeDefined();
    expect(bundle.adSets['as1'].insights?.spend).toBe('600');
    // adset revenue = conversions × conversionValue = 8 × 999 = 7992
    expect(bundle.adSets['as1'].insights?.action_values).toEqual([
      { action_type: 'purchase', value: 7992 },
    ]);
    expect(bundle.ads['ad1']).toBeDefined();
    // ad revenue = 4 × 999 = 3996
    expect(bundle.ads['ad1'].insights?.action_values).toEqual([
      { action_type: 'purchase', value: 3996 },
    ]);
    expect(bundle.metaWindowEnd.getTime()).toBeGreaterThan(bundle.metaWindowStart.getTime());
  });

  it('handles tenant with no products (conversionValue defaults to 0)', async () => {
    const metrics = makeMetrics();
    const company = {
      tenantId: 'astro',
      meta: { accessToken: 'tok', accountId: 'act_x' },
      products: [],
    };
    const adapter = new MetaSnapshotFetcherAdapter(
      metrics as unknown as import('../../../../src/campaigns/meta-ads/meta-metrics.service').MetaMetricsService,
      makeCompanies(company) as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    await adapter.fetch({ tenantId: 'astro', campaignId: 'c', metaCampaignId: 'mc1' });
    expect(metrics.fetchFullMetrics).toHaveBeenCalledWith('mc1', 'tok', 0, undefined, undefined, 0);
  });

  it('picks the first active product when multiple exist', async () => {
    const metrics = makeMetrics();
    const company = {
      tenantId: 'astro',
      meta: { accessToken: 'tok', accountId: 'act_x' },
      products: [
        { name: 'Old', active: false, conversionValue: 111 },
        { name: 'Kundli', active: true, conversionValue: 999, conversionEvent: 'Purchase' },
        { name: 'Nadi', active: true, conversionValue: 3999, conversionEvent: 'Lead' },
      ],
    };
    const adapter = new MetaSnapshotFetcherAdapter(
      metrics as unknown as import('../../../../src/campaigns/meta-ads/meta-metrics.service').MetaMetricsService,
      makeCompanies(company) as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    await adapter.fetch({ tenantId: 'astro', campaignId: 'c', metaCampaignId: 'mc' });
    expect(metrics.fetchFullMetrics).toHaveBeenCalledWith('mc', 'tok', 999, 'Purchase', undefined, 0);
  });

  it('propagates fetchFullMetrics rejection', async () => {
    const metrics = { fetchFullMetrics: jest.fn().mockRejectedValue(new Error('meta_5xx')) };
    const company = {
      meta: { accessToken: 'tok', accountId: 'act_x' },
      products: [{ name: 'Kundli', active: true, conversionValue: 999 }],
    };
    const adapter = new MetaSnapshotFetcherAdapter(
      metrics as unknown as import('../../../../src/campaigns/meta-ads/meta-metrics.service').MetaMetricsService,
      makeCompanies(company) as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    await expect(
      adapter.fetch({ tenantId: 'astro', campaignId: 'c', metaCampaignId: 'mc' }),
    ).rejects.toThrow(/meta_5xx/);
  });
});
