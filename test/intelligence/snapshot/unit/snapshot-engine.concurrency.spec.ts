import { SnapshotEngine } from '../../../../src/intelligence/snapshot/snapshot-engine.service';
import { EngineEventBus } from '../../../../src/intelligence/shared/engine-event-bus.service';
import { EngineRegistry } from '../../../../src/intelligence/shared/engine-registry';
import { SliceRepository } from '../../../../src/intelligence/shared/slice-repository.service';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SnapshotEngine concurrent cycle identity', () => {
  it('keeps each overlapped capture bound to its own cycle and campaign', async () => {
    const releaseCycleA = deferred();
    const cycleALoadStarted = deferred();
    const writes: Array<{
      cycleId: string;
      tenantId: string;
      campaignId: string;
      snapshotId: string;
    }> = [];

    const sliceRepo = {
      loadManyWithIdentity: jest.fn(async (cycleId: string) => {
        if (cycleId === 'cycle-a') {
          cycleALoadStarted.resolve();
          await releaseCycleA.promise;
        }
        return { slices: {}, identity: null };
      }),
      write: jest.fn(
        async (
          identity: {
            cycleId: string;
            tenantId: string;
            campaignId: string;
          },
          _engine: string,
          slice: { data: { snapshotId: string } },
        ) => {
          writes.push({ ...identity, snapshotId: slice.data.snapshotId });
        },
      ),
    } as unknown as SliceRepository;
    const eventBus = {
      emitCompleted: jest.fn(),
      emitFailed: jest.fn(),
      emitSkipped: jest.fn(),
    } as unknown as EngineEventBus;
    const fetcher = {
      fetch: jest.fn(async (input: { campaignId: string }) => ({
        marker: input.campaignId,
      })),
    };
    const snapshotModel = { create: jest.fn().mockResolvedValue(undefined) };
    const builder = {
      build: jest.fn(({ bundle }: { bundle: { marker: string } }) => ({
        snapshotId: `snapshot-${bundle.marker}`,
        collectedAt: new Date('2026-08-23T00:00:00.000Z'),
        metrics: { campaignLevel: {} },
        meta: { accountId: 'act-test' },
        missingFields: [],
        freshnessSec: 0,
      })),
    };
    const validator = {
      validate: jest.fn(() => ({ valid: true })),
      confidence: jest.fn(() => 1),
    };
    const engine = new SnapshotEngine(
      sliceRepo,
      eventBus,
      {} as EngineRegistry,
      fetcher as never,
      snapshotModel as never,
      builder as never,
      validator as never,
    );

    const cycleA = engine.captureForCycle({
      cycleId: 'cycle-a',
      tenantId: 'tenant-a',
      campaignId: 'campaign-a',
      metaCampaignId: 'meta-a',
      products: [],
    });
    await cycleALoadStarted.promise;

    // Let cycle B finish while cycle A is suspended inside BaseEngine.
    // A singleton currentCycleId would now be overwritten (then cleared).
    await engine.captureForCycle({
      cycleId: 'cycle-b',
      tenantId: 'tenant-b',
      campaignId: 'campaign-b',
      metaCampaignId: 'meta-b',
      products: [],
    });
    releaseCycleA.resolve();
    await cycleA;

    expect(fetcher.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        campaignId: 'campaign-a',
        metaCampaignId: 'meta-a',
      }),
    );
    expect(fetcher.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-b',
        campaignId: 'campaign-b',
        metaCampaignId: 'meta-b',
      }),
    );
    expect(writes).toEqual(
      expect.arrayContaining([
        {
          cycleId: 'cycle-a',
          tenantId: 'tenant-a',
          campaignId: 'campaign-a',
          snapshotId: 'snapshot-campaign-a',
        },
        {
          cycleId: 'cycle-b',
          tenantId: 'tenant-b',
          campaignId: 'campaign-b',
          snapshotId: 'snapshot-campaign-b',
        },
      ]),
    );
  });
});
