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
    highSpendZeroConversions: { adSetName: string; spend: number }[];
    creativeFatigue: { adName: string; hookStyle: string; ctrDrop: number }[];
    audienceFatigue: { adSetName: string; frequency: number }[];
    stuckInLearning: boolean;
    budgetExhaustionRisk: boolean;
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
    // Flag ad sets with zero conversions after spending more than 50% of their daily budget
    const dailyBudgetThreshold = Math.max(dailyBudget * 0.5, 500);
    const highSpendZeroConversions = current.adSets
      .filter(as => as.conversions === 0 && as.spend > dailyBudgetThreshold)
      .map(as => ({ adSetName: as.adSetName, spend: as.spend }));

    const audienceFatigue = current.adSets
      .filter(as => as.frequency > (company.pauseIfFrequencyAbove ?? 4))
      .map(as => ({ adSetName: as.adSetName, frequency: as.frequency }));

    // Creative fatigue — compare current CTR to stored baseline
    const creativeFatigue: { adName: string; hookStyle: string; ctrDrop: number }[] = [];
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
            adName: ad.metaAdId,
            hookStyle: ad.hookStyle ?? 'unknown',
            ctrDrop: Math.round(dropPercent),
          });
        }
      }
    }

    const stuckInLearning = ageDays > coldStartDays && current.campaign.conversions === 0;
    // budgetExhaustionRisk: spending >15% more than expected for the days elapsed
    const budgetExhaustionRisk = dailyBudget > 0 && expectedSpendToDate > 0 &&
      current.campaign.spend / expectedSpendToDate > 1.15;

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
        creativeFatigue,
        audienceFatigue,
        stuckInLearning,
        budgetExhaustionRisk,
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
