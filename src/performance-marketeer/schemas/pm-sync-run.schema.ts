import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PmSyncRunDocument = HydratedDocument<PmSyncRun>;

export type PmJob =
  | 'visitor-days'
  | 'orders'
  | 'refunds'
  | 'attribution'
  | 'meta-daily'
  | 'meta-entities'
  | 'meta-breakdowns'
  | 'meta-changes'
  | 'meta-campaigns';

/** Audit trail of every sync: what ran, over which days, how many rows, and any error. */
@Schema({ collection: 'pm_sync_runs', timestamps: true })
export class PmSyncRun {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) job: PmJob;
  @Prop({ default: '' }) from: string;
  @Prop({ default: '' }) to: string;
  @Prop({ default: '' }) product: string;
  /** 'cron' | 'api' | 'cli' */
  @Prop({ default: '' }) trigger: string;
  @Prop({ default: 'running' }) status:
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'partial';
  @Prop({ default: 0 }) rows: number;
  @Prop({ type: [String], default: [] }) errorMessages: string[];
  @Prop({ type: Object, default: {} }) stats: Record<string, number>;
  @Prop({ required: true }) startedAt: Date;
  @Prop({ type: Date, default: null }) finishedAt: Date | null;
}

export const PmSyncRunSchema = SchemaFactory.createForClass(PmSyncRun);
PmSyncRunSchema.index({ tenantId: 1, startedAt: -1 });
