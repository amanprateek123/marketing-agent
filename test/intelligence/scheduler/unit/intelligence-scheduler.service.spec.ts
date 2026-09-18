import { IntelligenceSchedulerService } from '../../../../src/intelligence/scheduler/intelligence-scheduler.service';
import { INTELLIGENCE_CADENCE_MS } from '../../../../src/intelligence/scheduler/intelligence-queue.constants';

type MockedQueue = {
  add: jest.Mock;
  removeRepeatable: jest.Mock;
  getRepeatableJobs: jest.Mock;
};

function makeQueue(): MockedQueue {
  return {
    add: jest.fn().mockResolvedValue(undefined),
    removeRepeatable: jest.fn().mockResolvedValue(undefined),
    getRepeatableJobs: jest.fn().mockResolvedValue([]),
  };
}

describe('IntelligenceSchedulerService', () => {
  let snapshotQueue: MockedQueue;
  let cycleQueue: MockedQueue;
  let service: IntelligenceSchedulerService;

  beforeEach(() => {
    snapshotQueue = makeQueue();
    cycleQueue = makeQueue();
    service = new IntelligenceSchedulerService(
      snapshotQueue as unknown as import('bullmq').Queue,
      cycleQueue as unknown as import('bullmq').Queue,
    );
  });

  describe('enrollTenant', () => {
    it('adds a repeatable job on the snapshot queue with 15-min cadence', async () => {
      await service.enrollTenant('astro');
      expect(snapshotQueue.add).toHaveBeenCalledWith(
        'snapshot:tenant:astro',
        { tenantId: 'astro' },
        expect.objectContaining({
          repeat: { every: INTELLIGENCE_CADENCE_MS.SNAPSHOT },
        }),
      );
    });

    it('adds a repeatable job on the cycle queue with 1-hour cadence', async () => {
      await service.enrollTenant('astro');
      expect(cycleQueue.add).toHaveBeenCalledWith(
        'cycle:tenant:astro',
        { tenantId: 'astro' },
        expect.objectContaining({
          repeat: { every: INTELLIGENCE_CADENCE_MS.CYCLE },
        }),
      );
    });

    it('is idempotent — re-enrolling the same tenant does not throw', async () => {
      await service.enrollTenant('astro');
      await expect(service.enrollTenant('astro')).resolves.not.toThrow();
      expect(snapshotQueue.add).toHaveBeenCalledTimes(2);
      expect(cycleQueue.add).toHaveBeenCalledTimes(2);
    });
  });

  describe('unenrollTenant', () => {
    it('removes repeatable jobs from both queues', async () => {
      await service.unenrollTenant('astro');
      expect(snapshotQueue.removeRepeatable).toHaveBeenCalledWith(
        'snapshot:tenant:astro',
        { every: INTELLIGENCE_CADENCE_MS.SNAPSHOT },
      );
      expect(cycleQueue.removeRepeatable).toHaveBeenCalledWith(
        'cycle:tenant:astro',
        { every: INTELLIGENCE_CADENCE_MS.CYCLE },
      );
    });
  });

  describe('triggerNow', () => {
    it('fires a one-shot snapshot job', async () => {
      await service.triggerNow('snapshot', 'astro');
      expect(snapshotQueue.add).toHaveBeenCalledWith(
        'snapshot:once:astro',
        { tenantId: 'astro' },
        expect.not.objectContaining({ repeat: expect.anything() }),
      );
    });

    it('fires a one-shot cycle job', async () => {
      await service.triggerNow('cycle', 'astro');
      expect(cycleQueue.add).toHaveBeenCalledWith(
        'cycle:once:astro',
        { tenantId: 'astro' },
        expect.not.objectContaining({ repeat: expect.anything() }),
      );
    });
  });

  describe('listEnrolled', () => {
    it('returns tenant IDs stripped from job names', async () => {
      snapshotQueue.getRepeatableJobs.mockResolvedValue([
        { name: 'snapshot:tenant:astro' },
        { name: 'snapshot:tenant:cosmo' },
        { name: 'other:tenant:noise' },
        { name: 'snapshot:once:xxx' },
      ]);
      const enrolled = await service.listEnrolled('snapshot');
      expect(enrolled).toEqual(['astro', 'cosmo']);
    });

    it('returns [] when no repeatables', async () => {
      snapshotQueue.getRepeatableJobs.mockResolvedValue([]);
      expect(await service.listEnrolled('snapshot')).toEqual([]);
    });

    it('routes to the correct queue', async () => {
      cycleQueue.getRepeatableJobs.mockResolvedValue([{ name: 'cycle:tenant:x' }]);
      const enrolled = await service.listEnrolled('cycle');
      expect(enrolled).toEqual(['x']);
      expect(snapshotQueue.getRepeatableJobs).not.toHaveBeenCalled();
    });
  });
});
