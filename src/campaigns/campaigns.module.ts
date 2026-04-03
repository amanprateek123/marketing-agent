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

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
    ]),
    ClaudeModule,
    CompaniesModule,
    CommonModule,
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignCreatorService, CampaignAuditorService, CampaignOptimizerService],
  exports: [CampaignsService, CampaignCreatorService, CampaignAuditorService],
})
export class CampaignsModule {}
