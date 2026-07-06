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
} from '../orchestrator/decision-context';

@Injectable()
export class ForecastEngine extends BaseEngine<'forecast', ForecastData> {
  readonly name = 'forecast' as const;
  readonly step = 10;
  readonly version = '1.0.0';
  readonly dependsOn = ['snapshot', 'trend', 'portfolio'] as const;

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

  protected async compute(deps: ComputeDeps<'forecast'>): Promise<ForecastData> {
    const snap = deps.snapshot!;
    const trend = deps.trend!;
    const cm = (snap.data as { metrics?: { campaignLevel?: Record<string, number> } })
      .metrics?.campaignLevel ?? {};
    const spendPerDay = (cm.spend as number) ?? 0;
    const revenuePerDay = (cm.revenue as number) ?? 0;
    const roas = (cm.roas as number) ?? 0;
    const purchasesPerDay = (cm.purchases as number) ?? 0;

    const spendSlope = trend.data.perMetric?.spend?.slope7d ?? 0;
    const revenueSlope = trend.data.perMetric?.revenue?.slope7d ?? 0;

    const project = (days: number): ForecastPoint => {
      const spend = Math.max(0, spendPerDay * days + spendSlope * (days * (days - 1) / 2));
      const revenue = Math.max(0, revenuePerDay * days + revenueSlope * (days * (days - 1) / 2));
      const conversions = purchasesPerDay * days;
      return {
        spend: Number(spend.toFixed(2)),
        revenue: Number(revenue.toFixed(2)),
        roas: spend > 0 ? Number((revenue / spend).toFixed(3)) : 0,
        conversions: Number(conversions.toFixed(2)),
        band: {
          lowSpend: Number((spend * 0.8).toFixed(2)),
          highSpend: Number((spend * 1.2).toFixed(2)),
          lowRevenue: Number((revenue * 0.7).toFixed(2)),
          highRevenue: Number((revenue * 1.3).toFixed(2)),
        },
      };
    };

    const windowSize = trend.data.perMetric?.spend?.windowSize ?? 1;
    const method: ForecastData['method'] =
      windowSize < 3 ? 'insufficient_history' : windowSize < 14 ? 'linear' : 'ema_projection';

    return {
      horizons: {
        next24h: project(1),
        next72h: project(3),
        next7d: project(7),
        next30d: project(30),
      },
      method,
    };
  }

  protected computeConfidence(
    _deps: ComputeDeps<'forecast'>,
    data: ForecastData,
  ): number {
    return data.method === 'insufficient_history' ? 0.25 : 0.7;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'history', ref: 'projection', weight: 1 }];
  }
}
