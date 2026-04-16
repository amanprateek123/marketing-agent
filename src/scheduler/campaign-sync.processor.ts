import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CompaniesService } from '../companies/companies.service';
import { CampaignSyncService } from '../campaigns/meta-ads/campaign-sync.service';
import { QUEUES } from './queue.constants';

@Processor(QUEUES.CAMPAIGN_SYNC, { lockDuration: 120000 })
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
