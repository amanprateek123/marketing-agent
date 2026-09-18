/**
 * Campaign names carry structure that nothing downstream reads.
 *
 * Operators encode real dimensions into Meta campaign names — product, funnel
 * stage, budget model, language, test intent:
 *
 *   "Nadi-Report-ABO-July'26-Test Festivals"
 *   "Nadi Leaf - New Batch_2026-07-20 - TAT"
 *   "Nadi-Report-Retargeting-Stage2-EN_2026-07-17_2026-07-17"
 *   "Nadi-Report-CBO-Lookalike-ATC"
 *
 * Treated as opaque strings, the account looks like five unrelated campaigns.
 * Parsed, an obvious pattern appears — every Nadi-Report campaign is below
 * breakeven while the one Nadi-Leaf campaign is the only profitable line item.
 * That is a product problem, not a creative problem, and no amount of
 * per-campaign detail surfaces it.
 *
 * Matching is deliberately conservative: a token is only claimed when it is
 * an unambiguous marker. Anything unrecognised stays in the product name
 * rather than being silently mis-bucketed, because a wrong facet is worse
 * than no facet — it invents a pattern that isn't there.
 */

export type FunnelStage =
  | 'retargeting'
  | 'lookalike'
  | 'interest'
  | 'broad'
  | 'unknown';

export type BudgetModel = 'abo' | 'cbo' | 'asc' | 'unknown';

export interface CampaignFacets {
  /**
   * Grouping key — the tenant's configured product when the name can be
   * attributed to one, else the heuristic guess. Deliberately COLLAPSES
   * distinct campaigns so rollups work.
   */
  product: string;
  /**
   * Per-campaign display label: cleaned of date stamps and structural noise
   * but keeping whatever distinguishes this campaign from its siblings
   * ("Placement", "Male Demographics", "Advantage+"). Never use `product`
   * for display — it renders sixteen different campaigns as the same string
   * and makes an alert list unreadable.
   */
  label: string;
  funnel: FunnelStage;
  funnelLabel: string;
  budgetModel: BudgetModel;
  /** ISO-ish language tag found in the name, lowercased. */
  language: string | null;
  /** Conversion-event tag embedded in the name (ATC, PUR, LEAD…). */
  optimizedFor: string | null;
  /** True when the name marks this as an explicit test. */
  isTest: boolean;
  /** Every token the parser recognised — for debugging the parse. */
  matched: string[];
}

const FUNNEL_MARKERS: Array<{ re: RegExp; stage: FunnelStage; label: string }> = [
  { re: /\bre-?targe?ting\b|\bre-?targett?ing\b|\brtg\b|\bremarketing\b/i, stage: 'retargeting', label: 'Retargeting' },
  { re: /\blookalike\b|\blal\b|\blla\b/i, stage: 'lookalike', label: 'Lookalike' },
  { re: /\binterests?\b|\bint\b/i, stage: 'interest', label: 'Interest' },
  { re: /\bbroad\b|\bopen\b|\bprospecting\b|\bcold\b/i, stage: 'broad', label: 'Broad / prospecting' },
];

const BUDGET_MARKERS: Array<{ re: RegExp; model: BudgetModel }> = [
  { re: /\bcbo\b/i, model: 'cbo' },
  { re: /\babo\b/i, model: 'abo' },
  { re: /\basc\b|\badvantage\+?\b/i, model: 'asc' },
];

const LANGUAGE_MARKERS: Array<{ re: RegExp; lang: string }> = [
  { re: /\bhinglish\b/i, lang: 'hinglish' },
  { re: /\ben\b|\benglish\b/i, lang: 'english' },
  { re: /\bhi\b|\bhindi\b/i, lang: 'hindi' },
  { re: /\bta\b|\btamil\b/i, lang: 'tamil' },
  { re: /\bte\b|\btelugu\b/i, lang: 'telugu' },
  { re: /\bkn\b|\bkannada\b/i, lang: 'kannada' },
  { re: /\bml\b|\bmalayalam\b/i, lang: 'malayalam' },
  { re: /\bmr\b|\bmarathi\b/i, lang: 'marathi' },
  { re: /\bbn\b|\bbengali\b/i, lang: 'bengali' },
];

