import { Injectable } from '@nestjs/common';
import { AuditSnapshotDocument } from '../schemas/audit-snapshot.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { FullCampaignMetrics } from '../meta-ads/meta-metrics.service';

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
}

@Injectable()
export class SignalDetectorService {
  detect(
    campaign: any,
    current: FullCampaignMetrics,
    snapshots: AuditSnapshotDocument[],
    company: CompanyDocument,
    weeklySpend?: number,
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

    // Estimate CTR range from historical audit snapshots (actual data, not parsed from text)
    let expectedCTRRange: { min: number; max: number } | null = null;
    const historicalCTRs = sorted
      .map(s => s.metrics.ctr)
      .filter(v => v > 0);
    if (historicalCTRs.length >= 2) {
      expectedCTRRange = {
        min: Math.min(...historicalCTRs) * 0.7,
        max: Math.max(...historicalCTRs) * 1.3,
      };
    }

    const currentCTR = current.campaign.ctr;
    const currentCTRVsBenchmark = expectedCTRRange
      ? currentCTR >= expectedCTRRange.max ? 'above'
        : currentCTR >= expectedCTRRange.min ? 'within'
        : 'below'
      : 'no_benchmark';

    // ── Anomalies ─────────────────────────────────────────────────────────────
    // Flag ad sets with zero conversions after spending more than 2x expected CPA (or 1 day's budget, whichever is higher)
    const expectedCPA = (company.products ?? []).find(p => p.active)?.performance?.avgCPA ?? dailyBudget;
    const highSpendThreshold = Math.max(expectedCPA * 2, dailyBudget);
    const highSpendZeroConversions = current.adSets
      .filter(as => as.conversions === 0 && as.spend > highSpendThreshold)
      .map(as => ({ adSetId: as.adSetId, adSetName: as.adSetName, spend: as.spend }));

    const audienceFatigue = current.adSets
      .filter(as => as.frequency > (company.pauseIfFrequencyAbove ?? 4))
      .map(as => ({ adSetId: as.adSetId, adSetName: as.adSetName, frequency: as.frequency }));

    // Creative fatigue — compare current CTR to stored baseline
    const creativeFatigue: { adId: string; adName: string; hookStyle: string; ctrDrop: number }[] = [];
    for (const adSet of campaign.adSets ?? []) {
      for (const ad of adSet.ads ?? []) {
        if (!ad.ctrBaseline || ad.ctrBaseline === 0) continue;
        const currentAd = current.adSets
          .flatMap(as => as.ads)
          .find(a => a.adId === ad.metaAdId);
        if (!currentAd) continue;
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

    // Campaign-level: spent more than 2 full days' budget with zero conversions
    const campaignZeroConversions = current.campaign.conversions === 0 &&
      dailyBudget > 0 && current.campaign.spend >= dailyBudget * 2;

    const stuckInLearning = ageDays > coldStartDays && current.campaign.conversions === 0;
    // budgetExhaustionRisk: spending >15% more than expected for the days elapsed
    const budgetExhaustionRisk = dailyBudget > 0 && expectedSpendToDate > 0 &&
      current.campaign.spend / expectedSpendToDate > 1.15;

    // ── Opportunities ─────────────────────────────────────────────────────────
    const scaleThreshold = company.scaleIfROASAbove ?? 1.5;
    const conversionValue = (company.products ?? []).find(p => p.active)?.conversionValue
      ?? (company.products ?? []).find(p => p.active)?.price ?? 0;
    const winningAdSets = current.adSets
      .filter(as => {
        const adSetROAS = as.spend > 0 && as.conversions > 0 ? (as.conversions * conversionValue) / as.spend : 0;
        return as.conversions >= 5 && adSetROAS > scaleThreshold;
      })
      .map(as => ({
        adSetName: as.adSetName,
        adSetId: as.adSetId,
        roas: as.spend > 0 && as.conversions > 0 ? (as.conversions * conversionValue) / as.spend : 0,
        ctr: as.ctr,
        conversions: as.conversions,
      }));

    const totalClicks = current.campaign.clicks;
    const highClicksLowConversions = totalClicks > 100 && current.campaign.conversions < 3;
    const readyForRetarget = ageDays >= 7 && highClicksLowConversions;

    // Early fatigue: winning ad set with CTR starting to decline (add fresh creative before it tanks)
    const earlyFatigue: { adSetName: string; adSetId: string; ctrDrop: number }[] = [];
    for (const winner of winningAdSets) {
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
        expectedCPARange: null,
        currentCTRVsBenchmark,
        currentCPAVsBenchmark: 'no_benchmark',
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
