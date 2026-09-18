import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model } from 'mongoose';
import {
  IntelligenceSnapshot,
} from '../../../../src/intelligence/snapshot/snapshot.schema';
import { SnapshotEngine } from '../../../../src/intelligence/snapshot/snapshot-engine.service';
import { SnapshotModule } from '../../../../src/intelligence/snapshot/snapshot.module';
import {
  META_SNAPSHOT_FETCHER,
  MetaSnapshotFetcher,
} from '../../../../src/intelligence/snapshot/meta-snapshot-fetcher.interface';
import { RawMetaBundle } from '../../../../src/intelligence/snapshot/snapshot.types';
import { SliceRepository } from '../../../../src/intelligence/shared/slice-repository.service';
import { EngineRegistry } from '../../../../src/intelligence/shared/engine-registry';
import { IntelligenceSharedModule } from '../../../../src/intelligence/shared/intelligence-shared.module';
import { EventEmitter2 } from '@nestjs/event-emitter';

class StubFetcher implements MetaSnapshotFetcher {
  public calls = 0;
  public bundle: RawMetaBundle = {
    campaign: {
      id: 'meta-cmp-1',
      effective_status: 'ACTIVE',
      learning_stage: 'ACTIVE',
      account_id: 'act_123',
      insights: {
        spend: '1000',
        impressions: '20000',
        clicks: '400',
        ctr: '2',
        cpc: '2.5',
        cpm: '50',
        frequency: '1.4',
        actions: [
          { action_type: 'purchase', value: '10' },
          { action_type: 'add_to_cart', value: '35' },
        ],
        action_values: [{ action_type: 'purchase', value: '1900' }],
      },
    },
    adSets: {
      as1: {
        id: 'as1',
        insights: {
          spend: '600',
          impressions: '12000',
          clicks: '240',
          actions: [{ action_type: 'purchase', value: '6' }],
          action_values: [{ action_type: 'purchase', value: '1140' }],
        },
      },
    },
    ads: {
      ad1: {
        id: 'ad1',
        hookStyle: 'social_proof',
        format: 'image',
        insights: {
          spend: '200',
          impressions: '5000',
          clicks: '80',
          actions: [{ action_type: 'purchase', value: '2' }],
          action_values: [{ action_type: 'purchase', value: '400' }],
        },
      },
    },
    metaWindowStart: new Date(Date.now() - 7 * 86400 * 1000),
    metaWindowEnd: new Date(Date.now() - 5 * 60 * 1000),
  };
  async fetch(): Promise<RawMetaBundle> {
    this.calls += 1;
    return this.bundle;
  }
}

