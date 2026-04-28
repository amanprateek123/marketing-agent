import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LearningRun, LearningRunSchema } from './schemas/learning-run.schema';
import { ShadowAction, ShadowActionSchema } from './schemas/shadow-action.schema';
import { IntelligenceBrief, IntelligenceBriefSchema } from '../pipeline/schemas/intelligence-brief.schema';
import { Campaign, CampaignSchema } from '../campaigns/schemas/campaign.schema';
import { CreativePackage, CreativePackageSchema } from '../creative/schemas/creative-package.schema';
import { CreativeLearningService } from './creative-learning.service';
import { CampaignLearningService } from './campaign-learning.service';
import { ShadowActionService } from './shadow-action.service';
import { ClaudeModule } from '../claude/claude.module';
import { CompaniesModule } from '../companies/companies.module';
import { CommonModule } from '../common/common.module';
import { MetaMetricsService } from '../campaigns/meta-ads/meta-metrics.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LearningRun.name, schema: LearningRunSchema },
      { name: ShadowAction.name, schema: ShadowActionSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: CreativePackage.name, schema: CreativePackageSchema },
    ]),
    ClaudeModule,
    forwardRef(() => CompaniesModule),
    CommonModule,
  ],
  providers: [CreativeLearningService, CampaignLearningService, ShadowActionService, MetaMetricsService],
  exports: [CreativeLearningService, CampaignLearningService, ShadowActionService],
})
export class LearningModule {}
