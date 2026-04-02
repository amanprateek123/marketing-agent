import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PipelineOrchestratorService } from '../pipeline/pipeline-orchestrator.service';
import { QUEUES } from './queue.constants';

@Processor(QUEUES.PIPELINE)
export class PipelineProcessor extends WorkerHost {
  private readonly logger = new Logger(PipelineProcessor.name);

  constructor(private readonly orchestrator: PipelineOrchestratorService) {
    super();
  }

  async process(job: Job<{ tenantId: string }>): Promise<void> {
    const { tenantId } = job.data;
    this.logger.log(`Processing scheduled pipeline: tenantId=${tenantId} jobId=${job.id}`);
    await this.orchestrator.trigger(tenantId);
  }
}
