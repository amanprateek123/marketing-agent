import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CompaniesModule } from '../companies/companies.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { QUEUES } from './queue.constants';
import { SchedulerService } from './scheduler.service';
import { PipelineProcessor } from './pipeline.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.PIPELINE }),
    CompaniesModule,
    PipelineModule,
  ],
  providers: [SchedulerService, PipelineProcessor],
  exports: [SchedulerService],
})
export class SchedulerModule {}
