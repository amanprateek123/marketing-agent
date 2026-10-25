import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Channel } from '../pm.logic';

export type PmVisitorDayDocument = HydratedDocument<PmVisitorDay>;

/**
 * One row = one product × one IST day × one OpenPanel device (OpenPanel
 * rotates device ids daily, so a row is a visitor-day). Raw values only —
 * scroll / time bands and conversion rates are computed at analysis time, so
 * any slicing stays possible. Rebuilt per product-day from ClickHouse.
 */
@Schema({ collection: 'pm_visitor_days', timestamps: true })
export class PmVisitorDay {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) product: string;
  /** YYYY-MM-DD, IST */
  @Prop({ required: true }) day: string;
  @Prop({ required: true }) deviceId: string;

  @Prop({ required: true }) firstAt: Date;
  @Prop({ required: true }) lastAt: Date;
  @Prop({ default: 0 }) sessions: number;

  /** screen_view count on the landing page / cart pages */
  @Prop({ default: 0 }) landingViews: number;
  @Prop({ default: 0 }) cartViews: number;
  /** First landing path seen that day, e.g. /hi/nadi-report-premium */
  @Prop({ default: '' }) landingPath: string;
  @Prop({ default: 'en' }) locale: string;

  /** Deepest scroll_depth mark on the landing page: 0, 25, 50, 75 or 100 */
  @Prop({ default: 0 }) maxScroll: number;
  /** Longest page_time active_seconds (a running total) on landing / cart pages */
  @Prop({ default: 0 }) activeSecondsLanding: number;
  @Prop({ default: 0 }) activeSecondsCart: number;

  @Prop({ type: Object, default: {} })
  geo: { city?: string; region?: string; country?: string };

  @Prop({ type: Object, default: {} })
  tech: { device?: string; os?: string; browser?: string };

  /** First-touch of the day: referrer + utm of the first event that carried them. */
  @Prop({ type: Object, default: {} })
  traffic: {
    channel: Channel;
    referrer?: string;
    referrerName?: string;
    referrerType?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
    utmId?: string;
    hasFbclid: boolean;
    hasGoogleClickId: boolean;
  };

  /** Meta ad ids seen that day (utm_content = ad, utm_term = ad set, utm_id = campaign). */
  @Prop({ type: Object, default: null })
  metaAd: {
    first: { adId: string; adsetId: string; campaignId: string; at: Date };
    last: { adId: string; adsetId: string; campaignId: string; at: Date };
    distinctAds: number;
  } | null;

  /** Funnel steps: how many times and when first, keyed by PmStepKey. */
  @Prop({ type: Object, default: {} })
  steps: Record<string, { count: number; firstAt: Date | null }>;

  /** Browser payment events; `ref` is the order's transactionId or id. */
  @Prop({ type: [{ at: Date, ref: String, _id: false }], default: [] })
  payments: { at: Date; ref: string }[];

  /** Server purchase events whose device is the buyer's browser; `orderId` = orders.id. */
  @Prop({ type: [{ at: Date, orderId: String, _id: false }], default: [] })
  purchases: { at: Date; orderId: string }[];
}

export const PmVisitorDaySchema = SchemaFactory.createForClass(PmVisitorDay);
PmVisitorDaySchema.index(
  { tenantId: 1, product: 1, day: 1, deviceId: 1 },
  { unique: true },
);
PmVisitorDaySchema.index({ tenantId: 1, 'payments.ref': 1 });
PmVisitorDaySchema.index({ tenantId: 1, 'purchases.orderId': 1 });
PmVisitorDaySchema.index({ tenantId: 1, day: 1, 'metaAd.last.adId': 1 });
