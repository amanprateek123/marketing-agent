import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaudeModule } from '../claude/claude.module';
import { CompaniesModule } from '../companies/companies.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { CommonModule } from '../common/common.module';
import { CreativeModule } from '../creative/creative.module';
import { Campaign, CampaignSchema } from '../campaigns/schemas/campaign.schema';
import {
  CreativeBrief,
  CreativeBriefSchema,
} from '../pipeline/schemas/creative-brief.schema';
import {
  PipelineRun,
  PipelineRunSchema,
} from '../pipeline/schemas/pipeline-run.schema';
import { CAMPAIGN_COPILOT_BUILD } from './campaign-copilot.contracts';
import { CampaignCopilotController } from './campaign-copilot.controller';
import { CampaignCopilotProcessor } from './campaign-copilot.processor';
import { CampaignCopilotService } from './campaign-copilot.service';
import { CampaignInsightsService } from './campaign-insights.service';
import {
  CampaignCopilotSession,
  CampaignCopilotSessionSchema,
} from './schemas/campaign-copilot-session.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: CampaignCopilotSession.name,
        schema: CampaignCopilotSessionSchema,
      },
      { name: CreativeBrief.name, schema: CreativeBriefSchema },
      { name: PipelineRun.name, schema: PipelineRunSchema },
      { name: Campaign.name, schema: CampaignSchema },
    ]),
    BullModule.registerQueue({ name: CAMPAIGN_COPILOT_BUILD }),
    ClaudeModule,
    CompaniesModule,
    CampaignsModule,
    CommonModule,
    CreativeModule,
  ],
  controllers: [CampaignCopilotController],
  providers: [
    CampaignCopilotService,
    CampaignCopilotProcessor,
    CampaignInsightsService,
  ],
  exports: [CampaignCopilotService],
})
export class CampaignCopilotModule {}