describe('SnapshotEngine (integration, stubbed Meta)', () => {
  let mongo: MongoMemoryServer;
  let moduleRef: TestingModule;
  let engine: SnapshotEngine;
  let sliceRepo: SliceRepository;
  let snapshotModel: Model<IntelligenceSnapshot>;
  let fetcher: StubFetcher;
  let emitter: EventEmitter2;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    fetcher = new StubFetcher();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        IntelligenceSharedModule,
        SnapshotModule.forFeature({
          fetcherProvider: { provide: META_SNAPSHOT_FETCHER, useValue: fetcher },
        }),
      ],
    }).compile();
    await moduleRef.init();

    engine = moduleRef.get(SnapshotEngine);
    sliceRepo = moduleRef.get(SliceRepository);
    snapshotModel = moduleRef.get(getModelToken(IntelligenceSnapshot.name));
    emitter = moduleRef.get(EventEmitter2);
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  afterEach(async () => {
    await snapshotModel.deleteMany({});
  });

  it('capture() writes an IntelligenceSnapshot doc and returns confidence', async () => {
    const before = fetcher.calls;
    const result = await engine.capture({
      tenantId: 'astro',
      campaignId: 'cam-1',
      metaCampaignId: 'meta-1',
      products: [
        { name: 'Kundli', conversionValue: 999, contributionMargin: 40, refundRatePercent: 5 },
      ],
    });
    expect(fetcher.calls).toBe(before + 1);
    expect(result.snapshotId).toMatch(/^snap-/);
    expect(result.confidence).toBeGreaterThan(0.7);

    const persisted = await snapshotModel.findOne({ snapshotId: result.snapshotId }).lean();
    expect(persisted).toBeDefined();
    expect((persisted?.metrics as { campaignLevel?: { spend?: number } })?.campaignLevel?.spend).toBe(1000);
    // Standalone capture does NOT set cycleId
    expect(persisted?.cycleId).toBeUndefined();
  });

  it('captureForCycle() writes snapshot + persists slice + emits intelligence.snapshot.completed', async () => {
    const cycleId = 'cycle-abc';
    const completed = new Promise<{ cycleId: string; confidence?: number }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for event')), 3000);
      emitter.once('intelligence.snapshot.completed', (p) => {
        clearTimeout(t);
        resolve(p);
      });
    });

    await engine.captureForCycle({
      cycleId,
      tenantId: 'astro',
      campaignId: 'cam-2',
      metaCampaignId: 'meta-2',
      products: [{ name: 'p', conversionValue: 999, refundRatePercent: 0 }],
    });

    const evt = await completed;
    expect(evt.cycleId).toBe(cycleId);
    expect(evt.confidence).toBeGreaterThan(0.5);

    const slice = await sliceRepo.load(cycleId, 'snapshot');
    expect(slice).toBeDefined();

    const persisted = await snapshotModel.findOne({ cycleId }).lean();
    expect(persisted?.cycleId).toBe(cycleId);
  });

  it('getHistory returns snapshots newest-first', async () => {
    // Insert 3 snapshots for the same campaign
    for (let i = 0; i < 3; i++) {
      await engine.capture({
        tenantId: 'astro',
        campaignId: 'cam-hist',
        metaCampaignId: 'meta-hist',
        products: [],
      });
    }
    const history = await engine.getHistory('astro', 'cam-hist', 10);
    expect(history).toHaveLength(3);
    // Newest first — collectedAt descending
    const times = history.map((s) => new Date(s.collectedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('is registered with the engine registry as name=snapshot step=1', () => {
    const registry = moduleRef.get(EngineRegistry);
    const descriptor = registry.get('snapshot');
    expect(descriptor).toBeDefined();
    expect(descriptor?.step).toBe(1);
    expect(descriptor?.dependsOn).toEqual([]);
  });

  it('reports deterministic=false on its slice (Meta is the boundary)', async () => {
    const cycleId = 'cycle-det';
    await engine.captureForCycle({
      cycleId,
      tenantId: 'astro',
      campaignId: 'cam-3',
      metaCampaignId: 'meta-3',
      products: [{ name: 'p', conversionValue: 999 }],
    });
    // Wait a tick for slice write
    await new Promise((r) => setTimeout(r, 50));
    const slice = (await sliceRepo.load(cycleId, 'snapshot')) as
      | { deterministic?: boolean }
      | undefined;
    expect(slice?.deterministic).toBe(false);
  });

  it('propagates fetcher failure via intelligence.snapshot.failed', async () => {
    // Swap fetcher to throw for this test
    fetcher.fetch = async () => {
      throw new Error('meta_down');
    };
    const cycleId = 'cycle-fail';
    const failed = new Promise<{ cycleId: string; error?: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for failed')), 3000);
      emitter.once('intelligence.snapshot.failed', (p) => {
        clearTimeout(t);
        resolve(p);
      });
    });

    await expect(
      engine.captureForCycle({
        cycleId,
        tenantId: 'astro',
        campaignId: 'cam-4',
        metaCampaignId: 'meta-4',
        products: [],
      }),
    ).rejects.toThrow();

    const evt = await failed;
    expect(evt.cycleId).toBe(cycleId);
    expect(evt.error).toMatch(/meta_down|compute_threw/);

    // Reset fetcher for subsequent tests
    fetcher.fetch = async () => fetcher.bundle;
  });
});
