import axios from 'axios';
import { MetaLearningImporterService } from './meta-learning-importer.service';

describe('MetaLearningImporterService campaign enrichment', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requests and retains campaign-level action_values', async () => {
    const actionValues = [{ action_type: 'purchase', value: '1250' }];
    const get = jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({
        data: {
          data: [
            {
              spend: '500',
              actions: [{ action_type: 'purchase', value: '1' }],
              action_values: actionValues,
              date_stop: '2026-08-20',
            },
          ],
        },
      } as any)
      .mockResolvedValueOnce({ data: { data: [] } } as any)
      .mockResolvedValueOnce({ data: { data: [] } } as any)
      .mockResolvedValueOnce({ data: { data: [] } } as any)
      .mockResolvedValueOnce({ data: { data: [] } } as any)
      .mockResolvedValueOnce({ data: { data: [] } } as any);
    const service = new MetaLearningImporterService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.enrichCampaign(
      { id: 'meta-campaign', name: 'Campaign' },
      'token',
      new Set(['purchase']),
    );

    expect(String(get.mock.calls[0][0])).toContain(
      'fields=spend,impressions,clicks,ctr,cpc,actions,action_values,frequency,date_stop',
    );
    expect(result?.insights.action_values).toEqual(actionValues);
    expect(result?.insights.date_stop).toBe('2026-08-20');
  });

  it('resolves overlapping product names specifically and leaves shared tokens ambiguous', () => {
    const service = new MetaLearningImporterService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const products = [
      {
        name: 'Nadi Report',
        price: 999,
        customConversionId: 'report-id',
      },
      {
        name: 'Nadi Leaf Reading',
        price: 1499,
        customConversionId: 'leaf-id',
      },
    ];

    expect(
      (service as any).detectProduct(
        {
          name: 'Legacy Nadi Campaign',
          adSets: [{ promoted_object: { custom_conversion_id: 'leaf-id' } }],
        },
        [{ id: 'leaf-id', name: 'Nadi Report Purchase' }],
        products,
      ),
    ).toBe('Nadi Leaf Reading');

    expect(
      (service as any).detectProduct(
        {
          name: 'Nadi Leaf August',
          adSets: [
            { promoted_object: { custom_conversion_id: 'legacy-leaf-id' } },
          ],
        },
        [{ id: 'legacy-leaf-id', name: 'Nadi Leaf Purchase Completed' }],
        products,
      ),
    ).toBe('Nadi Leaf Reading');

    expect(
      (service as any).detectProduct(
        { name: 'Nadi Campaign', adSets: [] },
        [],
        products,
      ),
    ).toBe('unknown');
  });
});
