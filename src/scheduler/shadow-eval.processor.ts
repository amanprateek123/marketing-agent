import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ShadowActionService } from '../learning/shadow-action.service';
import { QUEUES } from './queue.constants';

@Processor(QUEUES.SHADOW_EVAL)
export class ShadowEvalProcessor extends WorkerHost {
  private readonly logger = new Logger(ShadowEvalProcessor.name);

  constructor(private readonly shadowActions: ShadowActionService) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing shadow-action evaluation: jobId=${job.id}`);
    const result = await this.shadowActions.evaluatePending();
    this.logger.log(
      `Shadow eval done: 24h=${result.evaluated24h} 72h=${result.evaluated72h} finalized=${result.finalized}`,
    );
  }
}
