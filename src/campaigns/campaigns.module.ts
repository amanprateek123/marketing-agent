import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Campaign, CampaignSchema } from './schemas/campaign.schema';
import { IntelligenceBrief, IntelligenceBriefSchema } from '../pipeline/schemas/intelligence-brief.schema';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { CampaignCreatorService } from './campaign-creator/campaign-creator.service';
import { CampaignAuditorService } from './campaign-auditor/campaign-auditor.service';
import { CampaignOptimizerService } from './campaign-auditor/campaign-optimizer.service';
import { ClaudeModule } from '../claude/claude.module';
import { CompaniesModule } from '../companies/companies.module';
import { CommonModule } from '../common/common.module';
import { LearningModule } from '../learning/learning.module';
import { UsageLog, UsageLogSchema } from '../claude/schemas/usage-log.schema';
import { CampaignReviewTeamService } from '../teams/campaign-review-team.service';
import { DeliveryModule } from '../delivery/delivery.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
      { name: UsageLog.name, schema: UsageLogSchema },
    ]),
    ClaudeModule,
    CompaniesModule,
    CommonModule,
    LearningModule,
    DeliveryModule,
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignCreatorService, CampaignAuditorService, CampaignOptimizerService, CampaignReviewTeamService],
  exports: [CampaignsService, CampaignCreatorService, CampaignAuditorService],
})
export class CampaignsModule {}
