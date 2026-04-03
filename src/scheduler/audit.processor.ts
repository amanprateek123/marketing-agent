import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CampaignAuditorService } from '../campaigns/campaign-auditor/campaign-auditor.service';
import { QUEUES } from './queue.constants';

@Processor(QUEUES.CAMPAIGN_AUDIT)
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
