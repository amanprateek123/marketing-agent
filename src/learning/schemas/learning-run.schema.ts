import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type LearningRunDocument = HydratedDocument<LearningRun>;

export type LearningRunStatus = 'completed' | 'skipped' | 'failed';

@Schema({ collection: 'learning_runs', timestamps: true })
export class LearningRun {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true })
  status: LearningRunStatus;

  @Prop({ default: 0 })
  version: number;

  @Prop({ default: 0 })
  briefsAnalyzed: number;

  @Prop({ default: 0 })
  instinctsExtracted: number;

  @Prop({ default: false })
  promptsRegenerated: boolean;

  @Prop({ default: '' })
  skipReason: string;

  @Prop({ required: true })
  runAt: Date;

  @Prop({ default: 0 })
  costUSD: number;
}

export const LearningRunSchema = SchemaFactory.createForClass(LearningRun);
