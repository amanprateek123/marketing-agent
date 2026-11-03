import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { CampaignsModule } from '../../../campaigns/campaigns.module';
import {
  Campaign,
  CampaignSchema,
} from '../../../campaigns/schemas/campaign.schema';
import { S3Service } from '../../../common/storage/s3.service';
import { CompaniesModule } from '../../../companies/companies.module';
import { PerformanceMarketeerModule } from '../../performance-marketeer.module';
import { pmEnv } from '../../pm.config';
import {
  PmLaunchPlan,
  PmLaunchPlanSchema,
} from '../../schemas/pm-launch-plan.schema';
import { PmLaunchController } from './launch.controller';
import { PmLaunchService } from './launch.service';

/**
 * Separate from PerformanceMarketeerModule: it needs the campaign launch code
 * (and its queues), which the Performance Marketeer CLIs don't load.
 */
@Module({
  imports: [
    ConfigModule.forFeature(pmEnv),
    MongooseModule.forFeature([
      { name: PmLaunchPlan.name, schema: PmLaunchPlanSchema },
      { name: Campaign.name, schema: CampaignSchema },
    ]),
    PerformanceMarketeerModule,
    CampaignsModule,
    CompaniesModule,
  ],
  controllers: [PmLaunchController],
  providers: [PmLaunchService, S3Service],
})
export class PmLaunchModule {}
