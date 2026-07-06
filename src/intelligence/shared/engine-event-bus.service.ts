import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EngineSliceKey } from '../orchestrator/decision-context';

/**
 * Payload emitted on intelligence.<engine>.completed / .failed / .skipped.
 * Downstream engines subscribe via @OnEvent().
 */
export interface EnginePhaseEvent {
  cycleId: string;
  tenantId: string;
  campaignId: string;
  engine: EngineSliceKey;
  at: Date;
  confidence?: number;
  reason?: string;
  error?: string;
}

/**
 * Wrapper over Nest EventEmitter2. In phase 4 of the rollout this
 * becomes a Redis pub/sub backing without changing the interface.
 */
@Injectable()
export class EngineEventBus {
  private readonly logger = new Logger(EngineEventBus.name);

  constructor(private readonly emitter: EventEmitter2) {}

  emitCompleted(payload: EnginePhaseEvent): void {
    const evt = `intelligence.${payload.engine}.completed`;
    this.logger.debug(`emit ${evt} cycle=${payload.cycleId}`);
    this.emitter.emit(evt, payload);
  }

  emitFailed(payload: EnginePhaseEvent): void {
    const evt = `intelligence.${payload.engine}.failed`;
    this.logger.warn(`emit ${evt} cycle=${payload.cycleId} error=${payload.error}`);
    this.emitter.emit(evt, payload);
  }

  emitSkipped(payload: EnginePhaseEvent): void {
    const evt = `intelligence.${payload.engine}.skipped`;
    this.logger.debug(`emit ${evt} cycle=${payload.cycleId} reason=${payload.reason}`);
    this.emitter.emit(evt, payload);
  }

  emitCycleStarted(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
    at: Date;
  }): void {
    this.emitter.emit('intelligence.cycle.started', payload);
  }

  emitCycleCompleted(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
    durationMs: number;
    at: Date;
  }): void {
    this.emitter.emit('intelligence.cycle.completed', payload);
  }
}
