import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type IntelligenceBriefDocument = HydratedDocument<IntelligenceBrief>;

@Schema({ collection: 'intelligence_briefs', timestamps: true })
export class IntelligenceBrief {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

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
