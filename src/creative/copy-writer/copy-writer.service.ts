import { Injectable, Logger } from '@nestjs/common';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { CopyVariant } from '../schemas/creative-package.schema';

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

    // Hook taxonomy aligned with Creative Team primary path (creative-team.service.ts:411-419)
    // — both paths now share the same vocabulary so downstream learning isn't taxonomy-split.
    const allowedHookStyles = ['pain_point', 'bold_claim', 'price_shock', 'social_proof', 'curiosity_gap', 'before_after', 'urgency'];
    const hookStyleRule = brief.forcedHookStyle
      ? `MUST be exactly "${brief.forcedHookStyle}" for ALL 4 variants (forced replacement — variants differ on emotional position, voicing, and example, NOT on hookStyle).`
      : `one of [${allowedHookStyles.map(h => `"${h}"`).join(', ')}] — each variant uses a DIFFERENT hookStyle.`;
    const avoidBlock = brief.avoidHookStyles && brief.avoidHookStyles.length > 0
      ? `\n⚠ AVOID THESE HOOK STYLES (saturated/fatigued — do NOT generate variants with these): ${brief.avoidHookStyles.map(h => `"${h}"`).join(', ')}`
      : '';

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt: '',
      liveContext: this.liveContextBuilder.build(company),
      userMessage: `
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

${learningsBlock}

For each variant write:
- primaryText: the main ad body copy (3-5 sentences, Hinglish where natural). MUST mention product name AND price (${priceTag}).
- headline: short punchy headline (5-7 words max)
- cta: call to action button text — "Shop Now" / "Order Now" / "Buy Today" (NOT "Learn More" unless considering purchase)
- hookStyle: ${hookStyleRule}${avoidBlock}

COPY RULES:
- Specific beats vague: numbers, names, concrete moments
- No generic phrases ("best quality", "amazing", "don't miss out")
- Price (${priceTag}) in EVERY variant — no exceptions
- ${brief.forcedHookStyle ? `All 4 variants use hookStyle "${brief.forcedHookStyle}" — differentiate by angle/emotion/voicing/example, not by hookStyle.` : '4 variants must use 4 DIFFERENT hookStyles from the allowed list.'}

Also pick which variant is best for this brief and why.

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
