import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { IntelligenceOrchestrator } from '../orchestrator/intelligence-orchestrator.service';
import { LearningData } from '../orchestrator/decision-context';

@Injectable()
export class LearningEngine extends BaseEngine<'learning', LearningData> {
  readonly name = 'learning' as const;
  readonly step = 16;
  readonly version = '1.0.0';
  readonly dependsOn = ['execution'] as const;

  private readonly identity = new Map<
    string,
    { tenantId: string; campaignId: string }
  >();

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
    private readonly orchestrator: IntelligenceOrchestrator,
  ) {
    super(sliceRepo, eventBus, registry);
  }

  @OnEvent('intelligence.execution.completed')
  async onExecutionCompleted(payload: {
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
      // Close the cycle when Learning finishes (last engine in the pipeline).
      await this.orchestrator.closeCycle(payload.cycleId, 'completed');
    } finally {
      this.identity.delete(payload.cycleId);
    }
  }

  protected async identityFromDeps(cycleId: string) {
    return this.identity.get(cycleId) ?? { tenantId: '', campaignId: '' };
  }

  protected async compute(_deps: ComputeDeps<'learning'>): Promise<LearningData> {
    // Cycle-time (fast path) Learning: no measurements produced during
    // the same cycle. Real measurements land via the +24h / +72h
    // BullMQ handlers in a follow-up PR.
    return { measurements: [], calibrations: [], updates: [] };
  }

  protected computeConfidence(): number {
    return 0.5;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'learning', ref: 'no measurements this cycle', weight: 1 }];
  }
}
