import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model } from 'mongoose';
import { EngineOutputDoc } from '../../../src/intelligence/orchestrator/engine-output.schema';
import { SliceRepository } from '../../../src/intelligence/shared/slice-repository.service';
import { EngineContext } from '../../../src/intelligence/shared/engine-context';
import { IntelligenceSharedModule } from '../../../src/intelligence/shared/intelligence-shared.module';

describe('SliceRepository (integration, in-memory Mongo)', () => {
  let mongo: MongoMemoryServer;
  let moduleRef: TestingModule;
  let repo: SliceRepository;
  let model: Model<EngineOutputDoc>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        IntelligenceSharedModule,
      ],
    }).compile();

    repo = moduleRef.get(SliceRepository);
    model = moduleRef.get(getModelToken(EngineOutputDoc.name));
    // Ensure indexes (unique {cycleId, engine}) built before the tests
    await model.syncIndexes();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  afterEach(async () => {
    await model.deleteMany({});
  });

  const cycleId = 'cycle-1';
  const tenantId = 'astro';
  const campaignId = 'cam-1';

  const sampleSlice: EngineContext<{ objective: string }> = {
    data: { objective: 'sales' },
    confidence: 0.95,
    evidence: [{ kind: 'company_config', ref: 'company/astro', weight: 1 }],
    version: 'objective@1.0.0',
    computedAt: new Date(),
    ms: 8,
    deterministic: true,
  };

  it('write() persists a slice and load() returns it', async () => {
    await repo.write({ cycleId, tenantId, campaignId }, 'objective', sampleSlice);
    const loaded = await repo.load(cycleId, 'objective');
    expect(loaded).toBeDefined();
    expect((loaded as EngineContext<{ objective: string }>).data.objective).toBe('sales');
  });

  it('write() is idempotent — second call does not throw', async () => {
    await repo.write({ cycleId, tenantId, campaignId }, 'objective', sampleSlice);
    await expect(
      repo.write({ cycleId, tenantId, campaignId }, 'objective', {
        ...sampleSlice,
        data: { objective: 'awareness' },
      }),
    ).resolves.not.toThrow();
    // First-write wins under $setOnInsert semantics
    const loaded = await repo.load(cycleId, 'objective');
    expect((loaded as EngineContext<{ objective: string }>).data.objective).toBe('sales');
  });

  it('load() returns undefined when slice missing', async () => {
    const loaded = await repo.load(cycleId, 'trend');
    expect(loaded).toBeUndefined();
  });

  it('loadMany() returns partial DecisionContext', async () => {
    await repo.write({ cycleId, tenantId, campaignId }, 'objective', sampleSlice);
    await repo.write({ cycleId, tenantId, campaignId }, 'lifecycle', {
      ...sampleSlice,
      data: { stage: 'growing' },
      version: 'lifecycle@1.0.0',
    });
    const many = await repo.loadMany(cycleId, ['objective', 'lifecycle', 'trend']);
    expect(many.objective).toBeDefined();
    expect(many.lifecycle).toBeDefined();
    expect(many.trend).toBeUndefined();
  });

  it('loadFull() returns every slice written for a cycle', async () => {
    await repo.write({ cycleId, tenantId, campaignId }, 'objective', sampleSlice);
    await repo.write({ cycleId, tenantId, campaignId }, 'lifecycle', {
      ...sampleSlice,
      data: { stage: 'growing' },
      version: 'lifecycle@1.0.0',
    });
    const full = await repo.loadFull(cycleId);
    expect(Object.keys(full).sort()).toEqual(['lifecycle', 'objective']);
  });

  it('hasSlices() reports true only when every requested slice exists', async () => {
    await repo.write({ cycleId, tenantId, campaignId }, 'objective', sampleSlice);
    expect(await repo.hasSlices(cycleId, ['objective'])).toBe(true);
    expect(await repo.hasSlices(cycleId, ['objective', 'trend'])).toBe(false);
    expect(await repo.hasSlices(cycleId, [])).toBe(true);
  });

  it('unique index prevents duplicate (cycleId, engine) at the DB level', async () => {
    // Force two writes via raw model bypassing SliceRepository's upsert
    const raw = model as unknown as {
      create: (doc: Record<string, unknown>) => Promise<unknown>;
    };
    await raw.create({
      cycleId,
      tenantId,
      campaignId,
      engine: 'objective',
      slice: sampleSlice,
      writtenAt: new Date(),
    });
    await expect(
      raw.create({
        cycleId,
        tenantId,
        campaignId,
        engine: 'objective',
        slice: { ...sampleSlice, version: 'objective@2.0.0' },
        writtenAt: new Date(),
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('different cycles can hold the same engine slice independently', async () => {
    await repo.write({ cycleId: 'c-A', tenantId, campaignId }, 'objective', sampleSlice);
    await repo.write({ cycleId: 'c-B', tenantId, campaignId }, 'objective', sampleSlice);
    const a = await repo.load('c-A', 'objective');
    const b = await repo.load('c-B', 'objective');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });
});
