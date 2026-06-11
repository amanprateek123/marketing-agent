import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MetaLearningImporterService } from '../campaigns/meta-ads/meta-learning-importer.service';
import { QUEUES } from './queue.constants';

// Meta learning import pulls a tenant's full Meta Ads history (campaigns,
// ad sets, ads, insights) + runs Claude pattern analysis. 5-30 minutes
// depending on tenant size. 91astrology with 449 campaigns trends toward
// upper end. Default 30s lockDuration would falsely flag the worker stalled.
@Processor(QUEUES.META_LEARNING_IMPORT, {
  lockDuration: 30 * 60 * 1000,    // 30 min
  lockRenewTime: 15 * 60 * 1000,
  stalledInterval: 15 * 60 * 1000,
})
export class MetaLearningProcessor extends WorkerHost {
  private readonly logger = new Logger(MetaLearningProcessor.name);

  constructor(
    private readonly metaLearningImporter: MetaLearningImporterService,
  ) {
    super();
  }

  async process(job: Job<{ tenantId: string; importId: string; batchIndex?: number }>): Promise<void> {
    const { tenantId, importId, batchIndex } = job.data;

    if (job.name.startsWith('enrich-batch-')) {
      this.logger.log(`Processing enrich batch ${batchIndex} for ${tenantId} (jobId=${job.id})`);
      await this.metaLearningImporter.processEnrichBatch(importId, batchIndex!);
    } else if (job.name.startsWith('finalize-')) {
      this.logger.log(`Processing finalize for ${tenantId} (jobId=${job.id})`);
      await this.metaLearningImporter.finalizeImport(importId);
    } else {
      this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }
}
