import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AuditSnapshotDocument = HydratedDocument<AuditSnapshot>;

@Schema({ collection: 'audit_snapshots', timestamps: true })
export class AuditSnapshot {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  campaignId: string;

  @Prop({ required: true })
  metaCampaignId: string;

  @Prop({ required: true })
  auditedAt: Date;

  // Campaign-level metrics at this snapshot
  @Prop({ required: true, type: Object })
  metrics: {
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    roas: number;
    ctr: number;
    cpc: number;
    cpa: number;
    frequency: number;
  };

  // Ad set level snapshots
  @Prop({ type: [Object], default: [] })
  adSets: {
    metaAdSetId: string;
    name: string;
    audienceType: string;
    spend: number;
    conversions: number;
    ctr: number;
    cpa: number;
    roas: number;
    frequency: number;
  }[];

  // Ad level snapshots
  @Prop({ type: [Object], default: [] })
  ads: {
    metaAdId: string;
    name: string;
    hookStyle: string;
    copyVariantIndex: number;
    adSetId: string;
    spend: number;
    impressions: number;
    conversions: number;
    ctr: number;
    cpc: number;
  }[];

  // Agent verdict at this audit
  @Prop({ type: Object, default: null })
  verdict: {
    verdict: 'watch' | 'act' | 'no_action';
    urgency: 'immediate' | '48h' | '7d' | null;
    contextInsight: string;
    watchSignals: string[];
    recommendedActions: {
      type:
        | 'pause_ad'
        | 'pause_adset'
        | 'scale_adset'
        | 'replace_creative'
        | 'add_creative'
        | 'add_adset'
        | 'shift_budget_between_adsets'
        | 'reduce_total_budget'
        | 'narrow_placement'
        | 'dayparting'
        | 'refresh_audience';
      targetId: string;
      targetName: string;
      reason: string;
      priority: 'high' | 'medium' | 'low';
      params?: Record<string, any>;
    }[];
  } | null;
}

export const AuditSnapshotSchema = SchemaFactory.createForClass(AuditSnapshot);
