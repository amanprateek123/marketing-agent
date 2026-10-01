import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { Company, CompanySchema } from './schemas/company.schema';
import { UsageLog, UsageLogSchema } from '../claude/schemas/usage-log.schema';
import { ClaudeModule } from '../claude/claude.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { CommonModule } from '../common/common.module';
import { PromptGeneratorService } from './prompt-generator/prompt-generator.service';
import { LiveContextBuilder } from './prompt-generator/live-context.builder';
import { ProductSyncService } from './product-sync.service';
import { PipelineBridgeModule } from '../pipeline-bridge/pipeline-bridge.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Company.name, schema: CompanySchema },
      // Read-only access for the /usage aggregation endpoint
      { name: UsageLog.name, schema: UsageLogSchema },
    ]),
    ClaudeModule,
    CommonModule,
    forwardRef(() => CampaignsModule),
    forwardRef(() => SchedulerModule),
    PipelineBridgeModule,
  ],
  controllers: [CompaniesController],
  providers: [CompaniesService, PromptGeneratorService, LiveContextBuilder, ProductSyncService],
  exports: [CompaniesService, LiveContextBuilder, PromptGeneratorService, ProductSyncService],
})
export class CompaniesModule {}
