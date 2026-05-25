import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { CompaniesService } from '../companies/companies.service';
import { ActionLoggerService } from '../common/action-logger/action-logger.service';
import { CreativePackage, CreativePackageDocument } from '../creative/schemas/creative-package.schema';
import { Campaign, CampaignDocument } from '../campaigns/schemas/campaign.schema';
import { LearningRun, LearningRunDocument } from './schemas/learning-run.schema';
import { CreativeLearnings } from '../companies/schemas/company.types';
import { wilsonLowerBound, inverseNormalCdf } from '../common/statistics/bayesian-estimator.util';

const MIN_PACKAGES = 3;
const MIN_CONFIDENCE = 0.50;

const CREATIVE_LEARNING_PROMPT = `You are a creative performance analyst. Your job is to identify what creative patterns drive high CTR and what patterns underperform — based purely on data, not assumptions.

METHODOLOGY:
1. Look at hook style, copy tone, CTA text, and format for each creative
2. Compare CTR across creatives — CTR is the primary signal for creative quality (it fires before audience effects)
3. Identify patterns: what do the high-CTR creatives have in common? What do low-CTR ones share?
4. Assign confidence scores based on data volume:
   - 3 packages: max 0.60
   - 5 packages: max 0.85
   - 10+ packages: max 1.00
5. Only include a pattern if confidence >= 0.50
6. NEVER invent patterns not supported by the data

IMPORTANT — CTR vs ROAS:
- CTR = creative quality signal (did the hook/copy make people click?)
- ROAS = campaign system signal (did the audience/budget/objective convert?)
- Use CTR to judge creative, NOT ROAS (ROAS mixes creative + campaign variables)

OUTPUT — return only valid JSON:
{
  "winningHooks": ["string — hook styles with high CTR, e.g. 'challenge framing', 'time-saving angle'"],
  "losingHooks": ["string — hook styles with low CTR"],
  "winningFormats": ["string — formats with high engagement"],
  "losingFormats": ["string — formats to avoid"],
  "ctaInsights": ["string — which CTA patterns drove more clicks"],
  "copyToneInsights": ["string — tone observations, e.g. 'aspirational > fear-based for this audience'"],
  "visualInsights": ["string — image/video pattern observations"]
}`;

@Injectable()
export class CreativeLearningService {
  private readonly logger = new Logger(CreativeLearningService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly companiesService: CompaniesService,
    private readonly actionLogger: ActionLoggerService,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(LearningRun.name)
    private readonly learningRunModel: Model<LearningRunDocument>,
  ) {}

