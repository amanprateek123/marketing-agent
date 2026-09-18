import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CompaniesService } from '../companies/companies.service';
import { MetaDeepSyncService } from '../campaigns/meta-ads/meta-deep-sync.service';
import { QUEUES } from './queue.constants';

// Deep sync re-fetches segment breakdowns (age/gender, region, placement,
// hourly, per-asset) plus daily timeseries for every active campaign/adset/ad
// — around a dozen chunked Meta insight calls per account with 3s politeness
// sleeps between each, same shape/cost profile as CampaignSyncProcessor.
// Recurring runs pass a short backfillDays window (see scheduler.service.ts's
// DEEP_SYNC_BACKFILL_DAYS) so this stays cheap and keeps segment/timeseries
// data moving in lockstep with the 10-min campaign/adset sync. The full
// 90-day backfill remains available via the manual POST
// /:tenantId/deep-sync endpoint for fresh tenant onboarding or backfilling
// after a data gap.
@Processor(QUEUES.META_DEEP_SYNC, {
  lockDuration: 15 * 60 * 1000, // 15 min — matches CampaignSyncProcessor
  lockRenewTime: 5 * 60 * 1000,
})
export class MetaDeepSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(MetaDeepSyncProcessor.name);

  constructor(
    private readonly companiesService: CompaniesService,
    private readonly metaDeepSync: MetaDeepSyncService,
  ) {
    super();
  }

  async process(job: Job<{ tenantId: string; backfillDays?: number }>): Promise<void> {
    const { tenantId, backfillDays } = job.data;
    this.logger.log(`Deep-syncing segments/timeseries for ${tenantId} (jobId=${job.id})`);

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company?.meta?.accessToken) {
      this.logger.warn(`No Meta credentials for ${tenantId} — skipping deep sync`);
      return;
    }

    try {
      const result = await this.metaDeepSync.deepSync(company, { backfillDays });
      this.logger.log(
        `Deep sync done for ${tenantId}: ${result.timeseriesRows} timeseries rows, ` +
          `${result.breakdownDocs} breakdown docs, ${result.campaigns} campaigns, ${result.errors.length} errors`,
      );
      if (result.errors.length > 0) {
        this.logger.warn(`Deep sync errors for ${tenantId}: ${result.errors.join('; ')}`);
      }
    } catch (err: any) {
      this.logger.error(`Deep sync failed for ${tenantId}: ${err.message}`);
    }
  }
}
