import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type IntelligenceBriefDocument = HydratedDocument<IntelligenceBrief>;

@Schema({ collection: 'intelligence_briefs', timestamps: true })
export class IntelligenceBrief {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ index: true })
  briefId: string;

  @Prop({ default: '' })
  product: string;

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

  @Prop({ default: '' })
  hook: string;

  @Prop({ default: '' })
  keyMessage: string;

  @Prop({ default: '' })
  conversionBridge: string;

  /**
   * Audience funnel stage — determines whether the creative team writes
   * cold-prospect copy (problem-first 5-line, brand intro), warm-retarget copy
   * (offer-recall 2-3 line, no brand intro, no "Kya aap bhi…" hooks), or hot
   * cart-recovery copy (1-2 line urgency referencing the abandoned action).
   * Defaults to 'cold' since most first-pass strategy briefs target prospecting.
   */
  @Prop({ required: false, enum: ['cold', 'warm', 'hot'], default: 'cold' })
  audienceStage?: 'cold' | 'warm' | 'hot';

  @Prop({ required: true, default: 0 })
  confidenceScore: number;

  @Prop({ required: true, default: 0 })
  urgencyScore: number;

  @Prop({ required: true, default: 0 })
  finalScore: number;

  @Prop({ type: [String], default: [] })
  sourcePlatforms: string[];

  @Prop({ required: true, default: 0 })
  suggestedBudget: number;

  @Prop({ default: false })
  selected: boolean;

  // Performance written back by auditor (Phase 6)
  @Prop({ type: Object, default: {} })
  performanceWritten: {
    day7?: boolean;
    day14?: boolean;
    day30?: boolean;
  };

  @Prop({ type: Object })
  day7Performance?: { roas: number; ctr: number; cpc: number; conversions: number };

  @Prop({ type: Object })
  day14Performance?: { roas: number; ctr: number; cpc: number; conversions: number };

  @Prop({ type: Object })
  day30Performance?: { roas: number; ctr: number; cpc: number; conversions: number };
}

export const IntelligenceBriefSchema = SchemaFactory.createForClass(IntelligenceBrief);
