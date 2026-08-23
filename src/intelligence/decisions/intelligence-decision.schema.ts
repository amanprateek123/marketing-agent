import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type IntelligenceDecisionDocument =
  HydratedDocument<IntelligenceDecision>;

export type DecisionStatus =
  | 'shadow_review'
  | 'approved'
  | 'rejected'
  | 'expired';

export type DecisionExecutionStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'blocked';

export type IntelligenceDecisionContractVersion = 'goal_aware_v1';

export interface IntelligenceDecisionExpectedImpact {
  metric: string;
  deltaPct: number;
  confidence: number;
}

/**
 * intelligence_decisions — one document per proposed action from the
 * intelligence pipeline.
 *
 * Lifecycle:
 *   shadow_review (created) → approved / rejected (human review) → expired (>48h)
 *
 * The AUTOMATIC cascade (IntelligenceCascadeScheduler → ExecutionEngine)
 * never writes to Meta — every action it generates is unconditionally
 * deferred with shadowModeOnly=true, cascade-wide, no exceptions.
 *
 * A HUMAN approving a specific decision via POST .../approve is a separate,
 * deliberate path: DecisionsController calls executeApprovedDecision, which
 * DOES call Meta for that one decision (via CampaignAuditorService's
 * already-proven pendingActions execution pipeline) and records the result
 * in executedAt/executionError. See executeApprovedDecision for the only
 * code path in this system that ever mutates a live campaign.
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
  @Prop({ type: MongooseSchema.Types.Mixed }) parameters?: Record<
    string,
    unknown
  >;

  /**
   * Goal-aware decision contract. These fields are optional so historical
   * rows remain readable, but every new Recommendation Engine write includes
   * them. The UI uses the version marker—not guessed legacy reasoning—to
   * decide whether objective/KPI claims are safe to show.
   */
  @Prop() decisionContractVersion?: IntelligenceDecisionContractVersion;
  @Prop() objective?: string;
  @Prop() primaryKPI?: string;
  @Prop({ type: MongooseSchema.Types.Mixed })
  expectedImpact?: IntelligenceDecisionExpectedImpact;
  @Prop() financialDataAvailable?: boolean;

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
    /** Canonical v1 field names. Optional for malformed historical rows. */
    signalKind?: string;
    signalReasoning?: string;
    /** Legacy Recommendation v1.3 rows accidentally used these names. */
    kind?: string;
    reasoning?: string;
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
   * The (automatic) Execution Engine reads it before doing anything and
   * always defers while it's true. A human approving this specific decision
   * via POST /approve is a separate, deliberate override path (see
   * DecisionsService.executeApprovedDecision) — it flips this to false
   * and performs the real Meta call. shadowModeOnly=true here documents
   * "the automatic cascade never touched this"; it does not mean "this
   * decision can never be executed by a human."
   */
  @Prop({ required: true, default: true }) shadowModeOnly!: boolean;

  /** Set once executeApprovedDecision successfully applies this to Meta. */
  @Prop() executedAt?: Date;
  /**
   * Separate from the human-review status: an approved decision can be
   * pending, claimed by one executor, successfully applied, transiently
   * failed, or permanently blocked by validation. The atomic in_progress
   * claim is what prevents concurrent approval requests from calling Meta
   * twice for the same decision.
   */
  @Prop({
    enum: ['pending', 'in_progress', 'succeeded', 'failed', 'blocked'],
    default: 'pending',
  })
  executionStatus?: DecisionExecutionStatus;
  @Prop({ default: 0 }) executionAttempts?: number;
  @Prop() executionClaimedAt?: Date;
  /** Internal compare-and-set token; never include it in normal query output. */
  @Prop({ select: false }) executionClaimToken?: string;
  /** Error message from the last failed execution attempt, if any. */
  @Prop() executionError?: string;
}

export const IntelligenceDecisionSchema =
  SchemaFactory.createForClass(IntelligenceDecision);

// Fast query for "what's pending review right now?"
IntelligenceDecisionSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
// Per-campaign history
IntelligenceDecisionSchema.index({ tenantId: 1, campaignId: 1, createdAt: -1 });
// Unique action per cycle — prevents double-writes on cycle re-runs
IntelligenceDecisionSchema.index({ cycleId: 1, actionId: 1 }, { unique: true });
