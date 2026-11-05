import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PmCampaignTargetDocument = HydratedDocument<PmCampaignTarget>;

/**
 * The owner's goal for one campaign: ROAS and/or purchases within a period, and
 * a daily budget limit. First-party numbers count, except for app products (Meta).
 */
@Schema({ collection: 'pm_campaign_targets', timestamps: true })
export class PmCampaignTarget {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) campaignId: string;
  /** Purchases wanted within targetDays. null = no purchase target. */
  @Prop({ type: Number, default: null }) targetPurchases: number | null;
  /** ROAS wanted within targetDays. null = no ROAS target. */
  @Prop({ type: Number, default: null }) targetRoas: number | null;
  /** Length of the period, in days from targetStart. */
  @Prop({ type: Number, default: null }) targetDays: number | null;
  /** IST day YYYY-MM-DD the period started; set by the server when targetDays is saved. */
  @Prop({ type: String, default: null }) targetStart: string | null;
  /** Most the campaign may spend per day, in rupees. Not tied to the period. */
  @Prop({ type: Number, default: null }) maxDailyBudget: number | null;
  @Prop({ default: '' }) updatedBy: string;
  @Prop({
    type: [
      {
        targetPurchases: Number,
        targetRoas: Number,
        targetDays: Number,
        maxDailyBudget: Number,
        by: String,
        at: Date,
        _id: false,
      },
    ],
    default: [],
  })
  history: {
    targetPurchases?: number | null;
    targetRoas?: number | null;
    targetDays?: number | null;
    maxDailyBudget?: number | null;
    by: string;
    at: Date;
  }[];
}

export const PmCampaignTargetSchema =
  SchemaFactory.createForClass(PmCampaignTarget);
PmCampaignTargetSchema.index({ tenantId: 1, campaignId: 1 }, { unique: true });
