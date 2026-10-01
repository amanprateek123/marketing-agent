import { MetaAdsService } from './meta-ads.service';
import { CampaignOptimizerService } from '../campaign-auditor/campaign-optimizer.service';
import { probeVideoRatio } from '../../common/media/video-probe';

jest.mock('../../common/media/video-probe', () => ({
  probeVideoRatio: jest.fn(),
}));
const probe = probeVideoRatio as jest.Mock;

const copy = { primaryText: 'Body', headline: 'Headline', cta: 'Shop Now' };
const EVERYWHERE = {
  publisher_platforms: ['facebook', 'instagram'],
  facebook_positions: ['feed', 'story', 'facebook_reels', 'right_hand_column'],
  instagram_positions: ['stream', 'story', 'reels'],
};
const VERTICAL = {
  publisher_platforms: ['facebook', 'instagram'],
  facebook_positions: ['story', 'facebook_reels'],
  instagram_positions: ['story', 'reels'],
};

/**
 * Gallery sheets attached to live campaigns (new ad set / bulk add) used to
 * upload only each asset's primary file — the admin's other uploaded sizes
 * were dropped and one size served every placement. These paths now map
 * every size exactly like launch.
 */
describe('adding gallery creatives to a live ad set', () => {
  let service: any;
  let calls: { method: string; url: string; data: any }[];

  beforeEach(() => {
    probe.mockReset();
    service = new MetaAdsService();
    calls = [];
    let n = 0;
    service.uploadImage = jest.fn(async (url: string) => `hash:${url}`);
    service.uploadVideo = jest.fn(async (url: string) => `video:${url}`);
    service.getVideoThumbnailHash = jest.fn(
      async (id: string) => `thumb:${id}`,
    );
    service.updateAdStatus = jest.fn(async () => undefined);
    service.resolveInstagramIdentity = jest.fn(async () => 'instagram');
    service.metaApiCall = jest.fn(
      async (method: string, url: string, data: any) => {
        calls.push({ method, url, data });
        if (method === 'GET')
          return { data: { account_id: '1', targeting: service.__targeting } };
        return { data: { id: `id_${++n}` } };
      },
    );
  });
  const creative = () =>
    calls.find((c) => c.url.endsWith('/adcreatives'))!.data;

  it('maps every uploaded image size on an Everywhere ad set', async () => {
    service.__targeting = EVERYWHERE;
    await service.createAdInAdSet(
      'adset',
      'token',
      'Ad',
      copy,
      [
        { url: 'p.png', aspectRatio: '4:5' },
        { url: 'v.png', aspectRatio: '9:16' },
        { url: 's.png', aspectRatio: '1:1' },
      ],
      'page',
      'https://x.com',
    );
    expect(service.uploadImage).toHaveBeenCalledTimes(3);
    const spec = creative().asset_feed_spec;
    expect(spec.optimization_type).toBe('PLACEMENT');
    expect(spec.images.map((i: any) => i.hash).sort()).toEqual([
      'hash:p.png',
      'hash:s.png',
      'hash:v.png',
    ]);
    expect(creative().object_story_spec.instagram_user_id).toBe('instagram');
  });

  it('uses only the 9:16 image on a Stories/Reels-only ad set', async () => {
    service.__targeting = VERTICAL;
    await service.createAdInAdSet(
      'adset',
      'token',
      'Ad',
      copy,
      [
        { url: 'p.png', aspectRatio: '4:5' },
        { url: 'v.png', aspectRatio: '9:16' },
      ],
      'page',
      'https://x.com',
    );
    expect(creative().asset_feed_spec).toBeUndefined();
    expect(creative().object_story_spec.link_data.image_hash).toBe(
      'hash:v.png',
    );
  });

  it('still accepts a single URL (optimizer refresh / manual add)', async () => {
    service.__targeting = EVERYWHERE;
    await service.createAdInAdSet(
      'adset',
      'token',
      'Ad',
      copy,
      'one.png',
      'page',
      'https://x.com',
    );
    expect(service.uploadImage).toHaveBeenCalledTimes(1);
    expect(creative().object_story_spec.link_data.image_hash).toBe(
      'hash:one.png',
    );
  });

  it('maps every uploaded video size, measuring untagged ones', async () => {
    service.__targeting = EVERYWHERE;
    probe.mockImplementation(async (url: string) =>
      url === 'untagged.mp4' ? '9:16' : undefined,
    );
    await service.createVideoAdInAdSet(
      'adset',
      'token',
      'Ad',
      copy,
      [{ url: 'p.mp4', aspectRatio: '4:5' }, { url: 'untagged.mp4' }],
      'page',
      'https://x.com',
    );
    const spec = creative().asset_feed_spec;
    expect(spec.ad_formats).toEqual(['SINGLE_VIDEO']);
    expect(spec.videos.map((v: any) => [v.video_id, v.thumbnail_hash])).toEqual(
      [
        ['video:untagged.mp4', 'thumb:video:untagged.mp4'], // measured 9:16 → vertical group
        ['video:p.mp4', 'thumb:video:p.mp4'], // 4:5 → feeds default
      ],
    );
  });

  it('ships a single video everywhere without blocking', async () => {
    service.__targeting = EVERYWHERE;
    probe.mockResolvedValue(undefined);
    await service.createVideoAdInAdSet(
      'adset',
      'token',
      'Ad',
      copy,
      'only.mp4',
      'page',
      'https://x.com',
    );
    expect(creative().object_story_spec.video_data).toMatchObject({
      video_id: 'video:only.mp4',
      image_hash: 'thumb:video:only.mp4',
    });
  });

  it.each([
    ['explicit Stories/Reels on both platforms', VERTICAL, true],
    [
      'Instagram Stories only',
      { publisher_platforms: ['instagram'], instagram_positions: ['story'] },
      true,
    ],
    ['feed included', EVERYWHERE, false],
    [
      'Facebook with no positions listed (= all Facebook placements)',
      {
        publisher_platforms: ['facebook', 'instagram'],
        instagram_positions: ['story'],
      },
      false,
    ],
    ['automatic placements', {}, false],
  ])('reads the ad set placements: %s', async (_label, targeting, expected) => {
    service.__targeting = targeting;
    expect(
      (await service.getAdSetPlacementContext('adset', 'token')).verticalOnly,
    ).toBe(expected);
  });
});

