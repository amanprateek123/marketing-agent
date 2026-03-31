import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ResearchOutputDocument = HydratedDocument<ResearchOutput>;

export type ResearchType = 'competitor' | 'market';

@Schema({ collection: 'research_outputs', timestamps: true })
export class ResearchOutput {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ required: true, enum: ['competitor', 'market'] })
  type: ResearchType;

  // Full research content from the agent
  @Prop({ required: true })
  content: string;
}

export const ResearchOutputSchema = SchemaFactory.createForClass(ResearchOutput);
