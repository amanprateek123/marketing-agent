import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'crypto';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import {
  ScoutOutput,
  ScoutOutputDocument,
  ScoutOutputData,
  TrendingTopic,
  ViralTrend,
} from '../schemas/scout-output.schema';
import { ScoutSignal, ScoutSignalDocument } from '../schemas/scout-signal.schema';

@Injectable()
export abstract class ScoutBaseService {
  protected abstract readonly platform: string;
  protected abstract readonly agentType: AgentType;
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly claudeService: ClaudeService,
    protected readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(ScoutOutput.name)
    protected readonly scoutOutputModel: Model<ScoutOutputDocument>,
    @InjectModel(ScoutSignal.name)
    protected readonly scoutSignalModel: Model<ScoutSignalDocument>,
  ) {}

  async execute(
    company: CompanyDocument,
    runId: string,
  ): Promise<ScoutOutputData> {
    this.logger.log(`Scout starting: ${this.platform} | run: ${runId}`);

    const systemPrompt = this.getSystemPrompt(company);
    const liveContext = this.liveContextBuilder.build(company);

    // Load recently covered signals to inject as exclusion context
    const recentlyCovered = await this.loadRecentSignals(company.tenantId);
    const userMessage = this.buildResearchPrompt(company, recentlyCovered);

    // Verification loop — retry up to 3 times if JSON is invalid
    let output: ScoutOutputData | null = null;
    let lastError = '';

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await this.claudeService.runAgent({
          tenantId: company.tenantId,
          agentType: this.agentType,
          systemPrompt,
          liveContext,
          userMessage: attempt === 1
            ? userMessage
            : `${userMessage}\n\nPREVIOUS ATTEMPT FAILED: ${lastError}\nReturn ONLY valid JSON matching the required schema. Do not include any explanation before or after the JSON.`,
          maxTurns: 20,
          runId,
        });

        this.logger.debug(
          `Scout raw response (${this.platform} attempt ${attempt}): ${result.content.slice(0, 300)}`,
        );

        output = this.parseAndValidate(result.content);
        this.logger.log(
          `Scout success: ${this.platform} | attempt: ${attempt} | industry signals: ${output.trending_topics.length} | viral trends: ${output.viral_trends.length}`,
        );
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Scout attempt ${attempt}/3 failed: ${this.platform} | ${lastError}`,
        );
        if (attempt === 3) {
          this.logger.error(
            `Scout gave up after 3 attempts: ${this.platform} | run: ${runId}`,
          );
          throw new Error(
            `${this.platform} scout failed after 3 attempts: ${lastError}`,
          );
        }
      }
    }

    const finalOutput = output!; // always defined — loop throws on 3rd failure

    // Save full scout output
    await this.scoutOutputModel.create({
      tenantId: company.tenantId,
      runId,
      platform: this.platform,
      data: finalOutput,
      enriched: false,
    });

    // Save individual signals for dedup tracking (industry + viral)
    await this.saveSignals(company.tenantId, runId, finalOutput.trending_topics, finalOutput.viral_trends);

    return finalOutput;
  }

  // Each scout provides its own research prompt
  // recentlyCovered is injected by base class — scouts don't need to fetch it
  protected abstract buildResearchPrompt(
    company: CompanyDocument,
    recentlyCovered: { topic: string; angle: string; type: 'industry' | 'viral' }[],
  ): string;

  // Helper — scouts call this to append the exclusion block to their prompt
  protected buildExclusionBlock(
    recentlyCovered: { topic: string; angle: string; type: 'industry' | 'viral' }[],
  ): string {
    if (recentlyCovered.length === 0) return '';

    const lines = recentlyCovered
      .map((s) => `  - "${s.topic}" | angle: "${s.angle}" [${s.type} — TTL: ${s.type === 'viral' ? '7d' : '14d'}]`)
      .join('\n');

    return `
ALREADY RESEARCHED — DO NOT REPEAT:
The following topic+angle combinations were covered in the last 1-2 weeks.
Do not return them again. Find genuinely new angles or new topics.
Same topic with a DIFFERENT angle is allowed.
Viral trends older than 7 days should be skipped entirely.

${lines}
    `.trim();
  }

  private getSystemPrompt(company: CompanyDocument): string {
    const promptKey = `${this.platform}Scout` as keyof typeof company.prompts;
    const prompt = company.prompts?.[promptKey];

    if (!prompt) {
      throw new Error(
        `No system prompt found for ${this.platform}Scout — run prompt generation first`,
      );
    }

    return prompt;
  }

  private parseAndValidate(content: string): ScoutOutputData {
    let parsed: Partial<ScoutOutputData>;

    try {
      // 1. Try to extract a ```json ... ``` block anywhere in the response
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      if (fenceMatch) {
        parsed = JSON.parse(fenceMatch[1].trim());
      } else {
        // 2. Find the outermost { ... } object in the response
        const start = content.indexOf('{');
        const end = content.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) {
          throw new Error('No JSON object found in response');
        }
        parsed = JSON.parse(content.slice(start, end + 1));
      }
    } catch (err) {
      throw new Error(
        `Invalid JSON response from ${this.platform} scout: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Validate required fields
    if (!parsed.platform) throw new Error('Missing field: platform');
    if (!Array.isArray(parsed.trending_topics)) throw new Error('Missing field: trending_topics');
    if (!Array.isArray(parsed.format_insights)) throw new Error('Missing field: format_insights');
    if (!Array.isArray(parsed.hook_examples)) throw new Error('Missing field: hook_examples');
    if (typeof parsed.raw_summary !== 'string') throw new Error('Missing field: raw_summary');

    // Validate industry topics — drop only if signalScore is missing entirely
    const validTopics = (parsed.trending_topics as TrendingTopic[]).filter((t) => {
      if (typeof t.signalScore !== 'number') {
        this.logger.warn(`Dropping signal "${t.topic}" — missing signalScore`);
        return false;
      }
      const hasSource = t.engagementProof?.source &&
        t.engagementProof.source.startsWith('http');
      if (!hasSource) {
        // Penalise but keep — no URL means lower confidence, not zero value
        t.signalScore = Math.min(t.signalScore, 5);
        this.logger.warn(`Signal "${t.topic}" kept with capped score (no source URL)`);
      }
      return true;
    });

    // Validate viral trends — drop only if signalScore is missing entirely
    const validViralTrends = ((parsed.viral_trends ?? []) as ViralTrend[]).filter((v) => {
      if (typeof v.signalScore !== 'number') {
        this.logger.warn(`Dropping viral trend "${v.trend}" — missing signalScore`);
        return false;
      }
      const hasSource = v.source && v.source.startsWith('http');
      if (!hasSource) {
        v.signalScore = Math.min(v.signalScore, 5);
        this.logger.warn(`Viral trend "${v.trend}" kept with capped score (no source URL)`);
      }
      return true;
    });

    return {
      platform: parsed.platform,
      trending_topics: validTopics,
      viral_trends: validViralTrends,
      format_insights: parsed.format_insights ?? [],
      hook_examples: parsed.hook_examples ?? [],
      raw_summary: parsed.raw_summary ?? '',
    };
  }

  private async saveSignals(
    tenantId: string,
    runId: string,
    topics: TrendingTopic[],
    viralTrends: ViralTrend[] = [],
  ): Promise<void> {
    for (const topic of topics) {
      const hash = createHash('md5')
        .update(`${tenantId}:${this.platform}:industry:${topic.topic}:${topic.angle}`)
        .digest('hex');

      await this.scoutSignalModel.updateOne(
        { hash },
        {
          $set: {
            tenantId,
            runId,
            platform: this.platform,
            topic: topic.topic,
            angle: topic.angle,
            hash,
            signalScore: topic.signalScore,
            engagementProof: topic.engagementProof,
            recency: topic.recency,
            specificity: topic.specificity,
            sourceQuality: topic.sourceQuality,
            signalType: 'industry',
          },
        },
        { upsert: true },
      );
    }

    for (const trend of viralTrends) {
      const hash = createHash('md5')
        .update(`${tenantId}:${this.platform}:viral:${trend.trend}`)
        .digest('hex');

      await this.scoutSignalModel.updateOne(
        { hash },
        {
          $set: {
            tenantId,
            runId,
            platform: this.platform,
            topic: trend.trend,
            angle: trend.brand_tie_in,
            hash,
            signalScore: trend.signalScore,
            signalType: 'viral',
          },
        },
        { upsert: true },
      );
    }
  }

  private async loadRecentSignals(
    tenantId: string,
  ): Promise<{ topic: string; angle: string; type: 'industry' | 'viral' }[]> {
    const industryTTL = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 14 days
    const viralTTL = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);     // 7 days

    const recent = await this.scoutSignalModel
      .find({
        tenantId,
        platform: this.platform,
        $or: [
          { signalType: 'viral', createdAt: { $gte: viralTTL } },
          { signalType: { $ne: 'viral' }, createdAt: { $gte: industryTTL } },
        ],
      })
      .sort({ signalScore: -1 })
      .limit(25)
      .lean()
      .exec();

    return recent.map((s) => ({
      topic: s.topic,
      angle: s.angle,
      type: ((s as any).signalType === 'viral' ? 'viral' : 'industry') as 'industry' | 'viral',
    }));
  }

}
