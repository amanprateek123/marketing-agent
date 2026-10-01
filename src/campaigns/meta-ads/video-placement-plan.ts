import type { MetaVideoAsset } from './meta-ads.service';

/**
 * Which uploaded video serves which Ads Manager placement group, for whatever
 * sizes were supplied — all four, a subset, or a single (possibly untagged)
 * video. Never fails: each group gets its native size when one exists, else
 * the closest available, and `notes` records each substitution so the launch
 * log says which placements got a non-native cut.
 *
 * Groups match Ads Manager's placement asset customization for video:
 *   vertical → Stories, Reels, Facebook in-stream, Instagram search (9:16)
 *   feed     → Feeds and every other placement — the default (4:5, else 1:1)
 *
 * Videos can't be auto-resized the way images are (campaign-creator extends
 * images to every ratio before upload), so this acts on what was uploaded
 * rather than blocking the launch.
 */
const VERTICAL_PREFERENCE = ['9:16', '4:5', '1:1', '16:9'];
const FEED_PREFERENCE = ['4:5', '1:1', '9:16', '16:9'];

export interface VideoPlacementPlan {
  vertical: MetaVideoAsset;
  feed: MetaVideoAsset;
  /** Distinct videos the plan uses (1 or 2). */
  distinct: MetaVideoAsset[];
  /** Substitutions, e.g. "Feeds ← 9:16 (no 4:5/1:1 video)". */
  notes: string[];
}

export function planVideoPlacements(
  videos: MetaVideoAsset[],
): VideoPlacementPlan | undefined {
  const usable = videos.filter(
    (v, i) =>
      !!v.videoId && videos.findIndex((o) => o.videoId === v.videoId) === i,
  );
  if (!usable.length) return undefined;
  const sized = usable.filter((v) =>
    VERTICAL_PREFERENCE.includes(v.aspectRatio ?? ''),
  );

  // No known size at all: the first video serves every placement.
  if (!sized.length) {
    const only = usable[0];
    return {
      vertical: only,
      feed: only,
      distinct: [only],
      notes: [`All placements ← video ${only.videoId} (size unknown)`],
    };
  }

  const pick = (prefs: string[]) =>
    prefs
      .map((ratio) => sized.find((v) => v.aspectRatio === ratio))
      .find(Boolean)!;
  const vertical = pick(VERTICAL_PREFERENCE);
  const feed = pick(FEED_PREFERENCE);
  const notes: string[] = [];
  if (vertical.aspectRatio !== '9:16') {
    notes.push(`Stories/Reels ← ${vertical.aspectRatio} (no 9:16 video)`);
  }
  if (feed.aspectRatio !== '4:5' && feed.aspectRatio !== '1:1') {
    notes.push(`Feeds ← ${feed.aspectRatio} (no 4:5/1:1 video)`);
  }
  return {
    vertical,
    feed,
    distinct: vertical.videoId === feed.videoId ? [vertical] : [vertical, feed],
    notes,
  };
}
