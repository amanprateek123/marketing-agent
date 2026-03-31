import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { ScoutSignal, ScoutSignalDocument } from './schemas/scout-signal.schema';
import { CoordinatorOutput, CoordinatorOutputDocument } from './schemas/coordinator-output.schema';
import { ResearchOutput, ResearchOutputDocument } from './schemas/research-output.schema';

export interface CoordinatorResult {
  coordinatorOutputId: string;
  content: string;
  topSignals: {
    topic: string;
    platforms: string[];
    compositeScore: number;
    rationale: string;
  }[];
}

@Injectable()
export class CoordinatorService {
  private readonly logger = new Logger(CoordinatorService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(ScoutSignal.name)
    private readonly scoutSignalModel: Model<ScoutSignalDocument>,
    @InjectModel(CoordinatorOutput.name)
    private readonly coordinatorOutputModel: Model<CoordinatorOutputDocument>,
    @InjectModel(ResearchOutput.name)
    private readonly researchOutputModel: Model<ResearchOutputDocument>,
  ) {}

  async run(
    company: CompanyDocument,
    runId: string,
  ): Promise<CoordinatorResult> {
    const tenantId = company.tenantId;

    // Load all signals saved by scouts for this run
    const signals = await this.scoutSignalModel
      .find({ tenantId, runId })
      .lean()
      .exec();

    if (signals.length === 0) {
      this.logger.warn(`No signals found for tenantId=${tenantId} runId=${runId}`);
    }

    const systemPrompt = company.prompts?.coordinator ?? '';
    const liveContext = this.liveContextBuilder.build(company);

    const userMessage = this.buildCoordinatorPrompt(signals);

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.COORDINATOR,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 5,
    });

    const topSignals = this.extractTopSignals(result.content);

    const saved = await this.coordinatorOutputModel.create({
      tenantId,
      runId,
      content: result.content,
      topSignals,
    });

    this.logger.log(
      `Coordinator done: tenantId=${tenantId} runId=${runId} signals=${topSignals.length}`,
    );

    return {
      coordinatorOutputId: (saved as any)._id.toString(),
      content: result.content,
      topSignals,
    };
  }

  async runCompetitorResearch(
    company: CompanyDocument,
    runId: string,
    coordinatorContent: string,
  ): Promise<string> {
    const tenantId = company.tenantId;
    const systemPrompt = company.prompts?.competitorResearch ?? '';
    const liveContext = this.liveContextBuilder.build(company);

    const userMessage = `
Based on this coordinator synthesis, perform deep competitor research.

COORDINATOR SYNTHESIS:
${coordinatorContent}

Company competitors to analyse: ${company.competitors.join(', ')}

Use web_search to find recent competitor content, campaigns, and positioning changes.
Return your full research findings.
    `.trim();

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.COMPETITOR_RESEARCH,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 8,
    });

    await this.researchOutputModel.create({
      tenantId,
      runId,
      type: 'competitor',
      content: result.content,
    });

    this.logger.log(`Competitor research done: tenantId=${tenantId} runId=${runId}`);
    return result.content;
  }

  async runMarketResearch(
    company: CompanyDocument,
    runId: string,
    coordinatorContent: string,
  ): Promise<string> {
    const tenantId = company.tenantId;
    const systemPrompt = company.prompts?.marketResearch ?? '';
    const liveContext = this.liveContextBuilder.build(company);

    const userMessage = `
Based on this coordinator synthesis, analyse current market conditions and consumer trends.

COORDINATOR SYNTHESIS:
${coordinatorContent}

Industry: ${company.industry}
Target audience: ${company.targetAudience}

Use web_search to find recent market data, news, and consumer behaviour trends.
Return your full market research findings.
    `.trim();

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.MARKET_RESEARCH,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 6,
    });

    await this.researchOutputModel.create({
      tenantId,
      runId,
      type: 'market',
      content: result.content,
    });

    this.logger.log(`Market research done: tenantId=${tenantId} runId=${runId}`);
    return result.content;
  }

  private buildCoordinatorPrompt(
    signals: Array<{
      platform: string;
      topic: string;
      angle: string;
      signalScore: number;
      recency: string;
      specificity: string;
      sourceQuality: string;
      engagementProof?: { metric: string; value: number; source: string };
    }>,
  ): string {
    const grouped: Record<string, typeof signals> = {};
    for (const s of signals) {
      if (!grouped[s.platform]) grouped[s.platform] = [];
      grouped[s.platform].push(s);
    }

    const sections = Object.entries(grouped)
      .map(([platform, platformSignals]) => {
        const lines = platformSignals
          .sort((a, b) => b.signalScore - a.signalScore)
          .slice(0, 10)
          .map(
            (s) =>
              `  - [Score ${s.signalScore}] Topic: "${s.topic}" | Angle: "${s.angle}" | Recency: ${s.recency} | Specificity: ${s.specificity} | Source: ${s.engagementProof?.source ?? 'N/A'}`,
          )
          .join('\n');
        return `## ${platform.toUpperCase()} (${platformSignals.length} signals)\n${lines}`;
      })
      .join('\n\n');

    return `
Synthesise the following scout signals from across all platforms.

${sections.length > 0 ? sections : 'No signals collected this run.'}

Your job:
1. Identify topics that appear across multiple platforms (cross-platform momentum)
2. Score each cross-platform topic with a compositeScore (0–10)
3. Explain your rationale for the top signals
4. Produce a synthesis brief that the intelligence agents can use

Return your full synthesis.
    `.trim();
  }

  private extractTopSignals(content: string): CoordinatorResult['topSignals'] {
    // Try to parse a JSON block if the agent included one
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        const signals = parsed.topSignals ?? parsed.top_signals ?? parsed.signals ?? [];
        if (Array.isArray(signals) && signals.length > 0) {
          return signals.slice(0, 10).map((s: any) => ({
            topic: String(s.topic ?? ''),
            platforms: Array.isArray(s.platforms) ? s.platforms : [],
            compositeScore: Number(s.compositeScore ?? s.composite_score ?? 0),
            rationale: String(s.rationale ?? ''),
          }));
        }
      } catch {
        // fall through to empty
      }
    }

    // Fallback: return empty array — content is still stored in full
    return [];
  }
}
