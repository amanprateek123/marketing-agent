import { PmSyncService } from './pm-sync.service';

/** A Metabase outage (refunds step throws) must not stop Meta or attribution. */
describe('PmSyncService hourly', () => {
  it('runs the remaining steps when one step fails, then reports the failure', async () => {
    const visitorDays = { syncDay: jest.fn().mockResolvedValue(0) };
    const orders = {
      syncDay: jest.fn().mockResolvedValue(0),
      syncNewRefunds: jest
        .fn()
        .mockRejectedValue(new Error('timeout of 90000ms exceeded')),
    };
    const attribution = {
      attributeDays: jest
        .fn()
        .mockResolvedValue({ orders: 0, withDevice: 0, withMetaClick: 0 }),
    };
    const meta = {
      configured: true,
      accounts: ['111'],
      setHeartbeat: jest.fn(),
      syncDaily: jest.fn().mockResolvedValue({ rows: 5 }),
      adsToRefresh: jest.fn().mockResolvedValue([]),
      syncEntities: jest.fn().mockResolvedValue(0),
      syncChanges: jest.fn().mockResolvedValue(0),
      syncCampaignList: jest.fn().mockResolvedValue(2),
    };
    const statuses: string[] = [];
    const runs = {
      create: jest.fn().mockResolvedValue({ _id: 'r' }),
      updateOne: jest.fn((_q, u: { status: string }) => {
        statuses.push(u.status);
        return Promise.resolve();
      }),
    };
    const locks = {
      findOneAndUpdate: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
    };
    const sync = new PmSyncService(
      visitorDays as any,
      orders as any,
      attribution as any,
      meta as any,
      runs as any,
      locks as any,
      { tenantId: 't' } as any,
      null as any,
      null as any,
      null as any,
      null as any,
    );

    await expect(sync.hourly()).rejects.toThrow('1 of 8 steps failed');
    expect(attribution.attributeDays).toHaveBeenCalled();
    expect(meta.syncDaily).toHaveBeenCalled();
    expect(meta.syncChanges).toHaveBeenCalled();
    expect(statuses).toContain('failed');
    expect(meta.syncCampaignList).toHaveBeenCalledWith('111');
    expect(statuses.filter((s) => s === 'succeeded').length).toBe(7);
  });
});

/** D-30: before an AI run, load only what this campaign is missing. */
describe('PmSyncService campaignHistory', () => {
  const lean = (v: unknown) => ({ lean: () => Promise.resolve(v) });
  const setup = (o: { failDaily?: boolean } = {}) => {
    const meta = {
      configured: true,
      accounts: ['111', '222'],
      setHeartbeat: jest.fn(),
      syncDaily: o.failDaily
        ? jest.fn().mockRejectedValue(new Error('Meta API error 190'))
        : jest.fn().mockResolvedValue({ rows: 3, adIds: [] }),
      adsToRefresh: jest.fn().mockResolvedValue([]),
      syncEntities: jest.fn().mockResolvedValue(0),
      syncBreakdowns: jest.fn().mockResolvedValue(4),
      syncChanges: jest.fn().mockResolvedValue(2),
    };
    const visitorDays = { syncDay: jest.fn().mockResolvedValue(1) };
    const orders = { syncDay: jest.fn().mockResolvedValue(1) };
    const attribution = {
      attributeDays: jest
        .fn()
        .mockResolvedValue({ orders: 1, withDevice: 0, withMetaClick: 0 }),
    };
    const analysis = {
      missingDays: jest.fn().mockResolvedValue({
        // The 30-day window for to=10-26 starts 09-27: 09-25/26 are older, 10-20 recent.
        meta: ['2026-09-25', '2026-09-26', '2026-10-20'],
        orders: [],
        visitors: ['2026-10-20'],
      }),
    };
    const coverage = {
      findOne: jest.fn(({ key }: { key: string }) =>
        lean(
          key === 'campaign:c1'
            ? { days: ['2026-09-26'] }
            : { days: ['2026-10-14'] },
        ),
      ),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const metaDaily = {
      distinct: jest.fn().mockResolvedValue(['2026-10-20', '2026-10-21']),
    };
    const breakdowns = { distinct: jest.fn().mockResolvedValue(['2026-10-21']) };
    const runs = {
      create: jest.fn().mockResolvedValue({ _id: 'r' }),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const locks = {
      findOneAndUpdate: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      findOne: jest.fn().mockReturnValue(lean(null)),
    };
    const sync = new PmSyncService(
      visitorDays as any,
      orders as any,
      attribution as any,
      meta as any,
      runs as any,
      locks as any,
      { tenantId: 't' } as any,
      analysis as any,
      metaDaily as any,
      breakdowns as any,
      coverage as any,
    );
    return { sync, meta, visitorDays, orders, attribution, analysis, coverage };
  };
  const camp = {
    entityId: 'c1',
    accountId: '111',
    createdTime: new Date('2026-09-25T06:00:00Z'),
  };

  it('fills only the gaps; Meta only for this campaign', async () => {
    const m = setup();
    const steps: string[] = [];
    await m.sync.campaignHistory(camp, '2026-10-26', async (s) => steps.push(s));
    expect(m.analysis.missingDays).toHaveBeenCalledWith({
      from: '2026-09-25',
      to: '2026-10-26',
    });
    expect(m.visitorDays.syncDay).toHaveBeenCalled();
    expect(m.orders.syncDay).not.toHaveBeenCalled();
    // Attribution re-runs a week on from the new visitor day.
    expect(m.attribution.attributeDays.mock.calls.flat(2)).toContain('2026-10-26');
    // Every gap → this campaign only (09-26 already covered), never whole accounts.
    expect(m.meta.syncDaily.mock.calls).toEqual([
      ['111', '2026-09-25', '2026-09-25', 'c1'],
      ['111', '2026-10-20', '2026-10-20', 'c1'],
    ]);
    expect(m.coverage.updateOne).toHaveBeenCalledWith(
      { tenantId: 't', key: 'campaign:c1' },
      { $addToSet: { days: { $each: ['2026-09-25'] } } },
      { upsert: true },
    );
    // Breakdowns only for the spent day without them, this campaign only.
    expect(m.meta.syncBreakdowns.mock.calls).toEqual([
      ['111', '2026-10-20', '2026-10-20', 'c1'],
    ]);
    // Change log: last 14 days only (10-13..10-26), one day each, minus covered 10-14.
    const changeDays = m.meta.syncChanges.mock.calls.map((c) => c[1]);
    expect(changeDays).toHaveLength(13);
    expect(changeDays[0]).toBe('2026-10-13');
    expect(changeDays).not.toContain('2026-10-14');
    expect(m.meta.syncChanges.mock.calls[0]).toEqual(['111', '2026-10-13', '2026-10-13']);
    expect(steps[0]).toBe('history: visitors (1 days)');
  });

  it('a failed step stops the load with its error', async () => {
    const m = setup({ failDaily: true });
    await expect(m.sync.campaignHistory(camp, '2026-10-26')).rejects.toThrow(
      'Meta API error 190',
    );
    expect(m.meta.syncChanges).not.toHaveBeenCalled();
  });
});
