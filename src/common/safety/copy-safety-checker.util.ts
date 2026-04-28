/**
 * Pre-launch safety check for ad copy. Detects two classes of problems that
 * cause Meta policy strikes — which can restrict the Business Manager for days
 * or trigger account-level review.
 *
 *   1. Forbidden-claim phrases — outcome guarantees, miracle claims, body-shaming
 *      patterns. Meta's Community Standards reject these even on tame products.
 *
 *   2. Special-Ad-Category triggers — copy mentioning credit / employment / housing /
 *      social-issue topics MUST run under the corresponding `special_ad_categories`
 *      declaration. Running without the declaration is a high-severity violation.
 *
 * Pure regex check, no LLM. Fires before launch as a hard fail. The asymmetric
 * cost is huge: one BM ban kills tenant revenue for days.
 */

const FORBIDDEN_CLAIM_PATTERNS: { pattern: RegExp; reason: string }[] = [
  // Outcome guarantees — Meta rejects "guaranteed results" universally
  { pattern: /\b(guarantee[ds]?|guaranteed)\s+(results?|outcomes?|profits?|returns?|success)\b/i, reason: 'guaranteed-outcome claim' },
  { pattern: /\bmoney\s*back\s+guarantee\b/i, reason: 'money-back-guarantee phrasing (often tripped by automated review)' },

  // Miracle / 100% / cure
  { pattern: /\b100\s*%\s+(guaranteed|effective|natural|proven|safe|free|results?)\b/i, reason: '100% absolute claim' },
  { pattern: /\b(miracle|miraculous)\s+(cure|solution|treatment|product)\b/i, reason: 'miracle claim' },
  { pattern: /\bcures?\s+(your|the)\s+(disease|illness|cancer|diabetes|covid)/i, reason: 'medical cure claim' },

  // Body-shaming / before-after weight loss (well-known Meta trigger)
  { pattern: /\blose\s+(\d+)\s*(kg|kgs|kilos?|pounds?|lbs)\s+(in|within)\s+\d+\s+(days?|weeks?|months?)/i, reason: 'specific weight-loss-in-time-frame claim' },
  { pattern: /\bbefore\s*(?:&|and|\/)\s*after\s+(photos?|pics?|images?)\b/i, reason: 'before/after weight-loss imagery cue' },

  // Personal attribute targeting (Meta requires special-ads category for these)
  { pattern: /\b(are\s+you|do\s+you)\s+(diabetic|overweight|obese|depressed|anxious|infertile|pregnant)\b/i, reason: 'personal-attribute callout' },
];

const SPECIAL_AD_CATEGORY_TRIGGERS: { pattern: RegExp; category: string; reason: string }[] = [
  // CREDIT
  { pattern: /\b(credit\s*card|personal\s*loan|home\s*loan|car\s*loan|mortgage|emi|line\s*of\s*credit|payday\s*loan|microfinance)\b/i, category: 'CREDIT', reason: 'mentions credit / loan product' },
  { pattern: /\b(low|cheap|easy|instant|fast|quick)\s+(loan|credit|emi)\b/i, category: 'CREDIT', reason: 'predatory-credit phrasing pattern' },

  // EMPLOYMENT
  { pattern: /\b(jobs?\s+(at|in|for)|hiring\s+now|job\s+opening|career\s+opportunit|recruitment|earn\s+₹?\s*\d+\s*(per|\/)\s*(day|week|month))\b/i, category: 'EMPLOYMENT', reason: 'job listing / income claim' },

  // HOUSING
  { pattern: /\b(rent|sale|sell|buy|lease)\s+(apartment|flat|house|villa|property|condo)\b/i, category: 'HOUSING', reason: 'housing rental / sale offer' },

  // SOCIAL ISSUES / ELECTIONS
  { pattern: /\b(vote|election|candidate|political|campaign\s+for|protest|movement)\b/i, category: 'ISSUES_ELECTIONS_POLITICS', reason: 'political / election content' },
];

export interface CopySafetyResult {
  safe: boolean;
  forbiddenClaims: { phrase: string; reason: string; copyField: string }[];
  specialAdCategoryTriggers: { phrase: string; category: string; reason: string; copyField: string }[];
}

/**
 * Scan a single copy variant. Returns all flags found across primaryText / headline / cta.
 */
export function checkCopySafety(input: {
  primaryText?: string;
  headline?: string;
  description?: string;
  cta?: string;
  declaredSpecialAdCategories?: string[];
}): CopySafetyResult {
  const fields: { name: string; value: string }[] = [
    { name: 'primaryText', value: input.primaryText ?? '' },
    { name: 'headline', value: input.headline ?? '' },
    { name: 'description', value: input.description ?? '' },
    { name: 'cta', value: input.cta ?? '' },
  ].filter(f => f.value.length > 0);

  const declared = (input.declaredSpecialAdCategories ?? []).map(c => c.toUpperCase());

  const forbiddenClaims: CopySafetyResult['forbiddenClaims'] = [];
  const specialAdCategoryTriggers: CopySafetyResult['specialAdCategoryTriggers'] = [];

  for (const f of fields) {
    for (const { pattern, reason } of FORBIDDEN_CLAIM_PATTERNS) {
      const m = f.value.match(pattern);
      if (m) forbiddenClaims.push({ phrase: m[0], reason, copyField: f.name });
    }
    for (const { pattern, category, reason } of SPECIAL_AD_CATEGORY_TRIGGERS) {
      const m = f.value.match(pattern);
      if (m && !declared.includes(category)) {
        specialAdCategoryTriggers.push({ phrase: m[0], category, reason, copyField: f.name });
      }
    }
  }

  return {
    safe: forbiddenClaims.length === 0 && specialAdCategoryTriggers.length === 0,
    forbiddenClaims,
    specialAdCategoryTriggers,
  };
}

/**
 * Format a CopySafetyResult into a single error message suitable for throwing
 * before launch. Returns empty string if safe.
 */
export function formatSafetyError(result: CopySafetyResult): string {
  if (result.safe) return '';
  const parts: string[] = ['Copy safety check failed (would risk Meta policy strike):'];
  for (const f of result.forbiddenClaims) {
    parts.push(`  - [forbidden] "${f.phrase}" in ${f.copyField} — ${f.reason}`);
  }
  for (const f of result.specialAdCategoryTriggers) {
    parts.push(`  - [special-ad-category ${f.category}] "${f.phrase}" in ${f.copyField} — ${f.reason}; declare company.meta.specialAdCategories or rephrase`);
  }
  parts.push('Refusing to launch. Either rewrite the copy, or (for special-ad-category) declare the category on the company config.');
  return parts.join('\n');
}
