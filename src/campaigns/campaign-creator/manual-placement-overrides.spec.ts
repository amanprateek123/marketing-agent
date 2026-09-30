import { ManualCampaignService } from './manual-campaign.service';

describe('manual placement configuration', () => {
  const service = Object.create(ManualCampaignService.prototype);
  it.each(['custom', 'advantage_plus'])(
    'preserves overrides for %s campaigns',
    (campaignType) => {
      const imagePlacementOverrides = { feed: '1:1', vertical: '9:16' };
      const result = service.buildAdSetConfigs(
        {
          name: 'Test',
          campaignType,
          adSets: [
            {
              name: 'Ad set',
              audienceType: 'advantage_plus',
              budgetPercent: 100,
              placementPreset: 'everywhere',
              imagePlacementOverrides,
            },
          ],
        },
        { copyVariants: [{ headline: 'Test' }] },
        { products: [] },
      );
      expect(result[0]).toMatchObject({
        placementPreset: 'everywhere',
        imagePlacementOverrides,
      });
    },
  );
  it('rejects unsupported ratios before saving ad sets', () => {
    expect(() =>
      service.buildAdSetConfigs(
        { adSets: [{ imagePlacementOverrides: { feed: '3:2' } }] },
        { copyVariants: [] },
        {},
      ),
    ).toThrow('Invalid image placement override');
  });
});
