/**
 * Hook-style inference from free-text Meta ad copy.
 *
 * Why this exists:
 *   The Meta learning importer needs to label historical ads with a hookStyle
 *   so pattern-calculator can rank performance per (audienceType, hookStyle).
 *   Previously pattern-calculator AND campaign-sync each had their own copy of
 *   inferHookStyle that returned a 9-style enum (ugc / question / fear_then_relief
 *   / curiosity / personal_story etc.) which DOES NOT INTERSECT with the
 *   canonical 7+meme taxonomy in hook-styles.ts. Result: imported `winningHooks`
 *   referenced styles like `personal_story` that no live ad will ever match,
 *   so Day-7 saturation and winner/loser scans operated on a different alphabet
 *   than the importer.
 *
 *   This util is the single source of truth for inferring hookStyle from
 *   historical copy. Output is always a canonical HookStyle (or `'unknown'`).
 *
 * Mapping rationale (legacy regex → canonical):
 *   - ugc / testimonial → social_proof  (UGC is a form of social proof)
 *   - personal_story    → social_proof  (a story IS the proof)
 *   - question          → curiosity_gap (questions create info gaps)
 *   - fear_then_relief  → pain_point    (the fear IS the pain hook)
 *   - curiosity         → curiosity_gap (direct mapping)
 *   - bold_claim        → bold_claim    (direct mapping)
 *   - urgency           → urgency       (direct mapping)
 *   - social_proof      → social_proof  (direct mapping)
 *   New patterns we now detect (weren't in old enum):
 *   - price_shock       — explicit ₹ value or discount %
 *   - before_after      — transformation language
 */

import { HOOK_STYLES_DR, HOOK_STYLE_DESCRIPTIONS } from './hook-styles';

type CanonicalHookStyle = (typeof HOOK_STYLES_DR)[number];

/**
 * Infer canonical hookStyle from ad copy. Returns 'unknown' if no pattern
 * matches — caller can decide whether to drop the ad from learning or fall
 * back to an LLM batch labelling pass for high-unknown-rate imports.
 *
 * Order matters: most specific patterns first.
 */
