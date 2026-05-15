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
import { ScoutSignal, ScoutSignalDocument } from './schemas/scout-signal.schema';

@Injectable()
export class MetaAdsLibraryService {
  private readonly logger = new Logger(MetaAdsLibraryService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(MetaAdsLibraryOutput.name)
    private readonly outputModel: Model<MetaAdsLibraryOutputDocument>,
    @InjectModel(ScoutSignal.name)
    private readonly scoutSignalModel: Model<ScoutSignalDocument>,
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
    this.logger.log(`Competitor intel starting | tenant: ${tenantId} | run: ${runId}`);

    // ── Sourcing strategy (May 2026 rewrite) ─────────────────────────────────
    // Meta's ads_archive Graph API only returns ads in two cases:
    //   (a) ad_reached_countries is an EU country, OR
    //   (b) ad is in a special category (politics / social / credit / housing / employment)
    // For Indian non-political brands, the API returns 0 ads regardless of token.
    // Previous version called the API and returned empty insights every run.
    //
    // New approach: Claude Haiku uses WebSearch + WebFetch (already allowed for
    // META_ADS_LIBRARY agent type) to visit each competitor's public website +
    // pricing page and observe what offers/angles they're pushing. Combined
    // with already-collected scout signals filtered by competitor mention. Free,
    // no scraping ToS issues, captures price/promo changes faster than ads do.
    const competitors = (company.competitors ?? []).filter((c) => c && c.trim().length > 0);

    if (competitors.length === 0) {
      const empty: MetaAdsLibraryInsights = {
        competitorAds: [],
        gaps: [],
        dominantFormat: 'unknown',
        rawSummary: 'No competitors configured on company.competitors — competitive intel skipped.',
      };
      await this.outputModel.create({ tenantId, runId, insights: empty, rawContent: empty.rawSummary });
      return empty;
    }

    // ── Pre-fetch: scout signals already mentioning each competitor ──────────
    // 716 scout_signals were already collected for 91astrology over the last
    // 30 days. Feeding the relevant ones to Claude grounds its synthesis in
    // real social-proof data instead of letting it hallucinate from training.
    const competitorRegex = new RegExp(competitors.map(c => c.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|'), 'i');
    const recentSignals = await this.scoutSignalModel
      .find({
        tenantId,
        $or: [{ topic: competitorRegex }, { angle: competitorRegex }],
      })
      .sort({ createdAt: -1 })
      .limit(40)
      .lean()
      .exec();

    const signalsBlock = recentSignals.length > 0
      ? recentSignals.map((s, i) => `  ${i + 1}. [${s.platform}, score ${s.signalScore}] ${s.topic} — ${s.angle}`).join('\n')
      : '  (no recent scout signals mention these competitors)';

    this.logger.log(`Competitor intel: ${recentSignals.length} relevant scout signals + ${competitors.length} competitor websites to investigate`);

    // ── Claude (Haiku) synthesizes from web fetches + scout signals ──────────
    const liveContext = this.liveContextBuilder.build(company);

    const systemPrompt = company.prompts?.metaAdsLibrary ?? `
You are a paid-media competitive intelligence analyst. You investigate competitor
brands by visiting their public websites and pricing pages, and by reading
already-collected social signals about them. You DO NOT invent — every claim
must trace to a URL you fetched or a signal we provided.
    `.trim();

    const userMessage = `
Build competitive intelligence on ${company.name}'s competitors. Meta's Ad Library
Graph API does not return Indian non-political ads, so you must INVESTIGATE
each competitor's public footprint instead.

BRAND: ${company.name}
INDUSTRY: ${company.industry}
TARGET AUDIENCE: ${company.targetAudience}
GEOGRAPHY: ${company.geography || 'India'}
COMPETITORS: ${competitors.join(', ')}

ALREADY-COLLECTED SCOUT SIGNALS (recent, mentioning these competitors):
${signalsBlock}

INVESTIGATION TASK:
For each competitor (max 6, prioritise the most direct ones), use WebSearch
and WebFetch to gather:
  1. Their pricing — flagship product price, current discount/promo if any
  2. Their hero hook on the homepage — opening line, value proposition framing
  3. Their dominant angle — what they emphasise (cheap consultations, expert astrologers, free trial, lifestyle, urgency, social proof)
  4. Active offers — "₹1 first call", "free reading", "limited time", referral schemes
  5. Format clues — what creative format they push on their landing pages (video testimonial, carousel of astrologers, app-install banner)

Use the scout signals above to corroborate or surface what users are saying
about each competitor's offers. If a signal says "AstroTalk's call katti is a
scam" — that's a real angle gap (trust) ${company.name} can own.

OUTPUT — synthesise into this exact JSON shape (no markdown, no extra prose):
{
  "competitorAds": [
    {
      "competitor": "Brand Name",
      "hook": "the actual opening hook/value prop you observed on their site",
      "angle": "discount | testimonial | lifestyle | transformation | urgency | social_proof | fear | trust | expert_authority | other",
      "format": "video | image | carousel | landing_page | app_install | unknown",
      "cta": "the actual CTA text on their primary button",
      "estimatedDaysRunning": 0,
      "score": 8,
      "source": "the URL you fetched"
    }
  ],
  "gaps": [
    {
      "gap": "specific angle / audience segment / emotional trigger that NO competitor in your investigation is using",
      "opportunity": "concrete way ${company.name} can own this gap (1 sentence, specific to brand)",
      "urgency": "high | medium | low",
      "score": 9
    }
  ],
  "dominantFormat": "video | image | carousel | landing_page | app_install | unknown",
  "rawSummary": "2-3 sentence honest summary of the paid-media landscape across these competitors based on what you actually saw"
}

RULES (non-negotiable):
- Every competitorAds[].hook and .cta MUST be a string you actually fetched from a real URL — not training-data recall, not made up.
- Set estimatedDaysRunning to 0 (we cannot observe paid-ad longevity from websites — be honest, don't guess).
- Every competitorAds[].source MUST be a URL you fetched in this turn (not facebook.com/ads/library — those are blocked).
- competitorAds: max 5, ranked by score descending. Score = how strong/distinct the competitive threat is.
- gaps: max 5, ranked by score descending. Each gap must be defensible — only claim it if NO competitor you investigated does it.
- If WebFetch fails for a competitor (site down, blocked), skip that competitor — do not invent.
    `.trim();

    const result = await this.claudeService.runAgent({
      tenantId,
      runId,
      agentType: AgentType.META_ADS_LIBRARY,
      systemPrompt,
      liveContext,
      userMessage,
      maxTurns: 12,    // needs WebSearch + N × WebFetch to investigate each competitor
    });

    const insights = this.parseInsights(result.content);

    await this.outputModel.create({
      tenantId,
      runId,
      insights,
      rawContent: result.content,
    });

    this.logger.log(
      `Competitor intel done: tenantId=${tenantId} | scoutSignals=${recentSignals.length} | competitorAds=${insights.competitorAds.length} | gaps=${insights.gaps.length}`,
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
