import { completeCampaignLaunch } from './complete-campaign-launch';
import {
  MetaAdSetConfig,
  MetaLaunchResult,
} from '../meta-ads/meta-ads.service';

const adSet: MetaAdSetConfig = {
  name: 'Test',
  budgetPercent: 100,
  audienceType: 'broad',
  optimizationGoal: 'OFFSITE_CONVERSIONS',
  ads: [0],
};
function result(count: number): MetaLaunchResult {
  return {
    campaignId: 'campaign',
    adSets: [
      {
        adSetId: 'adset',
        name: 'Test',
        ads: Array.from({ length: count }, (_, i) => ({
          adId: `ad${i}`,
          creativeId: `creative${i}`,
          copyVariantIndex: 0,
          format: 'image' as const,
        })),
      },
    ],
  };
}

describe('campaign activation gate', () => {
  it('never activates a complete paused preview', async () => {
    const activate = jest.fn();
    expect(
      await completeCampaignLaunch(result(1), [adSet], true, activate),
    ).toBe('paused');
    expect(activate).not.toHaveBeenCalled();
  });
  it('activates a complete normal launch', async () => {
    const activate = jest.fn().mockResolvedValue(undefined);
    expect(
      await completeCampaignLaunch(result(1), [adSet], false, activate),
    ).toBe('active');
    expect(activate).toHaveBeenCalledTimes(1);
  });
  it('keeps a both-format launch paused if the video or image is missing', async () => {
    const activate = jest.fn();
    expect(
      await completeCampaignLaunch(
        result(1),
        [{ ...adSet, creativeFormat: 'both' }],
        false,
        activate,
        {
          imageHashes: { 0: [{ hash: 'image' }] },
          videoAssets: { 0: [{ videoId: 'video' }] },
        },
      ),
    ).toBe('paused');
    expect(activate).not.toHaveBeenCalled();
  });
  it('activates both-format only when both ads exist', async () => {
    const activate = jest.fn().mockResolvedValue(undefined);
    expect(
      await completeCampaignLaunch(
        result(2),
        [{ ...adSet, creativeFormat: 'both' }],
        false,
        activate,
        {
          imageHashes: { 0: [{ hash: 'image' }] },
          videoAssets: { 0: [{ videoId: 'video' }] },
        },
      ),
    ).toBe('active');
  });
  it('counts a carousel as one ad regardless of variant count', async () => {
    const activate = jest.fn().mockResolvedValue(undefined);
    expect(
      await completeCampaignLaunch(
        result(1),
        [{ ...adSet, creativeFormat: 'carousel', ads: [0, 1, 2] }],
        false,
        activate,
      ),
    ).toBe('active');
  });
  it('does not let extra ads in one set compensate for missing ads in another', async () => {
    const activate = jest.fn();
    const launch = result(2);
    launch.adSets.push({ adSetId: 'second', name: 'Second', ads: [] });
    expect(
      await completeCampaignLaunch(
        launch,
        [adSet, { ...adSet, name: 'Second' }],
        false,
        activate,
      ),
    ).toBe('paused');
    expect(activate).not.toHaveBeenCalled();
  });
  it('propagates activation errors for reconciliation', async () => {
    await expect(
      completeCampaignLaunch(
        result(1),
        [adSet],
        false,
        jest.fn().mockRejectedValue(new Error('Meta timeout')),
      ),
    ).rejects.toThrow('Meta timeout');
  });
  it('counts separate image and video variants in Both as nine ads, not eighteen', async () => {
    const activate = jest.fn().mockResolvedValue(undefined);
    const assets = {
      imageHashes: Object.fromEntries(
        [0, 1, 2, 3, 4].map((index) => [index, [{ hash: `image-${index}` }]]),
      ),
      videoAssets: Object.fromEntries(
        [5, 6, 7, 8].map((index) => [index, [{ videoId: `video-${index}` }]]),
      ),
    };
    expect(
      await completeCampaignLaunch(
        result(9),
        [
          {
            ...adSet,
            creativeFormat: 'both',
            ads: [0, 1, 2, 3, 4, 5, 6, 7, 8],
          },
        ],
        false,
        activate,
        assets,
      ),
    ).toBe('active');
    expect(activate).toHaveBeenCalledTimes(1);
    activate.mockClear();
    expect(
      await completeCampaignLaunch(
        result(8),
        [
          {
            ...adSet,
            creativeFormat: 'both',
            ads: [0, 1, 2, 3, 4, 5, 6, 7, 8],
          },
        ],
        false,
        activate,
        assets,
      ),
    ).toBe('paused');
    expect(activate).not.toHaveBeenCalled();
  });
});
