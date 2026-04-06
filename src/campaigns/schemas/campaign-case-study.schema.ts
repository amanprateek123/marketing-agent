import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CampaignCaseStudyDocument = HydratedDocument<CampaignCaseStudy>;

@Schema({ collection: 'campaign_case_studies', timestamps: true })
export class CampaignCaseStudy {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true })
  campaignName: string;

  @Prop({ default: '' })
  product: string;

  @Prop({ default: '' })
  dateRange: string;

  @Prop({ default: 0 })
  durationDays: number;

  @Prop({ default: 0 })
  totalSpend: number;

  @Prop({ default: 0 })
  totalConversions: number;

  @Prop({ default: '' })
  context: string;

  @Prop({ type: Object, default: {} })
  whatWorked: {
    hooks: string[];
    audiences: string[];
    formats: string[];
    bestCPA: number;
    bestROAS: number;
  };

  @Prop({ type: Object, default: {} })
  whatFailed: {
    hooks: string[];
    audiences: string[];
    reason: string;
  };

  @Prop({ default: '' })
  lesson: string;
}

export const CampaignCaseStudySchema = SchemaFactory.createForClass(CampaignCaseStudy);

// Compound index for tenant queries
CampaignCaseStudySchema.index({ tenantId: 1, product: 1 });
