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

  it('sends all four sizes and routes feeds, vertical and other placements', async () => {
    const payload = await create([
      { hash: 'square', aspectRatio: '1:1' },
      { hash: 'portrait', aspectRatio: '4:5' },
      { hash: 'vertical', aspectRatio: '9:16' },
      { hash: 'landscape', aspectRatio: '16:9' },
    ]);
    expect(payload.object_story_spec).toEqual({ page_id: 'page' });
    const spec = payload.asset_feed_spec;
    expect(spec).toMatchObject({
      optimization_type: 'PLACEMENT',
      ad_formats: ['SINGLE_IMAGE'],
      bodies: [{ text: copy.primaryText }],
      titles: [{ text: copy.headline }],
      link_urls: [{ website_url: url }],
      call_to_action_types: ['SHOP_NOW'],
    });
    expect(spec.images).toHaveLength(4);
    expect(servedHash(spec, 'facebook', 'feed')).toBe('portrait');
    expect(servedHash(spec, 'instagram', 'stream')).toBe('portrait');
    expect(servedHash(spec, 'instagram', 'profile_feed')).toBe('portrait');
    expect(servedHash(spec, 'facebook', 'story')).toBe('vertical');
    expect(servedHash(spec, 'facebook', 'facebook_reels')).toBe('vertical');
    expect(servedHash(spec, 'instagram', 'story')).toBe('vertical');
    expect(servedHash(spec, 'instagram', 'reels')).toBe('vertical');
    expect(servedHash(spec, 'facebook', 'right_hand_column')).toBe('landscape');
    expect(servedHash(spec, 'instagram', 'explore')).toBe('square');
    expect(servedHash(spec, 'facebook', 'marketplace')).toBe('square');
    expect(
      spec.asset_customization_rules.filter((rule: any) => rule.is_default),
    ).toHaveLength(1);
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
    expect(servedHash(payload.asset_feed_spec, 'instagram', 'stream')).toBe(
      'square',
    );
    expect(
      servedHash(payload.asset_feed_spec, 'facebook', 'right_hand_column'),
    ).toBe('portrait');
    expect(servedHash(payload.asset_feed_spec, 'facebook', 'story')).toBe(
      'vertical',
    );
    expect(servedHash(payload.asset_feed_spec, 'instagram', 'explore')).toBe(
      'wide',
    );
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
      expect(
        (post.mock.calls[0][1] as any).object_story_spec.video_data,
      ).toMatchObject({
        video_id: verticalOnly ? 'vertical' : 'portrait',
        image_hash: verticalOnly ? 'vertical-thumb' : 'portrait-thumb',
      });
    },
  );
});
