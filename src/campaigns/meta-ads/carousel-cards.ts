/** Card sizes Meta accepts for carousel ads; every card in one ad shares one. */
export type CarouselRatio = '1:1' | '4:5';
export const CAROUSEL_RATIOS: CarouselRatio[] = ['1:1', '4:5'];
export const CAROUSEL_MIN_CARDS = 2;
export const CAROUSEL_MAX_CARDS = 10;

/**
 * The cut of one image to use as a carousel card: the size tagged with the
 * chosen ratio, else the first (primary) one. Untagged primaries pass through
 * because a gallery tag can be missing even when the pixels are right.
 */
export function pickCarouselCardUrl(
  sizes: Array<{ url: string; aspectRatio?: string }>,
  ratio: CarouselRatio,
): string {
  return (sizes.find((s) => s.aspectRatio === ratio) ?? sizes[0])?.url ?? '';
}

/** Throws a plain-English error when a card count can't make a carousel. */
export function assertCarouselCardCount(count: number): void {
  if (count < CAROUSEL_MIN_CARDS) {
    throw new Error(`A carousel needs at least ${CAROUSEL_MIN_CARDS} images (got ${count}).`);
  }
  if (count > CAROUSEL_MAX_CARDS) {
    throw new Error(`A carousel can have at most ${CAROUSEL_MAX_CARDS} images (got ${count}).`);
  }
}
