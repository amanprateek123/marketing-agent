import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import {
  SliceIdentity,
  SliceRepository,
} from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { TrendData, TrendReading } from '../orchestrator/decision-context';
import {
  IntelligenceSnapshot,
  IntelligenceSnapshotDocument,
} from '../snapshot/snapshot.schema';
import {
  acceleration,
  ema,
  slope,
  velocity,
  volatility,
  vsBaseline,
  zScore,
} from './trend-math';
import {
  calculateTrendCoverage,
  hasAdequateTrendCoverage,
  MIN_TREND_ELAPSED_DAYS,
  MIN_TREND_OBSERVATIONS,
} from './trend-readiness';

const METRIC_KEYS = [
  'spend',
  'revenue',
  'impressions',
  'reach',
  'clicks',
  'ctr',
  'cpc',
  'cpm',
  'cvr',
  'purchases',
  'roas',
  'aov',
  'frequency',
] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Snapshot capture can run every 15 minutes. Load at most 30 days at that
// cadence, project only the fields used here, then retain one point per UTC
// day. This keeps the query bounded without letting scheduler frequency
// masquerade as history depth.
const MAX_RAW_HISTORY_OBSERVATIONS = 30 * 24 * 4;

const timestamp = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value as string);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : undefined;
};

/** Real elapsed time covered by snapshot history, never snapshot count. */
export function elapsedHistoryDays(
  currentCollectedAt: unknown,
  oldestCollectedAt: unknown,
): number {
  const current = timestamp(currentCollectedAt);
  const oldest = timestamp(oldestCollectedAt);
  if (current === undefined || oldest === undefined || oldest > current)
    return 0;
  // Four decimals keeps the persisted payload compact while avoiding an
  // early readiness unlock from rounding 47h53m up to 2.00 days.
  return Number(((current - oldest) / MS_PER_DAY).toFixed(4));
}

@Injectable()
export class TrendEngine extends BaseEngine<'trend', TrendData> {
  readonly name = 'trend' as const;
  readonly step = 4;
  readonly version = '1.3.0';
  readonly dependsOn = ['snapshot'] as const;

