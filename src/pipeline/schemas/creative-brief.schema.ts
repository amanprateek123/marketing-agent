import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CreativeBriefDocument = HydratedDocument<CreativeBrief>;

@Schema({ collection: 'creative_briefs', timestamps: true })
export class CreativeBrief {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ required: true, index: true })
  briefId: string;

  @Prop({ default: '' })
  product: string;

  @Prop({ required: true })
  topic: string;

  @Prop({ required: true })
  angle: string;

  @Prop({ required: true })
  platform: string;

  @Prop({ required: true })
  format: string;

  @Prop({ required: true })
  audience: string;

  @Prop({ required: true })
  hook: string;

  @Prop({ required: true })
  keyMessage: string;

  @Prop({ required: true })
  conversionBridge: string;

  /**
   * Funnel stage carried over from the IntelligenceBrief — drives the Campaign
   * Review Team's ad-set targeting choice (cold → AP/lookalike prospecting,
   * warm → LAL + visitors retarget, hot → cart-30d retarget). Default 'cold'
   * for backward compat with briefs created before this field existed.
   */
  @Prop({ required: false, enum: ['cold', 'warm', 'hot'], default: 'cold' })
  audienceStage?: 'cold' | 'warm' | 'hot';

  /**
   * Exploration-arm flag carried over from IntelligenceBrief — when true, the
   * Creative Team must NOT inject winningHooks/winningExemplars into its
   * prompts (closed-loop drift mitigation). See intelligence-brief.schema.ts
   * for full rationale.
   */
  @Prop({ required: false, default: false })
  explorationArm?: boolean;

  /**
   * Mirror of IntelligenceBrief.winnerCloneOf. Read by Creative Team (anchor
   * on winner pattern) and Campaign Review (skip cold-start 60% cut, use
   * sourceCPA × budgetTier as the launched-budget baseline).
   */
  @Prop({ type: Object, required: false })
  winnerCloneOf?: {
    sourceCampaignId: string;
    sourceBriefId: string;
    metaAdId: string;
    hookStyle: string;
    audienceType: string;
    format?: 'video' | 'image';
    budgetTier: number;
    sourceCPA: number;
    sourceROAS: number;
    clonedAt: Date;
  };

  /**
   * Audience segment NAME from product.audienceSegments[]. Carried from
   * IntelligenceBrief so campaign-creator's TS resolver can translate it
   * into ad-set targeting (age/gender/interests) at launch time.
   */
  @Prop({ required: false, default: '' })
  targetSegment?: string;

  /**
   * Language all downstream creative renders in. Carried from IntelligenceBrief
   * so the audit-fired add_creative path can preserve language continuity
   * across the original launch + every subsequent creative refresh.
   */
  @Prop({ required: false, default: '' })
  targetLanguage?: string;

  @Prop({ required: true, default: 0 })
  suggestedBudget: number;

  @Prop({ required: true, default: 0 })
  finalScore: number;

  @Prop({ required: true, default: false })
  selected: boolean;

  @Prop({ default: '' })
  selectionReason: string;

  // Phase 9 — Strategy Team debate data
  @Prop({ type: Number, default: null })
  debateRounds: number;

  @Prop({ type: [Object], default: [] })
  debateLog: { round: number; from: string; summary: string }[];

  @Prop({ type: String, default: null })
  debateRationale: string;
}

export const CreativeBriefSchema = SchemaFactory.createForClass(CreativeBrief);
