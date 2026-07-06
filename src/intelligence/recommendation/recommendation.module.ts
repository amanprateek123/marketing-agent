import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Campaign, CampaignSchema } from '../../campaigns/schemas/campaign.schema';
import {
  IntelligenceDecision,
  IntelligenceDecisionSchema,
} from '../decisions/intelligence-decision.schema';
import { RecommendationEngine } from './recommendation-engine.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IntelligenceDecision.name, schema: IntelligenceDecisionSchema },
      { name: Campaign.name, schema: CampaignSchema },
    ]),
  ],
  providers: [RecommendationEngine],
  exports: [RecommendationEngine],
})
export class RecommendationModule {}
