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
    },
    company: CompanyDocument,
    runId: string,
  ): Promise<CopyPackage> {
    const winningPatterns = company.learnings?.winningPatterns;
    const losingPatterns = company.learnings?.losingPatterns;

    const learningsBlock = winningPatterns
      ? `
WINNING PATTERNS (favour these):
- Hook styles: ${winningPatterns.hooks.join(', ') || 'none yet'}
- Formats: ${winningPatterns.formats.join(', ') || 'none yet'}

LOSING PATTERNS (avoid these):
- Hook styles: ${losingPatterns?.hooks.join(', ') || 'none yet'}
      `.trim()
      : 'No learnings yet — use your best judgement.';

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId,
      agentType: AgentType.CREATIVE_PRODUCER,
      systemPrompt: company.prompts?.ideaPool ?? '',
      liveContext: this.liveContextBuilder.build(company),
      userMessage: `
Write 3 ad copy variants for ${company.name} for the following content brief.

BRIEF:
Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Target audience: ${brief.audience}
Hook: ${brief.hook}
Key message: ${brief.keyMessage}
Conversion bridge: ${brief.conversionBridge}

${learningsBlock}

For each variant write:
- primaryText: the main ad body copy (2-4 sentences, Hinglish where appropriate)
- headline: short punchy headline (5-8 words max)
- cta: call to action button text (3-5 words)
- hookStyle: tag this variant's hook style (e.g. "personal_story", "question", "bold_claim", "social_proof", "fear_then_relief")

Also pick which variant is best for this brief and why.

Return ONLY valid JSON in this format:
\`\`\`json
{
  "variants": [
    {
      "primaryText": "...",
      "headline": "...",
      "cta": "...",
      "hookStyle": "..."
    }
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
