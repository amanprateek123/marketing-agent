import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CampaignDocument = HydratedDocument<Campaign>;

export type CampaignStatus = 'pending_approval' | 'active' | 'paused' | 'completed' | 'failed';

@Schema({ collection: 'campaigns', timestamps: true })
export class Campaign {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ required: true, index: true })
  briefId: string;

  @Prop({ default: '' })
  topic: string;

  @Prop({ default: '' })
  angle: string;

  @Prop({ default: '' })
  creativePackageId: string;

  @Prop({ index: true, sparse: true, default: '' })
  metaCampaignId: string;

  @Prop({ required: true, default: 'pending_approval' })
  status: CampaignStatus;

  @Prop({ required: true })
  budget: number;

  @Prop({ required: true })
  objective: string;

  @Prop()
  launchedAt?: Date;

  @Prop()
  approvedAt?: Date;

  @Prop()
  pausedAt?: Date;

  @Prop()
  pauseReason?: string;

  // Live metrics (written back by auditor in Phase 6)
  @Prop({ default: 0 })
  spend: number;

  @Prop({ default: 0 })
  impressions: number;

  @Prop({ default: 0 })
  clicks: number;

  @Prop({ default: 0 })
  conversions: number;

  @Prop({ default: 0 })
  roas: number;

  @Prop({ default: 0 })
  ctr: number;

  @Prop({ default: 0 })
  cpc: number;

  @Prop()
  lastAuditedAt?: Date;

  @Prop({ type: [Object], default: [] })
  auditHistory: {
    auditedAt: Date;
    action: string;
    reason: string;
    metricsBefore: Record<string, number>;
  }[];

  // Phase 9 — Campaign Review Team data
  @Prop({ type: String, default: '' })
  reviewNotes: string;

  @Prop({ type: Object, default: null })
  reviewAdjustments: {
    budgetAdjusted: boolean;
    originalBudget: number;
    recommendedBudget: number;
    targetingNotes: string;
    timingNotes: string;
    scaleRules: string;
    pauseRules: string;
  };

  @Prop({ type: [Object], default: [] })
  reviewDebateLog: { round: number; from: string; summary: string }[];

  // Structured campaign config from Campaign Review Team
  @Prop({ type: Object, default: null })
  campaignConfig: {
    budget: number;
    objective: string;
    conversionEvent: string;
    conversionValue: number;
    adSets: {
      name: string;
      budgetPercent: number;
      audienceType: string;
      metaAudienceId?: string;
      excludeAudienceIds?: string[];
      ageMin?: number;
      ageMax?: number;
      gender?: string;
      geoLocations?: string[];
      interests?: string[];
      optimizationGoal: string;
      ads: number[];
    }[];
    scaleRules: string;
    pauseRules: string;
  };

  // Meta ad set + ad IDs (populated after launch, updated by auditor)
  @Prop({ type: [Object], default: [] })
  adSets: {
    metaAdSetId: string;
    name: string;
    budgetPercent: number;
    audienceType: string;
    status: string;
    metrics?: {
      spend: number;
      impressions: number;
      clicks: number;
      conversions: number;
      ctr: number;
      cpc: number;
      cpa: number;
      frequency: number;
      reach: number;
    };
    ads: {
      metaAdId: string;
      copyVariantIndex: number;
      hookStyle: string;
      status: string;
      metrics?: {
        spend: number;
        impressions: number;
        clicks: number;
        conversions: number;
        ctr: number;
        cpc: number;
      };
      ctrBaseline?: number;          // first 48h average CTR (for fatigue detection)
      baselineSetAt?: Date;
    }[];
  }[];

  // Pending optimization actions (auditor recommends, human approves or grace period expires)
  @Prop({ type: [Object], default: [] })
  pendingActions: {
    actionId: string;
    type: 'pause_ad' | 'pause_adset' | 'scale_adset' | 'replace_creative';
    targetId: string;                 // Meta ad/adset ID
    targetName: string;
    reason: string;
    metrics: Record<string, number>;  // relevant metrics at time of recommendation
    recommendedAt: Date;
    executeAt: Date;                  // recommendedAt + gracePeriod
    status: 'pending' | 'executed' | 'overridden' | 'expired';
    executedAt?: Date;
  }[];
}

export const CampaignSchema = SchemaFactory.createForClass(Campaign);
