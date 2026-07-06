import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import {
  ExecutionData,
  RecommendedAction,
} from '../orchestrator/decision-context';

/**
 * PR-N: Execution shadow mode. All actions are DEFERRED with reason
 * 'shadow_mode_only' — no Meta mutations are performed until a
 * follow-up PR wires the real executor + tenant lock. This keeps the
 * cascade running while ensuring nothing mutates production state.
 */
@Injectable()
export class ExecutionEngine extends BaseEngine<'execution', ExecutionData> {
  private readonly log = new Logger(ExecutionEngine.name);
  readonly name = 'execution' as const;
  readonly step = 15;
  readonly version = '1.0.0';
  readonly dependsOn = [
    'recommendation',
    'explainability',
    'lifecycle',
    'confidence',
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

  @OnEvent('intelligence.explainability.completed')
  async onExplainabilityCompleted(payload: {
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

  protected async compute(deps: ComputeDeps<'execution'>): Promise<ExecutionData> {
    const actions = deps.recommendation!.data.actions as RecommendedAction[];
    const okToExecute = deps.confidence!.data.gates.okToExecute;

    const deferred: ExecutionData['deferred'] = [];
    const applied: ExecutionData['applied'] = [];
    const failed: ExecutionData['failed'] = [];

    for (const a of actions) {
      if (a.requiresHumanApproval) {
        deferred.push({ actionId: a.actionId, reason: 'requires_human_approval' });
        continue;
      }
      if (!okToExecute) {
        deferred.push({ actionId: a.actionId, reason: 'confidence_gates_blocked' });
        continue;
      }
      // Shadow: no Meta call yet.
      deferred.push({ actionId: a.actionId, reason: 'shadow_mode_only' });
      this.log.debug(
        `SHADOW-EXECUTION action=${a.type} target=${a.targetType}/${a.targetId} — no Meta mutation`,
      );
      // When the real executor lands, populate `applied` instead:
      // applied.push({
      //   actionId: a.actionId,
      //   appliedActionId: randomUUID(),
      //   appliedAt: new Date(),
      //   rollback: { supported: true, payload: {} },
      // });
    }

    return { applied, deferred, failed };
  }

  protected computeConfidence(deps: ComputeDeps<'execution'>): number {
    return deps.confidence!.data.overall;
  }

  protected buildEvidence(
    _deps: ComputeDeps<'execution'>,
    data: ExecutionData,
  ): Evidence[] {
    return [
      {
        kind: 'context',
        ref: `applied:${data.applied.length}/deferred:${data.deferred.length}`,
        weight: 1,
      },
    ];
  }
}
