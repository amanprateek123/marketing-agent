import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../../../src/intelligence/shared/base-engine';
import { EngineEventBus } from '../../../src/intelligence/shared/engine-event-bus.service';
import { EngineRegistry } from '../../../src/intelligence/shared/engine-registry';
import { SliceRepository } from '../../../src/intelligence/shared/slice-repository.service';
import {
  EngineSliceKey,
  DecisionContext,
} from '../../../src/intelligence/orchestrator/decision-context';
import {
  ComputeDeps,
} from '../../../src/intelligence/shared/engine.interface';
import { Evidence } from '../../../src/intelligence/shared/engine-context';

/**
 * A fake Snapshot engine used in integration tests. It writes a minimal
 * SnapshotData slice on `intelligence.cycle.started`.
 */
@Injectable()
export class FakeSnapshotEngine extends BaseEngine<'snapshot', { snapshotId: string; collectedAt: Date; note: string }> {
  private readonly log = new Logger(FakeSnapshotEngine.name);
  readonly name = 'snapshot' as const;
  readonly step = 1;
  readonly version = '0.0.1-test';
  readonly dependsOn = [] as const;

  constructor(sliceRepo: SliceRepository, eventBus: EngineEventBus, registry: EngineRegistry) {
    super(sliceRepo, eventBus, registry);
  }

  @OnEvent('intelligence.cycle.started')
  async onCycleStarted(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
    at: Date;
  }): Promise<void> {
    this.log.debug(`snapshot fired for cycle ${payload.cycleId}`);
    // We stash identity here so the base class can find it without
    // fetching from Mongo. Simpler for the fake.
    this.identity.set(payload.cycleId, { tenantId: payload.tenantId, campaignId: payload.campaignId });
    await this.execute(payload.cycleId);
  }

  private readonly identity = new Map<string, { tenantId: string; campaignId: string }>();

  protected async identityFromDeps(cycleId: string): Promise<{ tenantId: string; campaignId: string }> {
    return this.identity.get(cycleId) ?? { tenantId: '', campaignId: '' };
  }

  protected isDeterministic(): boolean {
    return false;
  }

  protected async compute(): Promise<{ snapshotId: string; collectedAt: Date; note: string }> {
    return {
      snapshotId: `fake-snap-${Date.now()}`,
      collectedAt: new Date(),
      note: 'produced by FakeSnapshotEngine',
    };
  }

  protected computeConfidence(): number {
    return 0.9;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'external_api', ref: 'fixture://meta', weight: 1 }];
  }
}

/**
 * A fake Objective engine that depends on snapshot and produces a
 * minimal ObjectiveData slice.
 */
@Injectable()
export class FakeObjectiveEngine extends BaseEngine<'objective', { objective: string; primaryKPI: string }> {
  private readonly log = new Logger(FakeObjectiveEngine.name);
  readonly name = 'objective' as const;
  readonly step = 2;
  readonly version = '0.0.1-test';
  readonly dependsOn = ['snapshot'] as const;

  constructor(sliceRepo: SliceRepository, eventBus: EngineEventBus, registry: EngineRegistry) {
    super(sliceRepo, eventBus, registry);
  }

  @OnEvent('intelligence.snapshot.completed')
  async onSnapshotDone(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
  }): Promise<void> {
    this.log.debug(`objective fired for cycle ${payload.cycleId}`);
    this.identity.set(payload.cycleId, { tenantId: payload.tenantId, campaignId: payload.campaignId });
    await this.execute(payload.cycleId);
  }

  private readonly identity = new Map<string, { tenantId: string; campaignId: string }>();

  protected async identityFromDeps(cycleId: string): Promise<{ tenantId: string; campaignId: string }> {
    return this.identity.get(cycleId) ?? { tenantId: '', campaignId: '' };
  }

  protected async compute(deps: ComputeDeps<'objective'>): Promise<{ objective: string; primaryKPI: string }> {
    // Prove we can read the snapshot slice from the store
    const snapshot = deps.snapshot;
    if (!snapshot) throw new Error('objective compute: snapshot missing');
    return { objective: 'sales', primaryKPI: 'roas' };
  }

  protected computeConfidence(): number {
    return 1.0;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'company_config', ref: 'test-fixture', weight: 1 }];
  }
}

/**
 * A fake engine with an intentional DAG violation — used to prove the
 * registry catches step-order bugs at bootstrap.
 */
@Injectable()
export class BackwardsDependencyEngine extends BaseEngine<'objective', Record<string, never>> {
  readonly name = 'objective' as const;
  readonly step = 2;
  readonly version = '0.0.0-broken';
  // Wrong: depends on 'signal' which has step 6 > this engine's step 2.
  readonly dependsOn = ['signal'] as const;

  constructor(sliceRepo: SliceRepository, eventBus: EngineEventBus, registry: EngineRegistry) {
    super(sliceRepo, eventBus, registry);
  }

  protected async compute(): Promise<Record<string, never>> {
    return {} as Record<string, never>;
  }
  protected computeConfidence(): number {
    return 1;
  }
  protected buildEvidence(): Evidence[] {
    return [];
  }
}
