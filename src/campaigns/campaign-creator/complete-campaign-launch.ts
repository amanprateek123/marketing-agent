import type {
  MetaAdSetConfig,
  MetaCampaignConfig,
  MetaLaunchResult,
} from '../meta-ads/meta-ads.service';

type LaunchAssets = Pick<MetaCampaignConfig, 'imageHashes' | 'videoAssets'>;

export function expectedLaunchAdCount(
  adSets: MetaAdSetConfig[],
  assets: LaunchAssets = {},
): number {
  return adSets.reduce(
    (total, adSet) =>
      total +
      (adSet.creativeFormat === 'carousel'
        ? 1
        : adSet.creativeFormat === 'both'
          ? adSet.ads.reduce(
              (count, variant) =>
                count +
                Number(
                  assets.imageHashes?.[variant]?.some(
                    (image) => !!image.hash,
                  ) ?? false,
                ) +
                Number(
                  assets.videoAssets?.[variant]?.some(
                    (video) => !!video.videoId,
                  ) ?? false,
                ),
              0,
            )
          : adSet.ads.length),
    0,
  );
}

/** A preview request must never call activation, even after a complete launch. */
export async function completeCampaignLaunch(
  result: MetaLaunchResult,
  adSets: MetaAdSetConfig[],
  launchPaused: boolean,
  activate: () => Promise<void>,
  assets: LaunchAssets = {},
): Promise<'active' | 'paused'> {
  const expected = expectedLaunchAdCount(adSets, assets);
  const complete =
    result.adSets.length === adSets.length &&
    result.adSets.every(
      (adSet, index) =>
        adSet.ads.length === expectedLaunchAdCount([adSets[index]], assets),
    );
  if (launchPaused || expected === 0 || !complete) return 'paused';
  await activate();
  return 'active';
}
