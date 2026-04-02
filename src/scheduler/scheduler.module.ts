import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { CompaniesModule } from '../companies/companies.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { PipelineRun, PipelineRunSchema } from '../pipeline/schemas/pipeline-run.schema';
import { QUEUES } from './queue.constants';
import { SchedulerService } from './scheduler.service';
import { PipelineProcessor } from './pipeline.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.PIPELINE }),
    MongooseModule.forFeature([{ name: PipelineRun.name, schema: PipelineRunSchema }]),
    CompaniesModule,
    PipelineModule,
  ],
  providers: [SchedulerService, PipelineProcessor],
  exports: [SchedulerService],
})
export class SchedulerModule {}
