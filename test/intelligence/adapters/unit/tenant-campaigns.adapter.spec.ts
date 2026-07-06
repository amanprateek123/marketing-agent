import { TenantCampaignsAdapter } from '../../../../src/intelligence/adapters/tenant-campaigns.adapter';

function buildQuery(returnValue: unknown) {
  return {
    lean: () => ({ exec: () => Promise.resolve(returnValue) }),
  };
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

const activeCampaign = (id: string, meta = `meta-${id}`) => ({
  _id: id,
  tenantId: 'astro',
  metaCampaignId: meta,
  status: 'active',
});

describe('TenantCampaignsAdapter', () => {
  it('returns campaigns with reduced product info', async () => {
    const campaignModel = makeCampaignModel([activeCampaign('c1'), activeCampaign('c2')]);
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
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );

    const targets = await adapter.listActiveCampaigns('astro');

    expect(campaignModel.find).toHaveBeenCalledWith({
      tenantId: 'astro',
      status: 'active',
      metaCampaignId: { $ne: '' },
    });
    expect(companies.findByTenantId).toHaveBeenCalledWith('astro');
    expect(targets).toHaveLength(2);
    expect(targets[0]).toEqual({
      campaignId: 'c1',
      metaCampaignId: 'meta-c1',
      products: [
        { name: 'Kundli', conversionValue: 999, contributionMargin: 40, refundRatePercent: 5 },
      ],
    });
    // Inactive Nadi excluded; conversionEvent stripped (not part of ProductForRevenue)
    expect(targets[0].products).toHaveLength(1);
  });

  it('drops campaigns with empty metaCampaignId defensively even if find leaks any', async () => {
    const campaignModel = makeCampaignModel([
      activeCampaign('c1'),
      { _id: 'c2', tenantId: 'astro', metaCampaignId: '', status: 'active' },
    ]);
    const companies = makeCompaniesService({ tenantId: 'astro', products: [] });
    const adapter = new TenantCampaignsAdapter(
      campaignModel as unknown as import('mongoose').Model<any>,
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    const targets = await adapter.listActiveCampaigns('astro');
    expect(targets).toHaveLength(1);
    expect(targets[0].campaignId).toBe('c1');
  });

  it('returns [] and does not throw when the tenant lookup rejects', async () => {
    const campaignModel = makeCampaignModel([activeCampaign('c1')]);
    const companies = {
      findByTenantId: jest.fn().mockRejectedValue(new Error('not found')),
    };
    const adapter = new TenantCampaignsAdapter(
      campaignModel as unknown as import('mongoose').Model<any>,
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    const targets = await adapter.listActiveCampaigns('missing');
    expect(targets).toEqual([]);
  });

  it('coerces _id to string', async () => {
    const campaignModel = makeCampaignModel([
      { _id: { toString: () => 'objectid-abc' }, metaCampaignId: 'meta-x', status: 'active' },
    ]);
    const companies = makeCompaniesService({ products: [] });
    const adapter = new TenantCampaignsAdapter(
      campaignModel as unknown as import('mongoose').Model<any>,
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
      companies as unknown as import('../../../../src/companies/companies.service').CompaniesService,
    );
    expect(await adapter.listActiveCampaigns('astro')).toEqual([]);
  });
});
