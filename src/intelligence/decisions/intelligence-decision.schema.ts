import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type IntelligenceDecisionDocument = HydratedDocument<IntelligenceDecision>;

export type DecisionStatus = 'shadow_review' | 'approved' | 'rejected' | 'expired';

/**
 * intelligence_decisions — one document per proposed action from the
 * intelligence pipeline. Local only. Nothing here ever writes to Meta.
 *
 * Lifecycle:
 *   shadow_review (created) → approved / rejected (human review) → expired (>48h)
 *
 * When the operator approves a decision, this collection ONLY updates
 * its `status` and `humanReviewedAt`. The actual Meta write (if ever
 * enabled) happens in the Execution Engine — which is currently in
 * shadow_mode_only and defers everything.
 */
@Schema({ collection: 'intelligence_decisions', timestamps: true })
export class IntelligenceDecision {
  @Prop({ required: true, index: true }) tenantId!: string;
  @Prop({ required: true, index: true }) campaignId!: string;
  @Prop() metaCampaignId?: string;
  @Prop() campaignName?: string;
  @Prop({ required: true, index: true }) cycleId!: string;

  /** Snapshot pointer this decision was based on. */
  @Prop() snapshotId?: string;

  /** The action itself — matches RecommendedAction shape. */
  @Prop({ required: true }) actionId!: string;
  @Prop({ required: true }) actionType!: string;
  @Prop({ required: true }) targetType!: string;
  @Prop({ required: true }) targetId!: string;
  @Prop({ type: MongooseSchema.Types.Mixed }) parameters?: Record<string, unknown>;

  /** Expected ₹ profit delta over 7 days if applied. */
  @Prop({ required: true, default: 0 }) expectedProfitDeltaINR7d!: number;

  /** The reasoning paragraph — surfaced verbatim in the review UI. */
  @Prop({ required: true, default: '' }) reasoning!: string;

  /** Evidence chain — traceable inputs. */
  @Prop({ type: [Object], default: [] }) evidenceChain!: Array<{
    step: string;
    source: string;
  }>;

  /** Risk classification + gating info. */
  @Prop({ required: true }) risk!: string;
  @Prop({ required: true, default: 0 }) score!: number;
  @Prop({ default: 0 }) confidence?: number;
  @Prop({ type: [String], default: [] }) gatedBy!: string[];
  @Prop({ required: true, default: true }) requiresHumanApproval!: boolean;

  /** Original snapshot of what fired this decision — for review. */
  @Prop({ type: MongooseSchema.Types.Mixed }) evidenceSnapshot?: {
    signalKind: string;
    signalReasoning: string;
    metrics: Record<string, number>;
  };

  /** Review window. Auto-marks 'expired' after `reviewWindowExpiresAt`. */
  @Prop({ required: true, index: true }) reviewWindowExpiresAt!: Date;

  /** Current status of this decision. */
  @Prop({ required: true, default: 'shadow_review', index: true })
  status!: DecisionStatus;

  /** Human review metadata. */
  @Prop() humanReviewedAt?: Date;
  @Prop() humanReviewedBy?: string;
  @Prop() humanReviewNotes?: string;

  /**
   * Explicit safety flag — the pipeline sets this true when writing.
   * The Execution Engine reads it before doing anything. Any decision
   * with shadowModeOnly=true is guaranteed to never touch Meta.
   */
  @Prop({ required: true, default: true }) shadowModeOnly!: boolean;
}

export const IntelligenceDecisionSchema =
  SchemaFactory.createForClass(IntelligenceDecision);

// Fast query for "what's pending review right now?"
IntelligenceDecisionSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
// Per-campaign history
IntelligenceDecisionSchema.index({ tenantId: 1, campaignId: 1, createdAt: -1 });
// Unique action per cycle — prevents double-writes on cycle re-runs
IntelligenceDecisionSchema.index({ cycleId: 1, actionId: 1 }, { unique: true });
