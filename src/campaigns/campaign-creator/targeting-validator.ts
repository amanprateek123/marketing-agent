import { LANGUAGE_PRIMARY_GEOS } from './audience-targeting-resolver';

/**
 * Deterministic targeting sanity layer — runs in campaign-creator.launch()
 * AFTER the audience-targeting resolver, BEFORE the Meta Graph API.
 *
 * The resolver FILLS gaps from configured segments; this module VALIDATES the
 * combined result (LLM output + resolver patches). Without it, three classes
 * of "random" targeting reached Meta:
 *   - age ranges outside [18, 65] or inverted → opaque Meta error at launch
 *   - regional-language creative aimed at states that can't read it → silent
 *     budget burn (Meta accepts the targeting happily)
 *   - duplicate ad-set targeting → two ad sets bidding against each other
 *
 * Pure functions, no I/O — interest-ID and locale verification need the Meta
 * API and live in MetaAdsService.
 */

const AGE_FLOOR = 18;
const AGE_CEIL = 65;

/**
 * Clamp every ad set's age range into Meta's valid [18, 65] window. An
 * inverted range (min > max after clamping) means the LLM emitted nonsense —
 * we drop BOTH bounds (Meta defaults to 18-65) rather than guess which end
 * was intended. Mutates in place; returns human-readable corrections for logs.
 */
export function clampAgeRanges(adSets: Array<Record<string, any>>): string[] {
  const corrections: string[] = [];
  for (const adSet of adSets) {
    const name = adSet.name ?? 'unnamed';
    if (adSet.ageMin != null && adSet.ageMin !== 0) {
      const clamped = Math.min(Math.max(Math.round(adSet.ageMin), AGE_FLOOR), AGE_CEIL);
      if (clamped !== adSet.ageMin) {
        corrections.push(`${name}: ageMin ${adSet.ageMin} → ${clamped}`);
        adSet.ageMin = clamped;
      }
    }
    if (adSet.ageMax != null && adSet.ageMax !== 0) {
      const clamped = Math.min(Math.max(Math.round(adSet.ageMax), AGE_FLOOR), AGE_CEIL);
      if (clamped !== adSet.ageMax) {
        corrections.push(`${name}: ageMax ${adSet.ageMax} → ${clamped}`);
        adSet.ageMax = clamped;
      }
    }
    if (adSet.ageMin && adSet.ageMax && adSet.ageMin > adSet.ageMax) {
      corrections.push(`${name}: inverted age range ${adSet.ageMin}-${adSet.ageMax} dropped (Meta default 18-65 applies)`);
      delete adSet.ageMin;
      delete adSet.ageMax;
    }
  }
  return corrections;
}

/**
 * Regional languages where geo coherence is enforceable: the language has a
 * well-defined core+diaspora state set, and serving it outside that set is
 * almost certainly waste. hindi / hinglish / english are deliberately exempt —
 * they are broad-reach languages with legitimate pan-India delivery.
 */
const GEO_ENFORCED_LANGUAGES = new Set([
  'marathi', 'tamil', 'telugu', 'kannada', 'gujarati', 'punjabi', 'bengali', 'malayalam',
]);

/**
 * Enforce geo↔language coherence for regional-language creative. The mapping
 * tables (LANGUAGE_PRIMARY_GEOS) existed for months as PROMPT GUIDANCE the
 * review LLM could ignore — this turns them into code.
 *
 * Behavior per ad set (only when targetLanguage is a regional language):
 *   - geoStates fully inside core+diaspora → untouched
 *   - partial overlap → narrowed to the intersection (warn): the in-language
 *     states keep the budget instead of splitting it with states that can't
 *     read the ad
 *   - zero overlap → THROW: a Tamil creative aimed exclusively at the Hindi
 *     belt is a brief/targeting contradiction a human must resolve
 *   - no geoStates at all → set to core+diaspora (a correction, not a guess)
 *
 * Mutates in place; returns corrections for logging.
 */
