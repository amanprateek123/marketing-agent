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

/**
 * Screenshot-format hook styles. 4 styles — used only when brief.format === 'screenshot'.
 * The "copy" for this format IS a fake chat/review thread, not ad prose.
 */
export const HOOK_STYLES_SCREENSHOT = [
  'chat_advice_ask',
  'chat_price_objection',
  'review_screenshot',
  'dm_testimonial',
] as const;

/**
 * Poll/quiz-format hook styles. 2 styles — used only when brief.format === 'poll_quiz'.
 */
export const HOOK_STYLES_POLL = [
  'poll_would_you_rather',
  'poll_which_are_you',
] as const;

export type HookStyle =
  | (typeof HOOK_STYLES_DR)[number]
  | (typeof HOOK_STYLES_MEME)[number]
  | (typeof HOOK_STYLES_SCREENSHOT)[number]
  | (typeof HOOK_STYLES_POLL)[number];

const ALL_VALID = new Set<string>([
  ...HOOK_STYLES_DR,
  ...HOOK_STYLES_MEME,
  ...HOOK_STYLES_SCREENSHOT,
  ...HOOK_STYLES_POLL,
]);

/**
 * Validate a hookStyle string against the canonical taxonomy.
 * Used by parsers, auditor (when validating LLM output), and tests.
 */
export function isValidHookStyle(s: string | undefined | null): s is HookStyle {
  return !!s && ALL_VALID.has(s);
}

/**
 * Specs for each DR hookStyle. Rendered in prompts so the LLM writes
 * copywriter-grade hooks, not generic LLM slop. Each spec has:
 *   - trigger: the concrete moment/scene to open in (NOT an emotion label)
 *   - sensory: the one specific image/word that anchors it
 *   - banned: phrases the LLM defaults to that we forbid (so it can't fall back)
 * Drift between this taxonomy and the generator silently corrupts learning data,
 * so always import HOOK_STYLE_DESCRIPTIONS from here.
 */
export const HOOK_STYLE_DESCRIPTIONS: Record<(typeof HOOK_STYLES_DR)[number], string> = {
  pain_point:
    "Open mid-scene at a concrete trigger moment of doubt — never the emotion label. " +
    "Example: '3 baje raat, phone haath mein, Google pe likha — career kab badlega?' " +
    "Sensory: time-of-day + physical action. BANNED phrases: 'pareshaan', 'tension', 'stress', " +
    "'kya aap bhi…'. Use the situation, not the feeling-word.",
  bold_claim:
    "Specific, provable, NUMBER-anchored promise — never adjectives. " +
    "Example: '27 nakshatra mein se sirf 4 aapke favour mein hain — main bata sakta hoon kaunse'. " +
    "Sensory: a specific count, name, or position. BANNED: 'best', 'guaranteed', 'amazing', 'life-changing', '100%'.",
  price_shock:
    "Lead with the price as a stand-alone first line — value contrast in line 2. " +
    "Example: '₹1,799. Ek baar. Lifetime ka kundli analysis.' " +
    "Sensory: the price digit + a strikethrough mental anchor. BANNED: 'limited offer', 'huge discount', 'unbelievable deal'.",
  social_proof:
    "Open with a SPECIFIC outcome from a SPECIFIC person — name + city + result. " +
    "Example: 'Anita, Indore — usne Sade Sati ke 7 saal ka pattern dekha. Ab usse pata hai kab shift hoga.' " +
    "Sensory: real name + specific city + specific outcome (not 'happy', 'changed life'). " +
    "BANNED if no real testimonial in BRIEF FACTS — switch to a generic relatable scene instead. NEVER invent a testimonial.",
  curiosity_gap:
    "Hide the answer behind a SPECIFIC unknown — make them need to know ONE concrete thing. " +
    "Example: 'Aapki kundli mein ek yog hai jo aap nahi jaante. Naam hai…' " +
    "Sensory: a partial reveal — a word, a position, a number — withheld. " +
    "BANNED: 'click to learn more', 'read more', 'find out' (CTA-style — these are NOT hooks).",
  before_after:
    "Transformation framed as ASPIRATION, never a guarantee. Two states, same person, time gap implied. " +
    "Example: 'Pichle saal Diwali — same situation. Is saal — first kundli reading ke baad — sab kuch clear.' " +
    "Sensory: a date or seasonal anchor (Diwali, Saturn return, marriage) marking the gap. " +
    "BANNED: 'will change your life', any health/wealth guarantee. Frame as personal story, not promise.",
  urgency:
    "Real, defensible scarcity — slots, audit window, planetary transit deadline. NEVER fake countdown. " +
    "Example: 'Saturn 2 hafte mein move kar raha hai. Iss window mein reading lena ka asar 7 saal tak rehta hai.' " +
    "Sensory: an astronomical event date OR a real capacity limit (consultations/week). " +
    "BANNED: fake 'ends tonight', 'last 3 hours' if not actually true. Meta will flag it.",
};

/**
 * Specs for meme hookStyles — same role as HOOK_STYLE_DESCRIPTIONS but for
 * format='meme' briefs. These had NO specs while the 7 DR hooks each carried
 * trigger/sensory/banned guidance, so meme variants were the one place the
 * LLM free-styled. Meme ads live or die on the setup-payoff rhythm; generic
 * "relatable astrology meme" instructions produce cringe, not shares.
 */
