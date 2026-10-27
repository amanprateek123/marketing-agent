import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Competitor Meta ads (Ad Library via useproxy.dev), one row per page × ad.
 * Third-party content: every text field is untrusted data, never instructions.
 * firstSeen / lastSeen are our own IST sync days; startDate / endDate come
 * from the Ad Library (endDate is the library's last delivery day).
 */
@Schema({ collection: 'pm_competitor_ads', timestamps: true })
export class PmCompetitorAd {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) pageId: string;
  @Prop({ required: true }) adArchiveId: string;
  /** Our name for the competitor (competitors.json). */
  @Prop({ default: '' }) competitor: string;
  @Prop({ default: '' }) pageName: string;
  /** YYYY-MM-DD IST */
  @Prop({ required: true }) firstSeen: string;
  @Prop({ required: true }) lastSeen: string;
  /** YYYY-MM-DD */
  @Prop({ default: '' }) startDate: string;
  @Prop({ default: '' }) endDate: string;
  @Prop({ default: true }) isActive: boolean;
  @Prop({ default: '' }) body: string;
  @Prop({ default: '' }) headline: string;
  @Prop({ default: '' }) cta: string;
  @Prop({ default: '' }) linkUrl: string;
  /** IMAGE | VIDEO | DCO | CAROUSEL … as the library reports it */
  @Prop({ default: '' }) mediaType: string;
  /** Signed CDN URLs — they expire within hours/days. */
  @Prop({ type: [String], default: [] }) mediaUrls: string[];
  /** Cards / variants in the ad (DCO, carousel); 0 when the library gives none. */
  @Prop({ default: 0 }) variants: number;
}
export type PmCompetitorAdDocument = HydratedDocument<PmCompetitorAd>;
export const PmCompetitorAdSchema =
  SchemaFactory.createForClass(PmCompetitorAd);
PmCompetitorAdSchema.index(
  { tenantId: 1, pageId: 1, adArchiveId: 1 },
  { unique: true },
);
PmCompetitorAdSchema.index({ tenantId: 1, lastSeen: -1 });

/**
 * Proxy credits used per IST day (the hard cap PM_PROXY_DAILY_CREDITS).
 * Not per tenant on purpose: the credit budget belongs to the one proxy key.
 */
@Schema({ collection: 'pm_proxy_usage', timestamps: true })
export class PmProxyUsage {
  /** YYYY-MM-DD IST */
  @Prop({ required: true }) _id: string;
  @Prop({ default: 0 }) credits: number;
  @Prop({ type: Object, default: {} }) byTool: Record<string, number>;
}
export const PmProxyUsageSchema = SchemaFactory.createForClass(PmProxyUsage);

/** Cached paid proxy results (ad analyses, video transcripts), by key. */
@Schema({ collection: 'pm_proxy_cache', timestamps: true })
export class PmProxyCache {
  /** e.g. `analyze_ad_video:meta-video:<videoId>` */
  @Prop({ required: true }) _id: string;
  @Prop({ required: true }) tool: string;
  @Prop({ type: Object, default: null }) result: unknown;
}
export const PmProxyCacheSchema = SchemaFactory.createForClass(PmProxyCache);