  private readonly identity = new Map<
    string,
    { tenantId: string; campaignId: string }
  >();

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
    @InjectModel(IntelligenceSnapshot.name)
    private readonly snapshotModel: Model<IntelligenceSnapshotDocument>,
  ) {
    super(sliceRepo, eventBus, registry);
  }

  @OnEvent('intelligence.snapshot.completed')
  async onSnapshotCompleted(payload: {
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
    deps: ComputeDeps<'trend'>,
    cycleId: string,
    identity: SliceIdentity,
  ): Promise<TrendData> {
    void cycleId;
    const snap = deps.snapshot!;
    // deps carries only engine-slice outputs, never identity fields — the
    // previous `deps as unknown as {tenantId, campaignId}` cast always
    // resolved to undefined, so this query was always {tenantId:'',
    // campaignId:''} and matched nothing. That silently forced every
    // history series down to just the current snapshot (windowSize=1),
    // which zeroed out slopes/EMAs/vsBaseline and made every trend-baseline
    // signal (ctr_decay, creative_fatigue, audience_saturation) and the
    // forecast engine's linear/ema_projection methods permanently
    // unreachable, no matter how much real history existed in Mongo.
    // Load enough raw ticks to cover up to 30 days at the documented 15-min
    // capture cadence. They are collapsed to one daily observation below.
    const identityFilter = {
      tenantId: identity.tenantId,
      campaignId: identity.campaignId,
    };
    const currentSnapshotId = String(
      (snap.data as { snapshotId?: unknown }).snapshotId ?? '',
    ).trim();
    const historyFilter = currentSnapshotId
      ? { ...identityFilter, snapshotId: { $ne: currentSnapshotId } }
      : identityFilter;
    const [history, oldestSnapshot] = await Promise.all([
      this.snapshotModel
        .find(historyFilter)
        .sort({ collectedAt: -1 })
        .limit(MAX_RAW_HISTORY_OBSERVATIONS)
        .select({ snapshotId: 1, collectedAt: 1, 'metrics.campaignLevel': 1 })
        .lean()
        .exec(),
      // Keep the trend calculation bounded to 30 recent samples, but obtain
      // the real first-observed timestamp with a covered-index lookup. This
      // avoids calling 30 snapshots "30 days" when they may span only hours.
      this.snapshotModel
        .findOne(identityFilter)
        .sort({ collectedAt: 1 })
        .select({ collectedAt: 1 })
        .lean()
        .exec(),
    ]);

    const currentCollectedAt = (snap.data as { collectedAt?: unknown })
      .collectedAt;
    const dailyHistory = this.dailyObservations(
      history,
      currentCollectedAt,
      currentSnapshotId,
    );

    // Include the current snapshot in the series (newest observation).
    const perMetric: Record<string, TrendReading> = {};
    const anomalies: TrendData['anomalies'] = [];

    for (const key of METRIC_KEYS) {
      const series = this.buildSeriesFor(
        key,
        snap.data,
        dailyHistory,
        currentSnapshotId,
      );
      perMetric[key] = this.readingFor(series);
      const z = zScore(series.slice(0, -1), series[series.length - 1] ?? 0);
      if (Math.abs(z) > 2.5) {
        anomalies.push({
          metric: key,
          zScore: Number(z.toFixed(2)),
          note: 'z>2.5',
        });
      }
    }

    const stability = this.stabilityScore(perMetric);
    const direction = this.overallDirection(perMetric);
    const historyDepthDays = elapsedHistoryDays(
      currentCollectedAt,
      oldestSnapshot?.collectedAt,
    );
    const oldestWindowObservation = dailyHistory[dailyHistory.length - 1];
    const windowElapsedDays = elapsedHistoryDays(
      currentCollectedAt,
      oldestWindowObservation?.collectedAt,
    );
    const observationCount =
      Object.values(perMetric)[0]?.windowSize ?? (currentCollectedAt ? 1 : 0);
    const coverage = calculateTrendCoverage(currentCollectedAt, [
      ...dailyHistory.map((item) => item.collectedAt),
    ]);
    const trendReady =
      observationCount >= MIN_TREND_OBSERVATIONS &&
      windowElapsedDays >= MIN_TREND_ELAPSED_DAYS &&
      hasAdequateTrendCoverage(coverage);

    // historyDepthDays is intentionally emitted in the persisted slice even
    // though older TrendData readers do not yet require it. ConfidenceEngine
    // consumes it via a backwards-compatible optional intersection type.
    const result = {
      perMetric,
      overallDirection: direction,
      stabilityScore: stability,
      anomalies,
      observationCount,
      windowElapsedDays,
      historyDepthDays,
      ...coverage,
      trendReady,
    };
    return result;
  }

  /**
   * Retain the latest raw snapshot on each UTC calendar day. The input query
   * is newest-first, so the first document seen for a day is authoritative.
   * Any earlier tick from the current UTC day is excluded because the current
   * cycle snapshot already represents that day.
   */
  private dailyObservations(
    history: Array<{
      snapshotId?: string;
      collectedAt?: unknown;
      metrics?: Record<string, unknown>;
    }>,
    currentCollectedAt: unknown,
    currentSnapshotId: string,
  ): Array<{
    snapshotId?: string;
    collectedAt?: unknown;
    metrics?: Record<string, unknown>;
  }> {
    const currentDay = utcDay(currentCollectedAt);
    const seenDays = new Set<string>();
    const daily: Array<{
      snapshotId?: string;
      collectedAt?: unknown;
      metrics?: Record<string, unknown>;
    }> = [];

    for (const item of history) {
      if (currentSnapshotId && item.snapshotId === currentSnapshotId) continue;
      const day = utcDay(item.collectedAt);
      if (!day || day === currentDay || seenDays.has(day)) continue;
      seenDays.add(day);
      daily.push(item);
      if (daily.length === 29) break;
    }
    return daily;
  }

  private buildSeriesFor(
    key: string,
    currentData: unknown,
    history: Array<{
      snapshotId?: string;
      collectedAt?: unknown;
      metrics?: Record<string, unknown>;
    }>,
    currentSnapshotId: string,
  ): number[] {
    const pick = (m?: Record<string, unknown>): number => {
      const cl = m?.campaignLevel as Record<string, number> | undefined;
      const v = cl?.[key];
      return typeof v === 'number' ? v : 0;
    };
    // Oldest → newest series
    // The query excludes the current snapshot, but retain this defensive
    // filter for test doubles and eventual-consistency/retry paths. Counting
    // the current observation twice biases every slope, EMA and forecast.
    const chron = history
      .filter(
        (item) => !currentSnapshotId || item.snapshotId !== currentSnapshotId,
      )
      .reverse();
    const series = chron.map((h) =>
      pick(h.metrics as Record<string, unknown> | undefined),
    );
    const curMetrics = (currentData as { metrics?: Record<string, unknown> })
      ?.metrics;
    series.push(pick(curMetrics));
    return series;
  }

  private readingFor(series: number[]): TrendReading {
    const s7 = series.slice(-7);
    const s3 = series.slice(-3);
    return {
      slope7d: Number(slope(s7).toFixed(6)),
      slope3d: Number(slope(s3).toFixed(6)),
      ema7d: Number(ema(s7, 2 / 8).toFixed(4)),
      ema3d: Number(ema(s3, 2 / 4).toFixed(4)),
      velocity: Number(velocity(series).toFixed(4)),
      acceleration: Number(acceleration(series).toFixed(4)),
      volatility: Number(volatility(s7).toFixed(4)),
      vsBaseline: Number(vsBaseline(series).toFixed(4)),
      windowSize: series.length,
    };
  }

  private stabilityScore(perMetric: Record<string, TrendReading>): number {
    const vols = Object.values(perMetric).map((r) => r.volatility);
    if (vols.length === 0) return 0;
    const avg = vols.reduce((s, v) => s + v, 0) / vols.length;
    return Math.max(0, Math.min(1, 1 - avg));
  }

  private overallDirection(
    perMetric: Record<string, TrendReading>,
  ): TrendData['overallDirection'] {
    const roas = perMetric.roas?.slope7d ?? 0;
    const ctr = perMetric.ctr?.slope7d ?? 0;
    const stability = this.stabilityScore(perMetric);
    const primary = roas + ctr * 100;
    if (stability < 0.35) return 'volatile';
    if (primary > 0.01) return 'improving';
    if (primary < -0.01) return 'declining';
    return 'stable';
  }

  protected computeConfidence(
    _deps: ComputeDeps<'trend'>,
    data: TrendData,
  ): number {
    if (data.trendReady !== true) return 0.2;
    const observations = data.observationCount ?? 0;
    const elapsedDays = data.windowElapsedDays ?? 0;
    const evidenceDepth = Math.min(observations, Math.floor(elapsedDays) + 1);
    if (evidenceDepth >= 14) return 1;
    return 0.2 + (evidenceDepth - 2) * (0.8 / 12);
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'history', ref: 'intelligence_snapshots', weight: 1 }];
  }
}

function utcDay(value: unknown): string | undefined {
  const ms = timestamp(value);
  return ms === undefined ? undefined : new Date(ms).toISOString().slice(0, 10);
}
