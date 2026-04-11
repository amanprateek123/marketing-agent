import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import {
  MetaAdsLibraryOutput,
  MetaAdsLibraryOutputDocument,
  MetaAdsLibraryInsights,
  CompetitorAdInsight,
  AdLibraryGap,
} from './schemas/meta-ads-library-output.schema';

@Injectable()
export class MetaAdsLibraryService {
  private readonly logger = new Logger(MetaAdsLibraryService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(MetaAdsLibraryOutput.name)
    private readonly outputModel: Model<MetaAdsLibraryOutputDocument>,
  ) {}

  async runIdempotent(
    company: CompanyDocument,
    runId: string,
  ): Promise<MetaAdsLibraryInsights> {
    const existing = await this.outputModel.findOne({ tenantId: company.tenantId, runId }).lean().exec();
    if (existing) {
      this.logger.log(`Meta Ads Library: skipped — already complete for run ${runId}`);
      return existing.insights;
    }
    return this.run(company, runId);
  }

  async run(
    company: CompanyDocument,
    runId: string,
  ): Promise<MetaAdsLibraryInsights> {
    const tenantId = company.tenantId;
    this.logger.log(`Meta Ads Library starting | tenant: ${tenantId} | run: ${runId}`);

    const liveContext = this.liveContextBuilder.build(company);
    const competitors = company.competitors?.join(', ') ?? 'none listed';

    const systemPrompt = company.prompts?.metaAdsLibrary ?? `
You are a paid media competitive intelligence analyst specialising in Meta Ads.
Your job is to research what ads competitors are actively running in the Meta Ads Library
and identify strategic gaps. You must use web_search to find real evidence.
Always cite sources. Score every finding by how actionable it is (1-10).
    `.trim();

    const userMessage = `
Research the Meta Ads Library for ${company.name}'s competitors and category.

COMPETITORS: ${competitors}
INDUSTRY: ${company.industry}
TARGET AUDIENCE: ${company.targetAudience}

STEP 1 — COMPETITOR ADS
For each competitor, search:
- "site:facebook.com/ads/library [competitor]"
- "[competitor] facebook ads running india 2025"
- "[competitor] meta ads active creatives"

For each significant ad found, capture:
- The hook/opening line
- The angle (discount, testimonial, transformation, lifestyle, fear, urgency)
- Format (video/image/carousel)
- CTA
- How long it appears to have been running (longevity = proven winner)

STEP 2 — GAP ANALYSIS
After researching all competitors, identify:
- Topics/angles NOBODY is advertising on — biggest opportunities
- Audience segments nobody targets well in their ad copy
- Formats underused in this category
- Emotional triggers absent from all competitor ads

STEP 3 — CATEGORY FORMAT TRENDS
- Search: "${company.industry} best performing facebook ads india 2025"
- What format dominates this category right now?

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "competitorAds": [
    {
      "competitor": "Brand Name",
      "hook": "opening line or theme of the ad",
      "angle": "discount | testimonial | lifestyle | transformation | urgency | social_proof | fear | other",
      "format": "video | image | carousel | unknown",
      "cta": "Shop Now",
      "estimatedDaysRunning": 30,
      "score": 8,
      "source": "https://..."
    }
  ],
  "gaps": [
    {
      "gap": "what nobody is doing",
      "opportunity": "specific way ${company.name} can own this — angle, hook, audience",
      "urgency": "high | medium | low",
      "score": 9
    }
  ],
  "dominantFormat": "video",
  "rawSummary": "2-3 sentence summary of the paid ad landscape and biggest takeaway"
}

Rules:
- competitorAds: maximum 5, ranked by score descending. score 8-10 = direct threat or must-counter. score 5-7 = worth knowing. score 1-4 = weak signal.
- gaps: maximum 5, ranked by score descending. score 8-10 = large uncontested opportunity. urgency "high" = act this week.
- estimatedDaysRunning: estimate based on how established/polished the ad appears and search results. Use 0 if unknown.
- Do NOT invent competitor ads. If no evidence found for a competitor, skip them.
    `.trim();

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.META_ADS_LIBRARY,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 15,
    });

    const insights = this.parseInsights(result.content);

    await this.outputModel.create({
      tenantId,
      runId,
      insights,
      rawContent: result.content,
    });

    this.logger.log(
      `Meta Ads Library done: tenantId=${tenantId} | competitorAds: ${insights.competitorAds.length} | gaps: ${insights.gaps.length}`,
    );

    return insights;
  }

  private parseInsights(content: string): MetaAdsLibraryInsights {
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      const jsonStr = fenceMatch
        ? fenceMatch[1].trim()
        : content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonStr);

      const competitorAds: CompetitorAdInsight[] = (parsed.competitorAds ?? [])
        .filter((a: any) => a.competitor && a.hook && typeof a.score === 'number')
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, 5);

      const gaps: AdLibraryGap[] = (parsed.gaps ?? [])
        .filter((g: any) => g.gap && g.opportunity && typeof g.score === 'number')
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, 5);

      return {
        competitorAds,
        gaps,
        dominantFormat: parsed.dominantFormat ?? 'unknown',
        rawSummary: parsed.rawSummary ?? '',
      };
    } catch (err: any) {
      this.logger.warn(`Failed to parse Meta Ads Library output: ${err.message}`);
      return {
        competitorAds: [],
        gaps: [],
        dominantFormat: 'unknown',
        rawSummary: content.slice(0, 300),
      };
    }
  }
}
