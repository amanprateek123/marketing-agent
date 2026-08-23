import { TenantCampaignsAdapter } from '../../../../src/intelligence/adapters/tenant-campaigns.adapter';

function buildQuery(returnValue: unknown) {
  const query = {
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(returnValue),
  };
  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
}

function makeCampaignModel(campaigns: unknown[]) {
  return {
    find: jest.fn().mockReturnValue(buildQuery(campaigns)),
  };
}

function makeCompaniesService(company: unknown) {
  return {
    findByTenantId: jest.fn().mockResolvedValue(company),
  };
}

function makeBriefModel(briefs: unknown[] = []) {
  return {
    find: jest.fn().mockReturnValue(buildQuery(briefs)),
  };
}

const activeCampaign = (
  id: string,
  meta = `meta-${id}`,
  source: 'agent' | 'human' | 'manual' = 'agent',
) => ({
  _id: id,
  tenantId: 'astro',
  metaCampaignId: meta,
  status: 'active',
  source,
});

describe('TenantCampaignsAdapter', () => {
  it('returns campaigns with reduced product info', async () => {
    const campaignModel = makeCampaignModel([
      activeCampaign('c1'),
      activeCampaign('c2', 'meta-c2', 'human'),
    ]);
    const companies = makeCompaniesService({
      tenantId: 'astro',
      products: [
        {
          name: 'Kundli',
          active: true,
          conversionValue: 999,
          contributionMargin: 40,
          refundRatePercent: 5,
          conversionEvent: 'Purchase',
        },
        {
          name: 'Nadi',
          active: false,
          conversionValue: 3999,
        },
      ],
    });
    const adapter = new TenantCampaignsAdapter(
      campaignModel as unknown as import('mongoose').Model<any>,
      makeBriefModel() as unknown as import('mongoose').Model<any>,
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );

    const targets = await adapter.listActiveCampaigns('astro');

    expect(campaignModel.find).toHaveBeenCalledWith({
      tenantId: 'astro',
      status: 'active',
      metaCampaignId: { $ne: '' },
      source: { $in: ['agent', 'human'] },
    });
    expect(companies.findByTenantId).toHaveBeenCalledWith('astro');
    expect(targets).toHaveLength(2);
    expect(targets[0]).toEqual({
      campaignId: 'c1',
      metaCampaignId: 'meta-c1',
      products: [
        {
          name: 'Kundli',
          conversionValue: 999,
          contributionMargin: 40,
          refundRatePercent: 5,
        },
      ],
    });
    // Inactive Nadi excluded; conversionEvent stripped (not part of ProductForRevenue)
    expect(targets[0].products).toHaveLength(1);
  });

  it('drops empty Meta IDs and manual imports defensively even if find leaks them', async () => {
    const campaignModel = makeCampaignModel([
      activeCampaign('c1'),
      activeCampaign('c2', ''),
      activeCampaign('c3', 'meta-c3', 'manual'),
      activeCampaign('c4', 'meta-c4', 'human'),
    ]);
    const companies = makeCompaniesService({ tenantId: 'astro', products: [] });
    const adapter = new TenantCampaignsAdapter(
      campaignModel as unknown as import('mongoose').Model<any>,
      makeBriefModel() as unknown as import('mongoose').Model<any>,
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    const targets = await adapter.listActiveCampaigns('astro');
    expect(targets).toHaveLength(2);
    expect(targets[0].campaignId).toBe('c1');
    expect(targets[1].campaignId).toBe('c4');
  });

  it('passes only the campaign-resolved product into the snapshot pipeline', async () => {
    const campaignModel = makeCampaignModel([
      {
        ...activeCampaign('nadi'),
        productName: 'Nadi Leaf',
        name: 'Nadi Leaf TAT',
      },
    ]);
    const companies = makeCompaniesService({
      tenantId: 'astro',
      products: [
        {
          name: 'Nadi Report',
          active: true,
          conversionValue: 999,
          refundRatePercent: 5,
        },
        {
          name: 'Nadi Leaf',
          active: true,
          conversionValue: 3999,
          contributionMargin: 45,
          refundRatePercent: 12,
        },
      ],
    });
    const adapter = new TenantCampaignsAdapter(
      campaignModel as unknown as import('mongoose').Model<any>,
      makeBriefModel() as unknown as import('mongoose').Model<any>,
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );

    const targets = await adapter.listActiveCampaigns('astro');

    expect(targets[0].products).toEqual([
      {
        name: 'Nadi Leaf',
        conversionValue: 3999,
        contributionMargin: 45,
        refundRatePercent: 12,
      },
    ]);
  });

  it('preserves an alias-resolved inactive product for historical measurement', async () => {
    const campaignModel = makeCampaignModel([
      {
        ...activeCampaign('nadi-leaf'),
        productName: '',
        name: 'Nadi Leaf - New Batch_2026-07-20 - TAT',
      },
    ]);
    const companies = makeCompaniesService({
      tenantId: 'astro',
      products: [
        { name: 'Nadi Report', active: true, contributionMargin: 0.97 },
        {
          name: 'Nadi Leaf Reading',
          active: false,
          conversionValue: 10000,
          contributionMargin: 0.45,
          refundRatePercent: 12,
        },
      ],
    });
    const adapter = new TenantCampaignsAdapter(
      campaignModel as unknown as import('mongoose').Model<any>,
      makeBriefModel() as unknown as import('mongoose').Model<any>,
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );

    const targets = await adapter.listActiveCampaigns('astro');

    expect(targets[0].products).toEqual([
      {
        name: 'Nadi Leaf Reading',
        conversionValue: 10000,
        contributionMargin: 0.45,
        refundRatePercent: 12,
      },
    ]);
  });

  it('passes no product when a multi-product campaign cannot be resolved', async () => {
    const campaignModel = makeCampaignModel([
      { ...activeCampaign('legacy'), name: 'Summer growth experiment' },
    ]);
    const companies = makeCompaniesService({
      tenantId: 'astro',
      products: [
        { name: 'Nadi Report', active: true, conversionValue: 999 },
        { name: 'Nadi Leaf', active: true, conversionValue: 3999 },
      ],
    });
    const adapter = new TenantCampaignsAdapter(
      campaignModel as unknown as import('mongoose').Model<any>,
      makeBriefModel() as unknown as import('mongoose').Model<any>,
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );

    const targets = await adapter.listActiveCampaigns('astro');

    expect(targets[0].products).toEqual([]);
  });

  it('returns [] and does not throw when the tenant lookup rejects', async () => {
    const campaignModel = makeCampaignModel([activeCampaign('c1')]);
    const companies = {
      findByTenantId: jest.fn().mockRejectedValue(new Error('not found')),
    };
    const adapter = new TenantCampaignsAdapter(
      campaignModel as unknown as import('mongoose').Model<any>,
      makeBriefModel() as unknown as import('mongoose').Model<any>,
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    const targets = await adapter.listActiveCampaigns('missing');
    expect(targets).toEqual([]);
  });

  it('coerces _id to string', async () => {
    const campaignModel = makeCampaignModel([
      {
        _id: { toString: () => 'objectid-abc' },
        metaCampaignId: 'meta-x',
        status: 'active',
        source: 'agent',
      },
    ]);
    const companies = makeCompaniesService({ products: [] });
    const adapter = new TenantCampaignsAdapter(
      campaignModel as unknown as import('mongoose').Model<any>,
      makeBriefModel() as unknown as import('mongoose').Model<any>,
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    const targets = await adapter.listActiveCampaigns('astro');
    expect(targets[0].campaignId).toBe('objectid-abc');
  });

  it('returns [] when tenant has no active campaigns', async () => {
    const campaignModel = makeCampaignModel([]);
    const companies = makeCompaniesService({ products: [] });
    const adapter = new TenantCampaignsAdapter(
      campaignModel as unknown as import('mongoose').Model<any>,
      makeBriefModel() as unknown as import('mongoose').Model<any>,
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    expect(await adapter.listActiveCampaigns('astro')).toEqual([]);
  });
});
