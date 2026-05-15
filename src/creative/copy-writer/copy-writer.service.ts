import { Injectable, Logger } from '@nestjs/common';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { CopyVariant } from '../schemas/creative-package.schema';
import { HOOK_STYLES_DR } from '../../common/creative/hook-styles';
import { skillsForAgent, buildSkillBlock } from '../../common/skills/agent-skill-map';

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
      forcedHookStyle?: string;
      avoidHookStyles?: string[];
      audienceStage?: 'cold' | 'warm' | 'hot';   // cold = prospecting, warm = retarget, hot = cart-recovery
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<CopyPackage> {
    const creative = company.learnings?.creative;
    const activeProduct = (company.products ?? []).find(p => p.active);
    const priceTag = activeProduct ? `${activeProduct.currency}${activeProduct.price}` : '[price]';

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
    const hookStyleRule = brief.forcedHookStyle
      ? `MUST be exactly "${brief.forcedHookStyle}" for ALL 4 variants (forced replacement — variants differ on emotional position, voicing, and example, NOT on hookStyle).`
      : `one of [${HOOK_STYLES_DR.map(h => `"${h}"`).join(', ')}] — each variant uses a DIFFERENT hookStyle.`;
    const avoidBlock = brief.avoidHookStyles && brief.avoidHookStyles.length > 0
      ? `\n⚠ AVOID THESE HOOK STYLES (saturated/fatigued — do NOT generate variants with these): ${brief.avoidHookStyles.map(h => `"${h}"`).join(', ')}`
      : '';

    // Audience-stage rule — mirrors creative-team.service.ts:408-413. Without this the
    // fallback path silently generates cold-prospect copy for warm retarget pods.
    const audienceStageRule = (() => {
      const stage = brief.audienceStage ?? 'cold';
      if (stage === 'warm') {
        return `\nAUDIENCE STAGE: warm (retargeting site visitors). SKIP brand intro — they already know the brand. Lead with offer-recall ("Aapki ₹1 reading wait kar rahi hai"), objection-handling ("Pehli baat free — kuch lagega bhi nahi"), or specific reason-to-return. 2-3 line primaryText is enough. NEVER use cold-prospect hooks like "Kya aap bhi…" — they sound weird to someone who already engaged.`;
      }
      if (stage === 'hot') {
        return `\nAUDIENCE STAGE: hot (cart abandoners / 30d engaged). Cart-recovery urgency. Reference the specific abandoned action. Time-bound urgency ("Aaj raat tak ₹1 mein"). 1-2 line primaryText, ruthlessly short. Hook = the offer + a deadline.`;
      }
      return `\nAUDIENCE STAGE: cold (prospecting). Audience has NOT seen this brand before. Problem-first structure: agitate pain, introduce brand AS the solution, end with offer + CTA. Brand introduction is required. Hook must stop the scroll cold.`;
    })();

    const briefFactsBlock = JSON.stringify({
      topic: brief.topic,
      angle: brief.angle,
      hook: brief.hook,
      keyMessage: brief.keyMessage,
      conversionBridge: brief.conversionBridge,
      audience: brief.audience,
      product: activeProduct ? { name: activeProduct.name, price: activeProduct.price, currency: activeProduct.currency, differentiators: activeProduct.differentiators } : null,
    }, null, 2);

    const systemPrompt = company.prompts?.creativeTeamLead
      ?? company.prompts?.campaignCreator
      ?? `You are the Creative Director for ${company.name}. Produce on-brand, policy-compliant, scroll-stopping Meta ad copy. Tone: ${company.tone}. Audience: ${company.targetAudience} in ${company.geography}.`;

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt,
      liveContext: this.liveContextBuilder.build(company),
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
${activeProduct ? `Product: ${activeProduct.name} @ ${priceTag}` : ''}
${audienceStageRule}

${learningsBlock}

FACT-ANCHOR RULE (NON-NEGOTIABLE):
Every named entity, number, date, statistic, news event, person, or quoted claim
in your copy MUST come from BRIEF FACTS below. No inventing competitors, deadlines,
prices other than the product price, testimonials, or news events. If you cannot
cite the source from BRIEF FACTS, use a generic relatable pain instead.

BRIEF FACTS (the ONLY facts you may cite):
${briefFactsBlock}

For each variant write:
- primaryText: the main ad body copy (3-5 sentences, Hinglish where natural). MUST mention product name AND price (${priceTag}).
- headline: short punchy headline (5-7 words max)
- cta: call to action button text — "Shop Now" / "Order Now" / "Buy Today" (NOT "Learn More" unless considering purchase)
- hookStyle: ${hookStyleRule}${avoidBlock}

COPY RULES:
- Specific beats vague — BUT every specific must trace to BRIEF FACTS. If not cite-able, use a generic relatable pain.
- No generic phrases ("best quality", "amazing", "don't miss out")
- Price (${priceTag}) in EVERY variant — no exceptions
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
    const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
    const raw = fenceMatch ? fenceMatch[1].trim() : content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);

    try {
      const parsed = JSON.parse(raw);
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
