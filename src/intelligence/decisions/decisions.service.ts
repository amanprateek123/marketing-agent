import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
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
import {
  Campaign,
  isManagedCampaignSource,
} from '../../campaigns/schemas/campaign.schema';

const REVIEW_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

type ExecutableTargetType = 'campaign' | 'adset' | 'ad';

/**
 * The legacy executor is action-specific: several levers only understand a
 * Meta ad/ad-set id even though an old recommendation may have been stored at
 * campaign scope. Keep that distinction explicit at the final write boundary
 * so an internal campaign id can never be sent to an ad-set/ad Meta endpoint.
 */
const EXECUTABLE_ACTION_SCOPE: Record<string, ExecutableTargetType> = {
  pause_ad: 'ad',
  pause_adset: 'adset',
  scale_adset: 'adset',
  replace_creative: 'ad',
  add_creative: 'adset',
  add_adset: 'campaign',
  shift_budget_between_adsets: 'adset',
  reduce_total_budget: 'campaign',
  narrow_placement: 'adset',
  dayparting: 'adset',
};

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
    decisionContext?: {
      objective: string;
      primaryKPI: string;
      financialDataAvailable?: boolean;
    };
    actions: RecommendedAction[];
    signalReasoningByActionId: Record<
      string,
      {
        signalKind: string;
        signalReasoning: string;
        metrics: Record<string, number>;
      }
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
      decisionContractVersion: input.decisionContext
        ? ('goal_aware_v1' as const)
        : undefined,
      objective: input.decisionContext?.objective,
      primaryKPI: input.decisionContext?.primaryKPI,
      expectedImpact: input.decisionContext ? a.expectedImpact : undefined,
      financialDataAvailable: input.decisionContext?.financialDataAvailable,
      expectedProfitDeltaINR7d: a.expectedProfitDeltaINR7d,
      reasoning: a.reasoning,
      evidenceChain: a.evidenceChain,
      risk: a.risk,
      score: a.score,
      confidence: a.expectedImpact.confidence,
      gatedBy: a.gatedBy,
      requiresHumanApproval: a.requiresHumanApproval,
      evidenceSnapshot:
        input.signalReasoningByActionId[a.actionId] ?? undefined,
      reviewWindowExpiresAt: expires,
      status: 'shadow_review' as DecisionStatus,
      shadowModeOnly: true,
      executionStatus: 'pending' as const,
      executionAttempts: 0,
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
      const written =
        (err as { insertedDocs?: unknown[] }).insertedDocs?.length ?? 0;
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
    const campaignIds = [...new Set(open.map((r) => r.campaignId))].filter(
      Boolean,
    );
    if (campaignIds.length) {
      try {
        const docs = await this.campaignModel
          .find({ _id: { $in: campaignIds } })
          .select('metaAdSets')
          .lean()
          .exec();
        for (const d of docs as Array<{
          _id: unknown;
          metaAdSets?: unknown[];
        }>) {
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
    tenantId: string,
    decisionId: string,
    reviewer?: string,
    notes?: string,
  ): Promise<IntelligenceDecision> {
    const now = new Date();
    const set: Record<string, unknown> = {
      status: 'approved',
      humanReviewedAt: now,
      executionStatus: 'pending',
    };
    if (reviewer) set.humanReviewedBy = reviewer;
    if (notes) set.humanReviewNotes = notes;

    // Compare-and-set is intentional: two simultaneous reviewers cannot both
    // transition the same proposal and therefore cannot both reach Meta.
    const doc = await this.model
      .findOneAndUpdate(
        {
          _id: decisionId,
          tenantId,
          status: 'shadow_review',
          reviewWindowExpiresAt: { $gt: now },
        },
        { $set: set },
        { new: true },
      )
      .exec();
    if (doc) return doc.toObject();

    return this.reviewTransitionFailure(tenantId, decisionId, 'approved', now);
  }

  /**
   * Actually apply an approved decision to the live Meta campaign. Separate
   * from approve() so a decision can be marked "approved" even if the Meta
   * call fails — the human's judgment call and the execution outcome are
   * two different facts. Uses the decision's OWN stored tenantId (not a
   * caller-supplied one) so this can only ever touch the campaign the
   * decision was actually generated for.
   */
  async executeApprovedDecision(
    tenantId: string,
    decisionId: string,
    options: { retryFailed?: boolean } = {},
  ): Promise<{
    executed: boolean;
    error?: string;
  }> {
    const claimToken = randomUUID();
    const claimedAt = new Date();
    const claimableExecutionStates: Array<Record<string, unknown>> = [
      { executionStatus: { $exists: false } }, // approved legacy rows
      { executionStatus: 'pending' },
    ];
    if (options.retryFailed) {
      claimableExecutionStates.push({ executionStatus: 'failed' });
    }

    // Claim BEFORE any mutable external work. Only the request that wins this
    // conditional update may call the executor; every concurrent request sees
    // in_progress/succeeded and exits without touching Meta.
    const doc = await this.model
      .findOneAndUpdate(
        {
          _id: decisionId,
          tenantId,
          status: 'approved',
          executedAt: { $exists: false },
          $or: claimableExecutionStates,
        },
        {
          $set: {
            executionStatus: 'in_progress',
            executionClaimedAt: claimedAt,
            executionClaimToken: claimToken,
          },
          $unset: { executionError: 1 },
          $inc: { executionAttempts: 1 },
        },
        { new: true },
      )
      .exec();
    if (!doc) {
      return this.executionClaimFailure(
        tenantId,
        decisionId,
        Boolean(options.retryFailed),
      );
    }

    let campaign: Campaign | null;
    try {
      campaign = doc.campaignId
        ? await this.campaignModel
            .findOne({ _id: doc.campaignId, tenantId: doc.tenantId })
            .lean()
            .exec()
        : null;
    } catch (err) {
      const executionError = `Execution preflight failed: ${(err as Error).message}`;
      await this.finishExecutionClaim(
        tenantId,
        decisionId,
        claimToken,
        'failed',
        executionError,
      );
      return { executed: false, error: executionError };
    }
    const validationError = this.validateForExecution(doc, campaign);
    if (validationError) {
      await this.finishExecutionClaim(
        tenantId,
        decisionId,
        claimToken,
        'blocked',
        validationError,
      );
      this.log.warn(
        `Execution blocked for decision ${decisionId}: ${validationError}`,
      );
      return { executed: false, error: validationError };
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
      const completedAt = new Date();
      const completed = await this.model
        .findOneAndUpdate(
          {
            _id: decisionId,
            tenantId,
            executionStatus: 'in_progress',
            executionClaimToken: claimToken,
          },
          {
            $set: {
              executionStatus: 'succeeded',
              executedAt: completedAt,
              shadowModeOnly: false,
            },
            $unset: {
              executionError: 1,
              executionClaimToken: 1,
            },
          },
          { new: true },
        )
        .exec();
      if (!completed) {
        // Do not release/retry an uncertain claim: Meta may already have
        // applied the mutation. Leaving it in_progress forces reconciliation
        // and, importantly, prevents a second blind Meta call.
        const error =
          'Meta call completed but the execution record could not be finalized; manual reconciliation is required';
        this.log.error(`Execution uncertain for decision ${decisionId}`);
        return { executed: false, error };
      }
      this.log.log(
        `Executed decision ${decisionId} (${doc.actionType} on ${doc.targetId}) for tenant=${doc.tenantId}`,
      );
      return { executed: true };
    } catch (err) {
      const executionError = (err as Error).message;
      await this.finishExecutionClaim(
        tenantId,
        decisionId,
        claimToken,
        'failed',
        executionError,
      );
      this.log.error(
        `Execution failed for decision ${decisionId}: ${executionError}`,
      );
      return { executed: false, error: executionError };
    }
  }

  /**
   * Retry is deliberately explicit. A normal duplicate approve/execute request
   * cannot retry a failed Meta call because a network error may have an
   * ambiguous outcome. An operator must request this path knowingly; the same
   * atomic claim still allows only one retry request through.
   */
  async retryFailedExecution(
    tenantId: string,
    decisionId: string,
  ): Promise<{ executed: boolean; error?: string }> {
    return this.executeApprovedDecision(tenantId, decisionId, {
      retryFailed: true,
    });
  }

  private async finishExecutionClaim(
    tenantId: string,
    decisionId: string,
    claimToken: string,
    status: 'failed' | 'blocked',
    error: string,
  ): Promise<void> {
    await this.model
      .updateOne(
        {
          _id: decisionId,
          tenantId,
          executionStatus: 'in_progress',
          executionClaimToken: claimToken,
        },
        {
          $set: { executionStatus: status, executionError: error },
          $unset: { executionClaimToken: 1 },
        },
      )
      .exec();
  }

  private async executionClaimFailure(
    tenantId: string,
    decisionId: string,
    retryFailed: boolean,
  ): Promise<{ executed: false; error: string }> {
    const doc = await this.model
      .findOne({ _id: decisionId, tenantId })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException(`decision ${decisionId} not found`);
    if (doc.status !== 'approved') {
      return {
        executed: false,
        error: `Decision is ${doc.status}; only approved decisions can execute`,
      };
    }
    if (doc.executedAt || doc.executionStatus === 'succeeded') {
      return { executed: false, error: 'Decision was already executed' };
    }
    if (doc.executionStatus === 'in_progress') {
      return {
        executed: false,
        error: 'Decision execution is already in progress',
      };
    }
    if (doc.executionStatus === 'blocked') {
      return {
        executed: false,
        error: doc.executionError || 'Decision execution is blocked',
      };
    }
    if (doc.executionStatus === 'failed' && !retryFailed) {
      return {
        executed: false,
        error:
          'Previous execution failed; use the explicit retry-execution endpoint after checking Meta',
      };
    }
    return {
      executed: false,
      error: 'Decision could not be claimed for execution',
    };
  }

  /**
   * Validate the stored proposal against the campaign as it exists NOW.
   *
   * This deliberately runs immediately before the executor is called. A
   * recommendation can sit in review for 48h, during which its campaign or
   * target may be paused, replaced or re-synced. Invalid input returns a
   * human-readable error and, critically, does not enqueue a pending action or
   * call Meta.
   */
  private validateForExecution(
    doc: IntelligenceDecisionDocument,
    campaign: Campaign | null,
  ): string | undefined {
    if (!doc.campaignId) return 'Decision has no campaignId — cannot execute';
    if (!campaign) {
      return `Campaign ${doc.campaignId} was not found in tenant ${doc.tenantId}`;
    }
    if (!isManagedCampaignSource(campaign.source)) {
      return 'Decision targets a Meta-imported/manual campaign; it is read-only';
    }
    if (campaign.status !== 'active') {
      return `Campaign is ${campaign.status}; only active campaigns can be mutated`;
    }
    if (!campaign.metaCampaignId) {
      return 'Campaign has no Meta campaign id';
    }
    if (
      doc.metaCampaignId &&
      String(doc.metaCampaignId) !== String(campaign.metaCampaignId)
    ) {
      return `Decision Meta campaign ${doc.metaCampaignId} no longer matches campaign ${campaign.metaCampaignId}`;
    }

    const expectedTargetType = EXECUTABLE_ACTION_SCOPE[doc.actionType];
    if (!expectedTargetType) {
      return `Unsupported action type: ${doc.actionType}`;
    }
    if (doc.targetType !== expectedTargetType) {
      const expectedLabel =
        expectedTargetType === 'adset' ? 'ad-set' : expectedTargetType;
      const article = expectedTargetType === 'adset' ? 'an' : 'a';
      return `${doc.actionType} requires ${article} ${expectedLabel} target, not ${doc.targetType}`;
    }
    if (!doc.targetId || !String(doc.targetId).trim()) {
      return `${doc.actionType} has no target id`;
    }

    const legacyAdSets = (campaign.adSets ?? []) as Array<{
      metaAdSetId?: string;
      ads?: Array<{ metaAdId?: string }>;
    }>;
    const syncedAdSets = (campaign.metaAdSets ?? []) as Array<{
      id?: string;
      ads?: Array<{ id?: string }>;
    }>;
    const adSetIds = new Set([
      ...legacyAdSets.map((adSet) => String(adSet.metaAdSetId ?? '')),
      ...syncedAdSets.map((adSet) => String(adSet.id ?? '')),
    ]);
    const adIds = new Set([
      ...legacyAdSets.flatMap((adSet) =>
        (adSet.ads ?? []).map((ad) => String(ad.metaAdId ?? '')),
      ),
      ...syncedAdSets.flatMap((adSet) =>
        (adSet.ads ?? []).map((ad) => String(ad.id ?? '')),
      ),
    ]);
    const targetId = String(doc.targetId);

    if (expectedTargetType === 'campaign') {
      const campaignIds = new Set([
        String((campaign as Campaign & { _id?: unknown })._id ?? ''),
        String(campaign.metaCampaignId),
        String(doc.campaignId),
      ]);
      if (!campaignIds.has(targetId)) {
        return `Campaign target ${targetId} does not belong to decision campaign ${doc.campaignId}`;
      }
    } else if (expectedTargetType === 'adset' && !adSetIds.has(targetId)) {
      return `Ad set ${targetId} does not belong to decision campaign ${doc.campaignId}`;
    } else if (expectedTargetType === 'ad' && !adIds.has(targetId)) {
      return `Ad ${targetId} does not belong to decision campaign ${doc.campaignId}`;
    }

    return this.validateActionParameters(doc.actionType, doc.parameters ?? {}, {
      adSetIds,
      targetId,
    });
  }

  private validateActionParameters(
    actionType: string,
    parameters: Record<string, unknown>,
    scope: { adSetIds: Set<string>; targetId: string },
  ): string | undefined {
    if (actionType === 'add_adset') {
      // The legacy executor still derives/falls back across audience, product,
      // landing-page and creative data. Until the recommendation contract
      // carries every one of those immutable launch inputs, executing it would
      // mean inventing high-impact campaign configuration at approval time.
      return 'add_adset is review-only: the required audience, product, landing-page, budget, and creative launch contract is not complete';
    }

    if (actionType === 'shift_budget_between_adsets') {
      const toAdSetId =
        typeof parameters.toAdSetId === 'string'
          ? parameters.toAdSetId.trim()
          : '';
      const shiftPercent = Number(parameters.shiftPercent);
      if (!toAdSetId) return 'shift_budget_between_adsets needs toAdSetId';
      if (!scope.adSetIds.has(toAdSetId)) {
        return `Recipient ad set ${toAdSetId} does not belong to this campaign`;
      }
      if (toAdSetId === scope.targetId) {
        return 'Budget-shift donor and recipient must be different ad sets';
      }
      if (
        !Number.isFinite(shiftPercent) ||
        shiftPercent <= 0 ||
        shiftPercent > 50
      ) {
        return 'shift_budget_between_adsets needs shiftPercent in (0, 50]';
      }
    }

    if (actionType === 'reduce_total_budget') {
      const reductionPercent = Number(parameters.reductionPercent);
      if (
        !Number.isFinite(reductionPercent) ||
        reductionPercent <= 0 ||
        reductionPercent > 50
      ) {
        return 'reduce_total_budget needs reductionPercent in (0, 50]';
      }
    }

    if (actionType === 'narrow_placement') {
      const publisherPlatforms = parameters.publisherPlatforms;
      if (
        !Array.isArray(publisherPlatforms) ||
        publisherPlatforms.length === 0 ||
        publisherPlatforms.some(
          (platform) =>
            typeof platform !== 'string' || platform.trim().length === 0,
        )
      ) {
        return 'narrow_placement needs at least one publisher platform';
      }
    }

    if (actionType === 'dayparting') {
      const schedule = parameters.schedule;
      const validSlot = (slot: unknown): boolean => {
        if (!slot || typeof slot !== 'object') return false;
        const value = slot as Record<string, unknown>;
        const startMinute = Number(value.startMinute);
        const endMinute = Number(value.endMinute);
        const days = value.days;
        return (
          Number.isInteger(startMinute) &&
          Number.isInteger(endMinute) &&
          startMinute >= 0 &&
          endMinute <= 1440 &&
          startMinute < endMinute &&
          Array.isArray(days) &&
          days.length > 0 &&
          days.every(
            (day) =>
              Number.isInteger(Number(day)) &&
              Number(day) >= 0 &&
              Number(day) <= 6,
          )
        );
      };
      if (
        !Array.isArray(schedule) ||
        schedule.length === 0 ||
        !schedule.every(validSlot)
      ) {
        return 'dayparting needs valid schedule slots (minutes 0..1440, days 0..6)';
      }
    }

    return undefined;
  }

  async reject(
    tenantId: string,
    decisionId: string,
    reason: string,
    reviewer?: string,
  ): Promise<IntelligenceDecision> {
    const now = new Date();
    const set: Record<string, unknown> = {
      status: 'rejected',
      humanReviewedAt: now,
      humanReviewNotes: reason,
    };
    if (reviewer) set.humanReviewedBy = reviewer;

    // A rejection is legal only from the open review state. In particular it
    // cannot overwrite an approval while that approval is executing.
    const doc = await this.model
      .findOneAndUpdate(
        {
          _id: decisionId,
          tenantId,
          status: 'shadow_review',
          reviewWindowExpiresAt: { $gt: now },
        },
        { $set: set },
        { new: true },
      )
      .exec();
    if (doc) return doc.toObject();

    return this.reviewTransitionFailure(tenantId, decisionId, 'rejected', now);
  }

  private async reviewTransitionFailure(
    tenantId: string,
    decisionId: string,
    requestedStatus: 'approved' | 'rejected',
    now: Date,
  ): Promise<never> {
    let doc = await this.model
      .findOne({ _id: decisionId, tenantId })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException(`decision ${decisionId} not found`);

    if (
      doc.status === 'shadow_review' &&
      new Date(doc.reviewWindowExpiresAt).getTime() <= now.getTime()
    ) {
      const expired = await this.model
        .findOneAndUpdate(
          {
            _id: decisionId,
            tenantId,
            status: 'shadow_review',
            reviewWindowExpiresAt: { $lte: now },
          },
          { $set: { status: 'expired' } },
          { new: true },
        )
        .exec();
      if (expired) {
        throw new BadRequestException(
          `decision ${decisionId} review window has expired`,
        );
      }

      // Another legal transition won between the read and expiry attempt.
      doc = await this.model
        .findOne({ _id: decisionId, tenantId })
        .lean()
        .exec();
      if (!doc) {
        throw new NotFoundException(`decision ${decisionId} not found`);
      }
    }

    throw new BadRequestException(
      `decision ${decisionId} is ${doc.status}; only shadow_review decisions can be ${requestedStatus}`,
    );
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
    // Authorize the cycle identity before loading any slice payload. Without
    // the tenant predicate, a caller who learned another tenant's cycle UUID
    // could read its full diagnosis even though decision rows were scoped.
    const identity = await this.slices.identityForCycle(cycleId, tenantId);
    if (!identity) {
      throw new NotFoundException(
        `No engine output found for cycle ${cycleId}`,
      );
    }
    const slices = await this.slices.loadFull(cycleId, tenantId);
    if (!slices || Object.keys(slices).length === 0) {
      throw new NotFoundException(
        `No engine output found for cycle ${cycleId}`,
      );
    }

    const decisions = await this.model
      .find({ tenantId, cycleId })
      .sort({ score: -1 })
      .lean()
      .exec();
    const top = decisions[0];
    let campaignName = top?.campaignName ?? '';
    if (!campaignName && identity.campaignId) {
      const campaign = await this.campaignModel
        .findOne({ _id: identity.campaignId, tenantId })
        .select({ name: 1 })
        .lean()
        .exec();
      campaignName = campaign?.name ?? '';
    }

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
      campaignName,
      decisionsInCycle: decisions.length,
      topDecisionId: top ? String((top as { _id: unknown })._id) : null,
      stepsWithData: steps.filter((s) => s.status === 'ok').length,
      totalSteps: steps.length,
      steps: stripLogs(steps, includeLogs),
    };
  }

  async trace(tenantId: string, decisionId: string, includeLogs = false) {
    const decision = await this.model
      .findOne({ _id: decisionId, tenantId })
      .lean()
      .exec();
    if (!decision) {
      throw new NotFoundException(`Decision ${decisionId} not found`);
    }

    const slices = await this.slices.loadFull(decision.cycleId, tenantId);
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
