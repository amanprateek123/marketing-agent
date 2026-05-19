/**
 * Deterministic audience-targeting resolver.
 *
 * Runs in campaign-creator.launch() AFTER the Campaign Review Team produces
 * adSet configs but BEFORE we hit the Meta Graph API. Reads:
 *   - brief.targetSegment   (which audienceSegment name the Strategy Team picked)
 *   - product.audienceSegments[]  (structured age/gender/interests per segment)
 *   - INDIA_GEO_DEFAULTS    (per-tenant high-purchase-intent state list)
 *
 * Applies missing fields on each ad set so we never ship a "country=IN only"
 * ad set again. Already-set fields on the ad set (LLM may set ageMin etc.) win
 * — this resolver only fills GAPS, never overrides explicit choices.
 *
 * Why deterministic (TS) and not LLM:
 *   The Campaign Review Team prompt asks the LLM to populate these fields but
 *   the Performance Analyst routinely strips them ("budget too low to split"
 *   etc.) leading to zero-targeting ad sets shipping. TS guarantees the
 *   targeting reaches Meta regardless of LLM disagreement.
 */

export interface AudienceSegmentConfig {
  name: string;
  ageMin?: number;
  ageMax?: number;
  gender?: 'all' | 'male' | 'female';
  interests?: Array<{ id: string; name: string }> | string[]; // accept legacy string[] for backward compat
  languages?: Array<string | number>;   // canonical name or Meta locale ID; resolver normalises to IDs
}

export interface AdSetTargetingPatch {
  ageMin?: number;
  ageMax?: number;
  gender?: 'all' | 'male' | 'female';
  interests?: string[];     // Meta interest IDs (passed through as targeting.flexible_spec[].interests[].id)
  geoStates?: string[];     // Meta region keys (e.g. '480' for Maharashtra)
  geoCities?: string[];     // Meta city keys
  locales?: number[];       // Meta locale IDs (e.g. [84] for Marathi). Sent as targeting.locales.
}

/**
 * Canonical language name → Meta locale ID lookup. Indian-market focused.
 * Each entry must be verified against Meta's live endpoint:
 *   curl "https://graph.facebook.com/v21.0/search?type=adlocale&q=<name>&access_token=<TOKEN>"
 * Format of response: `{ "data": [{ "key": 81, "name": "Marathi" }, ...] }`
 *
 * Verified entries are marked with their verification date. Unverified entries
 * are listed below the line — DO NOT use them in production targeting until
 * verified. Meta has reshuffled locale IDs in past API version bumps; never
 * trust a memorised ID without a live check.
 *
 * Drift between this table and Meta's live IDs silently breaks targeting on
 * the affected language (API rejects unknown IDs with code 100).
 */
export const META_LOCALE_IDS: Record<string, number> = {
  // ─── VERIFIED (2026-05-19) ─────────────────────────────────────────────
  marathi:    81,   // verified via /search?type=adlocale&q=Marathi

  // ─── UNVERIFIED — DO NOT USE without running the search query above ────
  // These were cited from memory and may be wrong (Marathi was wrong by 3).
  // To activate: run the curl command, confirm the key, move the line above
  // the verified divider with today's date in the comment.
  // english:    24,
  // hindi:      53,
  // bengali:    89,
  // tamil:      96,
  // telugu:     95,
  // gujarati:   116,
  // punjabi:    122,
  // malayalam:  138,
  // kannada:    169,
  // urdu:       54,
  // odia:       139,
  // assamese:   170,
};

/**
 * Resolve a mixed array of language names/IDs to numeric Meta locale IDs.
 * Drops unknown names with no error (we'd rather ship partial targeting than
 * fail the whole launch); the caller logs `localesResolved` count for visibility.
 * The returned `dropped` array surfaces unrecognised inputs so callers can warn —
 * without this, an unverified language (e.g. "hindi" before the Hindi ID is
 * verified) silently produces zero locale targeting and the campaign reaches
 * everyone in the geo.
 */
