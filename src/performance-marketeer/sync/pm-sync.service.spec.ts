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
    );

    await expect(sync.hourly()).rejects.toThrow('1 of 7 steps failed');
    expect(attribution.attributeDays).toHaveBeenCalled();
    expect(meta.syncDaily).toHaveBeenCalled();
    expect(meta.syncChanges).toHaveBeenCalled();
    expect(statuses).toContain('failed');
    expect(statuses.filter((s) => s === 'succeeded').length).toBe(6);
  });
});
