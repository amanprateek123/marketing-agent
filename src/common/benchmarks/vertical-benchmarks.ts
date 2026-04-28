/**
 * Vertical benchmark library — used by SignalDetectorService when a campaign
 * has insufficient historical data of its own. Without these, every cold-start
 * campaign launches with `currentCTRVsBenchmark: 'no_benchmark'` and the auditor
 * literally cannot answer "is 0.4% CTR bad for this vertical?"
 *
 * Numbers reflect India Meta DR norms (FY2025-2026) for purchase/lead-optimised
 * campaigns. Tune per tenant by storing overrides on company.benchmarkPriors —
 * these are floors, not gospel.
 */

export type ConversionEventType = 'lead' | 'install' | 'purchase' | 'subscription';

export interface VerticalBenchmark {
  ctrRangePct: { min: number; max: number };       // healthy CTR window (link CTR, %)
  cpcRangeRupees: { min: number; max: number };    // typical CPC for this vertical
  cpaRangeRupees: { min: number; max: number };    // wide CPA range covering all event types
  cpaByEventType: Record<ConversionEventType, { min: number; max: number }>;  // event-specific CPA bands
  frequencyCap: number;                            // pause-or-refresh threshold
  cvrPct: { typical: number };                     // expected click→conversion rate
}

export const VERTICAL_BENCHMARKS_INDIA: Record<string, VerticalBenchmark> = {
  spirituality: {
    ctrRangePct:    { min: 1.2, max: 5.0 },                                    // ceiling 5% — Hindi/regional reels with face-cam routinely hit 4-6%
    cpcRangeRupees: { min: 5,   max: 30 },                                     // floor 5 for tier-3 Hindi-belt
    cpaRangeRupees: { min: 80,  max: 1200 },                                   // wide: lead ₹80-350, paid consultation ₹400-1200
    cpaByEventType: {
      lead:         { min: 80,  max: 350 },
      install:      { min: 60,  max: 250 },
      purchase:     { min: 400, max: 1200 },                                   // paid consultations
      subscription: { min: 250, max: 800 },
    },
    frequencyCap:   4.0,
    cvrPct:         { typical: 6.0 },
  },
  fintech: {
    ctrRangePct:    { min: 0.5, max: 1.8 },                                    // floor 0.5% — insurance/loan cold can do 0.4-0.7%
    cpcRangeRupees: { min: 25,  max: 150 },                                    // ceiling 150 — credit cards/personal loans hit ₹100-180 in metros
    cpaRangeRupees: { min: 250, max: 6000 },                                   // wide: top-of-funnel lead ₹250-1500, approved KYC/loan ₹2000-6000
    cpaByEventType: {
      lead:         { min: 250, max: 1500 },                                   // form-fill / app-install
      install:      { min: 150, max: 600 },
      purchase:     { min: 2000, max: 6000 },                                  // KYC-completed / approved card / loan disbursement
      subscription: { min: 800, max: 3500 },
    },
    frequencyCap:   3.5,
    cvrPct:         { typical: 3.0 },
  },
  edtech: {
    ctrRangePct:    { min: 1.0, max: 3.5 },                                    // ceiling 3.5% — JEE/NEET rank-result hooks punch high
    cpcRangeRupees: { min: 15,  max: 50 },
    cpaRangeRupees: { min: 150, max: 2500 },                                   // K-12 demo ₹250-600, UPSC test-series ₹800-2500
    cpaByEventType: {
      lead:         { min: 150, max: 600 },                                    // demo bookings / free-trial
      install:      { min: 100, max: 400 },                                    // app downloads
      purchase:     { min: 800, max: 2500 },                                   // paid course
      subscription: { min: 500, max: 1800 },
    },
    frequencyCap:   4.0,
    cvrPct:         { typical: 4.5 },
  },
  ecommerce_dtc: {
    ctrRangePct:    { min: 1.0, max: 3.0 },                                    // floor 1.0 — cold-prospecting fashion/beauty sits 1.0-1.5%
    cpcRangeRupees: { min: 15,  max: 60 },
    cpaRangeRupees: { min: 200, max: 2500 },                                   // mass DTC ₹200-1200, premium DTC ₹600-2500
    cpaByEventType: {
      lead:         { min: 100, max: 500 },
      install:      { min: 80,  max: 300 },
      purchase:     { min: 200, max: 2500 },                                   // varies with AOV — see eventType-aware logic
      subscription: { min: 400, max: 1500 },
    },
    frequencyCap:   4.0,                                                       // prospecting cap; retarget-aware logic in detector should allow 6-8 for retarget pods
    cvrPct:         { typical: 2.5 },
  },
  saas_b2b: {
    ctrRangePct:    { min: 0.6, max: 1.5 },
    cpcRangeRupees: { min: 40,  max: 150 },
    cpaRangeRupees: { min: 1000, max: 8000 },                                  // demo/MQL ₹1000-3500, SQL ₹3000-8000
    cpaByEventType: {
      lead:         { min: 1000, max: 3500 },                                  // demo-request / MQL
      install:      { min: 500, max: 2000 },                                   // free-trial signup
      purchase:     { min: 3000, max: 8000 },                                  // SQL / paid customer
      subscription: { min: 2500, max: 6000 },
    },
    frequencyCap:   3.0,
    cvrPct:         { typical: 2.0 },
  },
  food_delivery: {
    ctrRangePct:    { min: 1.8, max: 4.0 },
    cpcRangeRupees: { min: 6,   max: 25 },
    cpaRangeRupees: { min: 60,  max: 600 },                                    // FTU promo-led ₹60-250, no-promo first-order ₹250-600
    cpaByEventType: {
      lead:         { min: 40,  max: 200 },
      install:      { min: 50,  max: 200 },                                    // app install
      purchase:     { min: 60,  max: 600 },                                    // first-order activation
      subscription: { min: 200, max: 800 },
    },
    frequencyCap:   5.0,
    cvrPct:         { typical: 8.0 },
  },
  health_wellness: {
    ctrRangePct:    { min: 1.0, max: 2.8 },
    cpcRangeRupees: { min: 12,  max: 45 },
    cpaRangeRupees: { min: 150, max: 1800 },                                   // telehealth consultation ₹400-1500, supplement ₹500-1800
    cpaByEventType: {
      lead:         { min: 150, max: 600 },
      install:      { min: 120, max: 400 },
      purchase:     { min: 500, max: 1800 },
      subscription: { min: 400, max: 1500 },
    },
    frequencyCap:   4.0,
    cvrPct:         { typical: 4.0 },
  },
  default: {
    ctrRangePct:    { min: 1.0, max: 2.5 },
    cpcRangeRupees: { min: 15,  max: 50 },
    cpaRangeRupees: { min: 200, max: 2500 },
    cpaByEventType: {
      lead:         { min: 150, max: 800 },
      install:      { min: 100, max: 400 },
      purchase:     { min: 200, max: 2500 },
      subscription: { min: 400, max: 1500 },
    },
    frequencyCap:   4.0,
    cvrPct:         { typical: 3.5 },
  },
};

