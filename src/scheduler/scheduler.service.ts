import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CompaniesService } from '../companies/companies.service';
import { QUEUES } from './queue.constants';

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(QUEUES.PIPELINE) private readonly pipelineQueue: Queue,
    private readonly companiesService: CompaniesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.setupRecurringJobs();
  }

  async setupRecurringJobs(): Promise<void> {
    const companies = await this.companiesService.findAll();
    this.logger.log(`Setting up scheduled pipeline jobs for ${companies.length} tenant(s)`);

    for (const company of companies) {
      await this.scheduleForTenant(company.tenantId, new Date((company as any).createdAt), company.pipelineConfig);
    }
  }

  async scheduleForTenant(
    tenantId: string,
    createdAt: Date,
    pipelineConfig?: { mode: string; coldStartDays: number; autoSwitch: boolean },
  ): Promise<void> {
    const coldStartDays = pipelineConfig?.coldStartDays ?? 14;
    const autoSwitch = pipelineConfig?.autoSwitch ?? true;
    const ageInDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const isInColdStart = autoSwitch && ageInDays < coldStartDays;

    // Remove any existing repeatable jobs for this tenant before re-scheduling
    const existingJobs = await this.pipelineQueue.getRepeatableJobs();
    for (const job of existingJobs) {
      if (job.name === `pipeline-${tenantId}`) {
        await this.pipelineQueue.removeRepeatableByKey(job.key);
      }
    }

    if (isInColdStart) {
      // Daily at 9 AM IST during cold start
      await this.pipelineQueue.add(
        `pipeline-${tenantId}`,
        { tenantId },
        {
          repeat: { pattern: '0 9 * * *', tz: 'Asia/Kolkata' },
          jobId: `pipeline-daily-${tenantId}`,
        },
      );
      this.logger.log(`Scheduled DAILY pipeline for ${tenantId} (cold start — ${Math.round(coldStartDays - ageInDays)}d remaining)`);
    } else {
      // Weekly on Monday at 9 AM IST
      await this.pipelineQueue.add(
        `pipeline-${tenantId}`,
        { tenantId },
        {
          repeat: { pattern: '0 9 * * 1', tz: 'Asia/Kolkata' },
          jobId: `pipeline-weekly-${tenantId}`,
        },
      );
      this.logger.log(`Scheduled WEEKLY pipeline for ${tenantId} (Monday 9 AM IST)`);
    }
  }
}