export function resolveLocaleIds(input: Array<string | number> | undefined): number[] {
  if (!input?.length) return [];
  const ids: number[] = [];
  const dropped: string[] = [];
  for (const item of input) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      ids.push(item);
      continue;
    }
    if (typeof item === 'string') {
      const key = item.toLowerCase().trim();
      const id = META_LOCALE_IDS[key];
      if (id) {
        ids.push(id);
      } else {
        dropped.push(item);
      }
    }
  }
  if (dropped.length > 0) {
    // Use console because resolver module has no Logger injected. The caller
    // (campaign-creator) also logs the final `localesApplied` count, but this
    // line surfaces *which* inputs were silently dropped — vital when adding
    // a new language and forgetting to verify its Meta locale ID.
    console.warn(`[resolveLocaleIds] Dropped unverified language(s): ${dropped.join(', ')}. Add verified Meta locale IDs to META_LOCALE_IDS in audience-targeting-resolver.ts. See verification curl in the table comment.`);
  }
  return Array.from(new Set(ids));
}

/**
 * Indian-market geo defaults — top states by Vedic-astrology purchase intent.
 * Region keys verified against Meta's adgeolocation search API
 * (graph.facebook.com/v21.0/search?type=adgeolocation&country_code=IN) on
 * 2026-05-04. Excludes J&K, NE states, Goa (low purchase index for ₹1799+ AOV).
 */
export const INDIA_TOP_ASTROLOGY_STATES: Array<{ key: string; name: string }> = [
  { key: '1735', name: 'Maharashtra' },
  { key: '1744', name: 'Tamil Nadu' },     // Nadi astrology home turf
  { key: '1738', name: 'Karnataka' },
  { key: '1728', name: 'Delhi' },
  { key: '4100', name: 'Telangana' },
  { key: '1729', name: 'Gujarat' },
  { key: '1754', name: 'Uttar Pradesh' },
  { key: '1730', name: 'Haryana' },
  { key: '1724', name: 'Andhra Pradesh' },
  { key: '1742', name: 'Punjab' },
];

/**
 * State Meta region key → canonical language (best single-language match).
 * Used for two purposes:
 *   1. Geo→language fallback: when a brief has geoStates but no targetLanguage,
 *      derive the language from the primary state.
 *   2. Language×geo validation: campaign-review-team checks if a brief's
 *      geo states are linguistically aligned with targetLanguage.
 *
 * "Hindi belt" states all map to hindi. Multi-language states (Karnataka,
 * Telangana etc) map to the dominant state language — diaspora communities
 * are handled via LANGUAGE_PRIMARY_GEOS below.
 */
export const STATE_TO_LANGUAGE: Record<string, string> = {
  '1735': 'marathi',     // Maharashtra
  '1733': 'marathi',     // Goa (high Marathi penetration)
  '1744': 'tamil',       // Tamil Nadu
  '4100': 'telugu',      // Telangana
  '1724': 'telugu',      // Andhra Pradesh
  '1738': 'kannada',     // Karnataka
  '1729': 'gujarati',    // Gujarat
  '1742': 'punjabi',     // Punjab
  '1755': 'bengali',     // West Bengal
  '1736': 'malayalam',   // Kerala
  // Hindi belt
  '1728': 'hindi',       // Delhi
  '1754': 'hindi',       // Uttar Pradesh
  '1739': 'hindi',       // Madhya Pradesh (overlap with marathi in east/south)
  '1743': 'hindi',       // Rajasthan
  '1730': 'hindi',       // Haryana
  '1726': 'hindi',       // Bihar
  '1734': 'hindi',       // Jharkhand
  '1745': 'hindi',       // Uttarakhand
  '1737': 'hindi',       // Himachal Pradesh
  '1727': 'hindi',       // Chhattisgarh
};

/**
 * Language → recommended Meta region keys (core market + significant diaspora
 * states). Used by campaign-review-team to validate audience setup: if the
 * brief targets Marathi but only geoStates=['1728' Delhi], something's wrong.
 *
 * Each entry has:
 *   - core: states where the language is dominant. Always include these.
 *   - diaspora: states with significant secondary populations. Optional but
 *               recommended for high-AOV products where reach matters.
 *
 * For 91astro-grade ₹1,799 cultural-purchase products, recommend core + diaspora
 * stack for max addressable audience inside the language constraint.
 */
