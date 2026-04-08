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

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.PIPELINE }),
    BullModule.registerQueue({ name: QUEUES.CAMPAIGN_AUDIT }),
    BullModule.registerQueue({ name: QUEUES.MONTHLY_LEARNING }),
    BullModule.registerQueue({ name: QUEUES.META_LEARNING_IMPORT }),
    BullModule.registerQueue({ name: QUEUES.CAMPAIGN_SYNC }),
    MongooseModule.forFeature([{ name: PipelineRun.name, schema: PipelineRunSchema }]),
    forwardRef(() => CompaniesModule),
    PipelineModule,
    CampaignsModule,
    LearningModule,
  ],
  providers: [SchedulerService, PipelineProcessor, AuditProcessor, LearningProcessor, MetaLearningProcessor, CampaignSyncProcessor],
  exports: [SchedulerService],
})
export class SchedulerModule {}
