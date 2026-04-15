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
      await this.safeSend(slackWebhook, tenantId, signalsContent);
    }

    // ── 2. One digest entry + Slack message per idea (template — no LLM needed) ──
    for (let i = 0; i < ideaPoolResult.briefs.length; i++) {
      const brief = ideaPoolResult.briefs[i];
      const isRecommended = brief.briefId === ideaPoolResult.selectedBriefId;

      const ideaContent = this.formatIdeaBrief(
        brief, isRecommended, ideaPoolResult.selectionReason, i + 1, ideaPoolResult.briefs.length,
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
        await this.safeDivider(slackWebhook, tenantId);
        await this.safeSend(slackWebhook, tenantId, ideaContent);
      }
    }

    // ── 3. CTA ────────────────────────────────────────────────────────────────
    const ctaContent = this.buildCta(company, ideaPoolResult, runId);
    await this.digestModel.create({
      tenantId, runId, type: 'cta', content: ctaContent, delivered: false,
    });

    if (slackWebhook) {
      await this.safeDivider(slackWebhook, tenantId);
      await this.safeSend(slackWebhook, tenantId, ctaContent);
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
Write a paid ad intelligence summary for ${company.name}'s performance marketing team.

Do NOT ask questions. Write immediately.

TOP SIGNALS THIS WEEK (ranked by paid ad potential):
${topSignals || 'General platform signals collected — no top signals ranked this run.'}

Write 3-4 punchy sentences covering:
- What's happening in the market that creates a paid ad opportunity
- Which signals have the highest commercial/purchase intent right now
- The single biggest Meta ad campaign opportunity this week

Format as Slack markdown. No headers. 80-100 words max. Tone: performance marketer, not brand journalist.
      `.trim(),
      maxTurns: 2,
    });

    return `📊 *${company.name} | Weekly Intelligence — Week of ${this.weekLabel()}*\n\n${result.content}`;
  }

  // ── Per-idea brief (template — no LLM needed) ──────────────────────────────
  private formatIdeaBrief(
    brief: IdeaPoolResult['briefs'][0],
    isRecommended: boolean,
    selectionReason: string,
    index: number,
    total: number,
  ): string {
    const label = isRecommended ? `💡 *Idea ${index} of ${total} — RECOMMENDED*` : `💡 *Idea ${index} of ${total}*`;
    const recommendedLine = isRecommended ? `\n⭐ *System recommendation:* ${selectionReason}` : '';

    const lines = [
      label,
      recommendedLine,
      '',
      `*${brief.topic} — ${brief.angle}*`,
      brief.product ? `🛒 Product: ${brief.product}` : '',
      brief.hook ? `🎯 Ad hook: "${brief.hook}"` : '',
      brief.keyMessage ? `💬 Key message: ${brief.keyMessage}` : '',
      brief.conversionBridge ? `🔗 Conversion bridge: ${brief.conversionBridge}` : '',
      `👥 Audience: ${brief.audience}`,
      `📍 ${brief.platform} ${brief.format} | ₹${brief.suggestedBudget}/day`,
    ].filter(Boolean).join('\n');

    return lines;
  }

  // ── Safe Slack send — digest is already persisted, delivery failure shouldn't block pipeline
  private async safeSend(webhookUrl: string, tenantId: string, content: string): Promise<void> {
    try {
      await this.slackService.sendMessage(webhookUrl, tenantId, content);
    } catch (err: any) {
      this.logger.error(`Slack delivery failed for ${tenantId} — digest saved to DB but not delivered: ${err.message}`);
    }
  }

  private async safeDivider(webhookUrl: string, tenantId: string): Promise<void> {
    try {
      await this.slackService.sendDivider(webhookUrl, tenantId);
    } catch {
      // divider failure is non-critical
    }
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
