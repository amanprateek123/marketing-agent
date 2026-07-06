import { Inject, Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { SnapshotEngine } from '../snapshot/snapshot-engine.service';
import {
  INTELLIGENCE_QUEUES,
  SnapshotJobPayload,
} from './intelligence-queue.constants';
import {
  TENANT_CAMPAIGNS_PROVIDER,
  TenantCampaignsProvider,
} from './tenant-campaigns.provider.interface';

/**
 * Fires every 15 minutes per tenant. For each active campaign, invokes
 * SnapshotEngine.capture() (no cycle seeded). Failures on a single
 * campaign do not abort the tenant sweep — they are logged, counted,
 * and returned in the job result for observability.
 */
@Injectable()
@Processor(INTELLIGENCE_QUEUES.SNAPSHOT)
export class SnapshotProcessor extends WorkerHost {
  private readonly logger = new Logger(SnapshotProcessor.name);

  constructor(
    private readonly engine: SnapshotEngine,
    @Inject(TENANT_CAMPAIGNS_PROVIDER)
    private readonly campaigns: TenantCampaignsProvider,
  ) {
    super();
  }

  async process(job: Job<SnapshotJobPayload>): Promise<{
    tenantId: string;
    attempted: number;
    succeeded: number;
    failed: number;
    errors: Array<{ campaignId: string; error: string }>;
  }> {
    return this.run(job.data);
  }

  /**
   * Exposed as a plain method so unit tests can drive it without a
   * live BullMQ + Redis instance.
   */
  async run(
    payload: SnapshotJobPayload,
  ): Promise<{
    tenantId: string;
    attempted: number;
    succeeded: number;
    failed: number;
    errors: Array<{ campaignId: string; error: string }>;
  }> {
    const targets = await this.campaigns.listActiveCampaigns(payload.tenantId);
    const errors: Array<{ campaignId: string; error: string }> = [];
    let succeeded = 0;
    for (const t of targets) {
      try {
        await this.engine.capture({
          tenantId: payload.tenantId,
          campaignId: t.campaignId,
          metaCampaignId: t.metaCampaignId,
          products: t.products,
        });
        succeeded += 1;
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
      succeeded,
      failed: errors.length,
      errors,
    };
    this.logger.log(
      `SNAPSHOT tenant=${payload.tenantId} attempted=${result.attempted} succeeded=${result.succeeded} failed=${result.failed}`,
    );
    return result;
  }
}
