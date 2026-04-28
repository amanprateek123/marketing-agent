import { Injectable } from '@nestjs/common';
import { AuditSnapshotDocument } from '../schemas/audit-snapshot.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { FullCampaignMetrics } from '../meta-ads/meta-metrics.service';
import { getBenchmark, getCPARange, resolveVertical } from '../../common/benchmarks/vertical-benchmarks';
import { adSetWinnerPosterior } from '../../common/statistics/bayesian-estimator.util';
import { deriveFloorsFromVertical } from '../../common/statistics/power-calc.util';
import { thompsonAllocate, ThompsonAllocationResult } from '../../common/statistics/bandit-allocator.util';

export interface AuditSignalPacket {
  campaignAge: { hours: number; days: number; inLearningPhase: boolean };

  // Campaign-level trends (comparing last 3 snapshots)
  trends: {
    ctrTrend: 'improving' | 'stable' | 'declining' | 'insufficient_data';
    roasTrend: 'improving' | 'stable' | 'declining' | 'insufficient_data';
    frequencyTrend: 'rising' | 'stable' | 'insufficient_data';
    spendPace: 'on_track' | 'underspending' | 'overspending';
  };

  // Benchmark comparisons from learnings
  benchmarks: {
    expectedCTRRange: { min: number; max: number } | null;
    expectedCPARange: { min: number; max: number } | null;
    currentCTRVsBenchmark: 'above' | 'within' | 'below' | 'no_benchmark';
    currentCPAVsBenchmark: 'above' | 'within' | 'below' | 'no_benchmark';
    bestAudienceType: string | null;
  };

  // Anomalies detected
  anomalies: {
    highSpendZeroConversions: { adSetId: string; adSetName: string; spend: number }[];
    campaignZeroConversions: boolean;  // total spend > 1x daily budget but 0 conversions
    creativeFatigue: { adId: string; adName: string; hookStyle: string; ctrDrop: number; residualDrop: number }[];
    audienceFatigue: { adSetId: string; adSetName: string; frequency: number }[];
    stuckInLearning: boolean;
    budgetExhaustionRisk: boolean;
  };

  // Opportunities — positive signals for scaling actions
  opportunities: {
    winningAdSets: {
      adSetName: string;
      adSetId: string;
      roas: number;                  // raw observed ROAS (kept for context)
      shrunkenROAS: number;          // ROAS after shrinkage toward vertical prior
      lowerROAS: number;             // 95% lower bound on ROAS (Wilson on CVR × value/spend)
      ctr: number;
      conversions: number;
    }[];
    highClicksLowConversions: boolean;   // >100 clicks, <3 conversions → retarget candidate
    totalClicks: number;
    readyForRetarget: boolean;           // age >7d + highClicksLowConversions
    earlyFatigue: { adSetName: string; adSetId: string; ctrDrop: number }[];  // winning ad set with declining CTR → add_creative
  };

  // Safety rail breaches — TypeScript only, never overridden
  safetyBreaches: {
    weeklyCapExceeded: boolean;
    campaignCapExceeded: boolean;
  };

  // Account-level environment — distinguishes "your campaign tanked" from "everyone's
  // CPMs/CTR moved". Used both as a prompt hint AND as a DiD residual on creativeFatigue.
  // Null when the account-level fetch fails or is unavailable.
  marketEnvironment: {
    cpmChangePct: number;
    cpcChangePct: number;
    ctrChangePct: number;        // -ve = account CTR declining (for DiD adjustment)
    last7CPM: number;
    prior7CPM: number;
    last7CTR: number;
    prior7CTR: number;
    trend: 'spiking' | 'rising' | 'stable' | 'falling';
  } | null;

  // Vertical-aware sample-size floors — derived from cvrTypical / ctrMidpoint.
  // Surfaced so the auditor knows how much evidence is "enough" for this vertical.
  evidenceFloors: {
    impressionsForCtrSignal: number;
    clicksForZeroConvSignal: number;
    clicksForRetargetTrigger: number;
  };

  // Thompson Sampling allocation across active ad sets — recommended budget %.
  // The auditor uses this to pick the recipient when proposing shift_budget.
  // Null when there are 0 active ad sets.
  banditAllocation: ThompsonAllocationResult | null;