export function enforceGeoLanguageCoherence(
  adSets: Array<Record<string, any>>,
  targetLanguage: string | undefined,
): string[] {
  const lang = (targetLanguage ?? '').toLowerCase().trim();
  if (!GEO_ENFORCED_LANGUAGES.has(lang)) return [];
  const geo = LANGUAGE_PRIMARY_GEOS[lang];
  if (!geo) return [];
  const allowed = new Set([...geo.core, ...geo.diaspora]);

  const corrections: string[] = [];
  for (const adSet of adSets) {
    const name = adSet.name ?? 'unnamed';
    const states: string[] = Array.isArray(adSet.geoStates) ? adSet.geoStates : [];
    if (states.length === 0) {
      adSet.geoStates = [...geo.core, ...geo.diaspora];
      corrections.push(`${name}: no geoStates — set to ${lang} core+diaspora (${adSet.geoStates.length} states)`);
      continue;
    }
    const inLanguage = states.filter(s => allowed.has(String(s)));
    if (inLanguage.length === states.length) continue;
    if (inLanguage.length === 0) {
      throw new Error(
        `Geo-language mismatch: ad set "${name}" targets ${states.length} state(s), NONE of which speak ${lang} ` +
        `(creative targetLanguage=${lang}; allowed states: ${[...allowed].join(', ')}). ` +
        `This ships an ad people can't read — fix the brief's language or the ad set's geo before launching.`,
      );
    }
    corrections.push(
      `${name}: narrowed geoStates from ${states.length} to ${inLanguage.length} (${lang}-speaking only — dropped ${states.length - inLanguage.length} mismatched state(s))`,
    );
    adSet.geoStates = inLanguage;
  }
  return corrections;
}

/**
 * Dedup interests within each ad set and flag ad sets whose ENTIRE targeting
 * spec is identical (same audienceType + audience + geo + age + gender +
 * interests). Identical ad sets bid against each other in Meta's auction and
 * split learning signal — almost always an LLM copy-paste artifact, since the
 * point of multiple ad sets is an audience A/B. Creative-format-only splits
 * (same audience, image vs video) are EXEMPT — that's a legitimate format test.
 * Returns warnings; does not mutate beyond interest dedup (the Review Team may
 * have a reason — surfacing beats silently deleting an ad set).
 */
export function checkAdSetOverlap(adSets: Array<Record<string, any>>): string[] {
  const warnings: string[] = [];
  const seen = new Map<string, string>();
  for (const adSet of adSets) {
    if (Array.isArray(adSet.interests) && adSet.interests.length > 0) {
      const deduped = [...new Set(adSet.interests.map(String))];
      if (deduped.length !== adSet.interests.length) {
        warnings.push(`${adSet.name ?? 'unnamed'}: removed ${adSet.interests.length - deduped.length} duplicate interest ID(s)`);
        adSet.interests = deduped;
      }
    }
    const spec = JSON.stringify({
      type: adSet.audienceType ?? '',
      aud: adSet.metaAudienceId ?? '',
      geo: [...(adSet.geoStates ?? [])].sort(),
      age: [adSet.ageMin ?? 0, adSet.ageMax ?? 0],
      g: adSet.gender ?? 'all',
      int: [...(adSet.interests ?? [])].sort(),
    });
    // Key includes creativeFormat so an image-vs-video split on the same
    // audience (legitimate format test) doesn't trip the warning.
    const key = `${spec}|${adSet.creativeFormat ?? 'image'}`;
    const prior = seen.get(key);
    if (prior) {
      warnings.push(
        `Ad sets "${prior}" and "${adSet.name ?? 'unnamed'}" have IDENTICAL audience targeting AND format — they will bid against each other in the same auction and split learning signal. Differentiate the audiences or merge the ad sets.`,
      );
    } else {
      seen.set(key, adSet.name ?? 'unnamed');
    }
  }
  return warnings;
}
