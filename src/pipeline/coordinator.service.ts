import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { ScoutSignal, ScoutSignalDocument } from './schemas/scout-signal.schema';
import { ScoutOutput, ScoutOutputDocument } from './schemas/scout-output.schema';
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
    @InjectModel(ScoutOutput.name)
    private readonly scoutOutputModel: Model<ScoutOutputDocument>,
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

    // Load industry signals + scout outputs (for viral trends)
    const [signals, scoutOutputs] = await Promise.all([
      this.scoutSignalModel.find({ tenantId, runId }).lean().exec(),
      this.scoutOutputModel.find({ tenantId, runId }).lean().exec(),
    ]);

    if (signals.length === 0) {
      this.logger.warn(`No signals found for tenantId=${tenantId} runId=${runId}`);
    }

    const viralTrendsCount = scoutOutputs.reduce(
      (sum, o) => sum + (o.data?.viral_trends?.length ?? 0), 0,
    );
    this.logger.log(
      `Coordinator input: ${signals.length} industry signals + ${viralTrendsCount} viral trends`,
    );

    const systemPrompt = company.prompts?.coordinator ?? '';
    const liveContext = this.liveContextBuilder.build(company);

    const viralTrendInputs = scoutOutputs.map((o) => ({
      platform: o.platform,
      viral_trends: o.data?.viral_trends ?? [],
    }));

    const userMessage = this.buildCoordinatorPrompt(signals, viralTrendInputs);

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
    scoutOutputs: Array<{ platform: string; viral_trends: any[] }>,
  ): string {
    const grouped: Record<string, typeof signals> = {};
    for (const s of signals) {
      if (!grouped[s.platform]) grouped[s.platform] = [];
      grouped[s.platform].push(s);
    }

    const industrySections = Object.entries(grouped)
      .map(([platform, platformSignals]) => {
        const lines = platformSignals
          .sort((a, b) => b.signalScore - a.signalScore)
          .slice(0, 10)
          .map(
            (s) =>
              `  - [Score ${s.signalScore}] Topic: "${s.topic}" | Angle: "${s.angle}" | Recency: ${s.recency} | Source: ${s.engagementProof?.source ?? 'N/A'}`,
          )
          .join('\n');
        return `### ${platform.toUpperCase()} (${platformSignals.length} signals)\n${lines}`;
      })
      .join('\n\n');

    const viralSections = scoutOutputs
      .filter((o) => o.viral_trends?.length > 0)
      .map(({ platform, viral_trends }) => {
        const lines = viral_trends
          .slice(0, 5)
          .map(
            (v) =>
              `  - [Score ${v.signalScore}] Trend: "${v.trend}" | Tie-in: "${v.brand_tie_in}" | Source: ${v.source}`,
          )
          .join('\n');
        return `### ${platform.toUpperCase()} viral trends\n${lines}`;
      })
      .join('\n\n');

    return `
Synthesise the following signals from across all platforms and decide what's worth acting on.

## INDUSTRY SIGNALS (niche-specific)
${industrySections || 'No industry signals collected.'}

## VIRAL TRENDS (trend-jacking opportunities)
${viralSections || 'No viral trends collected.'}

Your job:
1. From industry signals — identify topics appearing across multiple platforms (cross-platform momentum)
2. From viral trends — identify trends strong enough to tie into the brand, with a clear brand_tie_in
3. Combine both into a single ranked list (topSignals) scored 0–10
4. A viral trend with a strong brand tie-in can outscore a weak industry signal
5. Produce a synthesis brief that the intelligence and idea pool agents can use

You MUST include a JSON block at the end using EXACTLY this format:

\`\`\`json
{
  "topSignals": [
    {
      "topic": "short topic name",
      "platforms": ["instagram", "twitter"],
      "compositeScore": 9.2,
      "rationale": "one sentence on why this signal matters now"
    }
  ]
}
\`\`\`

Include 5–10 top signals. Use exactly these field names: topic, platforms, compositeScore, rationale.
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
            topic: String(s.topic ?? s.title ?? s.id ?? ''),
            platforms: Array.isArray(s.platforms) ? s.platforms
              : Array.isArray(s.platformPresence) ? s.platformPresence
              : [],
            compositeScore: Number(s.compositeScore ?? s.composite_score ?? 0),
            rationale: String(s.rationale ?? s.urgency ?? (Array.isArray(s.primaryAngles) ? s.primaryAngles[0] : '') ?? ''),
          }));
        }
      } catch (err: any) {
        this.logger.warn(`extractTopSignals JSON parse failed: ${err.message} — topSignals will be empty`);
      }
    } else {
      this.logger.warn('extractTopSignals: no ```json block found in coordinator response — topSignals will be empty');
    }

    // Fallback: return empty array — content is still stored in full
    return [];
  }
}
