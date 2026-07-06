import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import {
  LifecycleData,
  LifecycleStage,
} from '../orchestrator/decision-context';
import { LIFECYCLE_GATES, nextStageOf } from './lifecycle-gates';

/**
 * Determines the campaign stage and which actions are legal.
 * Deterministic stage detector — Meta learning_stage takes priority,
 * then age + snapshot signals.
 */
@Injectable()
export class LifecycleEngine extends BaseEngine<'lifecycle', LifecycleData> {
  readonly name = 'lifecycle' as const;
  readonly step = 3;
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

  protected async compute(deps: ComputeDeps<'lifecycle'>): Promise<LifecycleData> {
    const snapshot = deps.snapshot!;
    const data = snapshot.data as {
      collectedAt: Date;
      metrics?: { campaignLevel?: Record<string, number> };
      meta?: { learningStage?: string; deliveryStatus?: string };
    };
    const cm = data.metrics?.campaignLevel ?? {};
    const learningStage = data.meta?.learningStage;
    const deliveryStatus = data.meta?.deliveryStatus;
    // Age is not on the snapshot payload today; approximate as 0 hours
    // until Campaign adapter surfaces launchedAt in a follow-up.
    const ageHours = 0;

    const stage = this.classify({
      learningStage,
      deliveryStatus,
      spend: (cm.spend as number) ?? 0,
      frequency: (cm.frequency as number) ?? 0,
      ctr: (cm.ctr as number) ?? 0,
      roas: (cm.roas as number) ?? 0,
      purchases: (cm.purchases as number) ?? 0,
      ageHours,
    });

    const gates = LIFECYCLE_GATES[stage];
    return {
      stage,
      ageHours,
      metaLearningStage: learningStage,
      progressionScore: this.progressionScore(stage),
      nextExpectedStage: nextStageOf(stage),
      allowedActions: [...gates.allowedActions],
      blockedActions: gates.blockedActions.map((b) => ({ ...b })),
      monitoringCadenceMinutes: gates.monitoringCadenceMinutes,
      gates: { ...gates.gates },
    };
  }

  private classify(input: {
    learningStage?: string;
    deliveryStatus?: string;
    spend: number;
    frequency: number;
    ctr: number;
    roas: number;
    purchases: number;
    ageHours: number;
  }): LifecycleStage {
    if (input.deliveryStatus === 'NOT_DELIVERING') return 'retirement';
    if (input.learningStage === 'LEARNING' || input.learningStage === 'LEARNING_LIMITED') {
      return 'learning';
    }
    if (input.deliveryStatus === 'PENDING' || input.deliveryStatus === 'PENDING_REVIEW') {
      return 'pending_approval';
    }
    if (input.spend > 0 && input.purchases === 0 && input.ctr === 0) {
      return 'launching';
    }
    if (input.frequency > 4 && input.ctr < 0.008) return 'fatigue';
    if (input.roas >= 2 && input.purchases >= 10) return 'scaling';
    if (input.roas >= 1 && input.purchases >= 5) return 'growing';
    if (input.spend > 0 && input.purchases > 0) return 'stable';
    return 'unknown';
  }

  private progressionScore(stage: LifecycleStage): number {
    const order: LifecycleStage[] = [
      'draft', 'pending_approval', 'launching', 'learning',
      'growing', 'scaling', 'stable', 'fatigue',
      'recovery', 'retirement', 'unknown',
    ];
    const idx = order.indexOf(stage);
    return idx < 0 ? 0 : idx / (order.length - 1);
  }

  protected computeConfidence(
    _deps: ComputeDeps<'lifecycle'>,
    data: LifecycleData,
  ): number {
    if (data.stage === 'unknown') return 0.3;
    if (data.metaLearningStage) return 0.9;
    return 0.7;
  }

  protected buildEvidence(
    _deps: ComputeDeps<'lifecycle'>,
    data: LifecycleData,
  ): Evidence[] {
    return [
      {
        kind: 'snapshot',
        ref: `lifecycle:${data.stage}`,
        weight: 1,
        note: data.metaLearningStage ? `meta=${data.metaLearningStage}` : 'inferred',
      },
    ];
  }
}
