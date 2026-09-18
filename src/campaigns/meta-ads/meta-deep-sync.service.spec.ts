import { MetaDeepSyncService } from './meta-deep-sync.service';
import {
  buildRevenueConfigFingerprint,
  isTrustedProductScopedTimeseriesRevenue,
  resolvePersistedCampaignProduct,
} from './timeseries-revenue-provenance.util';

describe('MetaDeepSyncService product-scoped daily revenue', () => {
  it('uses only the owning product conversion and stamps trustworthy provenance', async () => {
    const timeseriesModel = {
      bulkWrite: jest.fn().mockResolvedValue({
        upsertedCount: 3,
        modifiedCount: 0,
      }),
    };
    const service = new MetaDeepSyncService(
      {} as any,
      timeseriesModel as any,
      {} as any,
      {} as any,
    );
    const rules = new Map([
      [
        'meta-leaf',
        {
          conversionTypes: new Set(['offsite_conversion.custom.nadi-leaf']),
          attributionSource: 'custom_conversion',
          effectiveConversionValue: 100,
          refundFactor: 0.9,
          campaignProductName: 'Nadi Leaf',
          resolvedProductName: 'Nadi Leaf',
          productResolutionEvidence: 'persisted_campaign_product_exact',
          revenueConfigFingerprint: 'c'.repeat(64),
        },
      ],
    ]);

    await (service as any).upsertTimeseries(
      'tenant-1',
      'campaign',
      [
        {
          campaign_id: 'meta-leaf',
          date_start: '2026-08-01',
          spend: '100',
          actions: [
            {
              action_type: 'offsite_conversion.custom.nadi-report',
              value: '9',
            },
            {
              action_type: 'offsite_conversion.custom.nadi-leaf',
              value: '2',
            },
          ],
          action_values: [
            {
              action_type: 'offsite_conversion.custom.nadi-report',
              value: '900',
            },
            {
              action_type: 'offsite_conversion.custom.nadi-leaf',
              value: '200',
            },
          ],
        },
        {
          campaign_id: 'meta-leaf',
          date_start: '2026-08-02',
          spend: '50',
          actions: [
            {
              action_type: 'offsite_conversion.custom.nadi-leaf',
              value: '2',
            },
          ],
          action_values: [],
        },
        {
          campaign_id: 'meta-unresolved',
          date_start: '2026-08-01',
          spend: '75',
          actions: [{ action_type: 'purchase', value: '3' }],
          action_values: [{ action_type: 'purchase', value: '1000' }],
        },
      ],
      'campaign_id',
      rules,
      { complete: true },
    );

    const operations = timeseriesModel.bulkWrite.mock.calls[0][0];
    expect(operations[0].updateOne.update.$set).toMatchObject({
      conversions: 2,
      revenue: 180,
      revenueBasis: 'meta_action_value',
      revenueAttributionSource: 'custom_conversion',
      revenueAttributionActionTypes: ['offsite_conversion.custom.nadi-leaf'],
      revenueCalculationVersion: 'product_scoped_v1',
      revenueFetchCompleteness: 'complete',
      campaignProductName: 'Nadi Leaf',
      resolvedProductName: 'Nadi Leaf',
      productResolutionEvidence: 'persisted_campaign_product_exact',
      revenueConfigFingerprint: 'c'.repeat(64),
    });
    expect(operations[1].updateOne.update.$set).toMatchObject({
      conversions: 2,
      revenue: 200,
      revenueBasis: 'configured_conversion_value',
      revenueCalculationVersion: 'product_scoped_v1',
    });
    expect(operations[2].updateOne.update.$set).toMatchObject({
      conversions: 0,
      revenue: 0,
      revenueBasis: 'unknown',
      revenueAttributionSource: 'unresolved',
      revenueAttributionActionTypes: [],
      revenueCalculationVersion: 'product_scoped_v1',
    });
  });

  it('does not write any rows from an incomplete Meta fetch', async () => {
    const timeseriesModel = { bulkWrite: jest.fn() };
    const service = new MetaDeepSyncService(
      {} as any,
      timeseriesModel as any,
      {} as any,
      {} as any,
    );

    const written = await (service as any).upsertTimeseries(
      'tenant-1',
      'campaign',
      [
        {
          campaign_id: 'meta-leaf',
          date_start: '2026-08-01',
          spend: '100',
        },
      ],
      'campaign_id',
      new Map(),
      { complete: false },
    );

    expect(written).toBe(0);
    expect(timeseriesModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('requires an exact persisted product name for authoritative evidence', () => {
    const products = [
      { name: 'Nadi Report', active: true },
      { name: 'Nadi Leaf', active: false },
    ];

    expect(
      resolvePersistedCampaignProduct('Nadi Leaf', products),
    ).toMatchObject({
      resolvedProductName: 'Nadi Leaf',
      evidence: 'persisted_campaign_product_exact',
    });
    expect(resolvePersistedCampaignProduct('', [products[0]])).toMatchObject({
      product: null,
      evidence: 'missing_persisted_campaign_product',
    });
    expect(
      resolvePersistedCampaignProduct('Nadi Leaf launch', products),
    ).toMatchObject({
      product: null,
      evidence: 'unmatched_persisted_campaign_product',
    });

    const otherwiseTrustedRow = {
      revenue: 100,
      revenueBasis: 'meta_action_value',
      revenueAttributionSource: 'custom_conversion',
      revenueAttributionActionTypes: ['offsite_conversion.custom.nadi-leaf'],
      revenueCalculationVersion: 'product_scoped_v1',
      revenueFetchCompleteness: 'complete',
      campaignProductName: 'Nadi Leaf',
      resolvedProductName: 'Nadi Leaf',
      revenueConfigFingerprint: 'e'.repeat(64),
    };
    expect(
      isTrustedProductScopedTimeseriesRevenue(
        {
          ...otherwiseTrustedRow,
          productResolutionEvidence: 'persisted_campaign_product_exact',
        },
        'Nadi Leaf',
      ),
    ).toBe(true);
    expect(
      isTrustedProductScopedTimeseriesRevenue(
        {
          ...otherwiseTrustedRow,
          productResolutionEvidence: 'inferred_fallback',
        },
        'Nadi Leaf',
      ),
    ).toBe(false);
  });

  it('makes the sync-time config fingerprint deterministic', () => {
    const product = {
      name: 'Nadi Leaf',
      customConversionId: 'leaf-conversion',
    };
    const common = {
      product,
      effectiveConversionValue: 100,
      refundFactor: 0.9,
      useAppEvents: false,
    };
    expect(
      buildRevenueConfigFingerprint({
        ...common,
        conversionTypes: new Set(['second', 'first']),
      }),
    ).toBe(
      buildRevenueConfigFingerprint({
        ...common,
        conversionTypes: new Set(['first', 'second']),
      }),
    );
  });

  it('does not emit trusted day-of-week revenue from mixed legacy rows', async () => {
    const query: any = {};
    query.lean = jest.fn(() => query);
    query.exec = jest.fn().mockResolvedValue([
      {
        date: '2026-08-02',
        spend: 100,
        impressions: 1_000,
        clicks: 10,
        conversions: 1,
        revenue: 120,
        revenueBasis: 'meta_action_value',
        revenueAttributionSource: 'custom_conversion',
        revenueAttributionActionTypes: ['offsite_conversion.custom.nadi-leaf'],
        revenueCalculationVersion: 'product_scoped_v1',
        revenueFetchCompleteness: 'complete',
        campaignProductName: 'Nadi Leaf',
        resolvedProductName: 'Nadi Leaf',
        productResolutionEvidence: 'persisted_campaign_product_exact',
        revenueConfigFingerprint: 'd'.repeat(64),
      },
      {
        date: '2026-08-09',
        spend: 100,
        impressions: 1_000,
        clicks: 10,
        conversions: 1,
        revenue: 180,
      },
    ]);
    const timeseriesModel = { find: jest.fn(() => query) };
    const breakdownModel = { updateOne: jest.fn().mockResolvedValue({}) };
    const service = new MetaDeepSyncService(
      {} as any,
      timeseriesModel as any,
      breakdownModel as any,
      {} as any,
    );
    const rules = new Map([
      [
        'meta-leaf',
        {
          campaignProductName: 'Nadi Leaf',
        },
      ],
    ]);

    await (service as any).computeDayOfWeek('tenant-1', ['meta-leaf'], rules);

    const writtenRows = breakdownModel.updateOne.mock.calls[0][1].$set.rows;
    expect(writtenRows).toEqual([
      expect.objectContaining({
        keys: { dow: 'sunday' },
        spend: 200,
        persistedRevenue: 300,
        revenue: null,
        roas: null,
        returnCoverage: 'partial',
      }),
    ]);
  });
});
