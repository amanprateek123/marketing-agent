/**
 * Language utilities for the creative pipeline.
 *
 * Used by copy-writer, image-generator, and creative-team to render creative
 * artifacts in the audience's target language. Without these helpers each
 * generator hardcodes "Hinglish" and serves Hindi creative to non-Hindi
 * audiences — a trust-break the autonomous system can't recover from.
 *
 * Resolution chain (resolveTargetLanguage):
 *   1. segment.languages[0]  (most specific — per-audience override)
 *   2. product.languages[0]  (product-level default)
 *   3. 'hinglish'            (sane fallback for Indian-market DTC)
 *
 * Always returns a canonical lowercase name (the helpers below key off it).
 */

export type CanonicalLanguage =
  | 'hinglish'
  | 'hindi'
  | 'english'
  | 'marathi'
  | 'tamil'
  | 'telugu'
  | 'bengali'
  | 'gujarati'
  | 'punjabi'
  | 'kannada'
  | 'malayalam'
  | 'urdu';

const ALIASES: Record<string, CanonicalLanguage> = {
  // Common spellings / abbreviations the LLM or tenant config might use.
  hinglish: 'hinglish',
  hindi: 'hindi',
  hi: 'hindi',
  english: 'english',
  en: 'english',
  marathi: 'marathi',
  mr: 'marathi',
  tamil: 'tamil',
  ta: 'tamil',
  telugu: 'telugu',
  te: 'telugu',
  bengali: 'bengali',
  bangla: 'bengali',
  bn: 'bengali',
  gujarati: 'gujarati',
  gu: 'gujarati',
  punjabi: 'punjabi',
  pa: 'punjabi',
  kannada: 'kannada',
  kn: 'kannada',
  malayalam: 'malayalam',
  ml: 'malayalam',
  urdu: 'urdu',
  ur: 'urdu',
};

export function normaliseLanguage(input: string | undefined | null): CanonicalLanguage | null {
  if (!input) return null;
  const key = String(input).toLowerCase().trim();
  return ALIASES[key] ?? null;
}

/**
 * Pick a single target language for a brief from the resolution chain.
 * Returns lowercase canonical name (e.g. 'marathi'). When the input is a
 * multi-language list, prefers the most specific non-English / non-Hinglish
 * option — Marathi beats English when both are listed, because the segment
 * is presumably language-targeting (a generic product might list all of
 * English+Hindi+Marathi, but if a segment was created with multi-language
 * support, the regional language is the differentiating signal).
 */
export function resolveTargetLanguage(input: {
  segmentLanguages?: Array<string | number> | undefined;
  productLanguages?: string[] | undefined;
}): CanonicalLanguage {
  const { segmentLanguages, productLanguages } = input;

  const pickFirstRegional = (arr: Array<string | number> | undefined): CanonicalLanguage | null => {
    if (!arr?.length) return null;
    const normalised = arr
      .map(x => typeof x === 'string' ? normaliseLanguage(x) : null)
      .filter((x): x is CanonicalLanguage => x !== null);
    // Prefer regional languages over English/Hinglish — they're the differentiating signal
    const regional = normalised.find(l => l !== 'english' && l !== 'hinglish');
    return regional ?? normalised[0] ?? null;
  };

  return pickFirstRegional(segmentLanguages)
    ?? pickFirstRegional(productLanguages)
    ?? 'hinglish';
}

/**
 * Script that the language is written in. Drives rendering directives across
 * the creative chain.
 *
 * Image overlay rule (forImageOverlay=true):
 *   Always returns 'Latin' for native-script Indian languages — Nano Banana
 *   fails Devanagari/Tamil/Bengali/etc rendering ~70% of the time. The
 *   industry workaround is "Manglish" / "Tanglish" / "Hinglish" convention:
 *   target-language VOCABULARY in Latin SCRIPT. This is the natural register
 *   for digital-native Indian audiences anyway (how people actually type on
 *   Instagram), so it's not a downgrade — it's the right register.
 *
 * Native-script rule (forImageOverlay=false or omitted):
 *   Returns the actual writing system. Used for video VO (HeyGen TTS handles
 *   Devanagari fine), email/landing-page copy generation, and any other
 *   surface where the renderer reliably supports non-Latin scripts.
 */
