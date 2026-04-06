import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LearningRun, LearningRunSchema } from './schemas/learning-run.schema';
import { IntelligenceBrief, IntelligenceBriefSchema } from '../pipeline/schemas/intelligence-brief.schema';
import { Campaign, CampaignSchema } from '../campaigns/schemas/campaign.schema';
import { CreativePackage, CreativePackageSchema } from '../creative/schemas/creative-package.schema';
import { CreativeLearningService } from './creative-learning.service';
import { CampaignLearningService } from './campaign-learning.service';
import { ClaudeModule } from '../claude/claude.module';
import { CompaniesModule } from '../companies/companies.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LearningRun.name, schema: LearningRunSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: CreativePackage.name, schema: CreativePackageSchema },
    ]),
    ClaudeModule,
    forwardRef(() => CompaniesModule),
    CommonModule,
  ],
  providers: [CreativeLearningService, CampaignLearningService],
  exports: [CreativeLearningService, CampaignLearningService],
})
export class LearningModule {}