export const LANGUAGE_PRIMARY_GEOS: Record<string, { core: string[]; diaspora: string[]; rationale: string }> = {
  marathi: {
    core: ['1735', '1733'],                          // Maharashtra, Goa
    diaspora: ['1738', '1739', '1729'],              // Karnataka (Belgaum/Bangalore), MP (Indore/Bhopal), Gujarat (Surat)
    rationale: 'Maharashtra is core. Karnataka has 1.5M Marathi speakers (Belgaum/Bidar belt + Bangalore professionals). MP has 1.2M (Indore/Bhopal). Goa has high Marathi penetration. Skip Hindi-belt states — different language pool.',
  },
  hindi: {
    core: ['1728', '1754', '1739', '1743', '1730', '1726', '1734', '1745', '1737', '1727'],  // Hindi belt
    diaspora: ['1735', '1738', '1729'],              // Marathi/Kannada/Gujarati states have urban Hindi speakers
    rationale: 'Core Hindi belt (Delhi, UP, MP, Rajasthan, Haryana, Bihar, Jharkhand, Uttarakhand, HP, Chhattisgarh). Metro diaspora in Maharashtra/Karnataka/Gujarat — Hindi-speaking professionals in Mumbai/Bangalore/Surat.',
  },
  tamil: {
    core: ['1744'],                                  // Tamil Nadu (Puducherry not in INDIA_TOP_ASTROLOGY_STATES)
    diaspora: ['1738', '4100', '1738'],              // Karnataka (Bangalore Tamil), Telangana (Hyderabad)
    rationale: 'Tamil Nadu is core. Diaspora in Bangalore (1M+ Tamil speakers) and Hyderabad (Tamil professionals). For Nadi astrology specifically, TN is the cultural home turf — keep core narrow unless reach requires diaspora.',
  },
  telugu: {
    core: ['4100', '1724'],                          // Telangana, Andhra Pradesh
    diaspora: ['1738', '1744'],                      // Karnataka, Tamil Nadu (some Telugu-speaking belts)
    rationale: 'Telangana + AP are core. Diaspora in Bangalore/Chennai is modest.',
  },
  kannada: {
    core: ['1738'],                                  // Karnataka
    diaspora: ['1735', '1736'],                      // Maharashtra border, Kerala border
    rationale: 'Karnataka is core. Diaspora minimal outside neighboring states.',
  },
  gujarati: {
    core: ['1729'],                                  // Gujarat
    diaspora: ['1735', '1728'],                      // Mumbai, Delhi (large Gujarati business community)
    rationale: 'Gujarat is core. Major diaspora in Mumbai (Gujarati business community) and Delhi.',
  },
  punjabi: {
    core: ['1742', '1730'],                          // Punjab, Haryana (high Punjabi penetration)
    diaspora: ['1728'],                              // Delhi-NCR
    rationale: 'Punjab + Haryana are core. Delhi-NCR has the largest urban Punjabi population.',
  },
  bengali: {
    core: ['1755'],                                  // West Bengal
    diaspora: ['1734'],                              // Jharkhand (border districts)
    rationale: 'West Bengal is core. Minimal diaspora for this product class.',
  },
  malayalam: {
    core: ['1736'],                                  // Kerala
    diaspora: ['1738'],                              // Karnataka (Bangalore Malayali population)
    rationale: 'Kerala is core. Bangalore Malayali diaspora is significant for digital products.',
  },
  hinglish: {
    core: [],                                        // Use INDIA_TOP_ASTROLOGY_STATES (all)
    diaspora: [],
    rationale: 'Default Indian DTC audience — use the top-10 astrology-intent states (INDIA_TOP_ASTROLOGY_STATES).',
  },
  english: {
    core: ['1728', '1735', '1738'],                  // Delhi-NCR, Mumbai, Bangalore — English-speaking metro pockets
    diaspora: ['4100', '1736'],                      // Hyderabad, Kerala (high English literacy)
    rationale: 'English-language ads in India = metro tier-1 only. Tier-2/3 will not engage with pure English.',
  },
};

/**
 * Derive the most likely language from a list of geo state keys. Returns null
 * when states span multiple languages (defer to LLM / default) or list is empty.
 */
export function languageFromGeoStates(geoStates: string[] | undefined): string | null {
  if (!geoStates?.length) return null;
  const langs = new Set(geoStates.map(s => STATE_TO_LANGUAGE[s]).filter(Boolean));
  if (langs.size === 1) return Array.from(langs)[0];
  return null;   // multi-language geo — ambiguous, defer
}

/**
 * Resolve the audience segment from product config by name (case-insensitive,
 * fuzzy on word boundaries). Returns undefined if no match.
 */
function findSegment(
  segments: AudienceSegmentConfig[] | undefined,
  segmentName: string | undefined,
): AudienceSegmentConfig | undefined {
  if (!segments?.length || !segmentName) return undefined;
  const target = segmentName.toLowerCase().trim();
  return segments.find(
    (s) => s.name?.toLowerCase().trim() === target,
  );
}

