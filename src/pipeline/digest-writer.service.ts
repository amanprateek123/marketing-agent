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

    const runnerUps = ideaPool.briefs
      .filter((b) => b.briefId !== ideaPool.selectedBriefId)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, 4)
      .map((b, i) => `${i + 1}. "${b.topic}" | ${b.platform} ${b.format} | Score: ${b.finalScore}/10`)
      .join('\n');

    return `
Write the weekly marketing intelligence digest for ${company.name}.

IMPORTANT: You have all the data you need below. Do NOT ask any questions. Do NOT request clarification. Write the digest immediately using the data provided.

TOP SIGNALS THIS WEEK:
${topSignals || 'See coordinator synthesis — signals were collected across all platforms.'}

WINNING CONTENT BRIEF:
${winnerBlock}

SELECTION REASON: ${ideaPool.selectionReason}

RUNNER-UP IDEAS (not selected this run):
${runnerUps || 'No runner-up ideas.'}

The digest should:
1. Open with 2-3 key market insights from the top signals
2. Present the winning content idea with full brief details
3. List the runner-up ideas with their scores
4. Close with one actionable next step for the team

Write in a clear, confident tone. This goes directly to the marketing team. 400-500 words max.
    `.trim();
  }
}
