import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CoordinatorOutputDocument = HydratedDocument<CoordinatorOutput>;

@Schema({ collection: 'coordinator_outputs', timestamps: true })
export class CoordinatorOutput {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  // Full synthesis brief from coordinator
  @Prop({ required: true })
  content: string;

  // Top cross-platform signals extracted for scoring
  @Prop({ type: [Object], default: [] })
  topSignals: {
    topic: string;
    platforms: string[];
    compositeScore: number;
    rationale: string;
  }[];

  // Viral/meme trends kept separate from industry signals
  @Prop({ type: [Object], default: [] })
  viralTrends?: {
    trend: string;
    platforms: string[];
    brandTieIn: string;
    compositeScore: number;
    urgent: boolean;
  }[];
}

export const CoordinatorOutputSchema = SchemaFactory.createForClass(CoordinatorOutput);
