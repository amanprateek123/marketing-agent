import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DecisionsController } from './decisions.controller';
import { DecisionsService } from './decisions.service';
import {
  IntelligenceDecision,
  IntelligenceDecisionSchema,
} from './intelligence-decision.schema';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IntelligenceDecision.name, schema: IntelligenceDecisionSchema },
    ]),
  ],
  controllers: [DecisionsController],
  providers: [DecisionsService],
  exports: [DecisionsService],
})
export class DecisionsModule {}