  // Performance breakdowns (placements, hours, days-of-week). Provide the data the
  // auditor needs to make narrow_placement and dayparting recommendations grounded
  // in observed performance, not guessed. Empty arrays when Meta fetch fails.
  breakdowns: {
    byPlacement: Array<{
      publisherPlatform: string;
      platformPosition: string;
      spend: number;
      impressions: number;
      clicks: number;
      conversions: number;
      ctr: number;
      cpa: number;
    }>;
    byHour: Array<{
      hourOfDay: string;
      spend: number;
      impressions: number;
      clicks: number;
      conversions: number;
      ctr: number;
      cpa: number;
    }>;
    byDayOfWeek: Array<{
      dayOfWeek: number;
      dayLabel: string;
      spend: number;
      impressions: number;
      clicks: number;
      conversions: number;
      ctr: number;
      cvr: number;
      cpa: number;
    }>;
  };
}

// Statistical floors — derived per-vertical at runtime from cvrTypical and ctrMidpoint
// via power-calc.util.ts. Frequency-fatigue floor is a separate magnitude (we're not
// detecting a proportion change, just requiring enough impressions for frequency to be stable).
const MIN_IMPRESSIONS_FOR_FATIGUE = 500;

@Injectable()
export class SignalDetectorService {
  detect(
    campaign: any,
    current: FullCampaignMetrics,
    snapshots: AuditSnapshotDocument[],
    company: CompanyDocument,
    weeklySpend?: number,
    marketEnvironment?: AuditSignalPacket['marketEnvironment'],
    breakdowns?: AuditSignalPacket['breakdowns'],
  ): AuditSignalPacket {
    const launchedAt = new Date(campaign.launchedAt ?? Date.now());
    const ageMs = Date.now() - launchedAt.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    const ageDays = ageHours / 24;
    const coldStartDays = company.pipelineConfig?.coldStartDays ?? 14;

    // ── Trends from last 3 snapshots ─────────────────────────────────────────
    const sorted = [...snapshots].sort(
      (a, b) => new Date(b.auditedAt).getTime() - new Date(a.auditedAt).getTime(),
    ).slice(0, 3);

    const ctrTrend = this.calcTrend(sorted.map(s => s.metrics.ctr));
    const roasTrend = this.calcTrend(sorted.map(s => s.metrics.roas));
    const freqTrend = sorted.length >= 2
      ? (sorted[0].metrics.frequency > sorted[sorted.length - 1].metrics.frequency ? 'rising' : 'stable')
      : 'insufficient_data';

    // campaign.budget = daily budget (₹/day). Compare against expected cumulative spend.
    const dailyBudget = campaign.budget ?? 0;
    const expectedSpendToDate = dailyBudget * Math.max(ageDays, 1);
    const spendPace = dailyBudget > 0 && expectedSpendToDate > 0
      ? current.campaign.spend / expectedSpendToDate > 1.15 ? 'overspending'
        : current.campaign.spend / expectedSpendToDate < 0.5 && ageDays > 3 ? 'underspending'
        : 'on_track'
      : 'on_track';

    // ── Benchmarks from learnings ─────────────────────────────────────────────
    const learnings = company.learnings;
    const audienceScores = learnings?.campaign?.audienceScores ?? {};
    const bestAudienceType = Object.keys(audienceScores).length > 0
      ? Object.entries(audienceScores).sort(([, a], [, b]) => (b as number) - (a as number))[0][0]
      : null;

    // Benchmark resolution order: this campaign's history → vertical prior → null.
    // Vertical priors prevent "no_benchmark" on cold-start campaigns where the auditor
    // has no basis to judge whether 0.4% CTR is normal or terrible for this industry.
    const verticalBenchmark = getBenchmark(company.industry);

    // Vertical-aware sample-size floors — fintech needs ~5× the impressions of food-delivery
    // to detect the same effect with the same confidence. Power-calc derives floors that scale.
    const ctrMidpoint = (verticalBenchmark.ctrRangePct.min + verticalBenchmark.ctrRangePct.max) / 200; // /200 because input is %, output is decimal
    const cvrTypical = verticalBenchmark.cvrPct.typical / 100;
    const sampleFloors = deriveFloorsFromVertical({ ctrMidpoint, cvrTypical });
    const MIN_IMPRESSIONS_FOR_CTR_SIGNAL = sampleFloors.impressionsForCtrSignal;
    const MIN_CLICKS_FOR_ZERO_CONV_PAUSE = sampleFloors.clicksForZeroConvSignal;
    const MIN_CLICKS_FOR_RETARGET_TRIGGER = sampleFloors.clicksForRetargetTrigger;
    const MIN_CLICKS_FOR_CAMPAIGN_ZERO_CONV = Math.max(50, Math.round(sampleFloors.clicksForZeroConvSignal * 1.5));
    let expectedCTRRange: { min: number; max: number } | null = null;
    const historicalCTRs = sorted.map(s => s.metrics.ctr).filter(v => v > 0);
    if (historicalCTRs.length >= 2) {
      expectedCTRRange = {
        min: Math.min(...historicalCTRs) * 0.7,
        max: Math.max(...historicalCTRs) * 1.3,
      };
    } else {
      expectedCTRRange = {
        min: verticalBenchmark.ctrRangePct.min,
        max: verticalBenchmark.ctrRangePct.max,
      };
    }

    // CPA range resolution chain:
    //   1. Per-product CPA history (×0.7-1.5 around the historical mean)
    //   2. Vertical × objective-aware CPA band (lead vs purchase vs install vs subscription)
    //   3. Wide vertical fallback when objective doesn't map (awareness/traffic)
    // Solves the "spirituality lead at ₹150 vs paid consultation at ₹800 share one band" problem.
    const productCPA = (company.products ?? []).find(p => p.active)?.performance?.avgCPA;
    const cpaFromVertical = getCPARange(company.industry, company.primaryObjective);
    const expectedCPARange: { min: number; max: number } = productCPA && productCPA > 0
      ? { min: productCPA * 0.7, max: productCPA * 1.5 }
      : { min: cpaFromVertical.min, max: cpaFromVertical.max };

    const currentCTR = current.campaign.ctr;
    const currentCTRVsBenchmark = expectedCTRRange
      ? currentCTR >= expectedCTRRange.max ? 'above'
        : currentCTR >= expectedCTRRange.min ? 'within'
        : 'below'
      : 'no_benchmark';

    const currentCPA = current.campaign.cpa;
    const currentCPAVsBenchmark: 'above' | 'within' | 'below' | 'no_benchmark' =
      currentCPA > 0
        ? currentCPA <= expectedCPARange.min ? 'below'   // below = better (cheaper)
          : currentCPA <= expectedCPARange.max ? 'within'
          : 'above'
        : 'no_benchmark';

    // ── Anomalies ─────────────────────────────────────────────────────────────
    // Flag ad sets with zero conversions after enough click volume to make "zero" meaningful.
    // Spend alone is insufficient — a high-CPM low-volume audience can spend ₹2k on 10 clicks
    // and "zero conversions out of 10 clicks" is just noise.
    const expectedCPA = (company.products ?? []).find(p => p.active)?.performance?.avgCPA ?? dailyBudget;
    const highSpendThreshold = Math.max(expectedCPA * 2, dailyBudget);
    const highSpendZeroConversions = current.adSets
      .filter(as => as.conversions === 0
        && as.spend > highSpendThreshold
        && as.clicks >= MIN_CLICKS_FOR_ZERO_CONV_PAUSE)
      .map(as => ({ adSetId: as.adSetId, adSetName: as.adSetName, spend: as.spend }));

    // Audience fatigue requires enough impression volume — frequency on a tiny sample is meaningless.
    // Fall back to vertical-specific frequency cap when the tenant hasn't configured one.
    // Retarget pods naturally run frequency 6-8 (warm audience, repeated exposure works) — apply
    // a 1.75× multiplier so we don't pause healthy retarget ad sets that look "fatigued" by the
    // prospecting cap. Cross-reference live metrics against campaign.adSets[i].audienceType.
    const RETARGET_FREQ_MULTIPLIER = 1.75;
    const baseFrequencyCap = company.pauseIfFrequencyAbove ?? verticalBenchmark.frequencyCap;
    const adSetAudienceType: Record<string, string | undefined> = {};
    for (const persisted of (campaign.adSets ?? [])) {
      if (persisted?.metaAdSetId) adSetAudienceType[persisted.metaAdSetId] = persisted.audienceType;
    }
    const audienceFatigue = current.adSets
      .filter(as => {
        const audType = adSetAudienceType[as.adSetId];
        const isRetarget = audType === 'retarget' || audType === 'custom';
        const cap = isRetarget ? baseFrequencyCap * RETARGET_FREQ_MULTIPLIER : baseFrequencyCap;
        return as.frequency > cap && as.impressions >= MIN_IMPRESSIONS_FOR_FATIGUE;
      })
      .map(as => ({ adSetId: as.adSetId, adSetName: as.adSetName, frequency: as.frequency }));

    // Creative fatigue — DiD-adjusted comparison of current CTR vs stored baseline.
    // Raw approach (pre-Phase-6) flagged any 35% drop as fatigue, even when account-wide CTR
    // dropped 30% during festive / IPL / market spikes. DiD subtracts the account-level CTR
    // change so we only flag fatigue when the campaign drop is materially larger than the market.
    //
    // Decision rule: campaign drop must exceed account drop by ≥25 percentage points (residual).
    // If account CTR is FLAT or RISING, account adjustment ≈ 0 — same as the old 35% threshold.
    // If account CTR is dropping with the campaign, we require evidence the campaign is doing
    // worse than peers before swapping creative.
    const FATIGUE_RESIDUAL_THRESHOLD = 25;       // percentage-points campaign drop must exceed market drop
    const accountCTRChangePct = marketEnvironment?.ctrChangePct ?? 0;
    // Convert to "account drop magnitude" — positive number when CTR declined; 0 when rising/flat.
    const accountDropMagnitude = accountCTRChangePct < 0 ? -accountCTRChangePct : 0;
    const creativeFatigue: { adId: string; adName: string; hookStyle: string; ctrDrop: number; residualDrop: number }[] = [];
    for (const adSet of campaign.adSets ?? []) {
      for (const ad of adSet.ads ?? []) {
        if (!ad.ctrBaseline || ad.ctrBaseline === 0) continue;
        const currentAd = current.adSets
          .flatMap(as => as.ads)
          .find(a => a.adId === ad.metaAdId);
        if (!currentAd) continue;
        if (currentAd.impressions < MIN_IMPRESSIONS_FOR_CTR_SIGNAL) continue;
        const dropPercent = ((ad.ctrBaseline - currentAd.ctr) / ad.ctrBaseline) * 100;
        const residualDrop = dropPercent - accountDropMagnitude;
        if (dropPercent > 35 && residualDrop > FATIGUE_RESIDUAL_THRESHOLD) {
          creativeFatigue.push({
            adId: ad.metaAdId,
            adName: ad.metaAdId,
            hookStyle: ad.hookStyle ?? 'unknown',
            ctrDrop: Math.round(dropPercent),
            residualDrop: Math.round(residualDrop),
          });
        }
      }
    }

    // Campaign-level: zero conversions only meaningful once enough clicks have landed.
    // Spend without click volume = high-CPM noise, not a real "nothing converts" signal.
    const campaignZeroConversions = current.campaign.conversions === 0
      && dailyBudget > 0
      && current.campaign.spend >= dailyBudget * 2
      && current.campaign.clicks >= MIN_CLICKS_FOR_CAMPAIGN_ZERO_CONV;

    const stuckInLearning = ageDays > coldStartDays && current.campaign.conversions === 0;
    // budgetExhaustionRisk: spending >15% more than expected for the days elapsed
    const budgetExhaustionRisk = dailyBudget > 0 && expectedSpendToDate > 0 &&
      current.campaign.spend / expectedSpendToDate > 1.15;

    // ── Opportunities ─────────────────────────────────────────────────────────
    const scaleThreshold = company.scaleIfROASAbove ?? 1.5;
    const conversionValue = (company.products ?? []).find(p => p.active)?.conversionValue
      ?? (company.products ?? []).find(p => p.active)?.price ?? 0;
    // Winner detection via Bayesian posterior, not point-threshold cliff.
    // Two conditions must both hold:
    //   1. Shrunken ROAS > scaleThreshold — the point estimate (after pulling toward
    //      the vertical CVR prior) suggests a real winner, not lucky early data.
    //   2. Lower 95% bound on ROAS > 1.0 — we're confident the ad set is at least
    //      breakeven, not just performing well by chance.
    // Hard floor of MIN_FLOOR_CONVERSIONS=5 prevents posterior-only "winners" with
    // 1-2 conversions where even shrinkage can't fully tame the noise.
    const MIN_FLOOR_CONVERSIONS = 5;
    const priorCVR = (verticalBenchmark.cvrPct.typical || 3.5) / 100;
    const winningAdSets = current.adSets
      .map(as => {
        const observedROAS = as.spend > 0 && as.conversions > 0
          ? (as.conversions * conversionValue) / as.spend
          : 0;
        const post = adSetWinnerPosterior({
          conversions: as.conversions,
          clicks: as.clicks,
          spend: as.spend,
          conversionValue,
          priorCVR,
          // kappa = 10 pseudo-clicks of vertical-prior strength (moderate trust).
        });
        return {
          adSetName: as.adSetName,
          adSetId: as.adSetId,
          conversions: as.conversions,
          roas: observedROAS,
          shrunkenROAS: post.shrunkenROAS,
          lowerROAS: post.lowerROAS,
          ctr: as.ctr,
        };
      })
      .filter(w =>
        w.conversions >= MIN_FLOOR_CONVERSIONS
        && w.shrunkenROAS > scaleThreshold
        && w.lowerROAS > 1.0,
      );

    const totalClicks = current.campaign.clicks;
    // Retarget readiness needs enough clicks to claim "low conversions" is real, not noise.
    const highClicksLowConversions = totalClicks >= MIN_CLICKS_FOR_RETARGET_TRIGGER
      && current.campaign.conversions < 3;
    const readyForRetarget = ageDays >= 7 && highClicksLowConversions;

    // Early fatigue: winning ad set with CTR starting to decline (add fresh creative before it tanks).
    // Require winner to have current impressions ≥ MIN_IMPRESSIONS_FOR_CTR_SIGNAL so the trend is real.
    const earlyFatigue: { adSetName: string; adSetId: string; ctrDrop: number }[] = [];
    for (const winner of winningAdSets) {
      const winnerCurrent = current.adSets.find(as => as.adSetId === winner.adSetId);
      if (!winnerCurrent || winnerCurrent.impressions < MIN_IMPRESSIONS_FOR_CTR_SIGNAL) continue;
      const adSetSnapshots = sorted
        .flatMap(s => (s.adSets ?? []))
        .filter((as: any) => as.metaAdSetId === winner.adSetId);
      if (adSetSnapshots.length >= 2) {
        const recentCTR = adSetSnapshots[0]?.ctr ?? 0;
        const olderCTR = adSetSnapshots[adSetSnapshots.length - 1]?.ctr ?? 0;
        if (olderCTR > 0) {
          const drop = ((olderCTR - recentCTR) / olderCTR) * 100;
          if (drop > 15) {
            earlyFatigue.push({ adSetName: winner.adSetName, adSetId: winner.adSetId, ctrDrop: Math.round(drop) });
          }
        }
      }
    }

    // ── Safety rails ─────────────────────────────────────────────────────────
    const safetyBreaches = {
      weeklyCapExceeded: weeklySpend != null && company.weeklyBudgetCap > 0
        ? weeklySpend > company.weeklyBudgetCap
        : false,
      campaignCapExceeded: current.campaign.spend > (company.maxBudgetPerCampaign ?? Infinity),
    };

    return {
      campaignAge: { hours: Math.round(ageHours), days: Math.round(ageDays * 10) / 10, inLearningPhase: ageDays < coldStartDays },
      trends: { ctrTrend, roasTrend, frequencyTrend: freqTrend, spendPace },
      benchmarks: {
        expectedCTRRange,
        expectedCPARange,
        currentCTRVsBenchmark,
        currentCPAVsBenchmark,
        bestAudienceType,
      },
      anomalies: {
        highSpendZeroConversions,
        campaignZeroConversions,
        creativeFatigue,
        audienceFatigue,
        stuckInLearning,
        budgetExhaustionRisk,
      },
      opportunities: {
        winningAdSets,
        highClicksLowConversions,
        totalClicks,
        readyForRetarget,
        earlyFatigue,
      },
      safetyBreaches,
      marketEnvironment: marketEnvironment ?? null,
      evidenceFloors: {
        impressionsForCtrSignal: MIN_IMPRESSIONS_FOR_CTR_SIGNAL,
        clicksForZeroConvSignal: MIN_CLICKS_FOR_ZERO_CONV_PAUSE,
        clicksForRetargetTrigger: MIN_CLICKS_FOR_RETARGET_TRIGGER,
      },
      banditAllocation: this.computeBanditAllocation(current.adSets, conversionValue, priorCVR),
      breakdowns: breakdowns ?? { byPlacement: [], byHour: [], byDayOfWeek: [] },
    };
  }

  private computeBanditAllocation(
    adSets: FullCampaignMetrics['adSets'],
    conversionValue: number,
    priorCVR: number,
  ): ThompsonAllocationResult | null {
    // Only allocate across ad sets that are spending — paused / not-yet-launched arms
    // have no business in the bandit (no data, no spend to redistribute).
    const eligible = adSets.filter(as => as.spend > 0 && as.clicks > 0);
    if (eligible.length === 0) return null;
    return thompsonAllocate({
      adSets: eligible.map(as => ({
        adSetId: as.adSetId,
        adSetName: as.adSetName,
        conversions: as.conversions,
        clicks: as.clicks,
        spend: as.spend,
      })),
      priorCVR,
      conversionValue,
      numTrials: 200,
      kappa: 10,
    });
  }

  private calcTrend(values: number[]): 'improving' | 'stable' | 'declining' | 'insufficient_data' {
    if (values.length < 2) return 'insufficient_data';
    const recent = values[0];
    const oldest = values[values.length - 1];
    const changePct = oldest > 0 ? ((recent - oldest) / oldest) * 100 : 0;
    if (changePct > 10) return 'improving';
    if (changePct < -10) return 'declining';
    return 'stable';
  }
}