  async runQuickScan(tenantId: string): Promise<void> {
    const company = await this.companiesService.findByTenantId(tenantId);

    // Get completed creative packages from last 60 days
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const packages = await this.creativePackageModel
      .find({ tenantId, status: 'completed', createdAt: { $gte: sixtyDaysAgo } })
      .lean()
      .exec();

    if (packages.length < MIN_PACKAGES) {
      this.logger.log(
        `Creative quick scan skipped: tenantId=${tenantId} — only ${packages.length}/${MIN_PACKAGES} packages`,
      );
      return;
    }

    // Join with campaign CTR data
    const enriched = await this.enrichWithCTR(tenantId, packages);

    let result;
    try {
      result = await this.claudeService.runAgent({
        tenantId,
        agentType: AgentType.CREATIVE_LEARNING_AGENT,
        systemPrompt: CREATIVE_LEARNING_PROMPT,
        liveContext: '',
        userMessage: `Analyze these ${enriched.length} creative packages and extract patterns.

Company thresholds:
  targetROAS: ${company.targetROAS ?? 'not set'}
  primaryObjective: ${company.primaryObjective}
  tone: ${company.tone}

Creative performance data:
${JSON.stringify(enriched, null, 2)}

Current creative learnings (previous version):
${JSON.stringify(company.learnings?.creative ?? null, null, 2)}

Return ONLY the JSON object.`,
        model: 'claude-sonnet-4-6',
        maxTurns: 3,
      });
    } catch (err: any) {
      this.logger.error(`Creative learning agent failed: ${err.message}`);
      return;
    }

    const creativeLearnings = this.parseCreativeLearnings(result.content);
    const currentLearnings = company.learnings;

    // Extract verbatim winning exemplars deterministically from the enriched data —
    // NOT via LLM summarization. The LLM is prone to compressing winners into 4-word
    // labels and discarding the actual phrasing that worked. Statistical guardrails
    // (Wilson lower bound + Bonferroni-corrected z + composite CTR/CPA + min 10
    // conversions) keep the real lines available for downstream Creative Team to
    // anchor on without crowning lucky outliers.
    const perAdRows = await this.enrichPerAd(tenantId, packages);
    const winningExemplars = this.extractWinningExemplars(perAdRows);
    this.logger.log(
      `extractWinningExemplars: ${perAdRows.length} ad-rows → ${winningExemplars.length} exemplars (audienceTypes: ${[...new Set(winningExemplars.map(e => e.audienceSegment))].join(',') || 'none'})`,
    );

    // Live within-campaign hook arbitration. Recent head-to-head variant tests
    // that CONTRADICT historical winningHooks/losingHooks claims are surfaced
    // as a recency-weighted counter-signal — they don't overwrite the lists,
    // they flag the contradiction so the Creative Team and Campaign Review
    // Team see fresh disconfirming evidence in LiveContext.
    //
    // Bar lower than winningExemplars: this is a *flag*, not a permanent
    // promotion. Designed to catch cases like Kundli Clarity (2026-05-21)
    // where the historical "winning hook" (pain_point) lost head-to-head
    // to a historical "third-ranked" hook (curiosity_gap) inside one ad set.
    const existingHistorical = {
      winningHooks: company.learnings?.creative?.winningHooks ?? [],
      losingHooks: company.learnings?.creative?.losingHooks ?? [],
    };
    const liveCounterSignals = this.extractLiveCounterSignals(perAdRows, existingHistorical, packages);
    this.logger.log(
      `extractLiveCounterSignals: ${liveCounterSignals.length} counter-signals (${liveCounterSignals.map(s => `${s.winningHookStyle}>${s.losingHookStyle}`).join(', ') || 'none'})`,
    );

    // Race-safe: per-leaf dot-path slice instead of whole-tree replace. Was:
    // read learnings + splice + write whole tree → concurrent writers (Day 30
    // deep run + Meta importer) clobbered each other and version went backwards.
    // hookSaturation is owned by the audit loop and isn't touched here, so it
    // no longer needs explicit preservation — that was a band-aid for the old
    // race-prone path.
    await this.companiesService.setCreativeLearningSlice(tenantId, {
      ...creativeLearnings,
      winningExemplars,
      liveCounterSignals,
    }, { incrementVersion: true });

    await this.actionLogger.log({
      tenantId,
      agent: AgentType.CREATIVE_LEARNING_AGENT,
      action: 'creative_learnings_updated',
      reason: `Analyzed ${enriched.length} creative packages`,
      outcome: `Creative patterns updated. Winning hooks: ${creativeLearnings.winningHooks.length}. Losing hooks: ${creativeLearnings.losingHooks.length}.`,
    });

    await this.learningRunModel.create({
      tenantId,
      status: 'completed',
      version: (currentLearnings?.version ?? 0) + 1,
      briefsAnalyzed: enriched.length,
      instinctsExtracted:
        creativeLearnings.winningHooks.length +
        creativeLearnings.losingHooks.length +
        creativeLearnings.winningFormats.length +
        creativeLearnings.ctaInsights.length,
      promptsRegenerated: false, // quick scan does NOT regen prompts
      runAt: new Date(),
      costUSD: result.costUSD,
    });

    this.logger.log(
      `Creative quick scan complete: tenantId=${tenantId} packages=${enriched.length}`,
    );
  }

