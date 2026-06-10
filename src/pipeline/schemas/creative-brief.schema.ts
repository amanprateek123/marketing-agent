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
    format?: 'video' | 'image' | 'carousel';
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

  /**
   * Structured A/B experiment metadata. When set, this brief is part of a
   * deliberate isolated test — variants differ ONLY on `isolatedVariable`,
   * everything else (audience, budget, format, landing) is held constant.
   *
   * Why: today the Creative Team produces 4 independent variants delivered
   * via Meta's dynamic optimization. Meta picks a winner but doesn't tell us
   * *why* — variants differ on multiple variables simultaneously (hook + image
   * + headline), so the resulting "winningHooks" learnings are correlative,
   * not causal. Structured experiments fix that: hold N-1 variables constant,
   * vary 1, attribute the win cleanly.
   *
   * MVP scaffold: schema fields only. Strategy Team prompt change + audit-
   * loop evaluator that calls the experiment at sample-size threshold come
   * in the next session. When `experimentId` is null/undefined, the brief
   * behaves as today (free-form 4-variant generation).
   */
  @Prop({ type: String, default: null })
  experimentId?: string | null;

  @Prop({
    type: String,
    enum: ['hookStyle', 'audience', 'budget_band', 'format', 'cta', 'headline_pattern', null],
    default: null,
  })
  isolatedVariable?: 'hookStyle' | 'audience' | 'budget_band' | 'format' | 'cta' | 'headline_pattern' | null;

  @Prop({ type: Number, default: null })
  controlVariantIdx?: number | null;

  /**
   * Target conversions required to declare significance. Computed at design
   * time from power-calc.util given the brief's expected effect size and the
   * baseline conversion rate. Default null = no explicit target; auditor
   * applies the standard 50-conversions-per-arm rule.
   */
  @Prop({ type: Number, default: null })
  sampleSizeTarget?: number | null;

  /**
   * Status of the experiment evaluation. 'pending' until enough data; 'evaluated'
   * once auditor runs the significance test and writes the result.
   */
  @Prop({
    type: String,
    enum: ['pending', 'evaluated', 'inconclusive', 'aborted', null],
    default: null,
  })
  experimentStatus?: 'pending' | 'evaluated' | 'inconclusive' | 'aborted' | null;
}

export const CreativeBriefSchema = SchemaFactory.createForClass(CreativeBrief);
