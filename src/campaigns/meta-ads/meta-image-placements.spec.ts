import axios from 'axios';
import { MetaAdsService, MetaImageAsset } from './meta-ads.service';

jest.mock('axios');
const post = axios.post as jest.MockedFunction<typeof axios.post>;

describe('image placement creative requests', () => {
  const copy = { primaryText: 'Body', headline: 'Headline', cta: 'Shop Now' };
  const url = 'https://example.com/product?utm_campaign=test';
  let service: MetaAdsService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new MetaAdsService();
    (axios.get as jest.Mock).mockResolvedValue({ data: { instagram_business_account: { id: 'instagram' } } });
    post.mockResolvedValueOnce({ data: { id: 'creative' } });
    post.mockResolvedValueOnce({ data: { id: 'ad' } });
  });

  async function create(
    images: MetaImageAsset[],
    vertical = false,
    overrides = {},
  ) {
    const result = await (service as any).createAd(
      'act_123',
      'token',
      'adset',
      'Test',
      copy,
      images,
      'page',
      url,
      vertical,
      overrides,
    );
    expect(result).toEqual({ creativeId: 'creative', adId: 'ad' });
    expect(post.mock.calls[1][1]).toMatchObject({
      adset_id: 'adset',
      creative: { creative_id: 'creative' },
      status: 'PAUSED',
    });
    return post.mock.calls[0][1] as any;
  }

  function servedHash(spec: any, platform: string, position: string) {
    const rule =
      spec.asset_customization_rules.find(
        (entry: any) =>
          entry.customization_spec.publisher_platforms?.includes(platform) &&
          entry.customization_spec[`${platform}_positions`]?.includes(position),
      ) ??
      spec.asset_customization_rules.find((entry: any) => entry.is_default);
    return spec.images.find((image: any) =>
      image.adlabels.some((label: any) => label.name === rule.image_label.name),
    )?.hash;
  }

  it('rejects missing placement assets before making any Meta request', async () => {
    await expect(
      service.launchCampaign({
        adSets: [
          {
            name: 'Feed and Stories',
            ads: [0],
            placementPreset: 'vertical_feed',
          },
        ],
        copyVariants: [copy],
        imageHashes: { 0: [{ hash: 'feed', aspectRatio: '4:5' }] },
      } as any),
    ).rejects.toThrow('9:16');
    expect(post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('routes sizes the way Ads Manager groups placements', async () => {
    const payload = await create([
      { hash: 'square', aspectRatio: '1:1' },
      { hash: 'portrait', aspectRatio: '4:5' },
      { hash: 'vertical', aspectRatio: '9:16' },
      { hash: 'landscape', aspectRatio: '16:9' },
    ]);
    expect(payload.object_story_spec).toEqual({ page_id: 'page', instagram_user_id: 'instagram' });
    const spec = payload.asset_feed_spec;
    expect(spec).toMatchObject({
      optimization_type: 'PLACEMENT',
      ad_formats: ['SINGLE_IMAGE'],
      bodies: [{ text: copy.primaryText }],
      titles: [{ text: copy.headline }],
      link_urls: [{ website_url: url }],
      call_to_action_types: ['SHOP_NOW'],
    });
    // Ads Manager uses three groups; 16:9 has no group of its own.
    expect(spec.images.map((image: any) => image.hash).sort()).toEqual(['portrait', 'square', 'vertical']);
    for (const [platform, position] of [
      ['facebook', 'story'], ['facebook', 'facebook_reels'], ['facebook', 'instream_video'],
      ['instagram', 'story'], ['instagram', 'reels'], ['instagram', 'ig_search'],
    ]) expect(servedHash(spec, platform, position)).toBe('vertical');
    expect(servedHash(spec, 'facebook', 'right_hand_column')).toBe('square');
    expect(servedHash(spec, 'facebook', 'search')).toBe('square');
    for (const [platform, position] of [
      ['facebook', 'feed'], ['facebook', 'marketplace'], ['instagram', 'stream'],
      ['instagram', 'profile_feed'], ['instagram', 'explore'],
    ]) expect(servedHash(spec, platform, position)).toBe('portrait');
    const defaults = spec.asset_customization_rules.filter((rule: any) => rule.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].customization_spec).toEqual({});
  });

  it('retains both feed and vertical assets for mixed placements', async () => {
    const { asset_feed_spec: spec } = await create([
      { hash: 'portrait', aspectRatio: '4:5' },
      { hash: 'vertical', aspectRatio: '9:16' },
    ]);
    expect(spec.images).toHaveLength(2);
    expect(spec.asset_customization_rules).toHaveLength(2);
    expect(servedHash(spec, 'facebook', 'feed')).toBe('portrait');
    expect(servedHash(spec, 'instagram', 'reels')).toBe('vertical');
  });

  it('uses the vertical image directly for vertical-only placements', async () => {
    const payload = await create(
      [
        { hash: 'portrait', aspectRatio: '4:5' },
        { hash: 'vertical', aspectRatio: '9:16' },
      ],
      true,
    );
    expect(payload.asset_feed_spec).toBeUndefined();
    expect(payload.object_story_spec.link_data.image_hash).toBe('vertical');
  });

  it('uses square feeds when no portrait image exists', async () => {
    const { asset_feed_spec: spec } = await create([
      { hash: 'square', aspectRatio: '1:1' },
      { hash: 'vertical', aspectRatio: '9:16' },
    ]);
    expect(servedHash(spec, 'instagram', 'stream')).toBe('square');
    expect(servedHash(spec, 'facebook', 'story')).toBe('vertical');
  });

  it.each([
    [{ hash: 'single' }],
    [
      { hash: 'single', aspectRatio: '4:5' },
      { hash: 'single', aspectRatio: '9:16' },
    ],
    [
      { hash: 'single', aspectRatio: '4:5' },
      { hash: 'other', aspectRatio: '4:5' },
    ],
  ])(
    'keeps single-size creatives on the plain image path: %j',
    async (...images) => {
      const payload = await create(images);
      expect(payload.asset_feed_spec).toBeUndefined();
      expect(payload.object_story_spec.link_data).toMatchObject({
        image_hash: 'single',
        link: url,
        message: copy.primaryText,
        name: copy.headline,
        call_to_action: { type: 'SHOP_NOW', value: { link: url } },
      });
    },
  );

  it('propagates placement rejection without silently launching a cropped single image', async () => {
    post.mockReset();
    post.mockRejectedValueOnce({
      response: {
        data: {
          error: {
            code: 100,
            error_subcode: 1885896,
            message: 'Unsupported asset customization',
          },
        },
      },
    });
    await expect(
      (service as any).createAd(
        'act_123',
        'token',
        'adset',
        'Test',
        copy,
        [
          { hash: 'feed', aspectRatio: '4:5' },
          { hash: 'vertical', aspectRatio: '9:16' },
        ],
        'page',
        url,
      ),
    ).rejects.toThrow('1885896');
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('uses team overrides in the outgoing placement rules', async () => {
    const payload = await create(
      [
        { hash: 'portrait', aspectRatio: '4:5' },
        { hash: 'square', aspectRatio: '1:1' },
        { hash: 'vertical', aspectRatio: '9:16' },
        { hash: 'wide', aspectRatio: '16:9' },
      ],
      false,
      { feed: '1:1', landscape: '4:5', other: '16:9' },
    );
    const spec = payload.asset_feed_spec;
    expect(servedHash(spec, 'instagram', 'stream')).toBe('square');
    expect(servedHash(spec, 'instagram', 'explore')).toBe('square');
    expect(servedHash(spec, 'facebook', 'story')).toBe('vertical');
    // `other` (right column + search) wins over the legacy `landscape` key.
    expect(servedHash(spec, 'facebook', 'right_hand_column')).toBe('wide');
  });
  it('reads a saved legacy landscape override as the right column + search size', async () => {
    const payload = await create(
      [
        { hash: 'portrait', aspectRatio: '4:5' },
        { hash: 'vertical', aspectRatio: '9:16' },
        { hash: 'wide', aspectRatio: '16:9' },
      ],
      false,
      { landscape: '16:9' },
    );
    expect(servedHash(payload.asset_feed_spec, 'facebook', 'search')).toBe('wide');
  });
  it('honors the override for vertical-only ad sets', async () => {
    const payload = await create(
      [
        { hash: 'square', aspectRatio: '1:1' },
        { hash: 'vertical', aspectRatio: '9:16' },
      ],
      true,
      { vertical: '1:1' },
    );
    expect(payload.object_story_spec.link_data.image_hash).toBe('square');
  });
  it.each([true, false])(
    'selects the video size for vertical-only=%s',
    async (verticalOnly) => {
      await (service as any).createVideoAd(
        'act_123',
        'token',
        'adset',
        'Video',
        copy,
        [
          {
            videoId: 'portrait',
            aspectRatio: '4:5',
            thumbnailHash: 'portrait-thumb',
          },
          {
            videoId: 'vertical',
            aspectRatio: '9:16',
            thumbnailHash: 'vertical-thumb',
          },
        ],
        'page',
        url,
        undefined,
        verticalOnly,
      );
      const payload = post.mock.calls[0][1] as any;
      if (verticalOnly) {
        expect(payload.object_story_spec.video_data).toMatchObject({
          video_id: 'vertical',
          image_hash: 'vertical-thumb',
        });
        expect(payload.asset_feed_spec).toBeUndefined();
      } else {
        expect(payload.object_story_spec).toEqual({ page_id: 'page', instagram_user_id: 'instagram' });
        expect(payload.asset_feed_spec.videos.map((v: any) => v.video_id)).toEqual(['vertical', 'portrait']);
      }
    },
  );
  const videoPayload = async (videos: any[], verticalOnly = false) => {
    await (service as any).createVideoAd(
      'act_123', 'token', 'adset', 'Video', copy, videos, 'page', url, undefined, verticalOnly,
    );
    return post.mock.calls[0][1] as any;
  };
  const sizes = {
    square: { videoId: 'square', aspectRatio: '1:1', thumbnailHash: 'square-thumb' },
    portrait: { videoId: 'portrait', aspectRatio: '4:5', thumbnailHash: 'portrait-thumb' },
    vertical: { videoId: 'vertical', aspectRatio: '9:16', thumbnailHash: 'vertical-thumb' },
    landscape: { videoId: 'landscape', aspectRatio: '16:9', thumbnailHash: 'landscape-thumb' },
  };

  it('maps videos to Ads Manager groups: 9:16 vertical group, 4:5 feeds default', async () => {
    const { asset_feed_spec: spec } = await videoPayload(Object.values(sizes));
    expect(spec).toMatchObject({
      optimization_type: 'PLACEMENT',
      ad_formats: ['SINGLE_VIDEO'],
      bodies: [{ text: copy.primaryText }],
      titles: [{ text: copy.headline }],
      link_urls: [{ website_url: url }],
    });
    expect(spec.videos).toEqual([
      { video_id: 'vertical', thumbnail_hash: 'vertical-thumb', adlabels: [{ name: 'placement_video_0' }] },
      { video_id: 'portrait', thumbnail_hash: 'portrait-thumb', adlabels: [{ name: 'placement_video_1' }] },
    ]);
    expect(spec.asset_customization_rules).toEqual([
      {
        customization_spec: {
          publisher_platforms: ['facebook', 'instagram'],
          facebook_positions: ['story', 'facebook_reels', 'instream_video'],
          instagram_positions: ['story', 'reels', 'ig_search'],
        },
        video_label: { name: 'placement_video_0' },
        priority: 1,
      },
      { customization_spec: {}, video_label: { name: 'placement_video_1' }, is_default: true, priority: 2 },
    ]);
  });

  it('uses a square video for feeds when there is no 4:5', async () => {
    const { asset_feed_spec: spec } = await videoPayload([sizes.vertical, sizes.square]);
    expect(spec.videos.map((v: any) => v.video_id)).toEqual(['vertical', 'square']);
  });

  it.each([
    ['only a 9:16 video', [sizes.vertical], 'vertical'],
    ['only a 16:9 video', [sizes.landscape], 'landscape'],
    ['an untagged video', [{ videoId: 'untagged', thumbnailHash: 'untagged-thumb' }], 'untagged'],
    ['9:16 + 16:9 (9:16 is the closer fit for feeds)', [sizes.vertical, sizes.landscape], 'vertical'],
  ])('ships %s to every placement without blocking', async (_label, videos, expected) => {
    const payload = await videoPayload(videos);
    expect(payload.asset_feed_spec).toBeUndefined();
    expect(payload.object_story_spec.video_data.video_id).toBe(expected);
  });

  it('uses the closest size on vertical-only ad sets when there is no 9:16', async () => {
    const payload = await videoPayload([sizes.landscape, sizes.portrait], true);
    expect(payload.object_story_spec.video_data).toMatchObject({ video_id: 'portrait', image_hash: 'portrait-thumb' });
  });
});