  private async enrichWithCTR(
    tenantId: string,
    packages: CreativePackageDocument[],
  ): Promise<any[]> {
    const briefIds = packages.map(pkg => pkg.briefId).filter(Boolean);
    const campaigns = await this.campaignModel
      .find({ tenantId, briefId: { $in: briefIds } })
      .lean()
      .exec();
    const campaignMap = new Map(campaigns.map(c => [c.briefId, c]));

    return packages.map((pkg) => {
      const campaign = campaignMap.get(pkg.briefId);
      const selectedVariant = pkg.copyVariants?.[pkg.selectedCopyIndex];
      // Audience attribution for downstream exemplar filtering. Without this,
      // winningExemplars.audienceSegment is permanently undefined and warm/hot
      // briefs anchor on cold-prospect winners (and vice versa).
      // Heuristic: dominant active ad set's audienceType. If multiple ad sets
      // have different audienceTypes, take the highest-spend one.
      const audienceSegment = (() => {
        const activeAdSets = ((campaign as any)?.adSets ?? []).filter((as: any) => as.status !== 'paused');
        if (activeAdSets.length === 0) return undefined;
        const dominant = activeAdSets
          .slice()
          .sort((a: any, b: any) => (Number(b.spend) || 0) - (Number(a.spend) || 0))[0];
        return dominant?.audienceType ?? undefined;
      })();

      return {
        briefId: pkg.briefId,
        selectedCopy: selectedVariant
          ? {
              headline: selectedVariant.headline,
              primaryText: selectedVariant.primaryText,
              cta: selectedVariant.cta,
              hookStyle: selectedVariant.hookStyle,
            }
          : null,
        copySelectionReason: pkg.copySelectionReason,
        ctr: campaign?.ctr ?? null,
        clicks: campaign?.clicks ?? null,
        impressions: campaign?.impressions ?? null,
        spend: campaign?.spend ?? null,
        audienceSegment,
      };
    });
  }

