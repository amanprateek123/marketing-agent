import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import {
  TrendData,
  TrendReading,
} from '../orchestrator/decision-context';
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

@Injectable()
export class TrendEngine extends BaseEngine<'trend', TrendData> {
  readonly name = 'trend' as const;
  readonly step = 4;
  readonly version = '1.0.0';
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

  protected async compute(deps: ComputeDeps<'trend'>): Promise<TrendData> {
    const snap = deps.snapshot!;
    const ident = deps as unknown as { tenantId?: string; campaignId?: string };
    // Load recent snapshots history (up to 30 days).
    const history = await this.snapshotModel
      .find({
        tenantId: ident.tenantId ?? '',
        campaignId: ident.campaignId ?? '',
      })
      .sort({ collectedAt: -1 })
      .limit(30)
      .lean()
      .exec();

    // Include the current snapshot in the series (newest first).
    const perMetric: Record<string, TrendReading> = {};
    const anomalies: TrendData['anomalies'] = [];

    for (const key of METRIC_KEYS) {
      const series = this.buildSeriesFor(key, snap.data, history);
      perMetric[key] = this.readingFor(series);
      const z = zScore(series.slice(0, -1), series[series.length - 1] ?? 0);
      if (Math.abs(z) > 2.5) {
        anomalies.push({ metric: key, zScore: Number(z.toFixed(2)), note: 'z>2.5' });
      }
    }

    const stability = this.stabilityScore(perMetric);
    const direction = this.overallDirection(perMetric);

    return {
      perMetric,
      overallDirection: direction,
      stabilityScore: stability,
      anomalies,
    };
  }

  private buildSeriesFor(
    key: string,
    currentData: unknown,
    history: Array<{ metrics?: Record<string, unknown> }>,
  ): number[] {
    const pick = (m?: Record<string, unknown>): number => {
      const cl = m?.campaignLevel as Record<string, number> | undefined;
      const v = cl?.[key];
      return typeof v === 'number' ? v : 0;
    };
    // Oldest → newest series
    const chron = [...history].reverse();
    const series = chron.map((h) => pick(h.metrics as Record<string, unknown> | undefined));
    const curMetrics = (currentData as { metrics?: Record<string, unknown> })?.metrics;
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
    const w = Object.values(data.perMetric)[0]?.windowSize ?? 1;
    if (w >= 14) return 1;
    if (w <= 2) return 0.2;
    return 0.2 + (w - 2) * (0.8 / 12);
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'history', ref: 'intelligence_snapshots', weight: 1 }];
  }
}
