import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence, weightedConfidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { ConfidenceData } from '../orchestrator/decision-context';

@Injectable()
export class ConfidenceEngine extends BaseEngine<'confidence', ConfidenceData> {
  readonly name = 'confidence' as const;
  readonly step = 11;
  readonly version = '1.0.0';
  readonly dependsOn = [
    'snapshot',
    'objective',
    'lifecycle',
    'trend',
    'revenue',
    'signal',
    'diagnosis',
    'business',
    'portfolio',
    'forecast',
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

  @OnEvent('intelligence.forecast.completed')
  async onForecastCompleted(payload: {
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

  protected async compute(deps: ComputeDeps<'confidence'>): Promise<ConfidenceData> {
    const perEngine: Record<string, number> = {};
    for (const k of this.dependsOn) {
      const slice = (deps as Record<string, { confidence?: number }>)[k];
      perEngine[k] = slice?.confidence ?? 0;
    }
    const min = Math.min(...Object.values(perEngine));
    const meanConf = weightedConfidence(
      Object.values(perEngine).map((v) => ({ value: v, weight: 1 })),
    );

    const snap = deps.snapshot!.data as {
      freshnessSec?: number;
      missingFields?: string[];
      metrics?: { campaignLevel?: Record<string, number> };
    };
    const freshnessSec = snap.freshnessSec ?? 0;
    const snapshotCoverage = 1 - Math.min(1, (snap.missingFields?.length ?? 0) / 5);
    const purchases = (snap.metrics?.campaignLevel?.purchases as number) ?? 0;
    const statisticalPower = Math.min(1, purchases / 25);

    const quality = {
      dataFreshnessSec: freshnessSec,
      snapshotCoverage,
      historyDepthDays: 0,
      statisticalPower,
    };
    const qualityScore =
      snapshotCoverage * 0.4 +
      statisticalPower * 0.4 +
      (freshnessSec < 1800 ? 0.2 : freshnessSec < 3600 ? 0.1 : 0);

    const overall = 0.3 * min + 0.4 * meanConf + 0.3 * qualityScore;

    const stage = deps.lifecycle!.data.stage;
    const stageForbidsExec = ['learning', 'launching', 'unknown', 'draft', 'pending_approval'].includes(
      stage,
    );

    const okToRecommend = overall >= 0.5 && perEngine.snapshot >= 0.6;
    const okToExecute =
      overall >= 0.7 &&
      quality.statisticalPower >= 0.5 &&
      !stageForbidsExec &&
      (deps.diagnosis?.confidence ?? 0) >= 0.55;

    const reasonsBlocked: string[] = [];
    if (overall < 0.7) reasonsBlocked.push(`overall<0.7 (${overall.toFixed(2)})`);
    if (quality.statisticalPower < 0.5)
      reasonsBlocked.push(`power<0.5 (${quality.statisticalPower.toFixed(2)})`);
    if (stageForbidsExec) reasonsBlocked.push(`lifecycle=${stage}`);
    if ((deps.diagnosis?.confidence ?? 0) < 0.55)
      reasonsBlocked.push(`diagnosis<0.55`);

    return {
      overall: Number(overall.toFixed(3)),
      perEngine,
      quality,
      gates: { okToRecommend, okToExecute, reasonsBlocked },
    };
  }

  protected computeConfidence(
    _deps: ComputeDeps<'confidence'>,
    data: ConfidenceData,
  ): number {
    return data.overall;
  }

  protected buildEvidence(
    _deps: ComputeDeps<'confidence'>,
    data: ConfidenceData,
  ): Evidence[] {
    return Object.entries(data.perEngine).map(([k, v]) => ({
      kind: 'context',
      ref: `engine:${k}`,
      weight: 1,
      note: `conf=${v.toFixed(2)}`,
    }));
  }
}
