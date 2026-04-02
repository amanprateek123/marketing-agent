import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PipelineRunDocument = HydratedDocument<PipelineRun>;

export type PipelineRunStatus =
  | 'pending'
  | 'scouts_running'
  | 'scouts_enriching'
  | 'intelligence_running'
  | 'idea_pool_running'
  | 'creative_running'
  | 'campaign_launching'
  | 'completed'
  | 'failed';

@Schema({ collection: 'pipeline_runs', timestamps: true })
export class PipelineRun {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, unique: true, index: true })
  runId: string;

  @Prop({ required: true, default: 'pending' })
  status: PipelineRunStatus;

  @Prop({ default: '' })
  phase: string;

  @Prop({ required: true, default: () => new Date() })
  startedAt: Date;

  @Prop()
  completedAt?: Date;

  @Prop()
  error?: string;

  @Prop({ default: 0 })
  briefsGenerated: number;

  @Prop()
  selectedBriefId?: string;

  @Prop()
  campaignId?: string;

  @Prop()
  metaCampaignId?: string;

  @Prop({ default: 0 })
  costUSD: number;
}

export const PipelineRunSchema = SchemaFactory.createForClass(PipelineRun);
