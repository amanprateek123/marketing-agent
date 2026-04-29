/**
 * Canonical hookStyle taxonomy used across the creative pipeline.
 *
 * Single source of truth — imported by:
 *   - creative-team.service.ts (primary creative generation)
 *   - copy-writer.service.ts (fallback path)
 *   - campaign-auditor pickReplacementHook (rotation when an ad fatigues)
 *   - signal-detector hookSaturation tracking
 *   - audit-agent.service.ts validation
 *
 * Adding a new hookStyle: extend HOOK_STYLES_DR and (if applicable) update the
 * HOOK_STYLE_DESCRIPTIONS table. Removing one: also drop from any hardcoded
 * audit DEFAULT_HOOKS rotation lists. Drift between auditor and generator
 * silently corrupts saturation/exemplar data, so always import from here.
 */

/**
 * Direct-response hook styles — cover prospecting + retargeting + cart-recovery.
 * 7 styles. Generator uses one per variant (or all-same when forcedHookStyle is set).
 */
export const HOOK_STYLES_DR = [
  'pain_point',
  'bold_claim',
  'price_shock',
  'social_proof',
  'curiosity_gap',
  'before_after',
  'urgency',
] as const;

/**
 * Meme-format hook styles. 3 styles — used only when brief.format === 'meme'.
 * Note: meme-format briefs only generate 3 variants currently (one of meme styles +
 * a fourth variant uses one of the DR styles or the meme style is reused).
 */
export const HOOK_STYLES_MEME = [
  'meme_relatable',
  'meme_punchline',
  'meme_self_aware',
] as const;

export type HookStyle = (typeof HOOK_STYLES_DR)[number] | (typeof HOOK_STYLES_MEME)[number];

const ALL_VALID = new Set<string>([...HOOK_STYLES_DR, ...HOOK_STYLES_MEME]);

/**
 * Validate a hookStyle string against the canonical taxonomy.
 * Used by parsers, auditor (when validating LLM output), and tests.
 */
export function isValidHookStyle(s: string | undefined | null): s is HookStyle {
  return !!s && ALL_VALID.has(s);
}

/**
 * One-line description of each DR hookStyle. Rendered in prompts so the LLM
 * has stable definitions instead of inventing them per call.
 */
export const HOOK_STYLE_DESCRIPTIONS: Record<(typeof HOOK_STYLES_DR)[number], string> = {
  pain_point:    "open with the audience's frustration",
  bold_claim:    'specific, provable promise',
  price_shock:   'lead with value proposition + price',
  social_proof:  'open with result or testimonial',
  curiosity_gap: 'make them need to know more',
  before_after:  'transformation (frame as aspiration, not guarantee)',
  urgency:       'time or stock scarcity',
};