export function getScriptForLanguage(
  lang: CanonicalLanguage,
  opts: { forImageOverlay?: boolean } = {},
): string {
  // Manglish convention: image overlays always Latin for native-script Indian
  // languages. Nano Banana rendering reliability >> native-script authenticity
  // on a 9:16 mobile ad. The vocabulary is still the target language.
  if (opts.forImageOverlay) {
    if (lang === 'english' || lang === 'hinglish') return 'Latin';
    return 'Latin';   // Manglish / Tanglish / Hinglish for Marathi/Tamil/etc on image overlays
  }
  switch (lang) {
    case 'hindi':
    case 'marathi':
      return 'Devanagari';
    case 'tamil':
      return 'Tamil script';
    case 'telugu':
      return 'Telugu script';
    case 'bengali':
      return 'Bengali script';
    case 'gujarati':
      return 'Gujarati script';
    case 'punjabi':
      return 'Gurmukhi';
    case 'kannada':
      return 'Kannada script';
    case 'malayalam':
      return 'Malayalam script';
    case 'urdu':
      return 'Urdu (Nastaliq) script';
    case 'english':
    case 'hinglish':
    default:
      return 'Latin';
  }
}

/**
 * One-line register hint per language. Prepended to the copy + image prompts
 * so the LLM hits the right conversational vs textbook register. The 'hindi'
 * and 'hinglish' entries are tuned for Indian-market DTC; regional language
 * entries default to "conversational, NOT textbook" — extend with tenant-
 * specific register cues (Marathi: Maharashtrian household idiom, NOT
 * Marathi-news-anchor formal) over time.
 */
export const LANGUAGE_REGISTER_HINT: Record<CanonicalLanguage, string> = {
  hinglish: 'conversational Hinglish — Hindi words in Latin script with English connectors where natural. Tier-1/2 Indian metro register, NOT textbook Hindi.',
  hindi: 'conversational Hindi in Devanagari — Indore/Lucknow household register, NOT textbook (avoid sanskritised vocabulary when a colloquial word exists).',
  english: 'conversational English — Indian English idiom OK, do NOT slip into textbook or American business register.',
  marathi: 'conversational Marathi in Devanagari — Maharashtrian household register (Pune/Mumbai tier-1/2), NOT formal news-anchor Marathi. Use the natural mix of Marathi+English that real speakers use.',
  tamil: 'conversational Tamil in Tamil script — Chennai/Coimbatore household register, NOT pure literary Tamil. Natural Tanglish (Tamil+English code-switching) is fine where it matches how the audience actually speaks.',
  telugu: 'conversational Telugu in Telugu script — Hyderabad/Vijayawada household register. Natural code-switching with English/Hindi where it matches real speech.',
  bengali: 'conversational Bengali in Bengali script — Kolkata household register, NOT literary Bengali. Mix in English loanwords where real speakers do.',
  gujarati: 'conversational Gujarati in Gujarati script — Ahmedabad/Surat household register, NOT formal Gujarati. Natural code-switching with English/Hindi.',
  punjabi: 'conversational Punjabi in Gurmukhi — Amritsar/Ludhiana household register. Natural code-switching with Hindi where it matches real speech.',
  kannada: 'conversational Kannada in Kannada script — Bengaluru/Mysuru household register, NOT formal news Kannada.',
  malayalam: 'conversational Malayalam in Malayalam script — Kochi/Thiruvananthapuram household register, NOT literary Malayalam.',
  urdu: 'conversational Urdu — colloquial Hindustani register, NOT formal Persian-influenced Urdu.',
};
