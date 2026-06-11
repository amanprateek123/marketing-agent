import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LearningRun, LearningRunSchema } from './schemas/learning-run.schema';
import { ShadowAction, ShadowActionSchema } from './schemas/shadow-action.schema';
import { ExecutedAction, ExecutedActionSchema } from './schemas/executed-action.schema';
import { IntelligenceBrief, IntelligenceBriefSchema } from '../pipeline/schemas/intelligence-brief.schema';
import { Campaign, CampaignSchema } from '../campaigns/schemas/campaign.schema';
import { CreativePackage, CreativePackageSchema } from '../creative/schemas/creative-package.schema';
import { CreativeLearningService } from './creative-learning.service';
import { CampaignLearningService } from './campaign-learning.service';
import { ShadowActionService } from './shadow-action.service';
import { ActionOutcomeService } from './action-outcome.service';
import { PromptVersionEvalService } from './prompt-version-eval.service';
import { PromptVersionEval, PromptVersionEvalSchema } from './schemas/prompt-version-eval.schema';
import { DeliveryModule } from '../delivery/delivery.module';
import { ClaudeModule } from '../claude/claude.module';
import { CompaniesModule } from '../companies/companies.module';
import { CommonModule } from '../common/common.module';
import { MetaMetricsService } from '../campaigns/meta-ads/meta-metrics.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LearningRun.name, schema: LearningRunSchema },
      { name: ShadowAction.name, schema: ShadowActionSchema },
      { name: ExecutedAction.name, schema: ExecutedActionSchema },
      { name: PromptVersionEval.name, schema: PromptVersionEvalSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: CreativePackage.name, schema: CreativePackageSchema },
    ]),
    ClaudeModule,
    forwardRef(() => CompaniesModule),
    CommonModule,
    DeliveryModule,
  ],
  providers: [CreativeLearningService, CampaignLearningService, ShadowActionService, ActionOutcomeService, PromptVersionEvalService, MetaMetricsService],
  exports: [CreativeLearningService, CampaignLearningService, ShadowActionService, ActionOutcomeService, PromptVersionEvalService],
})
export class LearningModule {}
