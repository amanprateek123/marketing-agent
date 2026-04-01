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
    const ideasPerRun = company.pipelineConfig?.ideasPerRun ?? 5;

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

    const briefs = this.parseBriefs(generated.content);

    if (briefs.length === 0) {
      this.logger.warn(`Idea pool returned no briefs: tenantId=${tenantId} runId=${runId}`);
      return { briefs: [], selectedBriefId: '', selectionReason: '' };
    }

    // ── Rule-based winner selection ───────────────────────────────────────────
    const winner = this.selectWinner(briefs, coordinatorResult);
    const briefId = uuidv4();
    winner.briefId = briefId;

    // ── Persist ───────────────────────────────────────────────────────────────
    await this.intelligenceBriefModel.insertMany(
      briefs.map((b) => ({
        tenantId,
        runId,
        topic: b.topic,
        angle: b.angle,
        platform: b.platform,
        format: b.format,
        audience: b.audience,
        confidenceScore: 0,
        urgencyScore: b.urgent ? 10 : 5,
        finalScore: b.priorityScore ?? 0,
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
      finalScore: winner.priorityScore ?? 0,
      selected: true,
      selectionReason: winner.selectionReason,
    });

    this.logger.log(
      `Idea pool done: tenantId=${tenantId} runId=${runId} briefs=${briefs.length} selected=${briefId} source=${winner.ideaSource}`,
    );

    return {
      briefs: briefs.map((b) => ({
        briefId: b.briefId ?? '',
        topic: b.topic,
        angle: b.angle,
        platform: b.platform,
        format: b.format,
        audience: b.audience,
        hook: b.hook ?? '',
        keyMessage: b.keyMessage ?? '',
        conversionBridge: b.conversionBridge ?? '',
        suggestedBudget: b.suggestedBudget ?? 0,
        finalScore: b.priorityScore ?? 0,
      })),
      selectedBriefId: briefId,
      selectionReason: winner.selectionReason,
    };
  }

  private buildGeneratePrompt(
    coordinator: CoordinatorResult,
    competitorResearch: string,
    marketResearch: string,
    company: CompanyDocument,
    ideasPerRun: number,
  ): string {
    const coordinatorSlots = Math.max(1, ideasPerRun - 2);

    const topSignals = coordinator.topSignals
      .slice(0, coordinatorSlots)
      .map((s, i) =>
        `Signal ${i + 1} (score: ${s.compositeScore}) — "${s.topic}" | Platforms: ${s.platforms.join(', ')} | ${s.rationale}`,
      )
      .join('\n');

    return `
Generate exactly ${ideasPerRun} content ideas for ${company.name} split across 3 sources.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOURCE 1 — COORDINATOR SIGNALS (generate ${coordinatorSlots} ideas)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generate one idea per signal below. Each idea MUST directly address its signal.
Set ideaSource to "scout_signal" or "viral_trend" based on what the signal is.
Set signalRank to the signal number (1, 2, 3...).

${topSignals || coordinator.content.slice(0, 2000)}

FULL COORDINATOR SYNTHESIS (for context):
${coordinator.content}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOURCE 2 — COMPETITOR GAP (generate 1 idea)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
From the competitor research below, identify the single biggest gap or vulnerability
a competitor has RIGHT NOW that ${company.name} can exploit.
Set ideaSource to "competitor_gap".
Set urgent: true if this gap is time-sensitive (competitor is vulnerable this week).

${competitorResearch}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOURCE 3 — MARKET INSIGHT (generate 1 idea)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
From the market research below, identify the strongest seasonal or trending
market opportunity for ${company.name} right now.
Set ideaSource to "market_insight".
Set urgent: true if this is time-sensitive (seasonal window closing soon).

${marketResearch}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Return exactly ${ideasPerRun} ideas. For each idea provide:

\`\`\`json
{
  "briefs": [
    {
      "topic": "...",
      "angle": "...",
      "platform": "instagram|youtube|twitter|reddit",
      "format": "reel|carousel|thread|video|image",
      "audience": "...",
      "hook": "opening line or visual hook",
      "keyMessage": "what the audience should believe after seeing this",
      "conversionBridge": "how this leads to a sale or sign-up",
      "suggestedBudget": 0,
      "ideaSource": "scout_signal|viral_trend|competitor_gap|market_insight",
      "sourcePlatforms": ["instagram", "youtube"],
      "signalRank": 1,
      "urgent": false,
      "priorityScore": 8.5,
      "selectionReason": "one sentence on why this idea matters now"
    }
  ]
}
\`\`\`

Rules:
- signalRank: 1/2/3 for coordinator signal ideas, null for competitor/market ideas
- urgent: true only if this idea must be executed THIS WEEK
- priorityScore: your honest 1-10 rating for this idea's potential
    `.trim();
  }

  // ── Rule-based winner selection ─────────────────────────────────────────────
  // Priority order:
  // 1. Urgent competitor gap (competitor is vulnerable RIGHT NOW)
  // 2. Idea tied to Signal 1 (highest coordinator signal)
  // 3. Urgent market insight
  // 4. Idea tied to Signal 2
  // 5. Fallback: highest priorityScore
  private selectWinner(briefs: any[], coordinator: CoordinatorResult): any {
    // 1. Urgent competitor gap
    const urgentGap = briefs.find((b) => b.ideaSource === 'competitor_gap' && b.urgent === true);
    if (urgentGap) {
      urgentGap.selectionReason = urgentGap.selectionReason ?? 'Urgent competitor gap — competitor is vulnerable this week';
      return urgentGap;
    }

    // 2. Signal 1 idea
    const signal1 = briefs.find((b) => b.signalRank === 1);
    if (signal1) {
      const topSignal = coordinator.topSignals[0];
      signal1.selectionReason = signal1.selectionReason ??
        `Tied to top coordinator signal "${topSignal?.topic ?? 'Signal 1'}" (score: ${topSignal?.compositeScore ?? 'N/A'})`;
      return signal1;
    }

    // 3. Urgent market insight
    const urgentMarket = briefs.find((b) => b.ideaSource === 'market_insight' && b.urgent === true);
    if (urgentMarket) {
      urgentMarket.selectionReason = urgentMarket.selectionReason ?? 'Urgent market insight — seasonal window closing';
      return urgentMarket;
    }

    // 4. Signal 2 idea
    const signal2 = briefs.find((b) => b.signalRank === 2);
    if (signal2) {
      signal2.selectionReason = signal2.selectionReason ?? 'Tied to Signal 2 — no Signal 1 idea generated';
      return signal2;
    }

    // 5. Fallback: highest priorityScore
    const fallback = briefs.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))[0];
    fallback.selectionReason = fallback.selectionReason ?? 'Highest priority score among generated ideas';
    return fallback;
  }

  private parseBriefs(content: string): any[] {
    const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      try {
        const parsed = JSON.parse(fenceMatch[1].trim());
        return Array.isArray(parsed.briefs) ? parsed.briefs.map((b: any) => ({ ...b, briefId: '' })) : [];
      } catch {
        return [];
      }
    }

    // Fallback: find outermost { }
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1) return [];
    try {
      const parsed = JSON.parse(content.slice(start, end + 1));
      return Array.isArray(parsed.briefs) ? parsed.briefs.map((b: any) => ({ ...b, briefId: '' })) : [];
    } catch {
      return [];
    }
  }
}
