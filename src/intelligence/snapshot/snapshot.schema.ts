import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type IntelligenceSnapshotDocument =
  HydratedDocument<IntelligenceSnapshot>;

/**
 * intelligence_snapshots — the immutable truth layer for campaign
 * metrics. Written by SnapshotEngine on every 15-min tick regardless
 * of whether an hourly cycle is in flight.
 *
 * Downstream engines read from here (via SnapshotEngine.getHistory)
 * and never from Meta directly.
 */
@Schema({ collection: 'intelligence_snapshots', timestamps: true })
export class IntelligenceSnapshot {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, index: true })
  campaignId!: string;

  @Prop({ required: true })
  metaCampaignId!: string;

  /** Ties back to the intelligence_cycles doc when this snapshot seeded a cycle. */
  @Prop({ required: true })
  snapshotId!: string;

  /** cycleId when a snapshot participated in a cycle; empty for standalone 15-min ticks. */
  @Prop()
  cycleId?: string;

  @Prop({ required: true, default: '1.0.0' })
  schemaVersion!: string;

  @Prop({ required: true })
  collectedAt!: Date;

  @Prop({ required: true })
  metaWindowStart!: Date;

  @Prop({ required: true })
  metaWindowEnd!: Date;

  @Prop({ type: MongooseSchema.Types.Mixed })
  rawCampaign?: Record<string, unknown>;

  @Prop({ type: MongooseSchema.Types.Mixed })
  rawAdSets?: Record<string, unknown>;

  @Prop({ type: MongooseSchema.Types.Mixed })
  rawAds?: Record<string, unknown>;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  metrics!: Record<string, unknown>;

  /** Exact campaign → ad set → ad → creative identity captured with metrics. */
  @Prop({ type: MongooseSchema.Types.Mixed })
  entities?: Record<string, unknown>;

  @Prop({ type: MongooseSchema.Types.Mixed })
  meta?: Record<string, unknown>;

  @Prop({ type: [String], default: [] })
  missingFields!: string[];

  @Prop()
  freshnessSec?: number;
}

export const IntelligenceSnapshotSchema =
  SchemaFactory.createForClass(IntelligenceSnapshot);

// Every downstream engine that reads snapshot history queries by
// (tenantId, campaignId, collectedAt desc).
IntelligenceSnapshotSchema.index({
  tenantId: 1,
  campaignId: 1,
  collectedAt: -1,
});

// snapshotId is a unique pointer per snapshot doc.
IntelligenceSnapshotSchema.index({ snapshotId: 1 }, { unique: true });
