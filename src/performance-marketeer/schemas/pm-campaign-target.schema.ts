import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PmCampaignTargetDocument = HydratedDocument<PmCampaignTarget>;

/**
 * The owner's lifetime purchase target for one campaign (first-party
 * confirmed orders since launch). Any logged-in user can set or change it;
 * every change is kept in `history`. The AI analyst plans towards it.
 */
@Schema({ collection: 'pm_campaign_targets', timestamps: true })
export class PmCampaignTarget {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) campaignId: string;
  /** null = target removed (the history stays). */
  @Prop({ type: Number, default: null }) targetPurchases: number | null;
  @Prop({ default: '' }) updatedBy: string;
  @Prop({
    type: [{ targetPurchases: Number, by: String, at: Date, _id: false }],
    default: [],
  })
  history: { targetPurchases: number | null; by: string; at: Date }[];
}

export const PmCampaignTargetSchema =
  SchemaFactory.createForClass(PmCampaignTarget);
PmCampaignTargetSchema.index({ tenantId: 1, campaignId: 1 }, { unique: true });
