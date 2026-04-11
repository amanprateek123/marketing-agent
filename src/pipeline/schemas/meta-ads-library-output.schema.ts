import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MetaAdsLibraryOutputDocument = HydratedDocument<MetaAdsLibraryOutput>;

export interface CompetitorAdInsight {
  competitor: string;          // which competitor
  hook: string;                // the ad hook / opening line
  angle: string;               // the messaging angle (discount, testimonial, lifestyle, etc.)
  format: 'video' | 'image' | 'carousel' | 'unknown';
  cta: string;                 // call to action text
  estimatedDaysRunning: number; // longevity = proven winner
  score: number;               // 1-10 (higher = more threat or more to learn from)
  source?: string;             // URL to Meta Ads Library or search result
}

export interface AdLibraryGap {
  gap: string;                 // what nobody is doing
  opportunity: string;         // how to exploit it specifically
  urgency: 'high' | 'medium' | 'low';
  score: number;               // 1-10
}

export interface MetaAdsLibraryInsights {
  competitorAds: CompetitorAdInsight[];   // top 5 competitor ads ranked by score
  gaps: AdLibraryGap[];                  // top 5 gaps ranked by score
  dominantFormat: string;                // most common format in the category
  rawSummary: string;                    // 2-3 sentence summary
}

@Schema({ collection: 'meta_ads_library_outputs', timestamps: true })
export class MetaAdsLibraryOutput {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ type: Object, required: true })
  insights: MetaAdsLibraryInsights;

  // Raw agent output kept for debugging
  @Prop({ required: true })
  rawContent: string;
}

export const MetaAdsLibraryOutputSchema = SchemaFactory.createForClass(MetaAdsLibraryOutput);
