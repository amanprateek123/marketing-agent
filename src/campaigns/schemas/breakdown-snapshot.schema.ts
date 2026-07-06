import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BreakdownSnapshotDocument = HydratedDocument<BreakdownSnapshot>;

/**
 * Segment-level performance for one entity: WHO (age × gender), WHERE
 * (region / placement / device), WHEN (hour of day), and per-asset for
 * dynamic-creative ads. One doc per entity × breakdownType × window,
 * replaced wholesale on each deep-sync (rows are a snapshot, not history —
 * history lives in metric_timeseries).
 *
 * This is the data that turns "campaign ROAS 1.05" into "women 25-34 in
 * Maharashtra on IG Reels run 1.8, men 45+ on Audience Network run 0.4" —
 * the raw material for targeting-refinement proposals on custom campaigns.
 */
@Schema({ collection: 'breakdown_snapshots', timestamps: true })
export class BreakdownSnapshot {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  metaCampaignId: string;

  /** 'campaign' | 'adset' | 'ad' — granularity of entityId. */
  @Prop({ required: true })
  level: string;

  @Prop({ required: true, index: true })
  entityId: string;

  /** 'age_gender' | 'region' | 'placement' | 'hourly' | 'dow' | 'asset_video' | 'asset_body' | 'asset_title' */
  @Prop({ required: true })
  breakdownType: string;

  /** Insights window the rows cover, e.g. 'last_30d' | 'maximum'. */
  @Prop({ required: true })
  window: string;

  /**
   * One row per segment. `keys` holds the segment identity (whichever apply):
   * age, gender, region, country, publisherPlatform, platformPosition,
   * devicePlatform, hour, dow, assetId, assetText.
   */
  @Prop({ type: [Object], default: [] })
  rows: Array<{
    keys: Record<string, string>;
    spend: number;
    impressions: number;
    reach?: number;
    clicks: number;
    ctr: number;
    conversions: number;
    revenue: number;
    cpa: number;
    roas: number;
  }>;

  @Prop({ required: true })
  fetchedAt: Date;
}

export const BreakdownSnapshotSchema = SchemaFactory.createForClass(BreakdownSnapshot);

// One live snapshot per entity × breakdown × window — deep-sync upserts here.
BreakdownSnapshotSchema.index(
  { tenantId: 1, entityId: 1, breakdownType: 1, window: 1 },
  { unique: true },
);
BreakdownSnapshotSchema.index({ tenantId: 1, metaCampaignId: 1, breakdownType: 1 });