export function inferHookStyleFromCopy(
  adName: string,
  copyBody: string = '',
  copyTitle: string = '',
): CanonicalHookStyle | 'unknown' {
  const combined = `${adName} ${copyBody} ${copyTitle}`.toLowerCase();

  // ── price_shock — explicit price/discount language. Check FIRST because
  //    "₹999 only" can also match urgency keywords downstream, but the price
  //    is the dominant hook.
  if (/[₹$]\s*\d{2,}|rs\.?\s*\d{2,}|\d+\s*%\s*(off|discount|chhoot|kam)|flat\s*\d+|just\s*[₹$]?\s*\d+|sirf\s*[₹$]?\s*\d+|aaj\s*ka\s*offer/.test(combined)) {
    return 'price_shock';
  }

  // ── before_after — transformation language (kg lost, before/after, in N days)
  if (/before\s*(?:&|and|\/|-)\s*after|kg\s*(?:loss|lost|gain|kam|less|more)|\d+\s*(?:days?|weeks?|din|hafte)\s*(?:me|in)|transformation|glow\s*up|naya|naye\s*you|new\s*me/.test(combined)) {
    return 'before_after';
  }

  // ── social_proof — UGC, testimonials, ratings, customer counts (covers old `ugc` and `personal_story` buckets)
  if (/ugc|testimonial|real\s*customer|actual\s*customer|meri\s*kahani|mere\s*saath\s*hua|meri\s*story|my\s*story|i\s*was|personal\s*story|maine\s*try|maine\s*use|mere\s*jaisa|hum\s*sab|satisfied\s*customer/.test(combined)) {
    return 'social_proof';
  }
  if (/\d+[\s,]*(?:lakh|lac|k|thousand|crore|cr|hazaar)\+?\s*(?:customer|log|user|review|order|rating|happy|trust|families|families)|(?:4\.\d|5\.0|5\s*star)\s*(?:star|rating)?|top\s*rated|best\s*seller|#1|number\s*1|trusted\s*by|join\s+\d+/.test(combined)) {
    return 'social_proof';
  }

  // ── urgency — time/stock scarcity
  if (/sirf\s*aaj|limited|abhi|last\s*chance|offer\s*ends|hurry|jaldi|kal\s*se|today\s*only|expir|deadline|closing|running\s*out|stock\s*khatam|few\s*left/.test(combined)) {
    return 'urgency';
  }

  // ── pain_point — fear / problem / dosha (covers old `fear_then_relief`)
  if (/problem|pareshaan|pareshan|tension|dard|struggle|takleef|mushkil|worry|anxious|scared|dar|bhay|crisis|failed|fail|negative|dosha|dosh|pap|grahan|sade\s*sati|dhaiya|tired|exhausted|stress|frustrated|suffering/.test(combined)) {
    return 'pain_point';
  }

  // ── curiosity_gap — secret, reveal, questions (covers old `curiosity` AND `question`)
  if (/\?|kya\s*aap|kya\s*aapka|kya\s*ho|kyun|kaise|kitna|kaun\s*sa|kab|kya\s*pata|jaante\s*hain|did\s*you\s*know|are\s*you|do\s*you|have\s*you|secret|hidden|jaano|discover|pata\s*karo|reveal|untold|exclusive|insider|raaz|chhupayi|ankhon|khulasa|nobody\s*tells/.test(combined)) {
    return 'curiosity_gap';
  }

  // ── bold_claim — guarantees, proofs, "the best"
  if (/guaranteed|100\s*%|proven|scientific|authentic|original|genuine|sabse|best|certified|verified|fact|research|study|data|gold\s*standard|world['s]*\s*best/.test(combined)) {
    return 'bold_claim';
  }

  return 'unknown';
}

/**
 * Infer audienceType from Meta ad set name. Used when targeting object isn't
 * available (legacy import paths). Prefer reading targeting.custom_audiences /
 * targeting_automation.advantage_audience when you have the full ad set object.
 */
export function inferAudienceType(adSetName: string): string {
  const lower = (adSetName ?? '').toLowerCase();
  if (lower.includes('lookalike') || lower.includes('lal') || lower.includes('lla')) return 'lookalike';
  if (lower.includes('advantage') || lower.includes('a+')) return 'advantage_plus';
  if (lower.includes('retarget') || lower.includes('remarket')) return 'retarget';
  if (lower.includes('interest') || lower.includes('inmarket')) return 'interest';
  if (lower.includes('broad')) return 'broad';
  if (lower.includes('performing')) return 'performing_export';
  if (lower.includes('custom')) return 'custom';
  return 'other';
}

/**
 * Infer creative format from Meta creative payload. Falls back to ad-name
 * hints when the creative object isn't shaped as expected. Returns one of:
 * 'video' | 'image' | 'carousel' | 'reel' | 'story' | 'unknown'.
 */
export function inferFormatFromCreative(creative: any, adName: string = ''): string {
  // Primary path — use the creative object structure (most reliable)
  if (creative?.object_story_spec?.video_data) return 'video';
  if (creative?.object_story_spec?.link_data?.child_attachments?.length > 0) return 'carousel';
  if (creative?.object_story_spec?.link_data) return 'image';
  if (creative?.asset_feed_spec?.videos?.length > 0) return 'video';
  if (creative?.asset_feed_spec?.images?.length > 0) return 'image';

  // Fallback — name hints
  const name = (adName ?? '').toLowerCase();
  if (name.includes('reel')) return 'reel';
  if (name.includes('story') || name.includes('stories')) return 'story';
  if (name.includes('video') || name.includes('vid')) return 'video';
  if (name.includes('carousel')) return 'carousel';
  if (name.includes('image') || name.includes('feed')) return 'image';
  return 'unknown';
}

/**
 * Validate inferred hookStyle and log unknowns at scale. Returns a stable
 * "unknown_ratio" caller can use to gate fallback strategies (e.g. fall back
 * to LLM batch labelling when > 40% unknown).
 */
export function computeUnknownRatio(
  inferred: Array<CanonicalHookStyle | 'unknown'>,
): number {
  if (inferred.length === 0) return 0;
  return inferred.filter((s) => s === 'unknown').length / inferred.length;
}

export { HOOK_STYLE_DESCRIPTIONS };
