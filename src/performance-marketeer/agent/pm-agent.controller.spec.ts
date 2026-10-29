import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Model } from 'mongoose';
import { PmAgentController } from './pm-agent.controller';
import { PmAgentRun } from '../schemas/pm-agent-run.schema';
import { PmEnv } from '../pm.config';
import { PmAgentQueueService } from './pipeline/pm-agent-queue.service';
import { PmAgentQueueDto, PmCampaignTargetDto } from './pm-agent.controller';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

/** Chainable query stub: every method returns itself, exec() resolves `v`. */
const q = (v: unknown) => {
  const o: Record<string, jest.Mock> = {};
  for (const m of ['sort', 'lean', 'limit']) o[m] = jest.fn(() => o);
  o.exec = jest.fn().mockResolvedValue(v);
  return o;
};
const act = (id: string, impact: number, confidence: number, rank: number) => ({
  id,
  impactRupeesPerDay: impact,
  confidence,
  rank,
});

describe('PmAgentController', () => {
  const model = {
    aggregate: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };
  const queue = {
    enqueue: jest.fn().mockResolvedValue({ queued: ['120'], skipped: [] }),
    list: jest.fn().mockResolvedValue({ queued: [] }),
    cancel: jest.fn().mockResolvedValue({ cancelled: 'deleted' }),
  };
  const targets = { find: jest.fn(), findOneAndUpdate: jest.fn() };
  const entities = { find: jest.fn() };
  const c = new PmAgentController(
    model as unknown as Model<PmAgentRun>,
    targets as never,
    { tenantId: '91astrology' } as PmEnv,
    queue as unknown as PmAgentQueueService,
    entities as never,
  );
  const T = '91astrology';
  beforeEach(() => jest.clearAllMocks());

  it('validates tenant, date and campaign id', async () => {
    await expect(c.dates('other')).rejects.toThrow(NotFoundException);
    await expect(c.rollup(T, { date: '27-10-2026' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(c.rollup(T, { date: { $ne: 'x' } })).rejects.toThrow(
      BadRequestException,
    );
    await expect(c.run(T, 'bad id!', {})).rejects.toThrow(BadRequestException);
    await expect(
      c.note(T, '120', { date: '2026-1-1', note: 'x' }),
    ).rejects.toThrow(BadRequestException);
    expect(model.find).not.toHaveBeenCalled();
  });

  it('dates filters by tenant', async () => {
    model.aggregate.mockReturnValue(q([{ _id: '2026-10-27' }]));
    expect(await c.dates(T)).toEqual(['2026-10-27']);
    expect(model.aggregate.mock.calls[0][0][0]).toEqual({
      $match: { tenantId: T },
    });
  });

  it('roll-up defaults to the latest date and ranks actions by ₹ × confidence', async () => {
    model.findOne.mockReturnValue(q({ date: '2026-10-27' }));
    model.find.mockReturnValue(
      q([
        {
          campaignId: 'c1',
          campaignName: 'One',
          actions: [act('A1', 1000, 0.2, 1), act('A2', 500, 0.8, 2)],
          unresolved: ['I1'],
        },
        {
          campaignId: 'c2',
          campaignName: 'Two',
          actions: [act('A1', 400, 0.5, 1)],
          unresolved: [],
        },
      ]),
    );
    const r = await c.rollup(T, {});
    expect(model.find.mock.calls[0][0]).toEqual({
      tenantId: T,
      date: '2026-10-27',
    });
    expect(r.date).toBe('2026-10-27');
    expect(r.actions.map((a) => `${a.campaignName}:${a.id}`)).toEqual([
      'One:A2',
      'One:A1',
      'Two:A1',
    ]);
    expect(r.runs[0]).toMatchObject({ actionCount: 2, unresolvedCount: 1 });
  });

  it('roll-up with no runs at all is empty', async () => {
    model.findOne.mockReturnValue(q(null));
    expect(await c.rollup(T, {})).toEqual({
      date: null,
      runs: [],
      actions: [],
    });
  });

  it('note saves trimmed text scoped to tenant + campaign + date', async () => {
    model.findOneAndUpdate.mockReturnValue(
      q({ campaignId: 'c1', date: '2026-10-27', userNote: 'did A2' }),
    );
    await c.note(T, 'c1', { date: '2026-10-27', note: '  did A2 ' });
    expect(model.findOneAndUpdate.mock.calls[0].slice(0, 2)).toEqual([
      { tenantId: T, campaignId: 'c1', date: '2026-10-27' },
      { $set: { userNote: 'did A2' } },
    ]);
    model.findOneAndUpdate.mockReturnValue(q(null));
    await expect(
      c.note(T, 'c1', { date: '2026-10-27', note: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('queue DTO: 1–20 digit ids, optional date and rerun', () => {
    const errs = (b: object) =>
      validateSync(plainToInstance(PmAgentQueueDto, b)).map((e) => e.property);
    expect(errs({ campaignIds: ['120', '121'] })).toEqual([]);
    expect(errs({ campaignIds: [] })).toEqual(['campaignIds']);
    expect(errs({ campaignIds: ['12a'] })).toEqual(['campaignIds']);
    expect(
      errs({ campaignIds: Array.from({ length: 21 }, (_, i) => String(i)) }),
    ).toEqual(['campaignIds']);
    expect(
      errs({ campaignIds: ['1'], date: '2026-1-1', rerun: 'yes' }),
    ).toEqual(['date', 'rerun']);
  });

  it('queue routes check tenant and pass user, date, rerun through', async () => {
    const req = { user: { sub: 'admin@x', role: 'workspace' } } as never;
    await expect(
      c.enqueue('other', { campaignIds: ['120'] }, req),
    ).rejects.toThrow(NotFoundException);
    await expect(
      c.enqueue(T, { campaignIds: ['120'], date: '27-10-2026' }, req),
    ).rejects.toThrow(BadRequestException);
    expect(
      await c.enqueue(
        T,
        { campaignIds: ['120'], date: '2026-10-27', rerun: true },
        req,
      ),
    ).toEqual({ queued: ['120'], skipped: [] });
    expect(queue.enqueue).toHaveBeenCalledWith(
      ['120'],
      '2026-10-27',
      'admin@x',
      true,
    );
    await c.enqueue(T, { campaignIds: ['120'] }, {} as never);
    expect(queue.enqueue).toHaveBeenLastCalledWith(
      ['120'],
      undefined,
      '',
      false,
    );

    await c.queueList(T, { date: '2026-10-27' });
    expect(queue.list).toHaveBeenCalledWith('2026-10-27');
    await expect(c.queueList(T, { date: 'x' })).rejects.toThrow(
      BadRequestException,
    );

    await c.cancel(T, '120', { date: '2026-10-27' });
    expect(queue.cancel).toHaveBeenCalledWith('120', '2026-10-27');
    await expect(
      c.cancel(T, 'bad id!', { date: '2026-10-27' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('sets, changes and removes a lifetime purchase target, keeping history', async () => {
    const ok = (v: unknown) =>
      validateSync(plainToInstance(PmCampaignTargetDto, { targetPurchases: v })).length === 0;
    expect(ok(500)).toBe(true);
    expect(ok(null)).toBe(true);
    expect(ok(0)).toBe(false);
    expect(ok(2.5)).toBe(false);
    expect(ok('500')).toBe(false);

    targets.findOneAndUpdate.mockReturnValue(
      q({ campaignId: '120', targetPurchases: 500, updatedBy: 'u1' }),
    );
    const r = await c.setTarget(T, '120', { targetPurchases: 500 }, {
      user: { sub: 'u1' },
    } as never);
    expect(r.targetPurchases).toBe(500);
    const [filter, update, opts] = targets.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ tenantId: T, campaignId: '120' });
    expect(update.$set).toEqual({ targetPurchases: 500, updatedBy: 'u1' });
    expect(update.$push.history.$each[0]).toMatchObject({ targetPurchases: 500, by: 'u1' });
    expect(opts).toMatchObject({ upsert: true });
    await expect(
      c.setTarget('other', '120', { targetPurchases: 1 }, {} as never),
    ).rejects.toThrow(NotFoundException);
  });

  it('campaign list: active first, then newest; tenant checked', async () => {
    entities.find.mockReturnValue(
      q([
        { entityId: '1', name: 'Old paused', effectiveStatus: 'PAUSED', createdTime: new Date('2026-05-01') },
        { entityId: '2', name: 'New paused', effectiveStatus: 'PAUSED', createdTime: new Date('2026-10-01') },
        { entityId: '3', name: 'Active', effectiveStatus: 'ACTIVE', createdTime: new Date('2026-04-01') },
      ]),
    );
    expect((await c.campaigns(T)).map((x) => x.id)).toEqual(['3', '2', '1']);
    expect(entities.find.mock.calls[0][0]).toMatchObject({ tenantId: T, level: 'campaign' });
    await expect(c.campaigns('other')).rejects.toThrow(NotFoundException);
  });
});
