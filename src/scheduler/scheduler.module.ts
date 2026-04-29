import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { CompaniesModule } from '../companies/companies.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { LearningModule } from '../learning/learning.module';
import { PipelineRun, PipelineRunSchema } from '../pipeline/schemas/pipeline-run.schema';
import { QUEUES } from './queue.constants';
import { SchedulerService } from './scheduler.service';
import { PipelineProcessor } from './pipeline.processor';
import { AuditProcessor } from './audit.processor';
import { LearningProcessor } from './learning.processor';
import { MetaLearningProcessor } from './meta-learning.processor';
import { CampaignSyncProcessor } from './campaign-sync.processor';
import { CreativeReplacementProcessor } from './creative-replacement.processor';
import { ShadowEvalProcessor } from './shadow-eval.processor';
import { CreativeModule } from '../creative/creative.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { Campaign, CampaignSchema } from '../campaigns/schemas/campaign.schema';
import { IntelligenceBrief, IntelligenceBriefSchema } from '../pipeline/schemas/intelligence-brief.schema';

@Module({
  imports: [
    BullModule.registerQueue({
      name: QUEUES.PIPELINE,
      // Pipeline DAG is now awaited inside the processor (see pipeline.processor.ts).
      // attempts=2 covers transient Claude SDK / Mongo / Meta API hiccups; the
      // DAG itself is mostly idempotent across resume (each phase findOne-gates
      // on runId before re-executing). exponential backoff to avoid retry storms.
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    }),
    BullModule.registerQueue({ name: QUEUES.CAMPAIGN_AUDIT }),
    BullModule.registerQueue({ name: QUEUES.MONTHLY_LEARNING }),
    BullModule.registerQueue({ name: QUEUES.META_LEARNING_IMPORT }),
    BullModule.registerQueue({ name: QUEUES.CAMPAIGN_SYNC }),
    BullModule.registerQueue({ name: QUEUES.CREATIVE_PRODUCTION }),
    BullModule.registerQueue({ name: QUEUES.SHADOW_EVAL }),
    MongooseModule.forFeature([
      { name: PipelineRun.name, schema: PipelineRunSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
    ]),
    forwardRef(() => CompaniesModule),
    PipelineModule,
    CampaignsModule,
    CreativeModule,
    LearningModule,
    DeliveryModule,
  ],
  providers: [SchedulerService, PipelineProcessor, AuditProcessor, LearningProcessor, MetaLearningProcessor, CampaignSyncProcessor, CreativeReplacementProcessor, ShadowEvalProcessor],
  exports: [SchedulerService],
})
export class SchedulerModule {}
