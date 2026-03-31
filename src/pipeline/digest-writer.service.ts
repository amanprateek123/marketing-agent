import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { Digest, DigestDocument } from './schemas/digest.schema';
import { IdeaPoolResult } from './idea-pool.service';
import { CoordinatorResult } from './coordinator.service';

@Injectable()
export class DigestWriterService {
  private readonly logger = new Logger(DigestWriterService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(Digest.name)
    private readonly digestModel: Model<DigestDocument>,
  ) {}

  async run(
    company: CompanyDocument,
    runId: string,
    coordinatorResult: CoordinatorResult,
    ideaPoolResult: IdeaPoolResult,
  ): Promise<string> {
    const tenantId = company.tenantId;

    const systemPrompt = company.prompts?.digestWriter ?? '';
    const liveContext = this.liveContextBuilder.build(company);

    const userMessage = this.buildDigestPrompt(coordinatorResult, ideaPoolResult, company);

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.DIGEST_WRITER,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 3,
    });

    await this.digestModel.create({
      tenantId,
      runId,
      content: result.content,
      delivered: false,
    });

    this.logger.log(`Digest written: tenantId=${tenantId} runId=${runId}`);
    return result.content;
  }

  private buildDigestPrompt(
    coordinator: CoordinatorResult,
    ideaPool: IdeaPoolResult,
    company: CompanyDocument,
  ): string {
    const topSignals = coordinator.topSignals
      .slice(0, 3)
      .map((s) => `- "${s.topic}" (score: ${s.compositeScore}) — ${s.rationale}`)
      .join('\n');

    const winner = ideaPool.briefs.find((b) => b.briefId === ideaPool.selectedBriefId);
    const winnerBlock = winner
      ? `Topic: ${winner.topic}
Angle: ${winner.angle}
Platform: ${winner.platform} | Format: ${winner.format}
Hook: ${winner.hook}
Key message: ${winner.keyMessage}
Conversion bridge: ${winner.conversionBridge}
Score: ${winner.finalScore}/10`
      : 'No brief selected this run.';

    return `
Write the weekly marketing intelligence digest for ${company.name}.

TOP SIGNALS THIS WEEK:
${topSignals || 'No signals this run.'}

WINNING CONTENT BRIEF:
${winnerBlock}

SELECTION REASON: ${ideaPool.selectionReason}

The digest should:
1. Open with 2-3 key market insights (what's trending and why it matters)
2. Present the winning content idea with full brief details
3. List runner-up ideas briefly (topic + platform + score)
4. Close with one actionable next step

Write in a clear, confident tone. This goes directly to the marketing team.
    `.trim();
  }
}
