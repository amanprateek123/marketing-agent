import { Module, forwardRef } from '@nestjs/common';
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
import { MetaAdsService } from './meta-ads/meta-ads.service';
import { MetaMetricsService } from './meta-ads/meta-metrics.service';
import { MetaLearningImporterService } from './meta-ads/meta-learning-importer.service';
import { PatternCalculatorService } from './meta-ads/pattern-calculator.service';
import { CampaignCaseStudy, CampaignCaseStudySchema } from './schemas/campaign-case-study.schema';
import { DeliveryModule } from '../delivery/delivery.module';
import { CreativePackage, CreativePackageSchema } from '../creative/schemas/creative-package.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
      { name: UsageLog.name, schema: UsageLogSchema },
      { name: CreativePackage.name, schema: CreativePackageSchema },
      { name: CampaignCaseStudy.name, schema: CampaignCaseStudySchema },
    ]),
    ClaudeModule,
    forwardRef(() => CompaniesModule),
    CommonModule,
    LearningModule,
    DeliveryModule,
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignCreatorService, CampaignAuditorService, CampaignOptimizerService, CampaignReviewTeamService, MetaAdsService, MetaMetricsService, MetaLearningImporterService, PatternCalculatorService],
  exports: [CampaignsService, CampaignCreatorService, CampaignAuditorService, MetaLearningImporterService],
})
export class CampaignsModule {}
