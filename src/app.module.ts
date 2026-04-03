import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { ClaudeModule } from './claude/claude.module';
import { CompaniesModule } from './companies/companies.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { CommonModule } from './common/common.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { CreativeModule } from './creative/creative.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { LearningModule } from './learning/learning.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.get<string>('redis.url') },
      }),
    }),
    DatabaseModule,
    ClaudeModule,
    CompaniesModule,
    PipelineModule,
    CommonModule,
    SchedulerModule,
    CreativeModule,
    CampaignsModule,
    LearningModule,
  ],
})
export class AppModule {}
