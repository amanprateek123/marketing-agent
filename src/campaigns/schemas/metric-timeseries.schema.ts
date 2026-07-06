import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MetricTimeseriesDocument = HydratedDocument<MetricTimeseries>;

/**
 * One row = one entity × one day. Backfilled 90 days via
 * time_increment=1, then kept current by the deep-sync job.
 *
 * This is what the Trend Engine's EMAs/baselines read — replaces waiting
 * weeks for 30-min intelligence snapshots to accumulate history, and gives
 * ad-level trends a real daily series instead of a single lifetime row.
 */
@Schema({ collection: 'metric_timeseries', timestamps: true })
export class MetricTimeseries {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  metaCampaignId: string;

  /** 'campaign' | 'adset' | 'ad' */
  @Prop({ required: true })
  level: string;

  /** Meta ID of the campaign/adset/ad this row belongs to. */
  @Prop({ required: true, index: true })
  entityId: string;

  /** Parent adset ID (level='ad' only) — lets ad rows roll up without a join. */
  @Prop({ default: '' })
  adsetId: string;

  /** 'YYYY-MM-DD' in the ad account's timezone (Meta's date_start). */
  @Prop({ required: true })
  date: string;

  @Prop({ default: 0 }) spend: number;
  @Prop({ default: 0 }) impressions: number;
  @Prop({ default: 0 }) reach: number;
  @Prop({ default: 0 }) frequency: number;
  @Prop({ default: 0 }) clicks: number;
  @Prop({ default: 0 }) inlineLinkClicks: number;
  @Prop({ default: 0 }) ctr: number;
  @Prop({ default: 0 }) cpc: number;
  @Prop({ default: 0 }) cpm: number;
  @Prop({ default: 0 }) conversions: number;
  @Prop({ default: 0 }) revenue: number;
  @Prop({ default: 0 }) addToCart: number;
  @Prop({ default: 0 }) initiateCheckout: number;
  @Prop({ default: 0 }) landingPageView: number;
  @Prop({ default: 0 }) video3s: number;
  @Prop({ default: 0 }) thruplay: number;

  @Prop()
  syncedAt?: Date;
}

export const MetricTimeseriesSchema = SchemaFactory.createForClass(MetricTimeseries);

// One row per entity per day — deep-sync upserts on this key.
MetricTimeseriesSchema.index(
  { tenantId: 1, level: 1, entityId: 1, date: 1 },
  { unique: true },
);
// Series reads: "last N days for this campaign at level X".
MetricTimeseriesSchema.index({ tenantId: 1, metaCampaignId: 1, level: 1, date: 1 });
