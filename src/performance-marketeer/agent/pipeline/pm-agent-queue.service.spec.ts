import { ConflictException, NotFoundException } from '@nestjs/common';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, createConnection, Model } from 'mongoose';
import {
  PmAgentRun,
  PmAgentRunSchema,
} from '../../schemas/pm-agent-run.schema';
import { PmMetaEntity, PmMetaEntitySchema } from '../../schemas/pm-meta.schema';
import { PmAgentQueueService } from './pm-agent-queue.service';
import { PM_RUN_STALE_MS, PmPipelineService } from './pm-pipeline.service';

const T = '91astrology';
const D = '2026-10-27';

describe('PmAgentQueueService', () => {
  let mongo: MongoMemoryServer;
  let conn: Connection;
  let runs: Model<PmAgentRun>;
  let entities: Model<PmMetaEntity>;
  let root: string;
  let pipeline: PmPipelineService;
  let svc: PmAgentQueueService;
  const records = { daily: jest.fn() };
  const lessons = { scoreDaily: jest.fn() };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    conn = await createConnection(mongo.getUri()).asPromise();
    runs = conn.model(PmAgentRun.name, PmAgentRunSchema);
    entities = conn.model(PmMetaEntity.name, PmMetaEntitySchema);
    await runs.syncIndexes();
    root = mkdtempSync(join(tmpdir(), 'pm-queue-'));
    process.env.PM_AGENT_DIR = root;
    // Only claim/dirs of the real pipeline are used; the LLM path is stubbed per test.
    pipeline = new (PmPipelineService as any)(
      ...Array(11).fill(null),
      runs,
      entities,
      null,
      { tenantId: T },
    );
  });
  afterAll(async () => {
    await conn?.close();
    await mongo?.stop();
  });
  beforeEach(async () => {
    await runs.deleteMany({});
    await entities.deleteMany({});
    await entities.create(
      ['111', '222'].map((id) => ({
        tenantId: T,
        level: 'campaign',
        entityId: id,
        accountId: 'act_1',
        name: `C${id}`,
        product: 'p',
      })),
    );
    delete process.env.PM_AGENT_MAX_USD_PER_DAY;
    jest.clearAllMocks();
    svc = new PmAgentQueueService(
      pipeline,
      records as any,
      lessons as any,
      runs,
      entities,
      { tenantId: T } as any,
    );
  });

  it('enqueue: validates, skips queued/running, needs rerun for finished', async () => {
    expect(await svc.enqueue(['111', '999', '111'], D, 'admin')).toEqual({
      queued: ['111'],
      skipped: [{ campaignId: '999', reason: 'campaign not found' }],
    });
    const doc = await runs.findOne({ campaignId: '111' }).lean();
    expect(doc).toMatchObject({
      status: 'queued',
      queuedBy: 'admin',
      campaignName: 'C111',
      date: D,
    });
    expect(doc!.queuedAt).toBeInstanceOf(Date);

    expect((await svc.enqueue(['111'], D)).skipped).toEqual([
      { campaignId: '111', reason: 'already queued' },
    ]);
    await runs.updateOne({ campaignId: '111' }, { status: 'running' });
    expect((await svc.enqueue(['111'], D)).skipped[0].reason).toBe(
      'already running',
    );
    await runs.updateOne({ campaignId: '111' }, { status: 'done' });
    expect((await svc.enqueue(['111'], D)).skipped[0].reason).toBe(
      `already analysed for ${D} — pass rerun`,
    );
  });

  it('enqueue rerun: resets the doc, keeps prior cost, deletes the folder', async () => {
    await runs.create({
      tenantId: T,
      campaignId: '111',
      date: D,
      status: 'failed',
      step: 'plan v1',
      error: 'boom',
      costUsd: 7,
      actions: [{ id: 'A1' }],
      files: { 'x.md': 'x' },
      userNote: 'keep me',
    });
    const dir = pipeline.campaignDir('111', D);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '01-investigate.v1.md.json'), '{}');
    expect(await svc.enqueue(['111'], D, 'admin', true)).toEqual({
      queued: ['111'],
      skipped: [],
    });
    expect(existsSync(dir)).toBe(false);
    expect(await runs.findOne({ campaignId: '111' }).lean()).toMatchObject({
      status: 'queued',
      step: '',
      error: '',
      costUsd: 0,
      priorCostUsd: 7,
      actions: [],
      files: {},
      userNote: 'keep me',
    });
  });

  it('claim: two workers race for one run, one wins; CLI cannot take it', async () => {
    await svc.enqueue(['111'], D);
    const other = new PmAgentQueueService(
      pipeline,
      records as any,
      lessons as any,
      runs,
      entities,
      { tenantId: T } as any,
    );
    const got = await Promise.all([svc.claimNext(), other.claimNext()]);
    expect(got.filter(Boolean)).toHaveLength(1);
    expect((await runs.findOne({ campaignId: '111' }).lean())!.status).toBe(
      'running',
    );
    expect(await pipeline.claim(D, '111')).toBe(false);
    // A different campaign (no doc yet) can be claimed by the CLI.
    expect(await pipeline.claim(D, '222')).toBe(true);
    expect(await pipeline.claim(D, '222')).toBe(false);
  });

  it('claims oldest queuedAt first', async () => {
    await svc.enqueue(['222'], D);
    await svc.enqueue(['111'], '2026-10-26');
    expect((await svc.claimNext())!.campaignId).toBe('222');
    expect((await svc.claimNext())!.campaignId).toBe('111');
    expect(await svc.claimNext()).toBeNull();
  });

  it('stale running runs are requeued; fresh ones are not', async () => {
    const old = new Date(Date.now() - PM_RUN_STALE_MS - 1000);
    await runs.create([
      {
        tenantId: T,
        campaignId: '111',
        date: D,
        status: 'running',
        heartbeatAt: old,
        queuedAt: old,
      },
      {
        tenantId: T,
        campaignId: '222',
        date: D,
        status: 'running',
        heartbeatAt: new Date(),
      },
    ]);
    expect(await svc.requeueStale()).toBe(1);
    expect((await runs.findOne({ campaignId: '111' }).lean())!.status).toBe(
      'queued',
    );
    expect((await runs.findOne({ campaignId: '222' }).lean())!.status).toBe(
      'running',
    );
    // The CLI may also take a dead run directly.
    await runs.updateOne(
      { campaignId: '111' },
      { status: 'running', heartbeatAt: old },
    );
    expect(await pipeline.claim(D, '111')).toBe(true);
  });

  it('daily cap: a date at the cap waits, other dates still run', async () => {
    process.env.PM_AGENT_MAX_USD_PER_DAY = '10';
    await runs.create({
      tenantId: T,
      campaignId: '999',
      date: D,
      status: 'done',
      costUsd: 6,
      priorCostUsd: 4,
    });
    await svc.enqueue(['111'], D);
    expect(await svc.claimNext()).toBeNull();
    expect(await runs.findOne({ campaignId: '111' }).lean()).toMatchObject({
      status: 'queued',
      step: 'waiting: daily budget reached',
    });
    await svc.enqueue(['222'], '2026-10-28');
    expect((await svc.claimNext())!.campaignId).toBe('222');
  });

  it('cancel: never-ran → deleted, requeued → failed, running → 409, none → 404', async () => {
    await svc.enqueue(['111', '222'], D);
    expect(await svc.cancel('111', D)).toMatchObject({ cancelled: 'deleted' });
    expect(await runs.countDocuments({ campaignId: '111' })).toBe(0);
    await runs.updateOne({ campaignId: '222' }, { startedAt: new Date() });
    expect(await svc.cancel('222', D)).toMatchObject({
      cancelled: 'marked_failed',
    });
    expect(await runs.findOne({ campaignId: '222' }).lean()).toMatchObject({
      status: 'failed',
      error: 'cancelled',
    });
    await expect(svc.cancel('222', D)).rejects.toThrow(ConflictException);
    await expect(svc.cancel('111', D)).rejects.toThrow(NotFoundException);
  });

  it('list: queue positions, running, finished of the date, spend', async () => {
    await svc.enqueue(['111', '222'], D, 'admin');
    await svc.claimNext();
    await runs.create({
      tenantId: T,
      campaignId: '333',
      date: D,
      status: 'done',
      costUsd: 2.5,
      finishedAt: new Date(),
    });
    const l = await svc.list(D);
    expect(l.queued).toEqual([
      expect.objectContaining({
        campaignId: '222',
        position: 1,
        queuedBy: 'admin',
      }),
    ]);
    expect(l.running).toEqual([expect.objectContaining({ campaignId: '111' })]);
    expect(l.finished).toEqual([
      expect.objectContaining({
        campaignId: '333',
        status: 'done',
        actionCount: 0,
      }),
    ]);
    expect(l).toMatchObject({
      date: D,
      spentUsd: 2.5,
      capUsd: 100,
      worker: false,
    });
  });

  it('tick: preps the day and lessons once per date, runs the claimed campaign', async () => {
    const prep = jest
      .spyOn(pipeline, 'prepareDay')
      .mockImplementation(async (d) => {
        mkdirSync(pipeline.dayDir(d), { recursive: true });
        writeFileSync(join(pipeline.dayDir(d), 'account.md'), '#');
        return pipeline.dayDir(d);
      });
    const run = jest
      .spyOn(pipeline, 'runCampaign')
      .mockImplementation(async (date, campaignId) => {
        await runs.updateOne({ campaignId, date }, { status: 'done' });
        return {
          campaignId,
          status: 'done',
          step: 'done',
          actions: 0,
          costUsd: 0,
        };
      });
    records.daily.mockRejectedValueOnce(new Error('records down'));
    await svc.enqueue(['111', '222'], D);
    expect(await svc.tick()).toBe(true);
    expect(await svc.tick()).toBe(true);
    expect(await svc.tick()).toBe(false);
    expect(prep).toHaveBeenCalledTimes(1);
    expect(records.daily).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['111', { claimed: true }],
      ['222', { claimed: true }],
    ]);
    run.mockRejectedValueOnce(new Error('mongo blip'));
    await svc.enqueue(['111'], '2026-10-28');
    expect(await svc.tick()).toBe(false); // logged, never thrown
    prep.mockRestore();
    run.mockRestore();
  });
});
