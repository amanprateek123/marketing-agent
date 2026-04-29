import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, forwardRef } from '@nestjs/common';
import { Job } from 'bullmq';
import { PipelineOrchestratorService } from '../pipeline/pipeline-orchestrator.service';
import { SchedulerService } from './scheduler.service';
import { CompaniesService } from '../companies/companies.service';
import { QUEUES } from './queue.constants';

@Processor(QUEUES.PIPELINE)
export class PipelineProcessor extends WorkerHost {
  private readonly logger = new Logger(PipelineProcessor.name);

  constructor(
    private readonly orchestrator: PipelineOrchestratorService,
    @Inject(forwardRef(() => SchedulerService))
    private readonly schedulerService: SchedulerService,
    private readonly companiesService: CompaniesService,
  ) {
    super();
  }

  async process(job: Job<{ tenantId: string; action?: string }>): Promise<void> {
    const { tenantId, action } = job.data;

    // Handle schedule switch job (daily → weekly after cold start)
    if (action === 'switch_to_weekly') {
      this.logger.log(`Switching pipeline schedule to weekly: tenantId=${tenantId}`);
      const company = await this.companiesService.findByTenantId(tenantId);
      await this.schedulerService.scheduleForTenant(
        tenantId,
        new Date((company as any).createdAt),
        company.pipelineConfig,
      );
      return;
    }

    this.logger.log(`Processing scheduled pipeline: tenantId=${tenantId} jobId=${job.id}`);
    // Run the full pipeline DAG synchronously inside the BullMQ job. Was: await
    // trigger() which returned immediately after firing executeDAG in background
    // → BullMQ marked the job complete the moment runId was created, retries
    // were impossible (job was already "done"), and a worker crash mid-DAG
    // produced an orphan run that only the OnModuleInit recovery could clean.
    // Now: throw on DAG failure → BullMQ retries per attempts config.
    await this.orchestrator.runForJob(tenantId);
  }
}
