import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DecisionsController } from './decisions.controller';
import { DecisionsService } from './decisions.service';
import { CampaignsModule } from '../../campaigns/campaigns.module';
import {
  IntelligenceDecision,
  IntelligenceDecisionSchema,
} from './intelligence-decision.schema';
import { Campaign, CampaignSchema } from '../../campaigns/schemas/campaign.schema';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IntelligenceDecision.name, schema: IntelligenceDecisionSchema },
      // Read-only: used to count ad sets when collapsing redundant
      // campaign-vs-adset proposals on read. See collapseDuplicates().
      { name: Campaign.name, schema: CampaignSchema },
    ]),
    // For executeApprovedDecision — the real Meta-executing bridge lives on
    // CampaignAuditorService (already-proven pendingActions execution path).
    CampaignsModule,
  ],
  controllers: [DecisionsController],
  providers: [DecisionsService],
  exports: [DecisionsService],
})
export class DecisionsModule {}
