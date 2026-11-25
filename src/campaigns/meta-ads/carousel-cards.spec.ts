import { assertCarouselCardCount, pickCarouselCardUrl } from './carousel-cards';

describe('carousel cards', () => {
  const sizes = [
    { url: 'primary.jpg', aspectRatio: '9:16' },
    { url: 'square.jpg', aspectRatio: '1:1' },
    { url: 'portrait.jpg', aspectRatio: '4:5' },
  ];

  it('picks the size tagged with the chosen ratio', () => {
    expect(pickCarouselCardUrl(sizes, '1:1')).toBe('square.jpg');
    expect(pickCarouselCardUrl(sizes, '4:5')).toBe('portrait.jpg');
  });

  it('falls back to the primary when that ratio is missing', () => {
    expect(pickCarouselCardUrl([{ url: 'only.jpg' }], '4:5')).toBe('only.jpg');
    expect(pickCarouselCardUrl([], '1:1')).toBe('');
  });

  it('enforces 2-10 cards', () => {
    expect(() => assertCarouselCardCount(1)).toThrow(/at least 2/);
    expect(() => assertCarouselCardCount(11)).toThrow(/at most 10/);
    expect(() => assertCarouselCardCount(5)).not.toThrow();
  });
});
