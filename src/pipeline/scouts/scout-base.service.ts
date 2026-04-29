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

    // Pre-fetch real API data if the scout supports it (YouTube, Reddit)
    const prefetchedData = await this.prefetchApiData(company);

    const userMessage = this.wrapWithIterativePhases(
      this.buildResearchPrompt(company, recentlyCovered),
      prefetchedData,
    );

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
          maxTurns: 10,
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
    });

    // Save individual signals for dedup tracking (industry + viral)
    await this.saveSignals(company.tenantId, runId, finalOutput.trending_topics, finalOutput.viral_trends);

    return finalOutput;
  }

  // Override in scouts that have a real API pre-fetch (YouTube, Reddit).
  // Return a formatted string of pre-fetched data to inject into the prompt.
  // Default: no pre-fetch — Claude does web_search as before.
  protected async prefetchApiData(_company: CompanyDocument): Promise<string> {
    return '';
  }

  // Wraps each scout's research prompt with 3-phase iterative retrieval structure.
  // Guides the agent to spend its 10 turns systematically instead of doing 1-2 searches and stopping.
  // If prefetchedData is provided, Phase 1 is replaced with analysis of real data.
  private wrapWithIterativePhases(researchPrompt: string, prefetchedData = ''): string {
    const phase1 = prefetchedData
      ? `${prefetchedData}\n\n${researchPrompt}\n\nThe pre-fetched data above is REAL API data with verified engagement numbers. Use it as your primary source. Only use your search turns to fill gaps not covered above.`
      : researchPrompt;

    return `
Use all available search turns across 3 phases. Do NOT output JSON until Phase 3 is complete.

━━━ PHASE 1 — DISCOVERY (searches 1–4) ━━━
${phase1}

Return nothing yet. Just run your searches and collect candidates.

━━━ PHASE 2 — EVALUATE ━━━
Review everything you found in Phase 1.
For each candidate topic or trend ask:
- Does it have real engagement evidence (view counts, like counts, share counts)?
- Is it recent (last 7 days preferred, last 14 days acceptable)?
- Does it have a verifiable source URL?
Assign a preliminary signal score 1–10 based on evidence so far.
Identify the top 5 candidates (score ≥ 6) that need deeper verification.

━━━ PHASE 3 — DEEP-DIVE (searches 5–8) ━━━
For each of your top 5 candidates:
- Find the specific post / thread / video URL with actual numbers (views, likes, comments)
- Verify it is genuinely trending right now, not an old story
- If engagement data is unavailable, lower the signal score accordingly
- Drop candidates where you cannot find any source URL (score them 0)

After Phase 3, compile your final verified signals and return the JSON output as specified in your instructions.
    `.trim();
  }

  // Each scout provides its own research prompt
  // recentlyCovered is injected by base class — scouts don't need to fetch it
  protected abstract buildResearchPrompt(
    company: CompanyDocument,
    recentlyCovered: { topic: string; angle: string; type: 'industry' | 'viral' }[],
  ): string;

  /**
   * Per-platform engagement-value floor for a "trending" signal. Scouts override
   * to enforce realistic thresholds — e.g. a YouTube short with 200 views or a
   * Reddit post with 15 upvotes is not trending no matter what the LLM thinks.
   * Return 0 to skip the floor check (Twitter/Instagram have no reliable engagement
   * numbers via the current scraping path).
   *
   * Units must match the values the LLM puts in `engagementProof.value` — typically
   * views (YouTube), upvotes (Reddit), retweets (Twitter), likes (Instagram).
   */
  protected getEngagementFloor(): number {
    return 0;
  }

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

    // Validate required fields — format_insights and hook_examples are optional, default to []
    if (!parsed.platform) throw new Error('Missing field: platform');
    if (!Array.isArray(parsed.trending_topics)) throw new Error('Missing field: trending_topics');
    if (typeof parsed.raw_summary !== 'string') throw new Error('Missing field: raw_summary');

    // Validate industry topics — drop if signalScore missing OR below platform-aware
    // engagement floor. Previously the only filter was the LLM's self-assigned
    // signalScore ≥ 3, which let through 200-view YouTube shorts as "trending."
    // Each platform has its own units (views vs upvotes vs retweets), so the floor
    // is platform-aware. Twitter/Instagram have no API pre-fetch path, so engagement
    // floors there can't be reliably enforced — fall back to score-only.
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
      if (t.signalScore < 3) {
        this.logger.warn(`Dropping signal "${t.topic}" — score ${t.signalScore} below quality floor (3)`);
        return false;
      }
      // Platform-tiered engagement floor — drop signals whose engagementProof.value
      // is below the realistic "trending" threshold for the platform. Skip if no
      // numeric value present (Twitter/Instagram scrape often lacks reliable counts).
      if (typeof t.engagementProof?.value === 'number' && t.engagementProof.value > 0) {
        const floor = this.getEngagementFloor();
        if (floor > 0 && t.engagementProof.value < floor) {
          this.logger.warn(
            `Dropping signal "${t.topic}" — engagement ${t.engagementProof.value} (${t.engagementProof.metric}) below ${this.platform} floor (${floor})`,
          );
          return false;
        }
      }
      return true;
    });

    // Validate viral trends — drop if signalScore missing or below quality floor
    // Viral memes are ephemeral and rarely have clean canonical URLs — cap at 7 (not 5) to avoid
    // systematically penalising genuine trends just because they lack a permalink
    const validViralTrends = ((parsed.viral_trends ?? []) as ViralTrend[]).filter((v) => {
      if (typeof v.signalScore !== 'number') {
        this.logger.warn(`Dropping viral trend "${v.trend}" — missing signalScore`);
        return false;
      }
      const hasSource = v.source && v.source.startsWith('http');
      if (!hasSource) {
        v.signalScore = Math.min(v.signalScore, 7);
        this.logger.warn(`Viral trend "${v.trend}" kept with capped score (no source URL)`);
      }
      if (v.signalScore < 3) {
        this.logger.warn(`Dropping viral trend "${v.trend}" — score ${v.signalScore} below quality floor (3)`);
        return false;
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
    const ops: any[] = [];

    for (const topic of topics) {
      const hash = createHash('md5')
        .update(`${tenantId}:${this.platform}:industry:${topic.topic}:${topic.angle}`)
        .digest('hex');

      ops.push({
        updateOne: {
          filter: { hash },
          update: {
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
          upsert: true,
        },
      });
    }

    for (const trend of viralTrends) {
      const hash = createHash('md5')
        .update(`${tenantId}:${this.platform}:viral:${trend.trend}:${trend.brand_tie_in}`)
        .digest('hex');

      ops.push({
        updateOne: {
          filter: { hash },
          update: {
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
          upsert: true,
        },
      });
    }

    if (ops.length > 0) {
      await this.scoutSignalModel.bulkWrite(ops);
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
      .limit(50)
      .lean()
      .exec();

    return recent.map((s) => ({
      topic: s.topic,
      angle: s.angle,
      type: ((s as any).signalType === 'viral' ? 'viral' : 'industry') as 'industry' | 'viral',
    }));
  }

}