export const HOOK_STYLE_DESCRIPTIONS_MEME: Record<(typeof HOOK_STYLES_MEME)[number], string> = {
  meme_relatable:
    "ONE hyper-specific shared experience the audience has LIVED — named so precisely they tag a friend. " +
    "Example: 'Mercury retrograde shuru hote hi sabse pehle ex ka message aata hai 💀'. " +
    "Structure: LINE 1 = the situation (no setup, drop them in), LINE 2 = product tie-in as the 'fix'. " +
    "Sensory: a concrete moment (notification, 3am scroll, rishta call), not a category of moments. " +
    "BANNED: 'hum sab', 'every Indian', 'so relatable' — if the line announces relatability it isn't.",
  meme_punchline:
    "Setup-punchline with a HARD turn — line 1 builds one expectation, line 2 breaks it sideways. " +
    "Example: 'Maine apni kundli banwayi… ab pata hai kis din boss se baat NAHI karni hai.' " +
    "The punchline must be the product benefit wearing a joke, not a joke next to the product. " +
    "Sensory: punchline under 10 words; the turn lands on the LAST word. " +
    "BANNED: explaining the joke, emoji-as-punchline, puns on the brand name.",
  meme_self_aware:
    "The ad admits it's an ad — names the exact skepticism the viewer is feeling, then flips it with proof. " +
    "Example: 'Haan, ek aur astrology ad. Lekin yeh wala batata hai ki REPORT mein exactly kya milega 👇'. " +
    "Structure: LINE 1 = voice the objection ('scroll karne wale the na?'), LINE 2 = the concrete reason to stop. " +
    "Sensory: second-person, present tense, conversational — reads like a reply, not a billboard. " +
    "BANNED: irony with no payoff (self-awareness must END in a real claim), mocking the customer.",
};

/**
 * Specs for screenshot-format hookStyles. The "copy" IS a fake phone-UI conversation
 * (chat thread, review screenshot, DM) — write actual message bubbles, not ad prose.
 */
export const HOOK_STYLE_DESCRIPTIONS_SCREENSHOT: Record<(typeof HOOK_STYLES_SCREENSHOT)[number], string> = {
  chat_advice_ask:
    "A WhatsApp-style thread where a friend asks for advice and gets pointed to the product. " +
    "Example: 'Yaar career ko lekar bahut confuse hoon 😩' → 'Maine Nadi Report try kiya tha, kaafi clear ho gaya' → 'Link bhej?'. " +
    "Structure: 3-4 short bubbles, alternating senders, last bubble is the soft CTA. " +
    "BANNED: bubbles that read like ad copy — keep it typo-casual, real texting rhythm.",
  chat_price_objection:
    "A thread where one person raises the price objection and the other resolves it with a concrete fact. " +
    "Example: '₹1799 thoda zyada nahi?' → 'Lifetime report hai, ek baar ka hai... aur personalized remedies bhi included hai'. " +
    "Structure: objection bubble, then a specific-fact rebuttal bubble (not a generic reassurance). " +
    "BANNED: the rebuttal being vague ('trust me it's worth it') — it must cite the actual differentiator.",
  review_screenshot:
    "A star-rating review card (App Store / Google review style) with a real-feeling name + specific outcome. " +
    "Example: '★★★★★ Ritu S. — \"Mujhe pata chal gaya kab job switch karna sahi rahega, bilkul accurate\"'. " +
    "Structure: name + city (optional) + one specific, checkable claim — never 'life changing'. " +
    "BANNED: 5-star-only monotony language ('amazing', 'best ever') without a concrete detail.",
  dm_testimonial:
    "An Instagram-DM-style screenshot where a customer messages the brand's own account with a result. " +
    "Example: 'Hii, wo jo aapne bataya tha career ke baare mein... bilkul waisा hi hua 😭🙏'. " +
    "Structure: casual DM tone, one concrete callback to what the reading predicted, brand's short reply bubble. " +
    "BANNED: overly polished corporate-sounding DM text — must read like a real customer's message.",
};

/**
 * Specs for poll/quiz-format hookStyles. Copy is a question + exactly 2 options, framed
 * to make the viewer mentally answer before they've consciously decided to engage.
 */
export const HOOK_STYLE_DESCRIPTIONS_POLL: Record<(typeof HOOK_STYLES_POLL)[number], string> = {
  poll_would_you_rather:
    "A binary 'would you rather' framed around two paths the audience actually faces, product resolves the tension. " +
    "Example: 'Blind trust karoge ya apni kundli padhke decide karoge?' with two tappable-feeling options. " +
    "Structure: question line + Option A / Option B, product tie-in in the caption below. " +
    "BANNED: options that aren't genuinely both plausible — a fake choice reads as manipulative.",
  poll_which_are_you:
    "'Which one are you?' identity-split framed as two relatable personas, both resolved by the product. " +
    "Example: 'Type A: Har decision se pehle Google karta hai. Type B: Seedha kundli dekhta hai.' " +
    "Structure: two short persona labels + one-line description each, CTA invites the viewer to self-identify. " +
    "BANNED: personas that are just 'good customer vs bad customer' — both must be genuinely relatable, not a strawman.",
};