describe('resolving a gallery sheet into ads', () => {
  it('carries every uploaded size of each asset, primary first', async () => {
    const optimizer: any = Object.create(CampaignOptimizerService.prototype);
    optimizer.galleryService = {
      listSheetAssets: jest.fn(async () => [
        {
          _id: 'a1',
          assetType: 'image',
          sourcePackageId: 'pkg',
          variantIndex: 0,
          assetUrl: 'p.png',
          aspectRatio: '4:5',
          sizes: [
            { imageUrl: 'v.png', aspectRatio: '9:16', derived: false },
            { imageUrl: 's.png', aspectRatio: '1:1', derived: false },
          ],
        },
        {
          _id: 'a2',
          assetType: 'video',
          sourcePackageId: 'pkg',
          variantIndex: 0,
          assetUrl: 'v.mp4',
          sizes: [{ imageUrl: 'f.mp4', aspectRatio: '4:5', derived: false }],
        },
        {
          _id: 'a3',
          assetType: 'carousel_card',
          sourcePackageId: 'pkg',
          variantIndex: 0,
          assetUrl: 'c.png',
        },
      ]),
    };
    optimizer.creativePackageModel = {
      find: () => ({
        select: () => ({
          lean: () => ({
            exec: async () => [
              { _id: 'pkg', copyVariants: [copy], selectedCopyIndex: 0 },
            ],
          }),
        }),
      }),
    };
    const { entries, skippedCarousel } = await optimizer.resolveSheetEntries(
      'tenant',
      'sheet',
    );
    expect(skippedCarousel).toBe(1);
    expect(entries.map((e: any) => e.sizes)).toEqual([
      [
        { url: 'p.png', aspectRatio: '4:5' },
        { url: 'v.png', aspectRatio: '9:16' },
        { url: 's.png', aspectRatio: '1:1' },
      ],
      [
        { url: 'v.mp4', aspectRatio: undefined },
        { url: 'f.mp4', aspectRatio: '4:5' },
      ],
    ]);
  });
});
