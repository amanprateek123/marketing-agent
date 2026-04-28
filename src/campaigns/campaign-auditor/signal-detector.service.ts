import { Injectable } from '@nestjs/common';
import { AuditSnapshotDocument } from '../schemas/audit-snapshot.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { FullCampaignMetrics } from '../meta-ads/meta-metrics.service';
import { getBenchmark, getCPARange, resolveVertical } from '../../common/benchmarks/vertical-benchmarks';

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
    creativeFatigue: { adId: string; adName: string; hookStyle: string; ctrDrop: number }[];
    audienceFatigue: { adSetId: string; adSetName: string; frequency: number }[];
    stuckInLearning: boolean;
    budgetExhaustionRisk: boolean;
  };

  // Opportunities — positive signals for scaling actions
  opportunities: {
    winningAdSets: { adSetName: string; adSetId: string; roas: number; ctr: number; conversions: number }[];
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

  // Account-level CPM environment — distinguishes "your campaign tanked" from
  // "everyone's CPMs spiked". Null when the account-level fetch fails or is unavailable.
  marketEnvironment: {
    cpmChangePct: number;
    cpcChangePct: number;
    last7CPM: number;
    prior7CPM: number;
    trend: 'spiking' | 'rising' | 'stable' | 'falling';
  } | null;
}

// Statistical floors — never fire signals on samples this small. These come from
// media-buyer practice: <1k impressions can't distinguish CTR drop from noise;
// <30 clicks at 5% CVR has a 95% CI that overlaps with healthy; etc.
const MIN_IMPRESSIONS_FOR_CTR_SIGNAL = 1000;
const MIN_CLICKS_FOR_ZERO_CONV_PAUSE = 30;
const MIN_CLICKS_FOR_RETARGET_TRIGGER = 200;
const MIN_CONVERSIONS_FOR_WINNER = 10;
const MIN_IMPRESSIONS_FOR_FATIGUE = 500;
const MIN_CLICKS_FOR_CAMPAIGN_ZERO_CONV = 50;

@Injectable()
export class SignalDetectorService {
  detect(
    campaign: any,
    current: FullCampaignMetrics,
    snapshots: AuditSnapshotDocument[],
    company: CompanyDocument,
    weeklySpend?: number,
    marketEnvironment?: AuditSignalPacket['marketEnvironment'],
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

    // Creative fatigue — compare current CTR to stored baseline. Require ≥1k impressions on the
    // current sample so a 35% CTR drop is signal, not Tuesday-morning noise.
    const creativeFatigue: { adId: string; adName: string; hookStyle: string; ctrDrop: number }[] = [];
    for (const adSet of campaign.adSets ?? []) {
      for (const ad of adSet.ads ?? []) {
        if (!ad.ctrBaseline || ad.ctrBaseline === 0) continue;
        const currentAd = current.adSets
          .flatMap(as => as.ads)
          .find(a => a.adId === ad.metaAdId);
        if (!currentAd) continue;
        if (currentAd.impressions < MIN_IMPRESSIONS_FOR_CTR_SIGNAL) continue;
        const dropPercent = ((ad.ctrBaseline - currentAd.ctr) / ad.ctrBaseline) * 100;
        if (dropPercent > 35) {
          creativeFatigue.push({
            adId: ad.metaAdId,
            adName: ad.metaAdId,
            hookStyle: ad.hookStyle ?? 'unknown',
            ctrDrop: Math.round(dropPercent),
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
    // Winning = ≥10 conversions (statistically meaningful — 5 has ±90% CI, basically a coin flip)
    // and ROAS exceeds the configured scale threshold.
    const winningAdSets = current.adSets
      .filter(as => {
        const adSetROAS = as.spend > 0 && as.conversions > 0 ? (as.conversions * conversionValue) / as.spend : 0;
        return as.conversions >= MIN_CONVERSIONS_FOR_WINNER && adSetROAS > scaleThreshold;
      })
      .map(as => ({
        adSetName: as.adSetName,
        adSetId: as.adSetId,
        roas: as.spend > 0 && as.conversions > 0 ? (as.conversions * conversionValue) / as.spend : 0,
        ctr: as.ctr,
        conversions: as.conversions,
      }));

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
    };
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
