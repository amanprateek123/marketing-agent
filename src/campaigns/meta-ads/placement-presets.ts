/**
 * Operator-facing placement presets — the fixed choices exposed at ad-set
 * creation and as a post-launch edit, resolved here into the raw Meta
 * targeting arrays `MetaAdsService.createAdSet`/`updateAdSetPlacements`
 * actually send. Single source of truth so the AI audit loop's
 * narrow_placement validation (audit-agent.service.ts) and this
 * operator-facing resolver never drift apart on what a "valid position" is.
 *
 * Deliberately stays scoped to Facebook + Instagram for all three presets —
 * Audience Network and Messenger are excluded even from 'everywhere', per
 * the product guardrail already documented on MetaAdsService.createAdSet
 * ("for Indian DTC, AN is mostly garbage app-install clicks... 5-15% of
 * budget historically burned there before the auditor caught it").
 */
export type PlacementPreset = 'vertical' | 'vertical_feed' | 'everywhere';

export const PLACEMENT_PRESET_LABELS: Record<PlacementPreset, string> = {
  vertical: 'Vertical only (Stories & Reels)',
  vertical_feed: 'Vertical + Feed',
  everywhere: 'Everywhere (Facebook + Instagram)',
};

// 'video_feeds' is deliberately excluded — deprecated in Meta API v21.0
// (subcode 2490562); the Reels-style surface lives under 'facebook_reels'
// now. See the matching note on MetaAdsService.createAdSet.
export const VALID_FB_POSITIONS = new Set([
  'feed',
  'right_hand_column',
  'marketplace',
  'story',
  'search',
  'instream_video',
  'facebook_reels',
  'facebook_reels_overlay',
]);
// 'shop' is deliberately excluded — deprecated (confirmed live 2026-08-06:
// Meta API error subcode 2490417, "Instagram shop placement has been
// deprecated... cannot be selected"), the same class of removal as FB's
// 'video_feeds' above.
export const VALID_IG_POSITIONS = new Set([
  'stream',
  'story',
  'explore',
  'reels',
  'profile_feed',
  'ig_search',
]);
export const VALID_AN_POSITIONS = new Set([
  'classic',
  'rewarded_video',
  'instream_video',
]);

export interface ResolvedPlacements {
  publisherPlatforms: string[];
  facebookPositions: string[];
  instagramPositions: string[];
}

/** Preset -> concrete Meta `targeting` fields. Unknown input falls back to 'vertical' (today's unconditional default), never throws. */
export function resolvePlacementPreset(
  preset: PlacementPreset | undefined | null,
): ResolvedPlacements {
  switch (preset) {
    case 'vertical_feed':
      return {
        publisherPlatforms: ['facebook', 'instagram'],
        facebookPositions: ['facebook_reels', 'story', 'feed'],
        instagramPositions: ['story', 'reels', 'stream'],
      };
    case 'everywhere':
      return {
        publisherPlatforms: ['facebook', 'instagram'],
        facebookPositions: [...VALID_FB_POSITIONS],
        instagramPositions: [...VALID_IG_POSITIONS],
      };
    case 'vertical':
    default:
      return {
        publisherPlatforms: ['facebook', 'instagram'],
        facebookPositions: ['facebook_reels', 'story'],
        instagramPositions: ['story', 'reels'],
      };
  }
}
