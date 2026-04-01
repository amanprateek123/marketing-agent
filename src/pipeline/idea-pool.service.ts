import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { IntelligenceBrief, IntelligenceBriefDocument } from './schemas/intelligence-brief.schema';
import { CreativeBrief, CreativeBriefDocument } from './schemas/creative-brief.schema';
import { CoordinatorResult } from './coordinator.service';

export interface IdeaPoolResult {
  briefs: Array<{
    briefId: string;
    topic: string;
    angle: string;
    platform: string;
    format: string;
    audience: string;
    hook: string;
    keyMessage: string;
    conversionBridge: string;
    suggestedBudget: number;
    finalScore: number;
  }>;
  selectedBriefId: string;
  selectionReason: string;
}

@Injectable()
export class IdeaPoolService {
  private readonly logger = new Logger(IdeaPoolService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(IntelligenceBrief.name)
    private readonly intelligenceBriefModel: Model<IntelligenceBriefDocument>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBriefDocument>,
  ) {}

  async run(
    company: CompanyDocument,
    runId: string,
    coordinatorResult: CoordinatorResult,
    competitorResearch: string,
    marketResearch: string,
  ): Promise<IdeaPoolResult> {
    const tenantId = company.tenantId;

    const systemPrompt = company.prompts?.ideaPool ?? '';
    const liveContext = this.liveContextBuilder.build(company);

    const userMessage = this.buildIdeaPoolPrompt(
      coordinatorResult,
      competitorResearch,
      marketResearch,
      company,
    );

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.IDEA_POOL,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 8,
    });

    const parsed = this.parseBriefs(result.content);

    if (parsed.briefs.length === 0) {
      this.logger.warn(
        `Idea pool returned no briefs: tenantId=${tenantId} runId=${runId}`,
      );
      return { briefs: [], selectedBriefId: '', selectionReason: '' };
    }

    // Score and select
    const scored = this.scoreBriefs(parsed.briefs);
    const selected = scored[0];
    const briefId = uuidv4();
    selected.briefId = briefId;

    // Persist intelligence briefs (one per idea)
    await this.intelligenceBriefModel.insertMany(
      scored.map((b) => ({
        tenantId,
        runId,
        topic: b.topic,
        angle: b.angle,
        platform: b.platform,
        format: b.format,
        audience: b.audience,
        confidenceScore: b.confidenceScore ?? 0,
        urgencyScore: b.urgencyScore ?? 0,
        finalScore: b.finalScore,
        sourcePlatforms: b.sourcePlatforms ?? [],
        suggestedBudget: b.suggestedBudget ?? 0,
        selected: b.briefId === briefId,
      })),
    );

    // Persist the winner as a creative brief
    await this.creativeBriefModel.create({
      tenantId,
      runId,
      briefId,
      topic: selected.topic,
      angle: selected.angle,
      platform: selected.platform,
      format: selected.format,
      audience: selected.audience,
      hook: selected.hook,
      keyMessage: selected.keyMessage,
      conversionBridge: selected.conversionBridge,
      suggestedBudget: selected.suggestedBudget ?? 0,
      finalScore: selected.finalScore,
      selected: true,
      selectionReason: parsed.selectionReason ?? 'Highest composite score',
    });

    this.logger.log(
      `Idea pool done: tenantId=${tenantId} runId=${runId} briefs=${scored.length} selected=${briefId}`,
    );

    return {
      briefs: scored,
      selectedBriefId: briefId,
      selectionReason: parsed.selectionReason ?? 'Highest composite score',
    };
  }

  private buildIdeaPoolPrompt(
    coordinator: CoordinatorResult,
    competitorResearch: string,
    marketResearch: string,
    company: CompanyDocument,
  ): string {
    const ideasPerRun = company.pipelineConfig?.ideasPerRun ?? 3;

    const topSignals = coordinator.topSignals
      .slice(0, 5)
      .map(
        (s, i) =>
          `${i + 1}. "${s.topic}" | Platforms: ${s.platforms.join(', ')} | Score: ${s.compositeScore} | ${s.rationale}`,
      )
      .join('\n');

    return `
Generate ${ideasPerRun} content ideas for ${company.name} and pick the single best one.

TOP CROSS-PLATFORM SIGNALS:
${topSignals || 'See coordinator synthesis below.'}

COORDINATOR SYNTHESIS:
${coordinator.content}

COMPETITOR RESEARCH SUMMARY:
${competitorResearch.slice(0, 2000)}

MARKET RESEARCH SUMMARY:
${marketResearch.slice(0, 2000)}

For each idea, provide:
- topic, angle, platform, format, audience
- hook (opening line or visual hook)
- keyMessage (what the audience should believe after seeing this)
- conversionBridge (how this leads to a sale or sign-up)
- suggestedBudget (INR for paid promotion, 0 if organic)
- finalScore (0–10)

Then select the single best idea and explain why.

Return a JSON block:
\`\`\`json
{
  "briefs": [
    {
      "topic": "...",
      "angle": "...",
      "platform": "instagram|youtube|twitter|reddit",
      "format": "reel|carousel|thread|video|image",
      "audience": "...",
      "hook": "...",
      "keyMessage": "...",
      "conversionBridge": "...",
      "suggestedBudget": 0,
      "finalScore": 8.5,
      "confidenceScore": 7,
      "urgencyScore": 8,
      "sourcePlatforms": ["instagram", "youtube"]
    }
  ],
  "selectedIndex": 0,
  "selectionReason": "..."
}
\`\`\`
    `.trim();
  }

  private parseBriefs(content: string): {
    briefs: any[];
    selectionReason: string;
  } {
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
    if (!jsonMatch) return { briefs: [], selectionReason: '' };

    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const briefs: any[] = Array.isArray(parsed.briefs) ? parsed.briefs : [];
      const selectedIndex: number = parsed.selectedIndex ?? 0;
      const selectionReason: string = parsed.selectionReason ?? '';

      // Mark the selected brief
      if (briefs[selectedIndex]) {
        briefs[selectedIndex]._selected = true;
      }

      return { briefs, selectionReason };
    } catch {
      return { briefs: [], selectionReason: '' };
    }
  }

  private scoreBriefs(
    briefs: any[],
  ): Array<any & { briefId: string; finalScore: number }> {
    return briefs
      .map((b) => ({
        ...b,
        briefId: '',
        finalScore: Number(b.finalScore ?? 0),
      }))
      .sort((a, b) => b.finalScore - a.finalScore);
  }
}
