import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ScoutSignalDocument = HydratedDocument<ScoutSignal>;

@Schema({ collection: 'scout_signals', timestamps: true })
export class ScoutSignal {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ required: true })
  platform: string;

  @Prop({ required: true })
  topic: string;

  @Prop({ required: true })
  angle: string;

  @Prop({ required: true, unique: true, index: true })
  hash: string;

  @Prop({ required: true })
  signalScore: number;

  @Prop({ type: Object })
  engagementProof: {
    metric: string;
    value: number;
    source: string;
  };

  @Prop({ enum: ['high', 'medium'], default: 'medium' })
  recency: string;

  @Prop({ enum: ['high', 'medium'], default: 'medium' })
  specificity: string;

  @Prop({ enum: ['high', 'medium'], default: 'medium' })
  sourceQuality: string;
}

export const ScoutSignalSchema = SchemaFactory.createForClass(ScoutSignal);
