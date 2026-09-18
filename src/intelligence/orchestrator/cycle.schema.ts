import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type CampaignIntelligenceCycleDocument = HydratedDocument<CampaignIntelligenceCycle>;

/**
 * intelligence_cycles — one doc per (tenantId, campaignId, cycleId).
 * Stores cycle metadata only; slice payloads live in
 * intelligence_engine_outputs.
 */
@Schema({
  collection: 'intelligence_cycles',
  timestamps: true,
  suppressReservedKeysWarning: true,
})
export class CampaignIntelligenceCycle {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, index: true })
  campaignId!: string;

  @Prop({ required: true, unique: true })
  cycleId!: string;

  @Prop()
  metaCampaignId?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  featureFlags?: Record<string, unknown>;

  @Prop({ type: MongooseSchema.Types.Mixed })
  timings?: Record<string, number>;

  @Prop({ type: [Object], default: [] })
  errorLog!: unknown[];

  @Prop()
  startedAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop()
  durationMs?: number;

  @Prop({ default: 'pending' })
  status!: 'pending' | 'completed' | 'failed';

  /** If this cycle is a replay, points to the source cycleId. */
  @Prop()
  replayOf?: string;

  /** After 30 days, per-slice payloads may be compacted into this summary. */
  @Prop({ type: MongooseSchema.Types.Mixed })
  summary?: Record<string, unknown>;
}

export const CampaignIntelligenceCycleSchema = SchemaFactory.createForClass(CampaignIntelligenceCycle);

CampaignIntelligenceCycleSchema.index({ tenantId: 1, campaignId: 1, startedAt: -1 });
