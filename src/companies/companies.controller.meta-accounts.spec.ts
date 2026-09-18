import {
  CompaniesController,
  mergeMetaAccountCurrencies,
} from './companies.controller';

describe('Meta account currency provenance', () => {
  const discovered = [
    {
      id: 'act_123',
      name: 'India account',
      status: 'active' as const,
      currency: 'inr',
      timezoneName: 'Asia/Kolkata',
    },
    {
      id: 'act_456',
      name: 'US account',
      status: 'disabled' as const,
      currency: 'USD',
      timezoneName: 'America/Los_Angeles',
    },
    {
      id: 'act_999',
      name: 'Existing account',
      status: 'active' as const,
      currency: 'GBP',
      timezoneName: 'Europe/London',
    },
  ];

  it('normalizes selected Meta currencies and preserves unselected evidence', () => {
    expect(
      mergeMetaAccountCurrencies(
        { '999': 'usd', act_invalid: 'not-a-currency' },
        discovered,
        ['123'],
      ),
    ).toEqual({
      act_999: 'USD',
      act_123: 'INR',
    });
  });

  it('uses one discovery response for explicitly selected IDs', async () => {
    const company = {
      tenantId: 'tenant-1',
      meta: {
        accessToken: 'token',
        accountId: '123',
        accountIds: ['123', '999'],
        accountCurrencies: { act_999: 'USD' },
        businessId: 'business-1',
      },
    };
    const companiesService = {
      findByTenantId: jest.fn().mockResolvedValue(company),
      update: jest.fn().mockImplementation(async (_tenantId, dto) => ({
        company: { ...company, ...dto },
        needsPromptRegen: false,
      })),
    };
    const metaAdsService = {
      listAdAccounts: jest.fn().mockResolvedValue(discovered),
    };
    const campaignSyncService = {
      syncActiveCampaigns: jest.fn().mockResolvedValue({ synced: 0 }),
    };
    const controller = new CompaniesController(
      companiesService as any,
      {} as any,
      {} as any,
      metaAdsService as any,
      campaignSyncService as any,
      {} as any,
      {} as any,
    );

    await expect(
      controller.syncMetaAccounts('tenant-1', {
        accountIds: ['act_123'],
      }),
    ).resolves.toMatchObject({
      success: true,
      accountIds: ['123'],
    });

    expect(metaAdsService.listAdAccounts).toHaveBeenCalledTimes(1);
    expect(metaAdsService.listAdAccounts).toHaveBeenCalledWith(
      'token',
      'business-1',
    );
    expect(companiesService.update).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({
        meta: expect.objectContaining({
          accountIds: ['123'],
          accountCurrencies: {
            act_999: 'USD',
            act_123: 'INR',
          },
        }),
      }),
    );
    expect(campaignSyncService.syncActiveCampaigns).toHaveBeenCalledTimes(1);
  });

  it('auto-selects active accounts and records only their returned currencies', async () => {
    const company = {
      tenantId: 'tenant-1',
      meta: { accessToken: 'token', accountId: '123' },
    };
    const companiesService = {
      findByTenantId: jest.fn().mockResolvedValue(company),
      update: jest.fn().mockImplementation(async (_tenantId, dto) => ({
        company: { ...company, ...dto },
        needsPromptRegen: false,
      })),
    };
    const metaAdsService = {
      listAdAccounts: jest.fn().mockResolvedValue(discovered),
    };
    const campaignSyncService = {
      syncActiveCampaigns: jest.fn().mockResolvedValue({ synced: 0 }),
    };
    const controller = new CompaniesController(
      companiesService as any,
      {} as any,
      {} as any,
      metaAdsService as any,
      campaignSyncService as any,
      {} as any,
      {} as any,
    );

    await controller.syncMetaAccounts('tenant-1', {});

    expect(companiesService.update).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({
        meta: expect.objectContaining({
          accountIds: ['123', '999'],
          accountCurrencies: {
            act_123: 'INR',
            act_999: 'GBP',
          },
        }),
      }),
    );
  });
});