const INDUSTRY_KEYWORDS: { match: RegExp; key: keyof typeof VERTICAL_BENCHMARKS_INDIA }[] = [
  { match: /astro|spirit|religi|tarot|horoscope|vedic|puja|mystic/i,         key: 'spirituality' },
  { match: /fin\s*tech|loan|insur|invest|wealth|banking|credit|nbfc/i,        key: 'fintech' },
  { match: /ed\s*tech|education|exam|coaching|tutor|course|upsc|jee|neet/i,   key: 'edtech' },
  { match: /e\s*comm|d2c|dtc|fashion|beauty|apparel|cosmetic|jewelry/i,       key: 'ecommerce_dtc' },
  { match: /saas|b2b|software|crm|enterprise|api/i,                           key: 'saas_b2b' },
  { match: /food|restaurant|delivery|grocery|cloud\s*kitchen/i,               key: 'food_delivery' },
  { match: /health|wellness|fitness|nutrition|ayurved|yoga|therap/i,          key: 'health_wellness' },
];

export function resolveVertical(industry: string | undefined | null): keyof typeof VERTICAL_BENCHMARKS_INDIA {
  if (!industry) return 'default';
  for (const { match, key } of INDUSTRY_KEYWORDS) {
    if (match.test(industry)) return key;
  }
  return 'default';
}

export function getBenchmark(industry: string | undefined | null): VerticalBenchmark {
  return VERTICAL_BENCHMARKS_INDIA[resolveVertical(industry)];
}

/**
 * Map company.primaryObjective ('conversions' | 'awareness' | 'traffic' | 'leads')
 * to the conversion event type that benchmarks are bucketed by. Returns null when
 * the objective doesn't have a CPA-relevant counterpart (awareness, traffic).
 */
export function eventTypeFromObjective(primaryObjective: string | undefined | null): ConversionEventType | null {
  switch (primaryObjective) {
    case 'leads':       return 'lead';
    case 'conversions': return 'purchase';
    default:            return null;
  }
}

/**
 * Get the CPA range for a campaign given its company industry + objective.
 * Falls back to the wide vertical range when objective doesn't map cleanly.
 */
export function getCPARange(
  industry: string | undefined | null,
  primaryObjective: string | undefined | null,
): { min: number; max: number; eventType: ConversionEventType | null } {
  const benchmark = getBenchmark(industry);
  const eventType = eventTypeFromObjective(primaryObjective);
  if (eventType && benchmark.cpaByEventType[eventType]) {
    return { ...benchmark.cpaByEventType[eventType], eventType };
  }
  return { ...benchmark.cpaRangeRupees, eventType: null };
}
