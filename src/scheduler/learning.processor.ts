import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CreativeLearningService } from '../learning/creative-learning.service';
import { CampaignLearningService } from '../learning/campaign-learning.service';
import { QUEUES } from './queue.constants';

@Processor(QUEUES.MONTHLY_LEARNING)
export class LearningProcessor extends WorkerHost {
  private readonly logger = new Logger(LearningProcessor.name);

  constructor(
    private readonly creativeLearning: CreativeLearningService,
    private readonly campaignLearning: CampaignLearningService,
  ) {
    super();
  }

  async process(job: Job<{ tenantId: string }>): Promise<void> {
    const { tenantId } = job.data;
    this.logger.log(`Processing monthly learning: tenantId=${tenantId} jobId=${job.id}`);

    // Run both scans — creative quick scan first, then full campaign deep run
    await this.creativeLearning.runQuickScan(tenantId);
    await this.campaignLearning.runDeepRun(tenantId);
  }
}
