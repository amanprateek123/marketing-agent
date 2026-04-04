import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CreativeBriefDocument = HydratedDocument<CreativeBrief>;

@Schema({ collection: 'creative_briefs', timestamps: true })
export class CreativeBrief {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ required: true, index: true })
  briefId: string;

  @Prop({ required: true })
  topic: string;

  @Prop({ required: true })
  angle: string;

  @Prop({ required: true })
  platform: string;

  @Prop({ required: true })
  format: string;

  @Prop({ required: true })
  audience: string;

  @Prop({ required: true })
  hook: string;

  @Prop({ required: true })
  keyMessage: string;

  @Prop({ required: true })
  conversionBridge: string;

  @Prop({ required: true, default: 0 })
  suggestedBudget: number;

  @Prop({ required: true, default: 0 })
  finalScore: number;

  @Prop({ required: true, default: false })
  selected: boolean;

  @Prop({ default: '' })
  selectionReason: string;

  // Phase 9 — Strategy Team debate data
  @Prop({ type: Number, default: null })
  debateRounds: number;

  @Prop({ type: [Object], default: [] })
  debateLog: { round: number; from: string; summary: string }[];

  @Prop({ type: String, default: null })
  debateRationale: string;
}

export const CreativeBriefSchema = SchemaFactory.createForClass(CreativeBrief);
