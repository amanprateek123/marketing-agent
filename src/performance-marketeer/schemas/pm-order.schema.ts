import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { RefundState } from '../pm.logic';

export type PmOrderDocument = HydratedDocument<PmOrder>;

interface PmMetaClick {
  adId: string;
  adsetId: string;
  campaignId: string;
  at: Date;
}

/**
 * One row per 91astro order (paid or not) for the covered products, copied
 * from production Mongo via Metabase. No personal data: userId is the opaque
 * app id. Definitions: docs/performance-marketeer/07-definitions.md.
 */
@Schema({ collection: 'pm_orders', timestamps: true })
export class PmOrder {
  @Prop({ required: true }) tenantId: string;
  /** orders.id */
  @Prop({ required: true }) orderId: string;
  @Prop({ default: '' }) transactionId: string;
  @Prop({ required: true }) product: string;
  @Prop({ default: '' }) productTitle: string;
  @Prop({ default: '' }) userId: string;

  /** orders.createdAt (named orderedAt: `createdAt` is this row's own timestamp) */
  @Prop({ required: true }) orderedAt: Date;
  /** YYYY-MM-DD, IST */
  @Prop({ required: true }) day: string;

  @Prop({ default: '' }) status: string;
  @Prop({ default: '' }) paymentStatus: string;
  /** Definition 1: ORDER_CONFIRMED + SUCCESSFUL */
  @Prop({ default: false }) confirmed: boolean;

  @Prop({ default: 0 }) grossAmount: number;
  /** Definition 2: gross ex-GST, minus completed refunds */
  @Prop({ default: 0 }) netRevenue: number;
  @Prop({ default: 0 }) discount: number;
  @Prop({ default: '' }) couponCode: string;
  @Prop({ default: '' }) paymentMethod: string;
  /** Entered by staff (paymentMethod ADMIN_CREATED), not bought on the website — exclude from web funnel / attribution rates. */
  @Prop({ default: false }) adminCreated: boolean;
  @Prop({ default: '' }) currency: string;
  @Prop({ default: '' }) source: string;

  @Prop({ type: Object, default: { state: 'none', amount: 0, at: null } })
  refund: { state: RefundState; amount: number; at: Date | null };

  /** Definition 5 — only set for confirmed orders. */
  @Prop({ type: Boolean, default: null }) newToBusiness: boolean | null;
  @Prop({ type: Boolean, default: null }) newToProduct: boolean | null;

  /** Definition 4 — filled by the attribution step, not the order sync. */
  @Prop({ type: Object, default: null })
  attribution: {
    /** OpenPanel devices linked to this order (browser payment event and/or server purchase event). */
    deviceIds: string[];
    matchedBy: 'order_ref' | 'time_window' | 'none';
    metaLast: PmMetaClick | null;
    metaFirst: PmMetaClick | null;
    metaDistinctAds: number;
    /** Label every number with how it was attributed. */
    method: 'first_party_device_7d_click';
    computedAt: Date;
  } | null;
}

export const PmOrderSchema = SchemaFactory.createForClass(PmOrder);
PmOrderSchema.index({ tenantId: 1, orderId: 1 }, { unique: true });
PmOrderSchema.index({ tenantId: 1, product: 1, day: 1 });
PmOrderSchema.index({ tenantId: 1, orderedAt: 1 });
PmOrderSchema.index({ tenantId: 1, 'attribution.metaLast.adId': 1 });
