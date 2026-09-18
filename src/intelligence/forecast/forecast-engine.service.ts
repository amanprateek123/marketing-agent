import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import {
  ForecastData,
  ForecastPoint,
  ObjectiveKey,
} from '../orchestrator/decision-context';
import { isRevenueObjective } from '../objective/kpi-profiles';
import {
  hasEnoughElapsedTrendHistory,
  MIN_TREND_ELAPSED_DAYS,
  MIN_TREND_OBSERVATIONS,
} from '../trend/trend-readiness';

const MIN_EMA_OBSERVATIONS = 14;
const MIN_EMA_ELAPSED_DAYS = 13;

@Injectable()
export class ForecastEngine extends BaseEngine<'forecast', ForecastData> {
  readonly name = 'forecast' as const;
  readonly step = 10;
  readonly version = '1.2.0';
  readonly dependsOn = [
    'snapshot',
    'objective',
    'trend',
    'portfolio',
    'lifecycle',
  ] as const;

  private readonly identity = new Map<
    string,
    { tenantId: string; campaignId: string }
  >();

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
  ) {
    super(sliceRepo, eventBus, registry);
  }

  @OnEvent('intelligence.portfolio.completed')
  async onPortfolioCompleted(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
  }): Promise<void> {
    this.identity.set(payload.cycleId, {
      tenantId: payload.tenantId,
      campaignId: payload.campaignId,
    });
    try {
      await this.execute(payload.cycleId);
    } finally {
      this.identity.delete(payload.cycleId);
    }
  }

  protected async identityFromDeps(cycleId: string) {
    return this.identity.get(cycleId) ?? { tenantId: '', campaignId: '' };
  }

  protected async compute(
    deps: ComputeDeps<'forecast'>,
  ): Promise<ForecastData> {
    const snap = deps.snapshot!;
    const trend = deps.trend!;
    const cm =
      (snap.data as { metrics?: { campaignLevel?: Record<string, number> } })
        .metrics?.campaignLevel ?? {};
    const objective = deps.objective!.data.objective;
    const revenueObjective = isRevenueObjective(objective);
    const observationCount = trend.data.observationCount ?? 0;
    const elapsedDays = trend.data.windowElapsedDays ?? 0;
    const trendReady = hasEnoughElapsedTrendHistory(trend.data);
    const method: ForecastData['method'] = !trendReady
      ? 'insufficient_history'
      : observationCount >= MIN_EMA_OBSERVATIONS &&
          elapsedDays >= MIN_EMA_ELAPSED_DAYS
        ? 'ema_projection'
        : 'linear';
    // cm.spend/revenue/purchases are Meta's date_preset='maximum' totals —
    // the campaign's ENTIRE LIFETIME to date, not a single day's worth (see
    // meta-metrics.service.ts). This engine used to multiply that lifetime
    // total by `days` directly, which is why a campaign with, say, ₹2.5M of
    // lifetime spend produced a "7-day forecast" of ~₹17.8M: it was really
    // computing lifetime_spend × 7, not a real week of future spend.
    // Dividing by the campaign's real age (from LifecycleEngine) converts
    // these into genuine per-day rates.
    const ageDays = Math.max(1, (deps.lifecycle?.data.ageHours ?? 24) / 24);
    const spendPerDay = finite(cm.spend) / ageDays;
    const revenuePerDay = revenueObjective ? finite(cm.revenue) / ageDays : 0;
    const resultMetric = resultMetricForObjective(objective, cm);
    const resultsPerDay = resultMetric.total / ageDays;

    // Trend nudge: previously used the trend engine's raw `slope7d`/`slope3d`
    // in a days×(days-1)/2 quadratic term, but that slope is a regression
    // over the last N *snapshot documents*, not N real calendar days (the
    // cascade doesn't snapshot exactly once/day) — so its "per unit" doesn't
    // actually mean "per day", and compounding it quadratically over a
    // 30-day horizon amplified that unit mismatch further. `vsBaseline`
    // (latest/earliest in the observed window) is a dimensionless ratio
    // instead, so it's safe to use directly — damped to ±20% and clamped so
    // one volatile window can't swing the whole projection.
    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, v));
    // Until enough real elapsed daily history exists, forecast only the
    // campaign's observed age-normalised pace. Do not let repeated intraday
    // ticks create a trend nudge.
    const spendTrend = trendReady
      ? clamp(trendRatio(trend.data.perMetric?.spend?.vsBaseline), 0.5, 2)
      : 1;
    const outcomeTrend = trendReady
      ? clamp(
          trendRatio(
            trend.data.perMetric?.[
              revenueObjective ? 'revenue' : resultMetric.trendMetric
            ]?.vsBaseline,
          ),
          0.5,
          2,
        )
      : 1;
    const resultTrend = trendReady
      ? clamp(
          trendRatio(
            trend.data.perMetric?.[resultMetric.trendMetric]?.vsBaseline,
          ),
          0.5,
          2,
        )
      : 1;
    const dampedSpendRate = spendPerDay * (1 + (spendTrend - 1) * 0.2);
    const dampedRevenueRate = revenueObjective
      ? revenuePerDay * (1 + (outcomeTrend - 1) * 0.2)
      : 0;
    const dampedResultRate = resultsPerDay * (1 + (resultTrend - 1) * 0.2);

    const project = (days: number): ForecastPoint => {
      const spend = Math.max(0, dampedSpendRate * days);
      const revenue = revenueObjective
        ? Math.max(0, dampedRevenueRate * days)
        : 0;
      const conversions = Math.max(0, dampedResultRate * days);
      return {
        spend: Number(spend.toFixed(2)),
        revenue: Number(revenue.toFixed(2)),
        roas: spend > 0 ? Number((revenue / spend).toFixed(3)) : 0,
        conversions: Number(conversions.toFixed(2)),
        band: {
          lowSpend: Number((spend * 0.8).toFixed(2)),
          highSpend: Number((spend * 1.2).toFixed(2)),
          // The current contract has monetary band names only. For
          // non-revenue objectives leave them at zero rather than smuggling
          // impressions/clicks into fields that downstream renders as ₹.
          lowRevenue: revenueObjective ? Number((revenue * 0.7).toFixed(2)) : 0,
          highRevenue: revenueObjective
            ? Number((revenue * 1.3).toFixed(2))
            : 0,
        },
      };
    };

    return {
      horizons: {
        next24h: project(1),
        next72h: project(3),
        next7d: project(7),
        next30d: project(30),
      },
      method,
      history: {
        observationCount,
        elapsedDays,
        minimumObservationCount: MIN_TREND_OBSERVATIONS,
        minimumElapsedDays: MIN_TREND_ELAPSED_DAYS,
      },
    };
  }

  protected computeConfidence(
    _deps: ComputeDeps<'forecast'>,
    data: ForecastData,
  ): number {
    return data.method === 'insufficient_history' ? 0.25 : 0.7;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'history', ref: 'objective-projection', weight: 1 }];
  }
}

function finite(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function trendRatio(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 1;
}

function resultMetricForObjective(
  objective: ObjectiveKey,
  metrics: Record<string, number>,
): { total: number; trendMetric: string } {
  switch (objective) {
    case 'awareness':
    case 'video_views':
      return { total: finite(metrics.impressions), trendMetric: 'impressions' };
    case 'traffic':
    case 'engagement':
    case 'app_installs':
      return { total: finite(metrics.clicks), trendMetric: 'clicks' };
    case 'leads':
    case 'messages':
      return {
        total: finite(metrics.conversions ?? metrics.purchases),
        trendMetric:
          metrics.conversions !== undefined ? 'conversions' : 'purchases',
      };
    default:
      return { total: finite(metrics.purchases), trendMetric: 'purchases' };
  }
}
