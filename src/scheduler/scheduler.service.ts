import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { CompaniesService } from '../companies/companies.service';
import { PipelineRun, PipelineRunDocument } from '../pipeline/schemas/pipeline-run.schema';
import { QUEUES } from './queue.constants';

const AUDIT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(QUEUES.PIPELINE) private readonly pipelineQueue: Queue,
    @InjectQueue(QUEUES.CAMPAIGN_AUDIT) private readonly auditQueue: Queue,
    private readonly companiesService: CompaniesService,
    @InjectModel(PipelineRun.name)
    private readonly pipelineRunModel: Model<PipelineRunDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.setupRecurringJobs();
  }

  async setupRecurringJobs(): Promise<void> {
    const companies = await this.companiesService.findAll();
    this.logger.log(`Setting up scheduled jobs for ${companies.length} tenant(s)`);

    for (const company of companies) {
      await this.scheduleForTenant(company.tenantId, new Date((company as any).createdAt), company.pipelineConfig);
      await this.scheduleAuditForTenant(company.tenantId);
    }
  }

  async scheduleAuditForTenant(tenantId: string): Promise<void> {
    // Remove existing repeatable audit job for this tenant before re-scheduling
    const existingJobs = await this.auditQueue.getRepeatableJobs();
    for (const job of existingJobs) {
      if (job.name === `audit-${tenantId}`) {
        await this.auditQueue.removeRepeatableByKey(job.key);
      }
    }

    await this.auditQueue.add(
      `audit-${tenantId}`,
      { tenantId },
      {
        repeat: { every: AUDIT_INTERVAL_MS },
        jobId: `audit-${tenantId}`,
      },
    );
    this.logger.log(`Scheduled campaign audit every 6h for tenantId=${tenantId}`);
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

    // Don't re-schedule if a run completed in the last 20 hours — prevents
    // BullMQ from immediately firing a missed job on server restart
    const recentRun = await this.pipelineRunModel.findOne({
      tenantId,
      status: 'completed',
      completedAt: { $gte: new Date(Date.now() - 20 * 60 * 60 * 1000) },
    }).lean().exec();

    if (recentRun) {
      this.logger.log(`Skipping immediate schedule for ${tenantId} — run completed recently`);
    }

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
