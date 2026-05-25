import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type IntelligenceBriefDocument = HydratedDocument<IntelligenceBrief>;

@Schema({ collection: 'intelligence_briefs', timestamps: true })
export class IntelligenceBrief {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ index: true })
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

  @Prop({ default: '' })
  hook: string;

  @Prop({ default: '' })
  keyMessage: string;

  @Prop({ default: '' })
  conversionBridge: string;

  /**
   * Audience funnel stage — determines whether the creative team writes
   * cold-prospect copy (problem-first 5-line, brand intro), warm-retarget copy
   * (offer-recall 2-3 line, no brand intro, no "Kya aap bhi…" hooks), or hot
   * cart-recovery copy (1-2 line urgency referencing the abandoned action).
   * Defaults to 'cold' since most first-pass strategy briefs target prospecting.
   */
  @Prop({ required: false, enum: ['cold', 'warm', 'hot'], default: 'cold' })
  audienceStage?: 'cold' | 'warm' | 'hot';

  /**
   * Exploration-arm flag — closed-loop drift mitigation. Set to true on 1-of-N
   * briefs per run by the Strategy Team when the brief uses a hookStyle NOT in
   * winningHooks AND NOT in losingHooks. Downstream Creative Team must NOT
   * inject winningHooks/winningExemplars for these briefs (let the LLM
   * generate freely). Performance of exploration-arm briefs vs exploitation
   * briefs over rolling windows tells us whether the closed loop is drifting.
   * Default false — most briefs are exploitation.
   */
  @Prop({ required: false, default: false })
  explorationArm?: boolean;

  /**
   * Exploit-winner arm — mirror of explorationArm. Set to true on 1-of-N briefs
   * per run when company.learnings.hotWinners is non-empty and the Strategy
   * Team forces a clone of the top winner (varying topic/angle, keeping
   * hookStyle × audienceType × format × budgetTier constant).
   *
   * Downstream: Creative Team anchors on the winner's hookLine pattern, and
   * Campaign Review skips the cold-start 60% budget cut because the budget
   * tier already proved out on the source winner. Tagged so we can later
   * measure clone-vs-original CPA drift.
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
   * Audience segment NAME from product.audienceSegments[] that this brief
   * targets. Strategy Team picks one per brief (e.g. "career_anxious" or
   * "dosha_worried"). Campaign-creator's TS resolver translates this name
   * into concrete ad-set targeting (age/gender/interests) at launch time.
   * Replaces the previous "Campaign Review Team picks targeting from
   * free-text" path which drifted toward advantage_plus + zero filters.
   */
  @Prop({ required: false, default: '' })
  targetSegment?: string;

  /**
   * Language for ALL downstream creative output (copy, image overlay, VO).
   * Strategy Team picks this autonomously based on audience description and
   * geo signals. When unset (older briefs), creative-producer falls back to
   * geo-derived → product.languages → 'hinglish'.
   * Canonical lowercase: hinglish | hindi | marathi | tamil | telugu | bengali
   *   | gujarati | punjabi | kannada | malayalam | english.
   */
  @Prop({ required: false, default: '' })
  targetLanguage?: string;

  @Prop({ required: true, default: 0 })
  confidenceScore: number;

  @Prop({ required: true, default: 0 })
  urgencyScore: number;

  @Prop({ required: true, default: 0 })
  finalScore: number;

  @Prop({ type: [String], default: [] })
  sourcePlatforms: string[];

  @Prop({ required: true, default: 0 })
  suggestedBudget: number;

  @Prop({ default: false })
  selected: boolean;

  // Performance written back by auditor (Phase 6)
  @Prop({ type: Object, default: {} })
  performanceWritten: {
    day7?: boolean;
    day14?: boolean;
    day30?: boolean;
  };

  @Prop({ type: Object })
  day7Performance?: { roas: number; ctr: number; cpc: number; conversions: number };

  @Prop({ type: Object })
  day14Performance?: { roas: number; ctr: number; cpc: number; conversions: number };

  @Prop({ type: Object })
  day30Performance?: { roas: number; ctr: number; cpc: number; conversions: number };

  /**
   * Per-ad-set performance breakdown — kills the blended-ROAS problem where a
   * brief that launched 4 ad sets (1 winner ROAS 4.0 + 3 losers 0.5) was filed
   * as ROAS 1.0 and treated as mediocre. Causal-attribution layers can now
   * read per-ad-set rows and reason about hookStyle × audienceType × format
   * effects independently. Populated by campaign-auditor.writePerformanceBack
   * at each Day 7/14/30 cycle alongside the legacy day*Performance fields.
   */
  @Prop({ type: [Object], default: [] })
  adSetPerformance?: Array<{
    adSetId: string;
    name: string;
    audienceType: string;
    hookStyles: string[];     // distinct hookStyles in this ad set's ads
    formats: string[];        // distinct formats ('video' | 'image') in this ad set
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    cpa: number;
    roas: number;
    capturedAt: Date;
    capturedAtDay: 7 | 14 | 30;
  }>;
}

export const IntelligenceBriefSchema = SchemaFactory.createForClass(IntelligenceBrief);
