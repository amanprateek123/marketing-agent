import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CampaignAuditorService } from '../campaigns/campaign-auditor/campaign-auditor.service';
import { QUEUES } from './queue.constants';

// Audit cycle runs LLM analysis per active campaign × N campaigns. Each
// individual audit is 1-3 min (Meta fetches + signal detection + LLM verdict);
// tenant-wide cycle aggregates them. With 12+ active campaigns, total
// runtime can hit 15-20 min. Default 30s lockDuration is far too short.
@Processor(QUEUES.CAMPAIGN_AUDIT, {
  lockDuration: 20 * 60 * 1000,    // 20 min
  lockRenewTime: 10 * 60 * 1000,
  stalledInterval: 10 * 60 * 1000,
})
export class AuditProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditProcessor.name);

  constructor(private readonly auditorService: CampaignAuditorService) {
    super();
  }

  async process(job: Job<{ tenantId: string }>): Promise<void> {
    const { tenantId } = job.data;
    this.logger.log(`Processing campaign audit: tenantId=${tenantId} jobId=${job.id}`);
    await this.auditorService.audit(tenantId);
  }
}
