import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrimeService } from '../../../../src/intelligence/prime/prime.service';

function queryResult(value: unknown) {
  const query = {
    sort: jest.fn(),
    limit: jest.fn(),
    select: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(value),
  };
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
}

function buildPrime(
  campaign: Record<string, unknown>,
  products: Array<Record<string, unknown>>,
) {
  const emitter = new EventEmitter2();
  const campaignModel = {
    find: jest
      .fn()
      .mockReturnValueOnce(queryResult([campaign]))
      .mockReturnValueOnce(queryResult([campaign])),
  };
  const snapshotEngine = {
    captureForCycle: jest.fn(
      async (input: { cycleId: string }): Promise<void> => {
        emitter.emit('intelligence.cycle.completed', {
          cycleId: input.cycleId,
        });
      },
    ),
  };
  const service = new PrimeService(
    { syncActiveCampaigns: jest.fn() } as never,
    {
      findByTenantId: jest.fn().mockResolvedValue({
        tenantId: 'astro',
        meta: { accessToken: 'test-token' },
        products,
      }),
    } as never,
    {
      openCycle: jest.fn().mockResolvedValue({ cycleId: 'cycle-1' }),
    } as never,
    snapshotEngine as never,
    { list: jest.fn().mockResolvedValue([]) } as never,
    emitter,
    campaignModel as never,
    { find: jest.fn() } as never,
  );

  return { service, snapshotEngine };
}

describe('PrimeService campaign product resolution', () => {
  it('passes the inactive Nadi alias product rather than the tenant active product', async () => {
    const { service, snapshotEngine } = buildPrime(
      {
        _id: 'campaign-1',
        tenantId: 'astro',
        metaCampaignId: 'meta-1',
        name: 'Nadi Leaf - New Batch_2026-07-20 - TAT',
        productName: '',
        status: 'active',
        source: 'agent',
      },
      [
        {
          name: 'Nadi Report',
          active: true,
          conversionValue: 999,
          refundRatePercent: 5,
        },
        {
          name: 'Nadi Leaf Reading',
          active: false,
          conversionValue: 3999,
          contributionMargin: 45,
          refundRatePercent: 12,
        },
      ],
    );

    await service.runFor('astro', { skipSync: true, maxCampaigns: 1 });

    expect(snapshotEngine.captureForCycle).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 'campaign-1',
        metaCampaignId: 'meta-1',
        products: [
          {
            name: 'Nadi Leaf Reading',
            conversionValue: 3999,
            contributionMargin: 45,
            refundRatePercent: 12,
          },
        ],
      }),
    );
  });

  it('passes no product when a multi-product campaign is ambiguous', async () => {
    const { service, snapshotEngine } = buildPrime(
      {
        _id: 'campaign-2',
        tenantId: 'astro',
        metaCampaignId: 'meta-2',
        name: 'Summer growth experiment',
        status: 'active',
        source: 'agent',
      },
      [
        { name: 'Nadi Report', active: true, conversionValue: 999 },
        { name: 'Nadi Leaf', active: true, conversionValue: 3999 },
      ],
    );

    await service.runFor('astro', { skipSync: true, maxCampaigns: 1 });

    expect(snapshotEngine.captureForCycle).toHaveBeenCalledWith(
      expect.objectContaining({ products: [] }),
    );
  });
});