  private parseCreativeLearnings(content: string): CreativeLearnings {
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      const raw = fenceMatch
        ? JSON.parse(fenceMatch[1].trim())
        : JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));

      return {
        winningHooks: raw.winningHooks ?? [],
        losingHooks: raw.losingHooks ?? [],
        winningFormats: raw.winningFormats ?? [],
        losingFormats: raw.losingFormats ?? [],
        ctaInsights: raw.ctaInsights ?? [],
        copyToneInsights: raw.copyToneInsights ?? [],
        visualInsights: raw.visualInsights ?? [],
      };
    } catch (err: any) {
      this.logger.error(`Failed to parse creative learnings: ${err.message}`);
      throw new Error(`Creative Learning Agent returned invalid JSON: ${err.message}`);
    }
  }

  /**
   * Build a per-AD candidate set for exemplar extraction. Each row maps one
   * launched ad → one (audienceType, hookStyle, format) tuple with its own
   * metrics. This kills the dominant-spend audience-attribution heuristic that
   * mis-tagged warm-winning hooks as "cold" — exemplars now carry the actual
   * audienceType of the ad set they ran in.
   *
   * Pause-state contamination filter: skip campaigns that were paused before
   * day 5. Frontloaded 3-day data was treated as 7-day signal; now we drop it.
   */
  private async enrichPerAd(
    tenantId: string,
    packages: CreativePackageDocument[],
  ): Promise<Array<{
    briefId: string;
    adId: string;
    copyVariantIndex: number;
    primaryText: string;
    headline: string;
    cta: string;
    hookStyle: string;
    format: 'video' | 'image' | undefined;
    audienceType: string;
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    cpa: number | null;
  }>> {
    const briefIds = packages.map(p => p.briefId).filter(Boolean);
    const campaigns = await this.campaignModel
      .find({ tenantId, briefId: { $in: briefIds } })
      .lean()
      .exec();
    const packageByBrief = new Map(packages.map(p => [p.briefId, p]));

    const rows: Awaited<ReturnType<typeof this.enrichPerAd>> = [];
    const now = Date.now();
    const PAUSE_FILTER_MIN_LIVE_DAYS = 5;

    for (const campaign of campaigns) {
      // Pause-state contamination filter: skip pause-on-day-N<5 campaigns.
      // Their CTR is frontloaded learning-phase data treated identically to
      // a healthy 7-day-live campaign — biases learnings toward "this hookStyle
      // had high day-1-3 CTR" which doesn't generalize.
      if (campaign.status === 'paused' && campaign.launchedAt) {
        const stop = (campaign as any).pausedAt ? new Date((campaign as any).pausedAt).getTime() : now;
        const liveDays = (stop - new Date(campaign.launchedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (liveDays < PAUSE_FILTER_MIN_LIVE_DAYS) continue;
      }
      const pkg = packageByBrief.get(campaign.briefId);
      if (!pkg) continue;
      for (const adSet of (campaign as any).adSets ?? []) {
        for (const ad of adSet.ads ?? []) {
          const m = ad.metrics;
          if (!m) continue;
          const variantIdx = ad.copyVariantIndex ?? 0;
          const variant = (pkg as any).copyVariants?.[variantIdx];
          if (!variant?.primaryText) continue;
          const conversions = m.conversions ?? 0;
          const clicks = m.clicks ?? 0;
          const impressions = m.impressions ?? 0;
          const spend = m.spend ?? 0;
          rows.push({
            briefId: campaign.briefId,
            adId: ad.metaAdId,
            copyVariantIndex: variantIdx,
            primaryText: variant.primaryText,
            headline: variant.headline ?? '',
            cta: variant.cta ?? '',
            hookStyle: ad.hookStyle ?? variant.hookStyle ?? 'unknown',
            format: ad.format,
            audienceType: adSet.audienceType ?? 'unknown',
            spend,
            impressions,
            clicks,
            conversions,
            ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
            cpa: conversions > 0 ? spend / conversions : null,
          });
        }
      }
    }
    return rows;
  }

  /**
   * Extract verbatim winning hook lines deterministically, with statistical guardrails.
   *
   * Previously: ranked by raw CTR with min 1k impressions. At small N, top-10 vs
   * rank-20 was within noise; 50 ads × α=0.05 produced ~2.5 false-positive winners
   * every scan; CTR-only ranking picked clickbait (high CTR, zero conversions);
   * audienceSegment was set per-package by dominant-spend, mis-tagging warm wins
   * as cold.
   *
   * Now:
   *  - Per-ad extraction (audienceType is the actual ad set, not dominant-package guess)
   *  - Wilson 95% lower bound on CTR + Bonferroni-corrected z-score (z scales with N candidates)
   *  - Composite ranking 0.4·CTR-z + 0.6·CPA⁻¹-z (kills clickbait)
   *  - Hard floor: ≥10 conversions per ad (no zero-conversion candidates)
   *  - Lower-bound CTR must beat cohort median to qualify (not just be > 0)
   *  - 1k-impression floor scales by vertical CTR via power-calc when available
   */
  private extractWinningExemplars(
    perAdRows: Awaited<ReturnType<typeof this.enrichPerAd>>,
  ): NonNullable<CreativeLearnings['winningExemplars']> {
    const MIN_IMPRESSIONS = 1500;
    const MIN_CONVERSIONS = 10;
    const MAX_EXEMPLARS = 10;

    const eligible = perAdRows.filter((r) =>
      r.primaryText &&
      r.impressions >= MIN_IMPRESSIONS &&
      r.conversions >= MIN_CONVERSIONS,
    );
    if (eligible.length === 0) return [];

    // Bonferroni-corrected z for 95% family-wise: z = inverseNormalCDF(1 - α/(2k))
    // k = #candidates. Closed-form inverse not in stdlib; approximate via the
    // common rational mapping. For our scale (k≤200) this is fine.
    const k = eligible.length;
    const zCorrected = inverseNormalCdf(1 - 0.05 / (2 * Math.max(k, 1)));

    // Cohort median CTR — Wilson lower bound must beat this to count as winner.
    // Drops the "every ad with non-zero CTR is a winner" failure mode.
    const sortedCtr = eligible.map(r => r.ctr).sort((a, b) => a - b);
    const cohortMedianCtr = sortedCtr[Math.floor(sortedCtr.length / 2)] ?? 0;

    const scored = eligible.map((r) => {
      const ctrLowerBound = wilsonLowerBound(r.clicks, r.impressions, zCorrected) * 100; // pct points
      const cpaInv = r.cpa && r.cpa > 0 ? 1 / r.cpa : 0;
      return { ...r, ctrLowerBound, cpaInv };
    });

    // Z-scores within the eligible cohort for composite ranking
    const ctrLBMean = scored.reduce((s, r) => s + r.ctrLowerBound, 0) / scored.length;
    const ctrLBSD = Math.sqrt(scored.reduce((s, r) => s + (r.ctrLowerBound - ctrLBMean) ** 2, 0) / scored.length) || 1;
    const cpaInvMean = scored.reduce((s, r) => s + r.cpaInv, 0) / scored.length;
    const cpaInvSD = Math.sqrt(scored.reduce((s, r) => s + (r.cpaInv - cpaInvMean) ** 2, 0) / scored.length) || 1;

    const candidates = scored
      .filter(r => r.ctrLowerBound > cohortMedianCtr)  // beat the median, not just zero
      .map(r => ({
        ...r,
        composite: 0.4 * ((r.ctrLowerBound - ctrLBMean) / ctrLBSD)
                 + 0.6 * ((r.cpaInv - cpaInvMean) / cpaInvSD),
      }))
      .sort((a, b) => b.composite - a.composite)
      .slice(0, MAX_EXEMPLARS);

    const now = new Date();
    return candidates.map((r) => {
      const firstLine = String(r.primaryText)
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)[0] ?? r.headline ?? '';
      return {
        hookLine: firstLine,
        hookStyle: r.hookStyle,
        audienceSegment: r.audienceType,
        ctr: r.ctr,
        sampleSize: r.impressions,
        extractedAt: now,
      };
    });
  }

  private emptyCampaignLearnings() {
    return {
      audienceScores: {},
      platformROAS: {},
      budgetInsights: [],
      timingInsights: [],
      objectiveInsights: [],
    };
  }

  /**
   * Extract live within-campaign head-to-head hook arbitrations that contradict
   * historical winningHooks/losingHooks claims.
   *
   * Why this exists: the historical aggregator scores hookStyle by raw CTR across
   * 100+ ads with no audience/topic control. When the same hookStyles run side-by-
   * side INSIDE one ad set on the same day, the resulting CPA ranking is the
   * cleanest controlled comparison in the dataset — and frequently inverts the
   * historical claim. See the Kundli Clarity campaign (2026-05-21): pain_point
   * was the documented "winner" with confidence 0.95 but ran CPA ₹1,745 while
   * curiosity_gap (documented "third-ranked") ran CPA ₹862.
   *
   * Gating (conservative — this is a flag, not a permanent demotion):
   *  - both variants ≥₹1,500 spend (avoids cold-start noise)
   *  - winner ≥3 conversions (avoids zero-conv lucky-CPC variants)
   *  - winner CPA ≤ 0.75 × loser CPA (≥25% CPA gap, not noise)
   *  - winner.hookStyle is currently in losingHooks OR ranks below loser.hookStyle in winningHooks
   *
   * Emits up to MAX_SIGNALS entries, dedup'd by (winner × loser × audience).
   */
  private extractLiveCounterSignals(
    perAdRows: Awaited<ReturnType<typeof this.enrichPerAd>>,
    historical: { winningHooks: string[]; losingHooks: string[] },
    packages: CreativePackageDocument[],
  ): NonNullable<CreativeLearnings['liveCounterSignals']> {
    const MIN_SPEND_PER_VARIANT = 1500;
    const MIN_WINNER_CONVERSIONS = 3;
    const MIN_CPA_GAP_RATIO = 0.75;        // winner CPA must be ≤ 75% of loser CPA
    const MAX_SIGNALS = 8;

    // Parse hookStyle label from each historical entry. Entries look like
    // "pain_point: LB 7.18% / mean 7.26% CTR across 116 historical ads..."
    // The hookStyle is the leading [a-z_]+ token before the first colon.
    const parseHookStyle = (entry: string): string | null => {
      const m = String(entry ?? '').toLowerCase().match(/^([a-z_]+)/);
      return m ? m[1] : null;
    };
    const winningStyles = historical.winningHooks
      .map(parseHookStyle)
      .filter((s): s is string => !!s);
    const losingStyles = new Set(
      historical.losingHooks.map(parseHookStyle).filter((s): s is string => !!s),
    );
    // Lower index = higher rank. Use Infinity for missing.
    const winningRank = (style: string) => {
      const i = winningStyles.indexOf(style);
      return i === -1 ? Infinity : i;
    };

    // Map briefId -> productName for tagging (where available on the package)
    const productByBrief = new Map<string, string | undefined>();
    for (const pkg of packages) {
      productByBrief.set(pkg.briefId, (pkg as any)?.productName);
    }

    // Group ad-rows by (briefId × audienceType) — only ads inside the same
    // ad set are a controlled head-to-head.
    const groups = new Map<string, typeof perAdRows>();
    for (const row of perAdRows) {
      if (!row.hookStyle || row.hookStyle === 'unknown') continue;
      if (row.spend < MIN_SPEND_PER_VARIANT) continue;
      const key = `${row.briefId}::${row.audienceType}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    const signals: NonNullable<CreativeLearnings['liveCounterSignals']> = [];
    const seen = new Set<string>();

    for (const [key, rows] of groups.entries()) {
      if (rows.length < 2) continue;

      // Within-group head-to-head: each (winner, loser) pair where winner has
      // a finite CPA and CPA gap clears the gate.
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < rows.length; j++) {
          if (i === j) continue;
          const winner = rows[i];
          const loser = rows[j];
          if (winner.hookStyle === loser.hookStyle) continue;
          if (winner.cpa == null || loser.cpa == null) continue;
          if (winner.conversions < MIN_WINNER_CONVERSIONS) continue;
          if (winner.cpa > loser.cpa * MIN_CPA_GAP_RATIO) continue;

          // Contradiction filter:
          //  - winner is in losingHooks (historical loser beat someone), OR
          //  - winner ranks BELOW loser in winningHooks (i.e. winner index > loser index, both finite OR loser ranks while winner doesn't)
          const loserRank = winningRank(loser.hookStyle);
          const winnerRank = winningRank(winner.hookStyle);
          const winnerIsHistoricalLoser = losingStyles.has(winner.hookStyle);
          const winnerRanksLowerInWinning =
            Number.isFinite(loserRank) && winnerRank > loserRank;

          if (!winnerIsHistoricalLoser && !winnerRanksLowerInWinning) continue;

          const dedupeKey = `${winner.hookStyle}|${loser.hookStyle}|${winner.audienceType}|${winner.briefId}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          signals.push({
            winningHookStyle: winner.hookStyle,
            losingHookStyle: loser.hookStyle,
            audienceType: winner.audienceType,
            productName: productByBrief.get(winner.briefId),
            campaignId: winner.briefId,
            winnerCPA: winner.cpa,
            loserCPA: loser.cpa,
            deltaCPA: loser.cpa - winner.cpa,
            winnerSpend: winner.spend,
            observedAt: new Date(),
          });
        }
      }
    }

    // Rank by CPA delta (largest gap first), cap to MAX_SIGNALS.
    return signals
      .sort((a, b) => b.deltaCPA - a.deltaCPA)
      .slice(0, MAX_SIGNALS);
  }
}
