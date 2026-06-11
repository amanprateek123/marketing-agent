import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CompaniesService } from '../companies/companies.service';
import { CampaignSyncService } from '../campaigns/meta-ads/campaign-sync.service';
import { QUEUES } from './queue.constants';

// Bulk sync over a 449-campaign account is 6 chunked+paginated Meta fetch
// rounds with 3-5s politeness delays between them — real runtime is 3-8 min.
// At lockDuration=120s BullMQ declared the worker stalled mid-sync (same
// failure mode as creative-production pre-fix). 15 min covers worst case.
@Processor(QUEUES.CAMPAIGN_SYNC, {
  lockDuration: 15 * 60 * 1000,    // 15 min
  lockRenewTime: 5 * 60 * 1000,
})
export class CampaignSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignSyncProcessor.name);

  constructor(
    private readonly companiesService: CompaniesService,
    private readonly campaignSync: CampaignSyncService,
  ) {
    super();
  }

  async process(job: Job<{ tenantId: string }>): Promise<void> {
    const { tenantId } = job.data;
    this.logger.log(`Syncing active campaigns for ${tenantId} (jobId=${job.id})`);

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company.meta?.accessToken) {
      this.logger.warn(`No Meta credentials for ${tenantId} — skipping sync`);
      return;
    }

    const result = await this.campaignSync.syncActiveCampaigns(company);
    this.logger.log(`Campaign sync done: ${result.synced} campaigns synced for ${tenantId}`);
  }
}
