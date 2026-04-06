import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type EnrichedCampaignDocument = HydratedDocument<EnrichedCampaign>;

@Schema({ collection: 'enriched_campaigns', timestamps: true })
export class EnrichedCampaign {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, type: Types.ObjectId, index: true })
  importId: Types.ObjectId;

  @Prop({ required: true })
  campaignId: string;

  /** Full enriched campaign data (insights, adSets, adInsights, demographics, ads) */
  @Prop({ type: Object, required: true })
  data: any;
}

export const EnrichedCampaignSchema = SchemaFactory.createForClass(EnrichedCampaign);

EnrichedCampaignSchema.index({ importId: 1 });
