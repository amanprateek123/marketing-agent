export type ImageRatio = '4:5' | '9:16' | '1:1' | '16:9';
/**
 * Per-group size overrides, grouped the way Ads Manager's placement asset
 * customization groups placements:
 *   vertical → Stories, Reels, Facebook in-stream, Instagram search (9:16)
 *   other    → Facebook right column + Facebook search (1:1)
 *   feed     → Feeds and every other placement — the default (4:5, else 1:1)
 * `landscape` is a legacy key from the earlier four-group mapping and is read
 * as `other` when `other` isn't set, so saved campaigns keep launching.
 */
export type ImagePlacementOverrides = Partial<
  Record<'feed' | 'vertical' | 'landscape' | 'other', ImageRatio>
>;

/** Ratio chosen for the right column + search group (legacy `landscape` honoured). */
export function rightColumnSearchRatio(overrides: ImagePlacementOverrides = {}): ImageRatio {
  return overrides.other ?? overrides.landscape ?? '1:1';
}

export function validateImagePlacementOverrides(
  value: unknown,
): asserts value is ImagePlacementOverrides | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Image placement overrides must be an object.');
  }
  for (const [group, ratio] of Object.entries(value)) {
    if (
      !['feed', 'vertical', 'landscape', 'other'].includes(group) ||
      !['4:5', '9:16', '1:1', '16:9'].includes(ratio as string)
    ) {
      throw new Error(
        `Invalid image placement override: ${group}. Use 4:5, 9:16, 1:1 or 16:9.`,
      );
    }
  }
}
