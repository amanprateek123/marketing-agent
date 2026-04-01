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
    const liveContext = this.liveContextBuilder.build(company);
    const ideasPerRun = company.pipelineConfig?.ideasPerRun ?? 3;

    // ── Step 1: Generate ideas (no scores) ───────────────────────────────────
    const generateMessage = this.buildGeneratePrompt(
      coordinatorResult,
      competitorResearch,
      marketResearch,
      company,
      ideasPerRun,
    );

    const generated = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.IDEA_POOL,
      systemPrompt: company.prompts?.ideaPool ?? '',
      liveContext,
      userMessage: generateMessage,
      maxTurns: 8,
    });

    const rawBriefs = this.parseGeneratedBriefs(generated.content);

    if (rawBriefs.length === 0) {
      this.logger.warn(`Idea pool returned no briefs: tenantId=${tenantId} runId=${runId}`);
      return { briefs: [], selectedBriefId: '', selectionReason: '' };
    }

    // ── Step 2: Score ideas blindly (separate agent call) ────────────────────
    const scoreMessage = this.buildScoringPrompt(rawBriefs, company);

    const scored = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.IDEA_POOL,
      systemPrompt: company.prompts?.ideaPool ?? '',
      liveContext,
      userMessage: scoreMessage,
      maxTurns: 3,
    });

    const scoredBriefs = this.parseScoredBriefs(scored.content, rawBriefs);
    const sorted = scoredBriefs.sort((a, b) => b.finalScore - a.finalScore);
    const winner = sorted[0];
    const briefId = uuidv4();
    winner.briefId = briefId;

    // ── Persist ───────────────────────────────────────────────────────────────
    await this.intelligenceBriefModel.insertMany(
      sorted.map((b) => ({
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

    await this.creativeBriefModel.create({
      tenantId,
      runId,
      briefId,
      topic: winner.topic,
      angle: winner.angle,
      platform: winner.platform,
      format: winner.format,
      audience: winner.audience,
      hook: winner.hook,
      keyMessage: winner.keyMessage,
      conversionBridge: winner.conversionBridge,
      suggestedBudget: winner.suggestedBudget ?? 0,
      finalScore: winner.finalScore,
      selected: true,
      selectionReason: winner.selectionReason ?? 'Highest score from blind evaluation',
    });

    this.logger.log(
      `Idea pool done: tenantId=${tenantId} runId=${runId} briefs=${sorted.length} selected=${briefId}`,
    );

    return {
      briefs: sorted,
      selectedBriefId: briefId,
      selectionReason: winner.selectionReason ?? 'Highest score from blind evaluation',
    };
  }

  // ── Step 1 prompt: generate ideas, NO scores ────────────────────────────────
  private buildGeneratePrompt(
    coordinator: CoordinatorResult,
    competitorResearch: string,
    marketResearch: string,
    company: CompanyDocument,
    ideasPerRun: number,
  ): string {
    const topSignals = coordinator.topSignals
      .slice(0, 5)
      .map((s, i) => `${i + 1}. "${s.topic}" | Platforms: ${s.platforms.join(', ')} | ${s.rationale}`)
      .join('\n');

    return `
Generate ${ideasPerRun} content ideas for ${company.name}. Do NOT score them — scoring happens separately.

TOP CROSS-PLATFORM SIGNALS:
${topSignals || 'See coordinator synthesis below.'}

COORDINATOR SYNTHESIS:
${coordinator.content}

COMPETITOR RESEARCH:
${competitorResearch.slice(0, 2000)}

MARKET RESEARCH:
${marketResearch.slice(0, 2000)}

For each idea provide:
- topic, angle, platform, format, audience
- hook (opening line or visual hook)
- keyMessage (what the audience should believe after seeing this)
- conversionBridge (how this leads to a sale or sign-up)
- suggestedBudget (INR for paid promotion, 0 if organic)
- ideaSource: "scout_signal" | "viral_trend" | "competitor_gap" | "market_insight"

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
      "ideaSource": "scout_signal|viral_trend|competitor_gap|market_insight",
      "sourcePlatforms": ["instagram", "youtube"]
    }
  ]
}
\`\`\`
    `.trim();
  }

  // ── Step 2 prompt: score ideas blindly ────────────────────────────────────
  private buildScoringPrompt(briefs: any[], company: CompanyDocument): string {
    const briefList = briefs
      .map((b, i) => `
Idea ${i + 1}:
  Topic: ${b.topic}
  Angle: ${b.angle}
  Platform: ${b.platform} | Format: ${b.format}
  Audience: ${b.audience}
  Hook: ${b.hook}
  Key Message: ${b.keyMessage}
  Conversion Bridge: ${b.conversionBridge}
      `.trim())
      .join('\n\n');

    return `
Score these ${briefs.length} content ideas for ${company.name}. Be objective and critical — do not inflate scores.

${briefList}

For each idea score:
- confidenceScore (0–10): how confident are you this topic is genuinely trending?
- urgencyScore (0–10): how time-sensitive is this? Must act this week?
- finalScore (0–10): overall potential — consider virality, brand fit, conversion potential
- selectionReason: one sentence on why this score

Use the full range. A mediocre idea should score 4-5, not 7-8.

Return a JSON block:
\`\`\`json
{
  "scores": [
    {
      "index": 0,
      "confidenceScore": 7,
      "urgencyScore": 9,
      "finalScore": 8.2,
      "selectionReason": "..."
    }
  ]
}
\`\`\`
    `.trim();
  }

  private parseGeneratedBriefs(content: string): any[] {
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
    if (!jsonMatch) return [];
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return Array.isArray(parsed.briefs) ? parsed.briefs : [];
    } catch {
      return [];
    }
  }

  private parseScoredBriefs(content: string, rawBriefs: any[]): any[] {
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
    if (!jsonMatch) {
      // fallback: return briefs with zero scores
      return rawBriefs.map((b) => ({ ...b, briefId: '', finalScore: 0, confidenceScore: 0, urgencyScore: 0 }));
    }

    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const scores: any[] = Array.isArray(parsed.scores) ? parsed.scores : [];

      return rawBriefs.map((b, i) => {
        const score = scores.find((s) => s.index === i) ?? {};
        return {
          ...b,
          briefId: '',
          confidenceScore: Number(score.confidenceScore ?? 0),
          urgencyScore: Number(score.urgencyScore ?? 0),
          finalScore: Number(score.finalScore ?? 0),
          selectionReason: score.selectionReason ?? '',
        };
      });
    } catch {
      return rawBriefs.map((b) => ({ ...b, briefId: '', finalScore: 0, confidenceScore: 0, urgencyScore: 0 }));
    }
  }
}
