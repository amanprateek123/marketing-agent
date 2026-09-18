import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { EngineRegistry } from '../../../src/intelligence/shared/engine-registry';
import { SliceRepository } from '../../../src/intelligence/shared/slice-repository.service';
import { IntelligenceOrchestrator } from '../../../src/intelligence/orchestrator/intelligence-orchestrator.service';
import { IntelligenceSharedModule } from '../../../src/intelligence/shared/intelligence-shared.module';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  FakeObjectiveEngine,
  FakeSnapshotEngine,
} from '../fixtures/fake-engines';

/**
 * Proves the whole cascade: openCycle → intelligence.cycle.started fires
 * FakeSnapshotEngine → snapshot slice persisted → intelligence.snapshot.completed
 * fires FakeObjectiveEngine → objective slice persisted.
 */
describe('Intelligence pipeline cascade (integration)', () => {
  let mongo: MongoMemoryServer;
  let moduleRef: TestingModule;
  let orchestrator: IntelligenceOrchestrator;
  let sliceRepo: SliceRepository;
  let emitter: EventEmitter2;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        IntelligenceSharedModule,
      ],
      providers: [FakeSnapshotEngine, FakeObjectiveEngine],
    }).compile();
    await moduleRef.init();

    orchestrator = moduleRef.get(IntelligenceOrchestrator);
    sliceRepo = moduleRef.get(SliceRepository);
    emitter = moduleRef.get(EventEmitter2);
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  const waitForEvent = (event: string, timeoutMs = 3000): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${event}`)),
        timeoutMs,
      );
      emitter.once(event, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  it('cascades snapshot → objective end-to-end and persists both slices', async () => {
    const objectiveDonePromise = waitForEvent(
      'intelligence.objective.completed',
    );

    const dc = await orchestrator.openCycle({
      tenantId: 'astro',
      campaignId: 'cam-42',
      featureFlags: { intelligenceV2: true, contextsEnabled: 2 },
    });

    // Wait for the cascade to finish
    const donePayload = (await objectiveDonePromise) as {
      cycleId: string;
      engine: string;
    };
    expect(donePayload.cycleId).toBe(dc.cycleId);
    expect(donePayload.engine).toBe('objective');

    // Both slices landed in intelligence_engine_outputs
    const snapshotSlice = await sliceRepo.load(dc.cycleId, 'snapshot');
    const objectiveSlice = await sliceRepo.load(dc.cycleId, 'objective');
    expect(snapshotSlice).toBeDefined();
    expect(objectiveSlice).toBeDefined();
  });

  it('DAG validated at bootstrap (registry.onModuleInit did not throw)', () => {
    const registry = moduleRef.get(EngineRegistry);
    const names = registry.all().map((d) => d.name);
    expect(names).toEqual(['snapshot', 'objective']);
  });

  it('closeCycle updates status + emits intelligence.cycle.completed', async () => {
    const cycleCompletedPromise = waitForEvent('intelligence.cycle.completed');
    const dc = await orchestrator.openCycle({
      tenantId: 'astro',
      campaignId: 'cam-x',
    });
    // Give engines a moment to write slices (not required for closeCycle)
    await new Promise((r) => setTimeout(r, 50));
    await orchestrator.closeCycle(dc.cycleId, 'completed');
    const payload = (await cycleCompletedPromise) as {
      cycleId: string;
      durationMs: number;
    };
    expect(payload.cycleId).toBe(dc.cycleId);
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });
});
