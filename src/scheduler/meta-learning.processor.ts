import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MetaLearningImporterService } from '../campaigns/meta-ads/meta-learning-importer.service';
import { QUEUES } from './queue.constants';

@Processor(QUEUES.META_LEARNING_IMPORT)
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
