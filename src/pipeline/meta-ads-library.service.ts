import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
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

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

interface AdsArchiveAd {
  id?: string;
  page_id?: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_captions?: string[];
  ad_creative_link_descriptions?: string[];
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  ad_snapshot_url?: string;
  publisher_platforms?: string[];
}

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

    // Step 1 — fetch REAL competitor ads from Meta's ads_archive Graph endpoint.
    // Replaces the previous "Claude searches site:facebook.com/ads/library" path
    // which returned hallucinated competitor ads — Google rarely indexes those
    // URLs, so the model confabulated `format: "video"`, `estimatedDaysRunning: 30`
    // from prior knowledge. ads_archive returns real ad_creative_bodies +
    // ad_delivery_start_time. Note: outside EU and outside political/social-
    // issue ad categories, ads_archive may return zero results — this is the
    // honest outcome, strictly better than fake data downstream.
    const accessToken = company.meta?.accessToken;
    const competitors = (company.competitors ?? []).filter((c) => c && c.trim().length > 0);
    const region = company.geography === 'India' ? 'IN' : (company.geography || 'IN');

    let realAds: { competitor: string; ad: AdsArchiveAd }[] = [];
    if (accessToken && competitors.length > 0) {
      const results = await Promise.allSettled(
        competitors.slice(0, 8).map(async (competitor) => {
          const ads = await this.fetchAdsArchive(competitor, region, accessToken);
          return ads.map((ad) => ({ competitor, ad }));
        }),
      );
      realAds = results
        .filter((r): r is PromiseFulfilledResult<{ competitor: string; ad: AdsArchiveAd }[]> => r.status === 'fulfilled')
        .flatMap((r) => r.value);
      this.logger.log(`Meta Ads Library: fetched ${realAds.length} real ads from ads_archive across ${competitors.length} competitors`);
    } else if (!accessToken) {
      this.logger.warn(`Meta Ads Library: no company.meta.accessToken — skipping ads_archive fetch, returning empty insights`);
    }

    // Honest empty path — ads_archive returned nothing (most non-EU non-political
    // categories). Better to return empty + log than to invoke the Claude
    // hallucination path that produced fake "competitor ads" before.
    if (realAds.length === 0) {
      const empty: MetaAdsLibraryInsights = {
        competitorAds: [],
        gaps: [],
        dominantFormat: 'unknown',
        rawSummary: `No ads found via Meta ads_archive for competitors=[${competitors.join(', ')}] region=${region}. Outside EU + political/social-issue categories, Meta restricts public Ad Library API access. Strategy Team will run without competitive context this run.`,
      };
      await this.outputModel.create({
        tenantId,
        runId,
        insights: empty,
        rawContent: empty.rawSummary,
      });
      this.logger.log(`Meta Ads Library: returning empty insights (no real data available via ads_archive for this region/category)`);
      return empty;
    }

    // Step 2 — Claude (Haiku) synthesizes structured insights from REAL ads.
    // The LLM no longer hunts for ads — it only parses + scores what we hand it.
    const liveContext = this.liveContextBuilder.build(company);
    const realAdsBlock = realAds.slice(0, 30).map(({ competitor, ad }, i) => {
      const body = (ad.ad_creative_bodies ?? []).slice(0, 2).join(' / ').slice(0, 300);
      const title = (ad.ad_creative_link_titles ?? [])[0] ?? '';
      const desc = (ad.ad_creative_link_descriptions ?? [])[0] ?? '';
      const cta = (ad.ad_creative_link_captions ?? [])[0] ?? '';
      const start = ad.ad_delivery_start_time ?? '';
      const stop = ad.ad_delivery_stop_time ?? 'still running';
      const platforms = (ad.publisher_platforms ?? []).join(',') || 'unknown';
      return `Ad ${i + 1} | ${competitor} | start: ${start} | stop: ${stop} | platforms: ${platforms}
  body: "${body}"
  title: "${title}"
  description: "${desc}"
  cta: "${cta}"
  url: ${ad.ad_snapshot_url ?? ''}`;
    }).join('\n\n');

    const systemPrompt = company.prompts?.metaAdsLibrary ?? `
You are a paid media competitive intelligence analyst. You synthesize structured
insights from REAL competitor ads pulled from Meta's Ad Library. Do NOT invent
ads or details — work only from the ads provided in the user message.
    `.trim();

    const userMessage = `
Synthesize competitive intelligence from REAL competitor ads (sourced from
Meta's ads_archive Graph API). All data below is verified — do not invent
additional ads, do not extrapolate beyond what's shown.

BRAND: ${company.name}
INDUSTRY: ${company.industry}
TARGET AUDIENCE: ${company.targetAudience}
COMPETITORS QUERIED: ${competitors.join(', ')}

REAL COMPETITOR ADS (${realAds.length} total fetched, top 30 shown):
${realAdsBlock}

TASK:
1. For each ad, classify its angle (discount | testimonial | lifestyle | transformation | urgency | social_proof | fear | other), format (video | image | carousel | unknown), and longevity (days = today - start_time).
2. Score each ad 1-10: longevity ≥14 days = score 8-10 (proven winner), 7-13 days = score 5-7, < 7 days = score 1-4.
3. Identify GAPS: what angles / audience segments / emotional triggers are absent across ALL the ads above? (Don't search externally — base this on the actual ads we fetched.)
4. Identify DOMINANT FORMAT (count format frequency in the ads above).

Return ONLY this JSON (no markdown):
{
  "competitorAds": [
    {
      "competitor": "Brand Name",
      "hook": "opening line from ad body",
      "angle": "discount | testimonial | lifestyle | transformation | urgency | social_proof | fear | other",
      "format": "video | image | carousel | unknown",
      "cta": "Shop Now",
      "estimatedDaysRunning": 30,
      "score": 8,
      "source": "https://www.facebook.com/ads/library/?id=..."
    }
  ],
  "gaps": [
    {
      "gap": "what nobody in the fetched ads is doing",
      "opportunity": "specific way ${company.name} can own this",
      "urgency": "high | medium | low",
      "score": 9
    }
  ],
  "dominantFormat": "video | image | carousel | unknown",
  "rawSummary": "2-3 sentence summary of the paid ad landscape based on real data"
}

Rules:
- competitorAds: max 5, ranked by score descending.
- gaps: max 5, ranked by score descending. Only claim a "gap" if 0 of the ${realAds.length} ads do that thing.
- estimatedDaysRunning: compute from start_time, do not guess.
- ALL hooks/CTAs/angles MUST be from the ads above — never invent.
    `.trim();

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.META_ADS_LIBRARY,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 2,    // No tools needed — pure synthesis over provided data. Was 10 (web_search) before.
    });

    const insights = this.parseInsights(result.content);

    await this.outputModel.create({
      tenantId,
      runId,
      insights,
      rawContent: result.content,
    });

    this.logger.log(
      `Meta Ads Library done: tenantId=${tenantId} | realAdsFetched=${realAds.length} | competitorAds: ${insights.competitorAds.length} | gaps: ${insights.gaps.length}`,
    );

    return insights;
  }

  /**
   * Fetch competitor ads from Meta's ads_archive Graph endpoint.
   * Returns real ad data when available — empty array when category isn't
   * publicly accessible (most non-EU non-political ads). Does NOT throw on
   * API errors (Promise.allSettled handles it upstream).
   */
  private async fetchAdsArchive(
    competitorName: string,
    region: string,
    accessToken: string,
  ): Promise<AdsArchiveAd[]> {
    try {
      const fields = [
        'id',
        'page_id',
        'page_name',
        'ad_creative_bodies',
        'ad_creative_link_titles',
        'ad_creative_link_captions',
        'ad_creative_link_descriptions',
        'ad_delivery_start_time',
        'ad_delivery_stop_time',
        'ad_snapshot_url',
        'publisher_platforms',
      ].join(',');

      const response = await axios.get(`${META_API_BASE}/ads_archive`, {
        params: {
          search_terms: competitorName,
          ad_active_status: 'ACTIVE',
          ad_type: 'ALL',
          ad_reached_countries: `["${region}"]`,
          fields,
          limit: 10,
          access_token: accessToken,
        },
        timeout: 15000,
      });

      const ads: AdsArchiveAd[] = response.data?.data ?? [];
      this.logger.log(`ads_archive: ${competitorName} (${region}) → ${ads.length} ads`);
      return ads;
    } catch (err: any) {
      // Common: error code 100 (not in special category / no access) — log + return empty.
      const msg = err?.response?.data?.error?.message ?? err.message;
      this.logger.warn(`ads_archive failed for ${competitorName}: ${msg}`);
      return [];
    }
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
      this.logger.error(`Failed to parse Meta Ads Library output — pipeline continues with zero competitive intelligence: ${err.message}`);
      return {
        competitorAds: [],
        gaps: [],
        dominantFormat: 'unknown',
        rawSummary: content.slice(0, 300),
      };
    }
  }
}
