import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  CampaignRevenueAttributionSource,
  CampaignRevenueBasis,
} from './campaign.schema';

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

  /**
   * Daily return provenance. Rows written before these fields existed used an
   * account-wide union of conversion events and must not be presented as
   * product-scoped attributed return. `revenueCalculationVersion` is the
   * explicit trust boundary used by the Tool Impact chart.
   */
  @Prop({ default: 'unknown' })
  revenueBasis: CampaignRevenueBasis;

  @Prop({ default: 'unknown' })
  revenueAttributionSource: CampaignRevenueAttributionSource;

  @Prop({ type: [String], default: [] })
  revenueAttributionActionTypes: string[];

  @Prop({ default: '' })
  revenueCalculationVersion: string;

  /** Complete means every requested Meta page/chunk succeeded before write. */
  @Prop({ default: 'unknown' })
  revenueFetchCompleteness: string;

  /** Raw product identity explicitly persisted on Campaign.productName. */
  @Prop({ default: '' })
  campaignProductName: string;

  /** Canonical configured product name; blank when exact resolution failed. */
  @Prop({ default: '' })
  resolvedProductName: string;

  @Prop({ default: '' })
  productResolutionEvidence: string;

  /**
   * SHA-256 of the non-secret product conversion/value configuration at sync
   * time. Presence does not prove that the product still has this config.
   */
  @Prop({ default: '' })
  revenueConfigFingerprint: string;

  @Prop({ default: 0 }) addToCart: number;
  @Prop({ default: 0 }) initiateCheckout: number;
  @Prop({ default: 0 }) landingPageView: number;
  @Prop({ default: 0 }) video3s: number;
  @Prop({ default: 0 }) thruplay: number;

  @Prop()
  syncedAt?: Date;
}

export const MetricTimeseriesSchema =
  SchemaFactory.createForClass(MetricTimeseries);

// One row per entity per day — deep-sync upserts on this key.
MetricTimeseriesSchema.index(
  { tenantId: 1, level: 1, entityId: 1, date: 1 },
  { unique: true },
);
// Series reads: "last N days for this campaign at level X".
MetricTimeseriesSchema.index({
  tenantId: 1,
  metaCampaignId: 1,
  level: 1,
  date: 1,
});
