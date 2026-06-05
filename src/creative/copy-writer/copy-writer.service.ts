import { Injectable, Logger } from '@nestjs/common';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { CopyVariant } from '../schemas/creative-package.schema';
import { HOOK_STYLES_DR, HOOK_STYLE_DESCRIPTIONS } from '../../common/creative/hook-styles';
import { resolveVertical } from '../../common/benchmarks/vertical-benchmarks';
import { skillsForAgent, buildSkillBlock } from '../../common/skills/agent-skill-map';
import { parseRobustJson } from '../../common/llm/robust-json-parser.util';
import {
  resolveTargetLanguage,
  LANGUAGE_REGISTER_HINT,
  CanonicalLanguage,
} from '../../common/creative/language-utils';

export interface CopyPackage {
  variants: CopyVariant[];
  selectedIndex: number;
  selectionReason: string;
}

@Injectable()
export class CopyWriterService {
  private readonly logger = new Logger(CopyWriterService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
  ) {}

  async generate(
    brief: {
      topic: string;
      angle: string;
      platform: string;
      format: string;
      audience: string;
      hook: string;
      keyMessage: string;
      conversionBridge: string;
      product?: string;                          // resolved to product entry below
      forcedHookStyle?: string;
      avoidHookStyles?: string[];
      audienceStage?: 'cold' | 'warm' | 'hot';   // cold = prospecting, warm = retarget, hot = cart-recovery
      targetLanguage?: CanonicalLanguage;        // pre-resolved by creative-producer; we re-resolve if missing
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<CopyPackage> {
    const creative = company.learnings?.creative;
    // Resolve product from brief first, fall back to first-active. Without this
    // a Nadi-Leaf brief would pick Nadi Report (first in array) and inject the
    // wrong price.
    const activeProduct = (brief.product
      ? (company.products ?? []).find(p => p.name === brief.product)
      : undefined)
      ?? (company.products ?? []).find(p => p.active);
    const hidePriceInCopy = !!activeProduct?.hidePriceInCreative;
    const priceTag = !activeProduct
      ? '[price]'
      : hidePriceInCopy
        ? '[PRICE SUPPRESSED — omit price entirely]'
        : `${activeProduct.currency}${activeProduct.price}`;
    // Fall back to local resolution if caller didn't pass targetLanguage — keeps
    // the fallback path self-contained (creative-team primary path resolves
    // upstream; direct CopyWriter callers still get correct behaviour).
    const targetLanguage: CanonicalLanguage = brief.targetLanguage
      ?? resolveTargetLanguage({ productLanguages: activeProduct?.languages });
    const languageRegister = LANGUAGE_REGISTER_HINT[targetLanguage];

    const learningsBlock = creative
      ? `
WINNING PATTERNS (favour these):
- Hook styles: ${creative.winningHooks.join(', ') || 'none yet'}
- Formats: ${creative.winningFormats.join(', ') || 'none yet'}
- CTA insights: ${creative.ctaInsights.join(', ') || 'none yet'}

LOSING PATTERNS (avoid these):
- Hook styles: ${creative.losingHooks.join(', ') || 'none yet'}
- Formats: ${creative.losingFormats.join(', ') || 'none yet'}
      `.trim()
      : 'No learnings yet — use your best judgement.';

    // Canonical hookStyle taxonomy — single source of truth shared with creative-team
    // primary path and audit's pickReplacementHook. Drift here corrupts learning data.
    // Each hookStyle now ships with a trigger+sensory+banned spec (HOOK_STYLE_DESCRIPTIONS)
    // so the LLM writes copywriter-grade hooks instead of generic LLM slop.
    const hookSpecBlock = HOOK_STYLES_DR.map(h => `  - ${h}: ${HOOK_STYLE_DESCRIPTIONS[h]}`).join('\n');
    const hookStyleRule = brief.forcedHookStyle
      ? `MUST be exactly "${brief.forcedHookStyle}" for ALL 4 variants (forced replacement — variants differ on emotional position, voicing, and example, NOT on hookStyle). Follow this spec exactly:\n  ${HOOK_STYLE_DESCRIPTIONS[brief.forcedHookStyle as keyof typeof HOOK_STYLE_DESCRIPTIONS] ?? 'see allowed list above'}`
      : `one of [${HOOK_STYLES_DR.map(h => `"${h}"`).join(', ')}] — each variant uses a DIFFERENT hookStyle. Specs:\n${hookSpecBlock}`;
    const avoidBlock = brief.avoidHookStyles && brief.avoidHookStyles.length > 0
      ? `\n⚠ AVOID THESE HOOK STYLES (saturated/fatigued — do NOT generate variants with these): ${brief.avoidHookStyles.map(h => `"${h}"`).join(', ')}`
      : '';

    // Vertical-aware CTA whitelist. Spirituality buyers don't "shop" their destiny —
    // generic e-com CTAs ("Shop Now") hurt CVR. Info-product / consultation verticals
    // get verbs that match the purchase intent ("Get My Reading").
    const vertical = resolveVertical(company.industry);
    const isSpiritOrInfo = vertical === 'spirituality' || vertical === 'edtech';
    const ctaWhitelist = isSpiritOrInfo
      ? '"Get My Reading" / "Reveal My Chart" / "Claim My Reading" / "Book Consultation" / "Get My Report" — match the verb to what the buyer receives. Do NOT use "Shop Now" or "Buy Today" — these are e-com verbs and feel wrong for ${vertical} purchases.'
      : '"Shop Now" / "Order Now" / "Buy Today" (NOT "Learn More" unless considering purchase)';

    // Audience-stage rule — mirrors creative-team.service.ts:408-413. Without this the
    // fallback path silently generates cold-prospect copy for warm retarget pods.
    // For high-AOV considered purchases (≥₹1500), warm needs 4-5 lines with
    // objection-handling — 2-3 lines is impulse-grade and tanks CVR on premium tiers.
    const activeProductForStage = (company.products ?? []).find(p => p.active);
    const aov = activeProductForStage?.conversionValue ?? activeProductForStage?.price ?? 0;
    const isHighAOV = aov >= 1500;
    const audienceStageRule = (() => {
      const stage = brief.audienceStage ?? 'cold';
      if (stage === 'warm') {
        return isHighAOV
          ? `\nAUDIENCE STAGE: warm retarget for HIGH-AOV product (₹${aov}). They've seen the brand, they bounced. They have specific objections — handle them. Structure REQUIRED (4-5 lines):\n  Line 1: offer-recall ("Aapki Nadi reading abhi tak nahi li?")\n  Line 2: kill ONE objection — authenticity OR price-justification OR delivery-mechanic ("Pandit ji ne 2000 saal purani parampara se padhi" / "₹1,799 = ek bar, lifetime ka analysis" / "48 ghante mein WhatsApp pe full report")\n  Line 3: specific reassurance (delivery method, format, what they actually receive)\n  Line 4: CTA line\n  Do NOT use 2-3 line impulse copy here — ₹1,500+ is a CONSIDERED purchase; brevity reads as cheap. NEVER use cold-prospect hooks like "Kya aap bhi…".`
          : `\nAUDIENCE STAGE: warm (retargeting site visitors). SKIP brand intro — they already know the brand. Lead with offer-recall, objection-handling, or specific reason-to-return. 2-3 line primaryText is fine for impulse-AOV. NEVER use cold-prospect hooks like "Kya aap bhi…".`;
      }
      if (stage === 'hot') {
        return `\nAUDIENCE STAGE: hot (cart abandoners / 30d engaged). Cart-recovery urgency. Reference the specific abandoned action. Time-bound urgency ("Aaj raat tak ₹1 mein"). 1-2 line primaryText, ruthlessly short. Hook = the offer + a deadline. Price already known — you can OMIT the price line if the urgency line is stronger without it.`;
      }
      return `\nAUDIENCE STAGE: cold (prospecting). Audience has NOT seen this brand before. Problem-first structure: agitate pain, introduce brand AS the solution, end with offer + CTA. Brand introduction is required. Hook must stop the scroll cold.`;
    })();

    // Strip price from briefFacts product block when suppression is active.
    // The LLM treats briefFacts as authoritative — leaving price in here while
    // also adding "do not mention price" is contradictory and the LLM tends to
    // leak it. Remove it from the fact pool entirely instead.
    const briefFactsBlock = JSON.stringify({
      topic: brief.topic,
      angle: brief.angle,
      hook: brief.hook,
      keyMessage: brief.keyMessage,
      conversionBridge: brief.conversionBridge,
      audience: brief.audience,
      product: activeProduct
        ? (hidePriceInCopy
          ? { name: activeProduct.name, currency: activeProduct.currency, differentiators: activeProduct.differentiators, priceSuppressed: true }
          : { name: activeProduct.name, price: activeProduct.price, currency: activeProduct.currency, differentiators: activeProduct.differentiators })
        : null,
    }, null, 2);

    const systemPrompt = company.prompts?.creativeTeamLead
      ?? company.prompts?.campaignCreator
      ?? `You are the Creative Director for ${company.name}. Produce on-brand, policy-compliant, scroll-stopping Meta ad copy. Tone: ${company.tone}. Audience: ${company.targetAudience} in ${company.geography}.`;

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt,
      liveContext: this.liveContextBuilder.build(company, brief.product),
      skills: skillsForAgent('CREATIVE_TEAM'),
      userMessage: `
${buildSkillBlock('CREATIVE_TEAM')}
Write 4 ad copy variants for ${company.name} for the following content brief.

BRIEF:
Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Target audience: ${brief.audience}
Hook: ${brief.hook}
Key message: ${brief.keyMessage}
Conversion bridge: ${brief.conversionBridge}
${activeProduct ? (hidePriceInCopy ? `Product: ${activeProduct.name} (PRICE SUPPRESSED — do NOT mention any price, no ₹, no rupees, no booking-fee amounts; lead with trust signals, lineage, and discovery framing instead)` : `Product: ${activeProduct.name} @ ${priceTag}`) : ''}
${audienceStageRule}

${learningsBlock}

FACT-ANCHOR RULE (NON-NEGOTIABLE):
Every named entity, number, date, statistic, news event, person, or quoted claim
in your copy MUST come from BRIEF FACTS below. No inventing competitors, deadlines,
${hidePriceInCopy ? 'or' : 'prices other than the product price,'} testimonials, or news events. If you cannot
cite the source from BRIEF FACTS, use a generic relatable pain instead.${hidePriceInCopy ? '\nPRICE SUPPRESSION ACTIVE for this product — do NOT mention any price (no ₹, no rupees, no booking-fee amounts) in ANY variant.' : ''}

BRIEF FACTS (the ONLY facts you may cite):
${briefFactsBlock}

═══ TARGET LANGUAGE ═══
This brief targets audiences who speak **${targetLanguage}**.
Register: ${languageRegister}
ALL primaryText and headline output MUST be in this language and register.
- If the hook spec examples below are in Hindi but targetLanguage is different, translate the PATTERN (trigger + sensory + banned) to the target language with equivalent register — NOT a word-for-word translation.
- CTA button text stays as-is from the CTA whitelist (Meta's button widgets are language-flexible).
- Do NOT mix languages within a variant unless code-switching is natural to the register (e.g. Hinglish allows English connectors; pure Marathi/Tamil/Bengali should not casually mix in Hindi).
═══

For each variant write:
- primaryText: the main ad body copy in ${targetLanguage}. Length: 3-5 sentences for cold, 4-5 sentences for warm-high-AOV, 1-2 sentences for hot. ${brief.audienceStage === 'hot' ? 'For hot stage, price line is OPTIONAL — omit if urgency reads stronger without it.' : `MUST mention product name AND price (${priceTag}).`}
- headline: short punchy headline in ${targetLanguage} (5-7 words max)
- cta: call to action button text — ${ctaWhitelist}
- hookStyle: ${hookStyleRule}${avoidBlock}

COPY RULES:
- Specific beats vague — BUT every specific must trace to BRIEF FACTS. If not cite-able, use a generic relatable pain.
- No generic phrases ("best quality", "amazing", "don't miss out")
- ${brief.audienceStage === 'hot' ? 'Hot stage: price OPTIONAL per variant (buyer already knows it). Focus on urgency + deadline.' : `Price (${priceTag}) in EVERY variant — no exceptions`}
- Hook → body → offer → CTA must form a logical chain. Headline's promise = what body delivers. No bait-and-switch.
- ${brief.forcedHookStyle ? `All 4 variants use hookStyle "${brief.forcedHookStyle}" — differentiate by angle/emotion/voicing/example, not by hookStyle.` : '4 variants must use 4 DIFFERENT hookStyles from the allowed list.'}

Also pick which variant is best for this brief and why — pick the one with the strongest coherent hook→body→CTA chain, not just the loudest hook.

Return ONLY valid JSON in this format:
\`\`\`json
{
  "variants": [
    { "primaryText": "...", "headline": "...", "cta": "...", "hookStyle": "..." }
  ],
  "selectedIndex": 0,
  "selectionReason": "one sentence why this variant wins"
}
\`\`\`
      `.trim(),
      maxTurns: 3,
    });

    return this.parse(result.content);
  }

  private parse(content: string): CopyPackage {
    try {
      const parsed: any = parseRobustJson(content);
      if (!Array.isArray(parsed.variants) || parsed.variants.length === 0) {
        throw new Error('No variants in response');
      }
      return {
        variants: parsed.variants,
        selectedIndex: parsed.selectedIndex ?? 0,
        selectionReason: parsed.selectionReason ?? '',
      };
    } catch (err) {
      this.logger.error(`Failed to parse copy variants: ${err}`);
      throw new Error(`CopyWriter parse failed: ${err}`);
    }
  }
}
