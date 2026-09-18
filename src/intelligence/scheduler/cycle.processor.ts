import { Inject, Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { IntelligenceOrchestrator } from '../orchestrator/intelligence-orchestrator.service';
import { SnapshotEngine } from '../snapshot/snapshot-engine.service';
import {
  CycleJobPayload,
  INTELLIGENCE_QUEUES,
} from './intelligence-queue.constants';
import {
  TENANT_CAMPAIGNS_PROVIDER,
  TenantCampaignsProvider,
} from './tenant-campaigns.provider.interface';

/**
 * Fires every 1 hour per tenant. For each active campaign:
 *   1. Open a new cycle via IntelligenceOrchestrator.openCycle()
 *   2. Call SnapshotEngine.captureForCycle() — writes the snapshot
 *      slice to intelligence_engine_outputs and emits
 *      intelligence.snapshot.completed { cycleId }
 *   3. Downstream engines wake on that event and cascade naturally.
 *
 * The processor does NOT wait for the downstream cascade to finish —
 * engines complete asynchronously via the event bus. The orchestrator's
 * closeCycle() is called by Learning Engine (16) when it finishes, or
 * by a stuck-cycle sweeper (deferred to a follow-up PR).
 */
@Injectable()
@Processor(INTELLIGENCE_QUEUES.CYCLE)
export class CycleProcessor extends WorkerHost {
  private readonly logger = new Logger(CycleProcessor.name);

  constructor(
    private readonly orchestrator: IntelligenceOrchestrator,
    private readonly snapshotEngine: SnapshotEngine,
    @Inject(TENANT_CAMPAIGNS_PROVIDER)
    private readonly campaigns: TenantCampaignsProvider,
  ) {
    super();
  }

  async process(job: Job<CycleJobPayload>): Promise<{
    tenantId: string;
    attempted: number;
    opened: number;
    failed: number;
    errors: Array<{ campaignId: string; error: string }>;
  }> {
    return this.run(job.data);
  }

  /**
   * Exposed for unit tests. Drives the tenant sweep without BullMQ.
   */
  async run(payload: CycleJobPayload): Promise<{
    tenantId: string;
    attempted: number;
    opened: number;
    failed: number;
    errors: Array<{ campaignId: string; error: string }>;
  }> {
    const targets = await this.campaigns.listActiveCampaigns(payload.tenantId);
    const errors: Array<{ campaignId: string; error: string }> = [];
    let opened = 0;
    for (const t of targets) {
      try {
        const dc = await this.orchestrator.openCycle({
          tenantId: payload.tenantId,
          campaignId: t.campaignId,
          metaCampaignId: t.metaCampaignId,
        });
        await this.snapshotEngine.captureForCycle({
          cycleId: dc.cycleId,
          tenantId: payload.tenantId,
          campaignId: t.campaignId,
          metaCampaignId: t.metaCampaignId,
          products: t.products,
        });
        opened += 1;
      } catch (err) {
        errors.push({
          campaignId: t.campaignId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const result = {
      tenantId: payload.tenantId,
      attempted: targets.length,
      opened,
      failed: errors.length,
      errors,
    };
    this.logger.log(
      `CYCLE tenant=${payload.tenantId} attempted=${result.attempted} opened=${result.opened} failed=${result.failed}`,
    );
    return result;
  }
}
