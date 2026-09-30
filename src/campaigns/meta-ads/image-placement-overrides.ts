export type ImageRatio = '4:5' | '9:16' | '1:1' | '16:9';
export type ImagePlacementOverrides = Partial<
  Record<'feed' | 'vertical' | 'landscape' | 'other', ImageRatio>
>;

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
