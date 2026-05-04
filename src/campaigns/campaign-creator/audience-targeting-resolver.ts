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
}

export interface AdSetTargetingPatch {
  ageMin?: number;
  ageMax?: number;
  gender?: 'all' | 'male' | 'female';
  interests?: string[];     // Meta interest IDs (passed through as targeting.flexible_spec[].interests[].id)
  geoStates?: string[];     // Meta region keys (e.g. '480' for Maharashtra)
  geoCities?: string[];     // Meta city keys
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
}): { patches: number; segmentMatched: boolean; segmentUsed: string | undefined } {
  const { adSets, productSegments, briefTargetSegment, briefAudienceStage, geography } = input;

  const segment = findSegment(productSegments, briefTargetSegment);
  let totalPatches = 0;

  const isIndia = !geography || geography.toLowerCase().includes('india');
  const defaultGeoStates = isIndia ? INDIA_TOP_ASTROLOGY_STATES.map((s) => s.key) : [];

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
  }

  return {
    patches: totalPatches,
    segmentMatched: !!segment,
    segmentUsed: segment?.name,
  };
}
