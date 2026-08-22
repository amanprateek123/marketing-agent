import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RecommendedAction } from '../orchestrator/decision-context';
import { SliceRepository } from '../shared/slice-repository.service';
import {
  DecisionTraceStep,
  buildDecisionTrace,
} from './decision-trace.builder';
import { CampaignAuditorService } from '../../campaigns/campaign-auditor/campaign-auditor.service';
import {
  DecisionStatus,
  IntelligenceDecision,
  IntelligenceDecisionDocument,
} from './intelligence-decision.schema';
import { Campaign } from '../../campaigns/schemas/campaign.schema';

const REVIEW_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

@Injectable()
export class DecisionsService {
  private readonly log = new Logger(DecisionsService.name);

  constructor(
    @InjectModel(IntelligenceDecision.name)
    private readonly model: Model<IntelligenceDecisionDocument>,
    private readonly campaignAuditor: CampaignAuditorService,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<Campaign>,
    // Provided by the @Global() IntelligenceSharedModule — no import needed here.
    private readonly slices: SliceRepository,
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
    const rows = await this.model
      .find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(500, Math.max(1, input.limit ?? 100)))
      .lean()
      .exec();

    return this.collapseDuplicates(rows);
  }

  /**
   * Collapse still-open proposals that say the same thing.
   *
   * Two open decisions with the same (campaign, target, actionType) are the
   * same suggestion — the engine's own dedup uses exactly that key. They
   * existed because actionId was a random UUID, so the {cycleId, actionId}
   * unique index could not reject a re-run and the review UI listed "Refresh
   * the creative" and "Stop the ad" twice each.
   *
   * actionId is deterministic now, so new runs cannot duplicate. This guards
   * the rows already written under the old scheme — a read-side collapse
   * rather than a migration, since the stored decisions are real records of
   * what was proposed and shouldn't be rewritten to tidy a display bug. The
   * newest of each pair wins; the rest age out on their own review window.
   *
   * Only open proposals are collapsed. Reviewed history (approved, rejected,
   * expired) is left intact — that IS a log, and deduplicating it would hide
   * that the same suggestion was made and answered more than once.
   */
  private async collapseDuplicates(
    rows: IntelligenceDecision[],
  ): Promise<IntelligenceDecision[]> {
    const open = rows.filter((r) => r.status === 'shadow_review');

    // Second collapse: the SAME lever offered at two scopes.
    //
    // Signals fire independently at campaign and ad-set level, so a
    // single-ad-set campaign got "increase budget (whole campaign)" AND
    // "increase budget (ad group)" — the same money, listed twice, with
    // nothing on screen to tell them apart. The engine no longer emits both,
    // but rows written before that fix are still inside their 48h window.
    //
    // Gated on the campaign genuinely having one ad set: with two or more,
    // campaign-wide and single-ad-set budget changes are different decisions
    // and both belong on screen.
    const singleAdSetCampaigns = new Set<string>();
    const campaignIds = [...new Set(open.map((r) => r.campaignId))].filter(Boolean);
    if (campaignIds.length) {
      try {
        const docs = await this.campaignModel
          .find({ _id: { $in: campaignIds } })
          .select('metaAdSets')
          .lean()
          .exec();
        for (const d of docs as Array<{ _id: unknown; metaAdSets?: unknown[] }>) {
          if ((d.metaAdSets ?? []).length <= 1) {
            singleAdSetCampaigns.add(String(d._id));
          }
        }
      } catch (err) {
        this.log.warn(`ad-set count lookup: ${(err as Error).message}`);
      }
    }
    const hasAdSetTwin = new Set(
      open
        .filter((r) => r.targetType === 'adset')
        .map((r) => `${r.campaignId}|${r.actionType}`),
    );

    const seen = new Set<string>();
    const out: IntelligenceDecision[] = [];
    for (const r of rows) {
      if (r.status !== 'shadow_review') {
        out.push(r);
        continue;
      }
      if (
        r.targetType === 'campaign' &&
        singleAdSetCampaigns.has(String(r.campaignId)) &&
        hasAdSetTwin.has(`${r.campaignId}|${r.actionType}`)
      ) {
        continue;
      }
      const key = `${r.campaignId}|${r.targetType}|${r.targetId}|${r.actionType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
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
   * Record the human approval itself. The controller immediately follows this
   * with executeApprovedDecision(); keeping the writes separate preserves the
   * reviewer decision even when the live Meta call fails.
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

  /**
   * Actually apply an approved decision to the live Meta campaign. Separate
   * from approve() so a decision can be marked "approved" even if the Meta
   * call fails — the human's judgment call and the execution outcome are
   * two different facts. Uses the decision's OWN stored tenantId (not a
   * caller-supplied one) so this can only ever touch the campaign the
   * decision was actually generated for.
   */
  async executeApprovedDecision(decisionId: string): Promise<{
    executed: boolean;
    error?: string;
  }> {
    const doc = await this.model.findById(decisionId).exec();
    if (!doc) throw new NotFoundException(`decision ${decisionId} not found`);
    if (!doc.campaignId) {
      doc.executionError = 'Decision has no campaignId — cannot execute';
      await doc.save();
      return { executed: false, error: doc.executionError };
    }

    try {
      await this.campaignAuditor.executeExternalAction(
        doc.tenantId,
        doc.campaignId,
        {
          actionId: doc.actionId,
          type: doc.actionType,
          targetId: doc.targetId,
          targetName: doc.campaignName || doc.targetId,
          reason: doc.reasoning,
          metrics: (doc.parameters ?? {}) as Record<string, unknown>,
        },
      );
      doc.executedAt = new Date();
      doc.executionError = undefined;
      doc.shadowModeOnly = false;
      await doc.save();
      this.log.log(
        `Executed decision ${decisionId} (${doc.actionType} on ${doc.targetId}) for tenant=${doc.tenantId}`,
      );
      return { executed: true };
    } catch (err) {
      doc.executionError = (err as Error).message;
      await doc.save();
      this.log.error(
        `Execution failed for decision ${decisionId}: ${doc.executionError}`,
      );
      return { executed: false, error: doc.executionError };
    }
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

  /**
   * The sixteen-step reasoning trace behind one decision.
   *
   * Loads the slices the cycle already wrote and renders them in plain English
   * — no engine is re-run, so this is read-only, cheap, and always shows the
   * reasoning that actually produced the decision rather than what the engines
   * would conclude if asked again now.
   *
   * A cycle whose slices have been pruned still returns all sixteen steps,
   * each marked `no_data`. That's deliberate: "step 9 recorded nothing" is a
   * real and useful answer, and collapsing the list would hide which parts of
   * the cascade were silent.
   */
  /**
   * Cycle-level trace: the sixteen steps for one cascade run, whether or not
   * it ended in a recommendation.
   *
   * `trace()` below can only be reached through a decision, so a cycle that
   * proposed nothing — every action gated, or the campaign simply healthy —
   * has no readable record at all, even though its sixteen slices were all
   * computed and stored. That is the case an operator most often wants to
   * inspect ("it looked and did nothing — why?").
   *
   * When the cycle DID produce decisions, the highest-scoring one is passed
   * in so the decision-specific highlighting still appears.
   */
  async cycleTrace(tenantId: string, cycleId: string, includeLogs = false) {
    const slices = await this.slices.loadFull(cycleId);
    if (!slices || Object.keys(slices).length === 0) {
      throw new NotFoundException(`No engine output found for cycle ${cycleId}`);
    }

    const decisions = await this.model
      .find({ tenantId, cycleId })
      .sort({ score: -1 })
      .lean()
      .exec();
    const top = decisions[0];

    const steps = buildDecisionTrace({
      slices,
      decision: top
        ? {
            actionId: top.actionId,
            actionType: top.actionType,
            targetId: top.targetId,
            expectedProfitDeltaINR7d: top.expectedProfitDeltaINR7d,
            confidence: top.confidence,
            gatedBy: top.gatedBy,
            evidenceSnapshot: top.evidenceSnapshot,
          }
        : undefined,
    });

    return {
      cycleId,
      campaignName: top?.campaignName ?? '',
      decisionsInCycle: decisions.length,
      topDecisionId: top ? String((top as { _id: unknown })._id) : null,
      stepsWithData: steps.filter((s) => s.status === 'ok').length,
      totalSteps: steps.length,
      steps: stripLogs(steps, includeLogs),
    };
  }

  async trace(tenantId: string, decisionId: string, includeLogs = false) {
    const decision = await this.model.findOne({ _id: decisionId, tenantId }).lean().exec();
    if (!decision) {
      throw new NotFoundException(`Decision ${decisionId} not found`);
    }

    const slices = await this.slices.loadFull(decision.cycleId);
    const steps = buildDecisionTrace({
      slices,
      decision: {
        actionId: decision.actionId,
        actionType: decision.actionType,
        targetId: decision.targetId,
        expectedProfitDeltaINR7d: decision.expectedProfitDeltaINR7d,
        confidence: decision.confidence,
        gatedBy: decision.gatedBy,
        evidenceSnapshot: decision.evidenceSnapshot,
      },
    });

    return {
      decisionId,
      cycleId: decision.cycleId,
      campaignName: decision.campaignName ?? '',
      actionType: decision.actionType,
      status: decision.status,
      // How much of the cascade actually left a record — the honest header for
      // a trace whose middle is empty.
      stepsWithData: steps.filter((s) => s.status === 'ok').length,
      totalSteps: steps.length,
      steps: stripLogs(steps, includeLogs),
    };
  }
}

/**
 * Raw slice logs are opt-in.
 *
 * They are a `key = value` dump of the engine's own output — up to 150 lines
 * per step, sixteen steps — and the review UI no longer renders them, so
 * shipping them by default was pure payload. They remain reachable with
 * ?includeLogs=true for anyone debugging the cascade, and the full slice is
 * always in intelligence_engine_outputs regardless.
 */
function stripLogs(
  steps: DecisionTraceStep[],
  includeLogs: boolean,
): DecisionTraceStep[] {
  if (includeLogs) return steps;
  return steps.map((s) => ({ ...s, logs: [] }));
}
