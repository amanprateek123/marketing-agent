import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PmMetaEntity } from './pm-meta.schema';

/**
 * Settings of one campaign / ad set / ad as seen on one IST day, written by
 * the entities sync before pm_meta_entities is overwritten. Day-to-day diffs
 * catch changes the activity log misses (journal fallback).
 */
@Schema({ collection: 'pm_meta_entity_snapshots', timestamps: true })
export class PmMetaEntitySnapshot {
  @Prop({ required: true }) tenantId: string;
  @Prop({ default: '' }) accountId: string;
  @Prop({ required: true }) level: 'campaign' | 'adset' | 'ad';
  @Prop({ required: true }) entityId: string;
  /** YYYY-MM-DD, IST */
  @Prop({ required: true }) date: string;
  @Prop({ default: '' }) name: string;
  @Prop({ default: '' }) campaignId: string;
  @Prop({ default: '' }) adsetId: string;
  @Prop({ default: '' }) status: string;
  @Prop({ default: '' }) effectiveStatus: string;
  @Prop({ type: Number, default: null }) dailyBudget: number | null; // rupees
  @Prop({ type: Number, default: null }) lifetimeBudget: number | null; // rupees
  @Prop({ default: '' }) bidStrategy: string;
  @Prop({ type: Object, default: null })
  targetingSummary: PmMetaEntity['targetingSummary'];
  @Prop({ default: '' }) learningStage: string;
  @Prop({ default: '' }) creativeId: string;
}
export type PmMetaEntitySnapshotDocument =
  HydratedDocument<PmMetaEntitySnapshot>;
export const PmMetaEntitySnapshotSchema =
  SchemaFactory.createForClass(PmMetaEntitySnapshot);
PmMetaEntitySnapshotSchema.index(
  { tenantId: 1, entityId: 1, date: 1 },
  { unique: true },
);
PmMetaEntitySnapshotSchema.index({ tenantId: 1, campaignId: 1, date: 1 });
