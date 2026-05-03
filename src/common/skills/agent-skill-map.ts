/**
 * Agent → Skill mapping. Single source of truth for which Claude Code SDK
 * skills each agent type should explicitly invoke during reasoning.
 *
 * Why this exists:
 *   The SDK auto-loads every skill in `.claude/skills/` as context for every
 *   agent call. But agents don't KNOW to use them unless the prompt tells
 *   them to. Result: 18 skills sit in context, the LLM ignores them, and
 *   we get the same generic reasoning we'd get with no skills at all.
 *
 *   This map defines per-agent "apply skill X when Y happens" directives.
 *   Each agent's prompt builder calls `buildSkillBlock(agentType)` and gets
 *   a concise (~150 token) directive block to prepend. The skills' full
 *   content stays in SDK auto-loaded context — we're just routing attention.
 *
 * What's NOT here:
 *   - page-cro: deferred per user — landing-page reviewer agent will use it later
 *   - autonomous-loops, continuous-learning-v2, cost-aware-llm-pipeline,
 *     iterative-retrieval, verification-loop: architectural skills, used by
 *     engineers building the system, not by agents during runtime decisions
 */

export type AgentSkillSlot = 'STRATEGY_TEAM' | 'CREATIVE_TEAM' | 'CAMPAIGN_REVIEW' | 'AUDIT_AGENT' | 'IDEA_POOL';

interface SkillDirective {
  name: string;
  when: string;   // explicit trigger — must be observable so the LLM knows when to invoke
}

export const AGENT_SKILLS: Record<AgentSkillSlot, SkillDirective[]> = {
  STRATEGY_TEAM: [
    { name: 'paid-ads',                  when: 'evaluating budget tier, audience type (lookalike vs interest vs broad), and ad-set count per brief' },
    { name: 'marketing-psychology',      when: 'choosing hook angle (pain_point / urgency / curiosity_gap) and emotional triggers per audience stage' },
    { name: 'product-marketing-context', when: 'reasoning about which audienceSegment from product config maps to the brief' },
    { name: 'customer-research',         when: 'translating scout signals into pain-point briefs in the customer voice (Hindi/Hinglish for India)' },
    { name: 'market-research',           when: 'cross-validating coordinator signals against industry context and seasonal triggers' },
    { name: 'competitor-alternatives',   when: 'briefs target competitor-displacement angles (anti-AstroTalk / fraud-trust-vacuum)' },
  ],

  CREATIVE_TEAM: [
    { name: 'ad-creative',          when: 'producing 4 copy variants — vary hookStyle per variant from canonical taxonomy' },
    { name: 'copywriting',          when: 'writing primaryText, headlines, CTAs — apply hook-formula structure' },
    { name: 'marketing-psychology', when: 'choosing emotional tone per audienceStage (cold/warm/hot) and per hookStyle' },
    { name: 'video',                when: 'producing the Heygen video prompt — apply Reels duration limits (15-25s optimal), hook in first 2s, hard cuts only' },
    { name: 'image',                when: 'producing the per-variant image prompt — apply visual centerpiece concept, mobile-first composition' },
  ],

  CAMPAIGN_REVIEW: [
    { name: 'paid-ads',             when: 'evaluating audience choice (lookalike vs advantage_plus vs interest), budget allocation, optimization goal, scale/pause rules' },
    { name: 'ab-test-setup',        when: 'assessing statistical viability — at ₹3-5k/day with ₹1000-1400 CPA = ~25 conv/wk per ad set, BELOW Meta learning-phase floor (~50/wk). Flag if budget cannot exit learning. Avoid recommending splits at <₹6k/day total.' },
    { name: 'marketing-psychology', when: 'reviewing pause-rule and scale-rule logic — avoid pausing on noise, avoid scaling on lucky-streak data' },
    { name: 'competitor-alternatives', when: 'reviewing campaigns with competitor-displacement angles' },
  ],

  AUDIT_AGENT: [
    { name: 'paid-ads',      when: 'choosing pause/scale/replace/shift_budget actions per ad set — apply Meta-specific timing (no scale before day 7, learning-phase respect)' },
    { name: 'ab-test-setup', when: 'evaluating whether a CTR/ROAS/CPA signal is statistically real or noise — apply Wilson lower bound + power-calc floor' },
  ],

  IDEA_POOL: [
    { name: 'paid-ads',                  when: 'sizing budget per idea + audience-stage rules' },
    { name: 'product-marketing-context', when: 'matching idea to product audienceSegment' },
    { name: 'marketing-psychology',      when: 'choosing hook angle for the winning idea' },
    { name: 'customer-research',         when: 'translating signals to customer-voice briefs' },
  ],
};

/**
 * Get just the skill NAMES for a given agent type. Use this to pass into
 * `RunAgentParams.skills` so the SDK preloads them into agent context.
 *
 * Without calling this + passing to runAgent, the skills sit on disk and
 * the LLM never sees them — buildSkillBlock() then points to nothing.
 */
export function skillsForAgent(agentType: AgentSkillSlot): string[] {
  return AGENT_SKILLS[agentType]?.map((s) => s.name) ?? [];
}

/**
 * Build a concise "skills available + when to apply" block to prepend to an
 * agent's prompt. Used in tandem with skillsForAgent() — the names get
 * preloaded into context by the SDK; this block tells the LLM when to apply
 * each one.
 *
 * Output is ~120-180 tokens depending on agent. Cheap signal, big leverage.
 */
export function buildSkillBlock(agentType: AgentSkillSlot): string {
  const skills = AGENT_SKILLS[agentType];
  if (!skills?.length) return '';

  const lines = skills.map((s, i) => `  ${i + 1}. \`${s.name}\` — apply when ${s.when}`);
  return `═══════════════════════════════════════════════════
EXPERT SKILL FRAMEWORKS YOU MUST APPLY (already loaded in your context):
${lines.join('\n')}

These are not generic suggestions — they are specific frameworks loaded
under .claude/skills/. Reference them explicitly in your reasoning when
their trigger condition matches. Do NOT default to generic marketing
advice when one of these skill frameworks fits.
═══════════════════════════════════════════════════
`;
}
