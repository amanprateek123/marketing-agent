import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RecommendedAction } from '../orchestrator/decision-context';
import {
  DecisionStatus,
  IntelligenceDecision,
  IntelligenceDecisionDocument,
} from './intelligence-decision.schema';

const REVIEW_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

@Injectable()
export class DecisionsService {
  private readonly log = new Logger(DecisionsService.name);

  constructor(
    @InjectModel(IntelligenceDecision.name)
    private readonly model: Model<IntelligenceDecisionDocument>,
  ) {}

  /**
   * Persist a batch of Recommendation Engine outputs as shadow decisions.
   * Called by the Recommendation Engine at end of each cycle.
   *
   * SAFETY: every decision written here has shadowModeOnly=true. Even
   * if Execution Engine later reads this collection, it is contractually
   * forbidden from mutating Meta while that flag is true.
   */
  async writeBatch(input: {
    tenantId: string;
    campaignId: string;
    cycleId: string;
    metaCampaignId?: string;
    snapshotId?: string;
    actions: RecommendedAction[];
    signalReasoningByActionId: Record<
      string,
      { kind: string; reasoning: string; metrics: Record<string, number> }
    >;
  }): Promise<{ written: number }> {
    if (input.actions.length === 0) return { written: 0 };
    const now = new Date();
    const expires = new Date(now.getTime() + REVIEW_WINDOW_MS);

    const docs = input.actions.map((a) => ({
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      metaCampaignId: input.metaCampaignId,
      cycleId: input.cycleId,
      snapshotId: input.snapshotId,
      actionId: a.actionId,
      actionType: a.type,
      targetType: a.targetType,
      targetId: a.targetId,
      parameters: a.parameters,
      expectedProfitDeltaINR7d: a.expectedProfitDeltaINR7d,
      reasoning: a.reasoning,
      evidenceChain: a.evidenceChain,
      risk: a.risk,
      score: a.score,
      gatedBy: a.gatedBy,
      requiresHumanApproval: a.requiresHumanApproval,
      evidenceSnapshot: input.signalReasoningByActionId[a.actionId] ?? undefined,
      reviewWindowExpiresAt: expires,
      status: 'shadow_review' as DecisionStatus,
      shadowModeOnly: true,
    }));

    try {
      // insertMany with ordered:false so a single duplicate (cycleId+actionId)
      // doesn't abort the whole batch.
      const res = await this.model.insertMany(docs, { ordered: false });
      this.log.log(
        `wrote ${res.length} shadow decisions for tenant=${input.tenantId} campaign=${input.campaignId} cycle=${input.cycleId}`,
      );
      return { written: res.length };
    } catch (err) {
      // Some docs may have failed due to duplicate key; count successes.
      const written = (err as { insertedDocs?: unknown[] }).insertedDocs?.length ?? 0;
      this.log.warn(
        `wrote ${written} shadow decisions (some duplicates skipped) for cycle=${input.cycleId}`,
      );
      return { written };
    }
  }

  /**
   * Query decisions for a tenant, optionally filtered by status +
   * campaignId. Marks stale shadow_review decisions as 'expired'
   * on-read (cheap sweep).
   */
  async list(input: {
    tenantId: string;
    status?: DecisionStatus;
    campaignId?: string;
    limit?: number;
    since?: Date;
  }): Promise<IntelligenceDecision[]> {
    await this.expireStale(input.tenantId);

    const q: Record<string, unknown> = { tenantId: input.tenantId };
    if (input.status) q.status = input.status;
    if (input.campaignId) q.campaignId = input.campaignId;
    if (input.since) q.createdAt = { $gte: input.since };
    return this.model
      .find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(500, Math.max(1, input.limit ?? 100)))
      .lean()
      .exec();
  }

  /** Auto-expire shadow_review decisions past their review window. */
  private async expireStale(tenantId: string): Promise<number> {
    const res = await this.model.updateMany(
      {
        tenantId,
        status: 'shadow_review',
        reviewWindowExpiresAt: { $lt: new Date() },
      },
      { $set: { status: 'expired' } },
    );
    return res.modifiedCount ?? 0;
  }

  /**
   * Mark a decision approved. LOCAL WRITE ONLY — this does not touch
   * Meta. Meta writes are gated by ExecutionEngine's shadow_mode flag,
   * which stays on until you explicitly disable it.
   */
  async approve(
    decisionId: string,
    reviewer?: string,
    notes?: string,
  ): Promise<IntelligenceDecision> {
    const doc = await this.model.findById(decisionId).exec();
    if (!doc) throw new NotFoundException(`decision ${decisionId} not found`);
    doc.status = 'approved';
    doc.humanReviewedAt = new Date();
    if (reviewer) doc.humanReviewedBy = reviewer;
    if (notes) doc.humanReviewNotes = notes;
    await doc.save();
    return doc.toObject();
  }

  async reject(
    decisionId: string,
    reason: string,
    reviewer?: string,
  ): Promise<IntelligenceDecision> {
    const doc = await this.model.findById(decisionId).exec();
    if (!doc) throw new NotFoundException(`decision ${decisionId} not found`);
    doc.status = 'rejected';
    doc.humanReviewedAt = new Date();
    if (reviewer) doc.humanReviewedBy = reviewer;
    doc.humanReviewNotes = reason;
    await doc.save();
    return doc.toObject();
  }

  /** Summary: counts by status, ordered by most recent. */
  async summary(tenantId: string): Promise<{
    counts: Record<DecisionStatus, number>;
    latestCycleId: string | null;
    latestCycleAt: Date | null;
  }> {
    await this.expireStale(tenantId);
    const agg = (await this.model
      .aggregate([
        { $match: { tenantId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec()) as Array<{ _id: DecisionStatus; count: number }>;
    const counts: Record<DecisionStatus, number> = {
      shadow_review: 0,
      approved: 0,
      rejected: 0,
      expired: 0,
    };
    for (const row of agg) counts[row._id] = row.count;

    const latest = await this.model
      .findOne({ tenantId })
      .sort({ createdAt: -1 })
      .select({ cycleId: 1, createdAt: 1 })
      .lean()
      .exec();

    return {
      counts,
      latestCycleId: latest?.cycleId ?? null,
      latestCycleAt: (latest as { createdAt?: Date } | null)?.createdAt ?? null,
    };
  }
}
