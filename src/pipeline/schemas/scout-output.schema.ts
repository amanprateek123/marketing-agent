import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ScoutOutputDocument = HydratedDocument<ScoutOutput>;

export interface TrendingTopic {
  topic: string;
  angle: string;
  engagementProof: {
    metric: string;
    value: number;
    source: string;
  };
  recency: 'high' | 'medium';
  specificity: 'high' | 'medium';
  sourceQuality: 'high' | 'medium';
  signalScore: number;
}

export interface ViralTrend {
  trend: string;
  why_it_works: string;
  brand_tie_in: string;
  signalScore: number;
  source: string;
}

export interface ScoutOutputData {
  platform: string;
  trending_topics: TrendingTopic[];
  viral_trends: ViralTrend[];
  format_insights: string[];
  hook_examples: string[];
  raw_summary: string;
}

@Schema({ collection: 'scout_outputs', timestamps: true })
export class ScoutOutput {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ required: true })
  platform: string;

  @Prop({ type: Object, required: true })
  data: ScoutOutputData;

  @Prop({ default: false })
  enriched: boolean;
}

export const ScoutOutputSchema = SchemaFactory.createForClass(ScoutOutput);
