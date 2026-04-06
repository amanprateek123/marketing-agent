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
import { SlackService } from '../delivery/slack.service';

@Injectable()
export class DigestWriterService {
  private readonly logger = new Logger(DigestWriterService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    private readonly slackService: SlackService,
    @InjectModel(Digest.name)
    private readonly digestModel: Model<DigestDocument>,
  ) {}

  async run(
    company: CompanyDocument,
    runId: string,
    coordinatorResult: CoordinatorResult,
    ideaPoolResult: IdeaPoolResult,
  ): Promise<void> {
    const tenantId = company.tenantId;
    const slackWebhook = company.delivery?.slackWebhook;

    // ── 1. Signals summary ────────────────────────────────────────────────────
    const signalsContent = await this.writeSignalsSummary(
      company, runId, coordinatorResult,
    );
    await this.digestModel.create({
      tenantId, runId, type: 'signals', content: signalsContent, delivered: false,
    });

    if (slackWebhook) {
      await this.slackService.sendMessage(slackWebhook, tenantId, signalsContent);
    }

    // ── 2. One digest entry + Slack message per idea ──────────────────────────
    for (let i = 0; i < ideaPoolResult.briefs.length; i++) {
      const brief = ideaPoolResult.briefs[i];
      const isRecommended = brief.briefId === ideaPoolResult.selectedBriefId;

      const ideaContent = await this.writeIdeaBrief(
        company, runId, brief, isRecommended, ideaPoolResult.selectionReason, i + 1, ideaPoolResult.briefs.length,
      );

      await this.digestModel.create({
        tenantId,
        runId,
        type: 'idea',
        briefId: brief.briefId,
        ideaIndex: i + 1,
        recommended: isRecommended,
        content: ideaContent,
        delivered: false,
      });

      if (slackWebhook) {
        await this.slackService.sendDivider(slackWebhook, tenantId);
        await this.slackService.sendMessage(slackWebhook, tenantId, ideaContent);
      }
    }

    // ── 3. CTA ────────────────────────────────────────────────────────────────
    const ctaContent = this.buildCta(company, ideaPoolResult, runId);
    await this.digestModel.create({
      tenantId, runId, type: 'cta', content: ctaContent, delivered: false,
    });

    if (slackWebhook) {
      await this.slackService.sendDivider(slackWebhook, tenantId);
      await this.slackService.sendMessage(slackWebhook, tenantId, ctaContent);
    }

    // Mark all delivered
    if (slackWebhook) {
      await this.digestModel.updateMany(
        { tenantId, runId },
        { delivered: true, deliveredAt: new Date() },
      );
    }

    this.logger.log(
      `Digest done: tenantId=${tenantId} runId=${runId} ideas=${ideaPoolResult.briefs.length} slack=${!!slackWebhook}`,
    );
  }

  // ── Signals summary ─────────────────────────────────────────────────────────
  private async writeSignalsSummary(
    company: CompanyDocument,
    runId: string,
    coordinator: CoordinatorResult,
  ): Promise<string> {
    const topSignals = coordinator.topSignals
      .slice(0, 5)
      .map((s, i) => `${i + 1}. "${s.topic}" — ${s.rationale}`)
      .join('\n');

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId,
      agentType: AgentType.DIGEST_WRITER,
      systemPrompt: company.prompts?.digestWriter ?? '',
      liveContext: this.liveContextBuilder.build(company),
      userMessage: `
Write a market signals summary for ${company.name}'s marketing team.

Do NOT ask questions. Write immediately.

TOP SIGNALS THIS WEEK:
${topSignals || 'General platform signals collected — no top signals ranked this run.'}

Write 3-4 punchy sentences covering:
- What is happening in the market right now
- Which signals are most urgent and why
- The single biggest opportunity this week

Format as Slack markdown. No headers. 80-100 words max.
      `.trim(),
      maxTurns: 2,
    });

    return `📊 *${company.name} | Weekly Intelligence — Week of ${this.weekLabel()}*\n\n${result.content}`;
  }

  // ── Per-idea brief ──────────────────────────────────────────────────────────
  private async writeIdeaBrief(
    company: CompanyDocument,
    runId: string,
    brief: IdeaPoolResult['briefs'][0],
    isRecommended: boolean,
    selectionReason: string,
    index: number,
    total: number,
  ): Promise<string> {
    const recommendedLine = isRecommended
      ? `\n⭐ *System recommendation:* ${selectionReason}`
      : '';

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId,
      agentType: AgentType.DIGEST_WRITER,
      systemPrompt: company.prompts?.digestWriter ?? '',
      liveContext: this.liveContextBuilder.build(company),
      userMessage: `
Write a content brief for ${company.name}'s marketing team. This is idea ${index} of ${total}.

Do NOT ask questions. Write immediately.

BRIEF DATA:
Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform} | Format: ${brief.format}
Audience: ${brief.audience}
Hook: ${brief.hook}
Key message: ${brief.keyMessage}
Conversion bridge: ${brief.conversionBridge}
Budget: ₹${brief.suggestedBudget}

Write a focused content brief in Slack markdown format:
- Bold topic as the header
- 1 sentence on the angle/why this matters now
- Hook (exact opening line or visual)
- Key message (what the audience should believe after)
- Conversion bridge (how it leads to a purchase)
- Platform + format + suggested budget

120-150 words max. No scores. Confident, actionable tone.
      `.trim(),
      maxTurns: 2,
    });

    const label = isRecommended ? `💡 *Idea ${index} of ${total} — RECOMMENDED*` : `💡 *Idea ${index} of ${total}*`;
    return `${label}${recommendedLine}\n\n${result.content}`;
  }

  // ── CTA — no LLM needed ────────────────────────────────────────────────────
  private buildCta(company: CompanyDocument, ideaPool: IdeaPoolResult, runId: string): string {
    const recommended = ideaPool.briefs.find((b) => b.briefId === ideaPool.selectedBriefId);
    const platform = recommended?.platform ?? 'your chosen platform';
    const format = recommended?.format ?? 'content';

    const ideaLinks = ideaPool.briefs
      .filter(b => b.briefId !== ideaPool.selectedBriefId && b.briefId)
      .map((b, i) => `  ${i + 1}. *${b.topic}* → \`POST /api/v1/pipeline/${company.tenantId}/runs/${runId}/produce/${b.briefId}\``)
      .join('\n');

    return `✅ *Next step*\nThe recommended idea (${platform} ${format}) is already in production.\n\n${ideaLinks ? `*Want to run another idea?* Pick any:\n${ideaLinks}` : ''}`;
  }

  private weekLabel(): string {
    return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }
}
