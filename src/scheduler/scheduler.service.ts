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
    @InjectQueue(QUEUES.MONTHLY_LEARNING) private readonly learningQueue: Queue,
    @InjectQueue(QUEUES.CAMPAIGN_SYNC) private readonly campaignSyncQueue: Queue,
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
      await this.scheduleLearningForTenant(company.tenantId);
      await this.scheduleCampaignSyncForTenant(company.tenantId);
    }
  }

  async scheduleLearningForTenant(tenantId: string): Promise<void> {
    // Remove existing repeatable learning job before re-scheduling
    const existingJobs = await this.learningQueue.getRepeatableJobs();
    for (const job of existingJobs) {
      if (job.name === `learning-${tenantId}`) {
        await this.learningQueue.removeRepeatableByKey(job.key);
      }
    }

    // 1st of every month at 3 AM IST
    await this.learningQueue.add(
      `learning-${tenantId}`,
      { tenantId },
      {
        repeat: { pattern: '0 3 1 * *', tz: 'Asia/Kolkata' },
        jobId: `learning-${tenantId}`,
      },
    );
    this.logger.log(`Scheduled monthly learning for tenantId=${tenantId} (1st of month, 3 AM IST)`);
  }

  async scheduleCampaignSyncForTenant(tenantId: string): Promise<void> {
    const existingJobs = await this.campaignSyncQueue.getRepeatableJobs();
    for (const job of existingJobs) {
      if (job.name === `campaign-sync-${tenantId}`) {
        await this.campaignSyncQueue.removeRepeatableByKey(job.key);
      }
    }

    await this.campaignSyncQueue.add(
      `campaign-sync-${tenantId}`,
      { tenantId },
      {
        repeat: { every: AUDIT_INTERVAL_MS }, // every 6 hours
        jobId: `campaign-sync-${tenantId}`,
      },
    );
    this.logger.log(`Scheduled campaign sync every 6h for tenantId=${tenantId}`);
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
    const mode = pipelineConfig?.mode ?? 'daily';
    const coldStartDays = pipelineConfig?.coldStartDays ?? 14;
    const autoSwitch = pipelineConfig?.autoSwitch ?? true;
    const ageInDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

    // Determine schedule: explicit mode overrides auto-switch logic
    let useDaily: boolean;
    if (!autoSwitch) {
      // Manual mode — respect the explicit setting
      useDaily = mode === 'daily';
    } else {
      // Auto-switch: daily during cold start, weekly after
      useDaily = ageInDays < coldStartDays;
    }

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

    // Remove any existing repeatable + switch jobs for this tenant before re-scheduling
    const existingJobs = await this.pipelineQueue.getRepeatableJobs();
    for (const job of existingJobs) {
      if (job.name === `pipeline-${tenantId}`) {
        await this.pipelineQueue.removeRepeatableByKey(job.key);
      }
    }

    if (useDaily) {
      // Daily at 9 AM IST
      await this.pipelineQueue.add(
        `pipeline-${tenantId}`,
        { tenantId },
        {
          repeat: { pattern: '0 9 * * *', tz: 'Asia/Kolkata' },
          jobId: `pipeline-daily-${tenantId}`,
        },
      );
      this.logger.log(`Scheduled DAILY pipeline for ${tenantId}`);

      // If auto-switch is on, schedule a one-shot job to switch to weekly when cold start ends
      if (autoSwitch && ageInDays < coldStartDays) {
        const remainingMs = Math.max(0, (coldStartDays - ageInDays) * 24 * 60 * 60 * 1000);
        await this.pipelineQueue.add(
          `pipeline-switch-${tenantId}`,
          { tenantId, action: 'switch_to_weekly' },
          {
            delay: remainingMs,
            jobId: `pipeline-switch-${tenantId}`,
            removeOnComplete: true,
          },
        );
        this.logger.log(`Scheduled daily→weekly switch for ${tenantId} in ${Math.round(remainingMs / (24 * 60 * 60 * 1000))}d`);
      }
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
