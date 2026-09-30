import { validateImagePlacementOverrides } from './image-placement-overrides';
import type { MetaCampaignConfig } from './meta-ads.service';

/** Validate uploaded assets before creating any campaign objects on Meta. */
export function validateLaunchAssets(
  config: Pick<
    MetaCampaignConfig,
    'adSets' | 'copyVariants' | 'imageHashes' | 'videoAssets' | 'carouselCards'
  >,
): void {
  for (const adSet of config.adSets) {
    validateImagePlacementOverrides(adSet.imagePlacementOverrides);
    const format = adSet.creativeFormat ?? 'image';
    if (format === 'carousel') {
      if (
        (config.carouselCards?.length ?? 0) < 2 ||
        config.carouselCards?.some((card) => !card.imageHash)
      ) {
        throw new Error(
          `Ad set "${adSet.name}" requires at least two successfully uploaded carousel cards.`,
        );
      }
      continue;
    }
    for (const variant of adSet.ads) {
      const context = `Ad set "${adSet.name}", variant ${variant + 1}`;
      if (!config.copyVariants[variant])
        throw new Error(`${context}: missing ad copy.`);
      const videos = config.videoAssets?.[variant] ?? [];
      const hasVideo = videos.some((video) => !!video.videoId);
      const images = (config.imageHashes?.[variant] ?? []).filter(
        (image) => !!image.hash,
      );
      const hasImage = images.length > 0;
      if (format === 'both' && !hasVideo && !hasImage) {
        throw new Error(`${context}: missing uploaded image or video.`);
      }
      if (format === 'video' && !hasVideo) {
        throw new Error(`${context}: missing uploaded video.`);
      }
      const needsImage =
        format === 'image' ||
        (format === 'both' && hasImage) ||
        (format === 'mixed' && !hasVideo);
      if (!needsImage) continue;
      const overrides = adSet.imagePlacementOverrides;
      if (overrides && Object.keys(overrides).length) {
        const required = [overrides.vertical ?? '9:16'];
        if ((adSet.placementPreset ?? 'vertical') !== 'vertical') {
          required.push(
            overrides.feed ??
              (images.some((image) => image.aspectRatio === '4:5')
                ? '4:5'
                : '1:1'),
          );
        }
        if (adSet.placementPreset === 'everywhere') {
          required.push(
            overrides.other ?? '1:1',
            overrides.landscape ?? '16:9',
          );
        }
        const hashesByRatio = new Map<string, string>();
        for (const ratio of new Set(required)) {
          const image = images.find((image) => image.aspectRatio === ratio);
          if (!image) {
            throw new Error(
              `${context}: missing uploaded ${ratio} image required by the placement mapping.`,
            );
          }
          const previousRatio = hashesByRatio.get(image.hash);
          if (previousRatio && previousRatio !== ratio) {
            throw new Error(
              `${context}: ${previousRatio} and ${ratio} require distinct uploaded images.`,
            );
          }
          hashesByRatio.set(image.hash, ratio);
        }
        continue;
      }
      const vertical = images.find((image) => image.aspectRatio === '9:16');
      if (!vertical)
        throw new Error(
          `${context}: missing uploaded 9:16 image for Stories/Reels. Supply or regenerate that size before launching.`,
        );
      if ((adSet.placementPreset ?? 'vertical') !== 'vertical') {
        const feed =
          images.find((image) => image.aspectRatio === '4:5') ??
          images.find((image) => image.aspectRatio === '1:1');
        if (!feed || feed.hash === vertical.hash) {
          throw new Error(
            `${context}: Feed requires a distinct uploaded 4:5 or 1:1 image in addition to 9:16.`,
          );
        }
      }
      if (adSet.placementPreset === 'everywhere') {
        for (const ratio of ['1:1', '16:9']) {
          if (
            !images.some(
              (image) =>
                image.aspectRatio === ratio && image.hash !== vertical.hash,
            )
          ) {
            throw new Error(
              `${context}: Everywhere placements require an uploaded ${ratio} image. Supply that size or narrow the placement selection.`,
            );
          }
        }
      }
    }
  }
}