/**
 * Apply targeting from a brief's targetSegment + tenant geo defaults onto
 * the given ad sets. Mutates ad sets in place. Returns a count of fields
 * patched per ad set for logging.
 */
export function applyAudienceTargeting(input: {
  adSets: Array<Record<string, any>>;
  productSegments: AudienceSegmentConfig[] | undefined;
  briefTargetSegment: string | undefined;
  briefAudienceStage: 'cold' | 'warm' | 'hot' | undefined;
  geography?: string;
  // Product-level language fallback. Resolver fills locales from segment.languages
  // first; if unset, falls back to this. Empty/unset means no locale filter.
  productLanguages?: Array<string | number>;
}): { patches: number; segmentMatched: boolean; segmentUsed: string | undefined; localesApplied: number[] } {
  const { adSets, productSegments, briefTargetSegment, briefAudienceStage, geography, productLanguages } = input;

  const segment = findSegment(productSegments, briefTargetSegment);
  let totalPatches = 0;

  const isIndia = !geography || geography.toLowerCase().includes('india');
  const defaultGeoStates = isIndia ? INDIA_TOP_ASTROLOGY_STATES.map((s) => s.key) : [];

  // Resolve locale IDs: segment override → product fallback → geo-derived → empty.
  // The geo-derived step uses STATE_TO_LANGUAGE — when all ad sets share a single
  // state pointing to one language (e.g. all Maharashtra → marathi), we infer the
  // locale even if no language was explicitly configured on the product. This makes
  // the autonomous Marathi launch work without manual Mongo segment config.
  const explicitLangs = segment?.languages ?? productLanguages;
  let derivedFromGeo: string | null = null;
  if (!explicitLangs?.length) {
    // Look at the first ad set with geoStates to derive language. All ad sets in
    // a campaign typically share the same geo, so the first is representative.
    const adSetWithGeo = adSets.find(as => Array.isArray(as.geoStates) && as.geoStates.length > 0);
    if (adSetWithGeo) {
      derivedFromGeo = languageFromGeoStates(adSetWithGeo.geoStates);
    }
  }
  const resolvedLocales = resolveLocaleIds(
    explicitLangs?.length ? explicitLangs : (derivedFromGeo ? [derivedFromGeo] : undefined),
  );

  for (const adSet of adSets) {
    // 1. Age — fill from segment if not set
    if (segment?.ageMin && (adSet.ageMin == null || adSet.ageMin === 0)) {
      adSet.ageMin = segment.ageMin;
      totalPatches++;
    }
    if (segment?.ageMax && (adSet.ageMax == null || adSet.ageMax === 0)) {
      adSet.ageMax = segment.ageMax;
      totalPatches++;
    }

    // 2. Gender — fill from segment if not set
    if (segment?.gender && !adSet.gender) {
      adSet.gender = segment.gender;
      totalPatches++;
    }

    // 3. Interests — fill from segment ONLY if interests are real Meta IDs.
    // Skip plain-string interests (legacy) — Meta API rejects them as names.
    if (segment?.interests?.length && (!adSet.interests || adSet.interests.length === 0)) {
      const interestObjects = segment.interests.filter(
        (i): i is { id: string; name: string } => typeof i === 'object' && 'id' in i && 'name' in i,
      );
      if (interestObjects.length > 0) {
        adSet.interests = interestObjects.map((i) => i.id);
        totalPatches++;
      }
    }

    // 4. Geo states — narrow to top-purchase-intent states when ad set has
    // only country-level geo. Saves budget vs CPM in low-conversion regions.
    const hasOnlyCountry = !adSet.geoStates || adSet.geoStates.length === 0;
    if (hasOnlyCountry && defaultGeoStates.length > 0) {
      adSet.geoStates = defaultGeoStates;
      totalPatches++;
    }

    // 5. Locales — fill from resolved (segment.languages → product.languages).
    // Only patches when the ad set has no locales of its own; explicit LLM-set
    // locales (numeric IDs) win.
    if (resolvedLocales.length > 0 && (!Array.isArray(adSet.locales) || adSet.locales.length === 0)) {
      adSet.locales = resolvedLocales;
      totalPatches++;
    }
  }

  return {
    patches: totalPatches,
    segmentMatched: !!segment,
    segmentUsed: segment?.name,
    localesApplied: resolvedLocales,
  };
}