const EVENT_MARKERS: Array<{ re: RegExp; event: string }> = [
  { re: /\batc\b|\baddtocart\b/i, event: 'Add to cart' },
  { re: /\bpur\b|\bpurchase\b/i, event: 'Purchase' },
  { re: /\blead\b/i, event: 'Lead' },
  { re: /\bic\b|\binitiatecheckout\b/i, event: 'Initiate checkout' },
  { re: /\bvc\b|\bviewcontent\b/i, event: 'View content' },
  { re: /\breg\b|\bregistration\b/i, event: 'Registration' },
];

const TEST_MARKER = /\btests?\b|\bexp\b|\bexperiment\b|\bab-?test\b/i;

/**
 * Tokens that are structural noise rather than product identity — dates,
 * month-year stamps, stage counters, and the markers already extracted above.
 * Stripped so "Nadi-Report-ABO-July'26-Test Festivals" and
 * "Nadi-Report-CBO-Lookalike-ATC" collapse to the same product, "Nadi Report".
 */
const NOISE_PATTERNS: RegExp[] = [
  // Separator normalisation runs BEFORE this list, so "2026-07-20" has
  // already become "2026 07 20" by the time these patterns see it — the
  // hyphenated forms alone silently matched nothing and left raw dates in
  // every label ("Nadi Report 2026 07 17 2026 07 17"). Both forms are kept
  // because this list is also applied to un-normalised input in places.
  /\b\d{4}[-/ ]\d{1,2}[-/ ]\d{1,2}\b/g,                       // 2026-07-20 / 2026 07 20
  /\b\d{1,2}[-/ ]\d{1,2}[-/ ]\d{2,4}\b/g,                     // 17/07/26 / 17 07 2026
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*['’]?\s?\d{2,4}\b/gi, // July'26
  /\bstage\s?\d+\b/gi,
  /\bv\d+\b/gi,
  /\bbatch\b/gi,
  /\bnew\b/gi,
  /\b\d{6,}\b/g,                                              // raw meta ids
];

/**
 * @param knownProducts The tenant's configured product names. When a campaign
 *   name contains one, it wins over the heuristic — the operator has already
 *   said what their products are, so guessing is strictly worse. Without this,
 *   the heuristic leaves test dimensions attached ("Nadi Report Placement",
 *   "Nadi Report Male Demographics", "Nadi Report Advatnage+") and shatters
 *   one product into six single-campaign buckets, which is not a rollup.
 */
export function parseCampaignName(
  rawName: string | undefined | null,
  knownProducts: string[] = [],
): CampaignFacets {
  const name = (rawName ?? '').trim();
  const matched: string[] = [];

  if (!name) {
    return {
      product: 'Unknown',
      label: 'Untitled',
      funnel: 'unknown',
      funnelLabel: 'Unknown',
      budgetModel: 'unknown',
      language: null,
      optimizedFor: null,
      isTest: false,
      matched,
    };
  }

  // Separators vary per operator (-, _, spaces). Normalise to spaces so the
  // \b word-boundary matches below behave the same across all of them.
  const normalised = name.replace(/[-_|/]+/g, ' ').replace(/\s+/g, ' ').trim();

  let funnel: FunnelStage = 'unknown';
  let funnelLabel = 'Unknown';
  for (const m of FUNNEL_MARKERS) {
    if (m.re.test(normalised)) {
      funnel = m.stage;
      funnelLabel = m.label;
      matched.push(m.stage);
      break;
    }
  }

  let budgetModel: BudgetModel = 'unknown';
  for (const m of BUDGET_MARKERS) {
    if (m.re.test(normalised)) {
      budgetModel = m.model;
      matched.push(m.model);
      break;
    }
  }

  let language: string | null = null;
  for (const m of LANGUAGE_MARKERS) {
    if (m.re.test(normalised)) {
      language = m.lang;
      matched.push(m.lang);
      break;
    }
  }

  let optimizedFor: string | null = null;
  for (const m of EVENT_MARKERS) {
    if (m.re.test(normalised)) {
      optimizedFor = m.event;
      matched.push(m.event);
      break;
    }
  }

  const isTest = TEST_MARKER.test(normalised);
  if (isTest) matched.push('test');

  const known = matchKnownProduct(normalised, knownProducts);
  if (known) matched.push(`product:${known}`);
  const heuristic = extractProduct(normalised, matched);

  return {
    product: known ?? heuristic,
    label: heuristic,
    funnel,
    funnelLabel,
    budgetModel,
    language,
    optimizedFor,
    isTest,
    matched,
  };
}

/**
 * Longest configured product name contained in the campaign name.
 *
 * Longest-first so "Nadi Leaf Premium" is preferred over "Nadi Leaf" when both
 * are configured — the more specific match is the correct one.
 */
function matchKnownProduct(
  normalised: string,
  knownProducts: string[],
): string | null {
  if (!knownProducts.length) return null;
  const haystack = normalised.toLowerCase().replace(/\s+/g, ' ');
  const candidates = knownProducts
    .filter(Boolean)
    .map((p) => ({
      raw: p,
      norm: p.toLowerCase().replace(/[-_|/]+/g, ' ').replace(/\s+/g, ' ').trim(),
    }))
    .filter((p) => p.norm.length > 0)
    // Longest first so "Nadi Leaf Reading" beats "Nadi Leaf" when a campaign
    // name contains both — the more specific product is the correct one.
    .sort((a, b) => b.norm.length - a.norm.length);

  for (const c of candidates) {
    if (haystack.includes(c.norm)) return c.raw;
  }

  // Campaign names routinely shorten the configured product: the product is
  // "Nadi Leaf Reading" but every campaign says "Nadi Leaf - New Batch…".
  // Retry on leading token prefixes, longest first, requiring at least two
  // tokens so a single generic word ("Nadi", shared by both products here)
  // can never claim a campaign for the wrong product.
  for (const c of candidates) {
    const tokens = c.norm.split(' ').filter(Boolean);
    for (let n = tokens.length - 1; n >= 2; n--) {
      const prefix = tokens.slice(0, n).join(' ');
      if (haystack.includes(prefix)) return c.raw;
    }
  }
  return null;
}

/**
 * Product = the name with every recognised structural token and date stamp
 * removed. Falls back to the first two words when stripping leaves nothing,
 * so a campaign never lands in an empty bucket.
 */
function extractProduct(normalised: string, matched: string[]): string {
  let s = ` ${normalised} `;

  for (const p of NOISE_PATTERNS) s = s.replace(p, ' ');

  const structural = [
    ...FUNNEL_MARKERS.map((m) => m.re),
    ...BUDGET_MARKERS.map((m) => m.re),
    ...LANGUAGE_MARKERS.map((m) => m.re),
    ...EVENT_MARKERS.map((m) => m.re),
    TEST_MARKER,
  ];
  for (const re of structural) {
    s = s.replace(new RegExp(re.source, 'gi'), ' ');
  }

  const cleaned = s.replace(/\s+/g, ' ').trim();
  if (cleaned) return titleCase(cleaned);

  const fallback = normalised.split(' ').slice(0, 2).join(' ').trim();
  return fallback ? titleCase(fallback) : 'Unknown';
}

function titleCase(s: string): string {
  return s
    .split(' ')
    .filter(Boolean)
    .map((w) =>
      // Preserve deliberate acronyms (TAT, EN) rather than lowercasing them.
      w.length <= 3 && w === w.toUpperCase()
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(' ');
}
