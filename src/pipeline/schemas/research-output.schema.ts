import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ResearchOutputDocument = HydratedDocument<ResearchOutput>;

export type ResearchType = 'competitor' | 'market';

export interface ResearchInsight {
  insight: string;       // one clear finding
  implication: string;   // what this means for campaign ideas
  urgency: 'high' | 'medium' | 'low';
  score: number;         // 1-10
  source?: string;       // URL if available
}

export interface StructuredResearch {
  insights: ResearchInsight[];  // top 5, ranked by score desc
  rawSummary: string;           // 2-3 sentence summary only
}

@Schema({ collection: 'research_outputs', timestamps: true })
export class ResearchOutput {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ required: true, enum: ['competitor', 'market'] })
  type: ResearchType;

  // Structured ranked insights (new)
  @Prop({ type: Object, default: null })
  structured: StructuredResearch | null;

  // Raw content kept for debugging only — NOT passed to agents
  @Prop({ required: true })
  content: string;
}

export const ResearchOutputSchema = SchemaFactory.createForClass(ResearchOutput);
