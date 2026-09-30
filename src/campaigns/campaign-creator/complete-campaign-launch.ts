import type {
  MetaAdSetConfig,
  MetaLaunchResult,
} from '../meta-ads/meta-ads.service';

export function expectedLaunchAdCount(adSets: MetaAdSetConfig[]): number {
  return adSets.reduce(
    (total, adSet) =>
      total +
      (adSet.creativeFormat === 'carousel'
        ? 1
        : adSet.ads.length * (adSet.creativeFormat === 'both' ? 2 : 1)),
    0,
  );
}

/** A preview request must never call activation, even after a complete launch. */
export async function completeCampaignLaunch(
  result: MetaLaunchResult,
  adSets: MetaAdSetConfig[],
  launchPaused: boolean,
  activate: () => Promise<void>,
): Promise<'active' | 'paused'> {
  const expected = expectedLaunchAdCount(adSets);
  const complete =
    result.adSets.length === adSets.length &&
    result.adSets.every(
      (adSet, index) =>
        adSet.ads.length === expectedLaunchAdCount([adSets[index]]),
    );
  if (launchPaused || expected === 0 || !complete) return 'paused';
  await activate();
  return 'active';
}
