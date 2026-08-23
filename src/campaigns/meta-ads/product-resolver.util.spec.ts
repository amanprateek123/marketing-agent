import { buildProductResolver } from './product-resolver.util';

function queryReturning<T>(value: T) {
  const query: any = {};
  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn().mockResolvedValue(value);
  return query;
}

describe('buildProductResolver', () => {
  it('resolves explicit productName, then brief, detected metadata, and active fallback', async () => {
    const products = [
      { name: 'Active fallback', active: true },
      { name: 'Explicit product', active: false },
      { name: 'Brief product', active: false },
      { name: 'Detected product', active: false },
    ];
    const campaignModel = {
      find: jest.fn(() =>
        queryReturning([
          {
            metaCampaignId: 'explicit',
            productName: 'explicit PRODUCT',
            briefId: 'brief-explicit',
          },
          { metaCampaignId: 'brief', productName: '', briefId: 'brief-2' },
        ]),
      ),
    };
    const briefModel = {
      find: jest.fn(() =>
        queryReturning([
          { briefId: 'brief-explicit', product: 'Brief product' },
          { briefId: 'brief-2', product: 'Brief product' },
        ]),
      ),
    };
    const detected = new Map([
      ['explicit', 'Detected product'],
      ['brief', 'Detected product'],
      ['detected', 'Detected product'],
    ]);

    const resolve = await buildProductResolver(
      campaignModel as any,
      briefModel as any,
      'tenant-1',
      ['explicit', 'brief', 'detected', 'fallback'],
      products,
      detected,
    );

    expect(resolve('explicit')).toBe(products[1]);
    expect(resolve('brief')).toBe(products[2]);
    expect(resolve('detected')).toBe(products[3]);
    expect(resolve('fallback')).toBe(products[0]);
    expect(campaignModel.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      metaCampaignId: {
        $in: ['explicit', 'brief', 'detected', 'fallback'],
      },
    });
  });

  it('uses a unique whole-phrase campaign-name match with multiple active products', async () => {
    const products = [
      { name: 'Wish Letter', active: true },
      { name: 'Nadi Report', active: true },
    ];
    const campaignModel = {
      find: jest.fn(() =>
        queryReturning([
          {
            metaCampaignId: 'wish',
            name: 'IN | Wish-Letter | Broad | 2026-08-20',
          },
        ]),
      ),
    };
    const briefModel = { find: jest.fn(() => queryReturning([])) };

    const resolve = await buildProductResolver(
      campaignModel as any,
      briefModel as any,
      'tenant-1',
      ['wish'],
      products,
    );

    expect(resolve('wish')).toBe(products[0]);
  });

  it('resolves the historical Nadi Leaf alias to an inactive configured product', async () => {
    const products = [
      { name: 'Nadi Report', active: true },
      {
        name: 'Nadi Leaf Reading',
        active: false,
        contributionMargin: 0.45,
        refundRatePercent: 12,
      },
    ];
    const campaignModel = {
      find: jest.fn(() =>
        queryReturning([
          {
            metaCampaignId: 'nadi-leaf',
            name: 'Nadi Leaf - New Batch_2026-07-20 - TAT',
          },
        ]),
      ),
    };
    const briefModel = { find: jest.fn(() => queryReturning([])) };

    const resolve = await buildProductResolver(
      campaignModel as any,
      briefModel as any,
      'tenant-1',
      ['nadi-leaf'],
      products,
    );

    expect(resolve('nadi-leaf')).toBe(products[1]);
  });

  it('does not guess when two products share the same two-token alias', async () => {
    const products = [
      { name: 'Nadi Leaf Reading', active: false },
      { name: 'Nadi Leaf Premium', active: true },
    ];
    const campaignModel = {
      find: jest.fn(() =>
        queryReturning([
          { metaCampaignId: 'ambiguous-leaf', name: 'Nadi Leaf - New Batch' },
        ]),
      ),
    };
    const briefModel = { find: jest.fn(() => queryReturning([])) };

    const resolve = await buildProductResolver(
      campaignModel as any,
      briefModel as any,
      'tenant-1',
      ['ambiguous-leaf'],
      products,
    );

    expect(resolve('ambiguous-leaf')).toBeUndefined();
  });

  it('returns unresolved for a campaign with no unique match when multiple products are active', async () => {
    const products = [
      { name: 'Wish Letter', active: true },
      { name: 'Nadi Report', active: true },
    ];
    const campaignModel = {
      find: jest.fn(() =>
        queryReturning([
          { metaCampaignId: 'ambiguous', name: 'Generic Legacy Campaign' },
        ]),
      ),
    };
    const briefModel = { find: jest.fn(() => queryReturning([])) };

    const resolve = await buildProductResolver(
      campaignModel as any,
      briefModel as any,
      'tenant-1',
      ['ambiguous'],
      products,
    );

    expect(resolve('ambiguous')).toBeUndefined();
  });
});
