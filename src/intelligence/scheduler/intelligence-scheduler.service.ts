import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  CycleJobPayload,
  INTELLIGENCE_CADENCE_MS,
  INTELLIGENCE_QUEUES,
  SnapshotJobPayload,
  tenantJobName,
} from './intelligence-queue.constants';

/**
 * Registers per-tenant repeatable jobs on the two intelligence queues.
 *
 * Called by:
 *   - CompaniesController on tenant creation (add-in later PR)
 *   - Backfill script for existing tenants (one-time)
 *   - Feature-flag toggle handler when `intelligenceV2.snapshotEnabled`
 *     goes true
 */
@Injectable()
export class IntelligenceSchedulerService {
  private readonly logger = new Logger(IntelligenceSchedulerService.name);

  constructor(
    @InjectQueue(INTELLIGENCE_QUEUES.SNAPSHOT)
    private readonly snapshotQueue: Queue<SnapshotJobPayload>,
    @InjectQueue(INTELLIGENCE_QUEUES.CYCLE)
    private readonly cycleQueue: Queue<CycleJobPayload>,
  ) {}

  /**
   * Idempotently enrolls a tenant on both queues. Safe to call
   * multiple times — BullMQ deduplicates repeatable jobs by
   * {jobName, every} key.
   */
  async enrollTenant(tenantId: string): Promise<void> {
    await this.snapshotQueue.add(
      tenantJobName('snapshot', tenantId),
      { tenantId },
      {
        repeat: { every: INTELLIGENCE_CADENCE_MS.SNAPSHOT },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    await this.cycleQueue.add(
      tenantJobName('cycle', tenantId),
      { tenantId },
      {
        repeat: { every: INTELLIGENCE_CADENCE_MS.CYCLE },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    this.logger.log(`enrolled tenant ${tenantId} on SNAPSHOT + CYCLE queues`);
  }

  /**
   * Removes both repeatable jobs for a tenant. Called on feature-flag
   * off, tenant deactivation, or manual rollback.
   */
  async unenrollTenant(tenantId: string): Promise<void> {
    await this.removeRepeatable(this.snapshotQueue, 'snapshot', tenantId, INTELLIGENCE_CADENCE_MS.SNAPSHOT);
    await this.removeRepeatable(this.cycleQueue, 'cycle', tenantId, INTELLIGENCE_CADENCE_MS.CYCLE);
    this.logger.log(`unenrolled tenant ${tenantId}`);
  }

  /**
   * Fires a one-shot job on each queue for immediate execution — used
   * by the /run-cycle and /snapshot on-demand endpoints.
   */
  async triggerNow(kind: 'snapshot' | 'cycle', tenantId: string): Promise<void> {
    const queue = kind === 'snapshot' ? this.snapshotQueue : this.cycleQueue;
    await queue.add(`${kind}:once:${tenantId}`, { tenantId }, { removeOnComplete: 10 });
  }

  /**
   * Lists tenants currently enrolled on a queue. Uses BullMQ's
   * repeatable-job registry.
   */
  async listEnrolled(kind: 'snapshot' | 'cycle'): Promise<string[]> {
    const queue = kind === 'snapshot' ? this.snapshotQueue : this.cycleQueue;
    const repeatables = await queue.getRepeatableJobs();
    const prefix = `${kind}:tenant:`;
    return repeatables
      .map((r) => r.name)
      .filter((n): n is string => typeof n === 'string' && n.startsWith(prefix))
      .map((n) => n.substring(prefix.length));
  }

  private async removeRepeatable(
    queue: Queue,
    kind: string,
    tenantId: string,
    every: number,
  ): Promise<void> {
    await queue.removeRepeatable(
      tenantJobName(kind, tenantId),
      { every },
    );
  }
}
