import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ShadowActionService } from '../learning/shadow-action.service';
import { ActionOutcomeService } from '../learning/action-outcome.service';
import { QUEUES } from './queue.constants';

// Each pending record costs a Meta fetchFullMetrics call (~1-3s). With up to
// 200 shadow + 200 executed records per run, worst case is well past the 30s
// BullMQ default lockDuration — same stalled-worker failure mode as
// creative-production. 15 min covers the worst case with headroom.
@Processor(QUEUES.SHADOW_EVAL, {
  lockDuration: 15 * 60 * 1000,    // 15 min
  lockRenewTime: 5 * 60 * 1000,
})
export class ShadowEvalProcessor extends WorkerHost {
  private readonly logger = new Logger(ShadowEvalProcessor.name);

  constructor(
    private readonly shadowActions: ShadowActionService,
    private readonly actionOutcomes: ActionOutcomeService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing action evaluation: jobId=${job.id}`);
    const shadow = await this.shadowActions.evaluatePending();
    this.logger.log(
      `Shadow eval done: 24h=${shadow.evaluated24h} 72h=${shadow.evaluated72h} finalized=${shadow.finalized}`,
    );
    // Executed-action outcomes ride the same daily job — same cadence, same
    // +24h/+72h windows, evaluated after shadows so a partial failure in one
    // doesn't starve the other.
    const executed = await this.actionOutcomes.evaluatePending();
    this.logger.log(
      `Executed-action eval done: 24h=${executed.evaluated24h} 72h=${executed.evaluated72h} finalized=${executed.finalized}`,
    );
  }
}
