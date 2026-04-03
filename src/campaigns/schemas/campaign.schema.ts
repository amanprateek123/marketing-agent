import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CampaignDocument = HydratedDocument<Campaign>;

export type CampaignStatus = 'active' | 'paused' | 'completed' | 'failed';

@Schema({ collection: 'campaigns', timestamps: true })
export class Campaign {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ required: true, index: true })
  briefId: string;

  @Prop({ required: true })
  creativePackageId: string;

  @Prop({ required: true, unique: true, index: true })
  metaCampaignId: string;

  @Prop({ required: true, default: 'active' })
  status: CampaignStatus;

  @Prop({ required: true })
  budget: number;

  @Prop({ required: true })
  objective: string;

  @Prop({ required: true })
  launchedAt: Date;

  @Prop()
  pausedAt?: Date;

  @Prop()
  pauseReason?: string;

  // Live metrics (written back by auditor in Phase 6)
  @Prop({ default: 0 })
  spend: number;

  @Prop({ default: 0 })
  impressions: number;

  @Prop({ default: 0 })
  clicks: number;

  @Prop({ default: 0 })
  conversions: number;

  @Prop({ default: 0 })
  roas: number;

  @Prop({ default: 0 })
  ctr: number;

  @Prop({ default: 0 })
  cpc: number;

  @Prop()
  lastAuditedAt?: Date;

  @Prop({ type: [Object], default: [] })
  auditHistory: {
    auditedAt: Date;
    action: string;
    reason: string;
    metricsBefore: Record<string, number>;
  }[];
}

export const CampaignSchema = SchemaFactory.createForClass(Campaign);
