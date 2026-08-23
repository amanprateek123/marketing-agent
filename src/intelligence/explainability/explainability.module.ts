import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaudeModule } from '../../claude/claude.module';
import {
  IntelligenceDecision,
  IntelligenceDecisionSchema,
} from '../decisions/intelligence-decision.schema';
import { ExplainabilityEngine } from './explainability-engine.service';
import { OpenAIIntelligenceReviewService } from './openai-intelligence-review.service';

@Global()
@Module({
  imports: [
    ClaudeModule,
    MongooseModule.forFeature([
      { name: IntelligenceDecision.name, schema: IntelligenceDecisionSchema },
    ]),
  ],
  providers: [ExplainabilityEngine, OpenAIIntelligenceReviewService],
  exports: [ExplainabilityEngine, OpenAIIntelligenceReviewService],
})
export class ExplainabilityModule {}
