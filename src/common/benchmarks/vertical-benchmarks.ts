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

export interface VerticalBenchmark {
  ctrRangePct: { min: number; max: number };       // healthy CTR window (link CTR, %)
  cpcRangeRupees: { min: number; max: number };    // typical CPC for this vertical
  cpaRangeRupees: { min: number; max: number };    // typical CPA (purchase / lead)
  frequencyCap: number;                            // pause-or-refresh threshold
  cvrPct: { typical: number };                     // expected click→conversion rate
}

export const VERTICAL_BENCHMARKS_INDIA: Record<string, VerticalBenchmark> = {
  spirituality: {
    ctrRangePct:    { min: 1.2, max: 3.5 },
    cpcRangeRupees: { min: 8,   max: 30 },
    cpaRangeRupees: { min: 80,  max: 350 },
    frequencyCap:   4.0,
    cvrPct:         { typical: 6.0 },
  },
  fintech: {
    ctrRangePct:    { min: 0.6, max: 1.8 },
    cpcRangeRupees: { min: 25,  max: 80 },
    cpaRangeRupees: { min: 250, max: 1500 },
    frequencyCap:   3.5,
    cvrPct:         { typical: 3.0 },
  },
  edtech: {
    ctrRangePct:    { min: 1.0, max: 2.5 },
    cpcRangeRupees: { min: 15,  max: 50 },
    cpaRangeRupees: { min: 150, max: 800 },
    frequencyCap:   4.0,
    cvrPct:         { typical: 4.5 },
  },
  ecommerce_dtc: {
    ctrRangePct:    { min: 1.5, max: 3.0 },
    cpcRangeRupees: { min: 15,  max: 60 },
    cpaRangeRupees: { min: 200, max: 1200 },
    frequencyCap:   4.0,
    cvrPct:         { typical: 2.5 },
  },
  saas_b2b: {
    ctrRangePct:    { min: 0.6, max: 1.5 },
    cpcRangeRupees: { min: 40,  max: 150 },
    cpaRangeRupees: { min: 500, max: 4000 },
    frequencyCap:   3.0,
    cvrPct:         { typical: 2.0 },
  },
  food_delivery: {
    ctrRangePct:    { min: 1.8, max: 4.0 },
    cpcRangeRupees: { min: 6,   max: 25 },
    cpaRangeRupees: { min: 60,  max: 250 },
    frequencyCap:   5.0,
    cvrPct:         { typical: 8.0 },
  },
  health_wellness: {
    ctrRangePct:    { min: 1.0, max: 2.8 },
    cpcRangeRupees: { min: 12,  max: 45 },
    cpaRangeRupees: { min: 150, max: 900 },
    frequencyCap:   4.0,
    cvrPct:         { typical: 4.0 },
  },
  default: {
    ctrRangePct:    { min: 1.0, max: 2.5 },
    cpcRangeRupees: { min: 15,  max: 50 },
    cpaRangeRupees: { min: 200, max: 1200 },
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
