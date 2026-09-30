import { MetaAdSetConfig } from './meta-ads.service';
import { validateLaunchAssets } from './validate-launch-assets';

const base: MetaAdSetConfig = {
  name: 'Test',
  budgetPercent: 100,
  audienceType: 'broad',
  optimizationGoal: 'OFFSITE_CONVERSIONS',
  ads: [0],
  placementPreset: 'vertical_feed',
};
const copyVariants = [
  { primaryText: 'Body', headline: 'Headline', cta: 'Learn More' },
];
const images = [
  { hash: 'feed', aspectRatio: '4:5' },
  { hash: 'vertical', aspectRatio: '9:16' },
];

function validate(overrides: Partial<MetaAdSetConfig> = {}, assets = images) {
  return validateLaunchAssets({
    adSets: [{ ...base, ...overrides }],
    copyVariants,
    imageHashes: { 0: assets },
  });
}

describe('launch asset validation', () => {
  it('accepts uploaded feed and vertical images', () =>
    expect(() => validate()).not.toThrow());
  it('accepts square feeds', () =>
    expect(() =>
      validate({}, [{ hash: 'square', aspectRatio: '1:1' }, images[1]]),
    ).not.toThrow());
  it('blocks a missing vertical upload', () =>
    expect(() => validate({}, [images[0]])).toThrow('9:16'));
  it('blocks a missing feed upload', () =>
    expect(() => validate({}, [images[1]])).toThrow('Feed requires'));
  it('blocks the same hash tagged with two sizes', () =>
    expect(() =>
      validate({}, [images[0], { hash: 'feed', aspectRatio: '9:16' }]),
    ).toThrow('distinct'));
  it('accepts only vertical for a vertical-only ad set', () =>
    expect(() =>
      validate({ placementPreset: 'vertical' }, [images[1]]),
    ).not.toThrow());
  it('requires square and landscape for everywhere', () => {
    expect(() => validate({ placementPreset: 'everywhere' })).toThrow('1:1');
    const square = { hash: 'square', aspectRatio: '1:1' };
    expect(() =>
      validate({ placementPreset: 'everywhere' }, [...images, square]),
    ).toThrow('16:9');
    expect(() =>
      validate({ placementPreset: 'everywhere' }, [
        ...images,
        square,
        { hash: 'wide', aspectRatio: '16:9' },
      ]),
    ).not.toThrow();
  });
  it('does not inspect unused variants', () =>
    expect(() =>
      validateLaunchAssets({
        adSets: [base],
        copyVariants,
        imageHashes: { 0: images, 1: [] },
      }),
    ).not.toThrow());
  it('rejects an empty image hash', () =>
    expect(() =>
      validate({}, [images[0], { hash: '', aspectRatio: '9:16' }]),
    ).toThrow('9:16'));
  it('rejects missing copy', () =>
    expect(() =>
      validateLaunchAssets({
        adSets: [base],
        copyVariants: [],
        imageHashes: { 0: images },
      }),
    ).toThrow('missing ad copy'));
  it.each(['video'] as const)(
    'rejects missing %s video instead of silently skipping it',
    (creativeFormat) => {
      expect(() => validate({ creativeFormat })).toThrow(
        'missing uploaded video',
      );
    },
  );
  it('permits mixed video variants without image assets', () =>
    expect(() =>
      validateLaunchAssets({
        adSets: [{ ...base, creativeFormat: 'mixed' }],
        copyVariants,
        videoAssets: { 0: [{ videoId: 'video' }] },
      }),
    ).not.toThrow());
  it('validates image sizes for mixed variants without video', () =>
    expect(() => validate({ creativeFormat: 'mixed' }, [images[0]])).toThrow(
      '9:16',
    ));
  it('rejects missing carousel cards', () =>
    expect(() => validate({ creativeFormat: 'carousel' })).toThrow(
      'carousel cards',
    ));
  it('accepts a complete carousel without image variants', () =>
    expect(() =>
      validateLaunchAssets({
        adSets: [{ ...base, creativeFormat: 'carousel' }],
        copyVariants,
        carouselCards: [
          { imageHash: 'one', headline: 'One' },
          { imageHash: 'two', headline: 'Two' },
        ],
      }),
    ).not.toThrow());
  it('accepts the logged five image variants and four separate video variants in Both format', () => {
    expect(() =>
      validateLaunchAssets({
        adSets: [
          { ...base, creativeFormat: 'both', ads: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
        ],
        copyVariants: Array.from({ length: 9 }, () => copyVariants[0]),
        imageHashes: Object.fromEntries(
          [0, 1, 2, 3, 4].map((index) => [index, images]),
        ),
        videoAssets: Object.fromEntries(
          [5, 6, 7, 8].map((index) => [index, [{ videoId: `video-${index}` }]]),
        ),
      }),
    ).not.toThrow();
  });
  it('still requires placement sizes for Both image variants', () => {
    expect(() => validate({ creativeFormat: 'both' }, [images[0]])).toThrow(
      '9:16',
    );
  });
  it('rejects a Both variant with no media', () => {
    expect(() => validate({ creativeFormat: 'both' }, [])).toThrow(
      'missing uploaded image or video',
    );
  });
  it('accepts a team-selected square for both feed and vertical placements', () => {
    expect(() =>
      validate({ imagePlacementOverrides: { vertical: '1:1', feed: '1:1' } }, [
        { hash: 'square', aspectRatio: '1:1' },
      ]),
    ).not.toThrow();
  });
  it('rejects a missing overridden size', () => {
    expect(() =>
      validate({ imagePlacementOverrides: { feed: '16:9' } }),
    ).toThrow('missing uploaded 16:9');
  });
  it('rejects malformed override values', () => {
    expect(() =>
      validate({ imagePlacementOverrides: { feed: 'bad' } as any }),
    ).toThrow('Invalid image placement override');
  });
  it('rejects duplicate hashes across distinct ratios even with an unrelated override', () => {
    expect(() =>
      validate({ imagePlacementOverrides: { other: '1:1' } }, [
        { hash: 'same', aspectRatio: '4:5' },
        { hash: 'same', aspectRatio: '9:16' },
      ]),
    ).toThrow('distinct uploaded images');
  });
});
