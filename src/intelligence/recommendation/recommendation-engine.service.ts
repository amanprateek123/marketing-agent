import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import {
  IntelligenceDecision,
  IntelligenceDecisionDocument,
} from '../decisions/intelligence-decision.schema';
import { Campaign } from '../../campaigns/schemas/campaign.schema';
import {
  CampaignActionType,
  DiagnosisData,
  RecommendationData,
  RecommendedAction,
  Signal,
  SignalKind,
  TrendData,
} from '../orchestrator/decision-context';

type DiagnosisFocus = DiagnosisData['rootCauses'][number]['suggestedFocus'];

const RISK: Record<CampaignActionType, 'low' | 'medium' | 'high'> = {
  pause_ad: 'low',
  pause_adset: 'medium',
  scale_adset: 'medium',
  replace_creative: 'medium',
  add_creative: 'low',
  add_adset: 'medium',
  shift_budget_between_adsets: 'low',
  reduce_total_budget: 'low',
  narrow_placement: 'low',
  dayparting: 'low',
};
const RISK_MULT = { low: 1, medium: 1.4, high: 2.2 };

const HUMAN_APPROVAL: CampaignActionType[] = [
  'pause_ad',
  'pause_adset',
  'scale_adset',
  'replace_creative',
  'reduce_total_budget',
];

/**
 * Which targetTypes each action is valid for. Prevents e.g. reduce_total_budget
 * from being emitted with an adset targetId (which the executor could not act on).
 */
// Widened from the original design after an audit found several signal→
// action pairings were structurally dead (a signal computed at a target
// level whose only mapped action excluded that scope, so it could never
// produce a decision no matter how strong the evidence):
//   - scale_adset now also allows 'campaign' — winner_emerging/confirmed
//     fire at campaign level too (default targetType), and a campaign-wide
//     budget increase is a real, valid lever (native for CBO campaigns).
//   - reduce_total_budget now also allows 'adset' — unprofitable_run at
//     adset level previously had no budget-cut option at all, only the
//     nuclear pause_adset; a scoped cut is often the better first move.
const ACTION_SCOPE: Record<CampaignActionType, Array<'campaign' | 'adset' | 'ad'>> = {
  pause_ad: ['ad', 'adset'],
  pause_adset: ['adset'],
  scale_adset: ['adset', 'campaign'],
  replace_creative: ['ad', 'adset'],
  add_creative: ['adset', 'campaign'],
  add_adset: ['campaign'],
  shift_budget_between_adsets: ['campaign', 'adset'],
  reduce_total_budget: ['campaign', 'adset'],
  narrow_placement: ['campaign', 'adset'],
  dayparting: ['campaign'],
};

/**
 * Signal → suggested action mapping. Kept deterministic — the *scoring*
 * happens on top of this using observed evidence.
 *
 * budget_saturation now also allows pause_adset (its adset-level firing had
 * no live action before — reduce_total_budget is campaign-only in scope).
 * hook_burn now also allows pause_ad — the only signal that gives pause_ad
 * a reachable path at all; previously declared but never emitted anywhere.
 */
const SIGNAL_TO_ACTIONS: Partial<Record<SignalKind, CampaignActionType[]>> = {
  creative_fatigue: ['replace_creative', 'add_creative'],
  hook_burn: ['replace_creative', 'add_creative', 'pause_ad'],
  ctr_decay: ['replace_creative'],
  cvr_collapse: ['pause_adset', 'replace_creative'],
  frequency_ceiling: ['narrow_placement', 'dayparting'],
  audience_saturation: ['narrow_placement', 'shift_budget_between_adsets'],
  audience_exhaustion: ['shift_budget_between_adsets', 'add_adset'],
  budget_saturation: ['reduce_total_budget', 'pause_adset'],
  delivery_stalled: ['shift_budget_between_adsets'],
  placement_leak: ['narrow_placement'],
  unprofitable_run: ['pause_adset', 'reduce_total_budget'],
  winner_emerging: ['scale_adset'],
  winner_confirmed: ['scale_adset'],
  learning_limited_locked: ['shift_budget_between_adsets'],
};

/**
 * Which DiagnosisEngine "focus" categories each action serves. Used to let
 * a genuine root-cause diagnosis pull weight toward the action that
 * actually addresses it, instead of every signal-implied action competing
 * on raw ₹ estimate alone.
 */
const ACTION_FOCUS: Record<CampaignActionType, DiagnosisFocus[]> = {
  pause_ad: ['creative', 'objective_mismatch'],
  pause_adset: ['budget', 'objective_mismatch'],
  scale_adset: ['budget'],
  replace_creative: ['creative'],
  add_creative: ['creative'],
  add_adset: ['audience'],
  shift_budget_between_adsets: ['budget', 'audience'],
  reduce_total_budget: ['budget'],
  narrow_placement: ['placement', 'audience'],
  dayparting: ['placement'],
};

/**
 * Recommendation Engine v1.1
 *
 * Every recommended action is scored by **expected ₹ contribution profit
 * delta over the next 7 days**, not an abstract impact %.
 *
 * We derive the profit delta from:
 *   - observed spend velocity (₹/day) from the snapshot
 *   - observed ROAS vs Revenue Engine's breakeven ROAS
 *   - the signal's strength (proxy for how much of the trend the action reverses)
 *
 * Every action ships with:
 *   - `expectedProfitDeltaINR7d` — the operator's ₹ answer to "why do this?"
 *   - `reasoning` — one paragraph of live-observation-grounded rationale
 *   - `evidenceChain` — traceable inputs (signals, trends, revenue derivation)
 */
@Injectable()
export class RecommendationEngine extends BaseEngine<
  'recommendation',
  RecommendationData
> {
  readonly name = 'recommendation' as const;
  readonly step = 13;
  readonly version = '1.1.0';
  readonly dependsOn = [
    'snapshot',
    'objective',
    'lifecycle',
    'trend',
    'revenue',
    'signal',
    'diagnosis',
    'business',
    'portfolio',
    'forecast',
    'confidence',
    'memory',
  ] as const;

  private readonly identity = new Map<
    string,
    { tenantId: string; campaignId: string }
  >();
  private currentCycleId?: string;

  private readonly log = new Logger(RecommendationEngine.name);

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
    @Optional()
    @InjectModel(IntelligenceDecision.name)
    private readonly decisionModel: Model<IntelligenceDecisionDocument> | null,
    @Optional()
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<Campaign> | null,
  ) {
    super(sliceRepo, eventBus, registry);
    this.log.log(
      `constructor: decisionModel ${this.decisionModel ? 'INJECTED' : 'NULL'} campaignModel ${this.campaignModel ? 'INJECTED' : 'NULL'}`,
    );
  }

  @OnEvent('intelligence.memory.completed')
  async onMemoryCompleted(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
  }): Promise<void> {
    this.identity.set(payload.cycleId, {
      tenantId: payload.tenantId,
      campaignId: payload.campaignId,
    });
    this.currentCycleId = payload.cycleId;
    try {
      await this.execute(payload.cycleId);
    } finally {
      this.identity.delete(payload.cycleId);
      this.currentCycleId = undefined;
    }
  }

  protected async identityFromDeps(cycleId: string) {
    return this.identity.get(cycleId) ?? { tenantId: '', campaignId: '' };
  }

  protected async compute(
    deps: ComputeDeps<'recommendation'>,
  ): Promise<RecommendationData> {
    const signals = (deps.signal!.data.signals ?? []) as Signal[];
    const lifecycle = deps.lifecycle!.data;
    const confidence = deps.confidence!.data;
    const diagnosis = deps.diagnosis!.data;
    const business = deps.business!.data;
    const forecast = deps.forecast!.data;
    const memory = deps.memory!.data;
    const portfolio = deps.portfolio!.data;
    const revenue = deps.revenue!.data as {
      breakeven: { roas: number; isProfitable: boolean };
      targetROAS: number;
      derivation?: { method: string; marginPct: number; breakevenROAS: number };
    };
    const snapshot = deps.snapshot!.data as {
      metrics?: {
        campaignLevel?: Record<string, number>;
        adSetLevel?: Record<string, Record<string, number>>;
      };
    };
    const trend = deps.trend!.data as TrendData;

    const cm = snapshot.metrics?.campaignLevel ?? {};
    const adSetLevel = snapshot.metrics?.adSetLevel ?? {};
    const observedROAS = num(cm.roas);
    const observedSpend = num(cm.spend);
    const observedPurchases = num(cm.purchases);

    // Daily spend velocity: prefer the forecast engine's trend-aware 7d
    // linear projection (accounts for slope, not just a flat average) once
    // there's enough history for it to mean something.
    //
    // observedSpend (cm.spend) is Meta's date_preset='maximum' figure — the
    // CAMPAIGN'S ENTIRE LIFETIME spend, not a week's worth (same root cause
    // as the ForecastEngine overshoot fixed earlier). `observedSpend / 7`
    // was silently overriding the correct forecast value via Math.max() for
    // any campaign older than ~7 days: an 88-day-old campaign with ₹2.5M
    // lifetime spend produced "₹364,051/day" here (lifetime÷7) when the
    // real pace was ~₹29,000/day. ageDays converts it to a genuine rate
    // instead; the ema3d fallback path has the same unit problem (ema3d is
    // an average of the cumulative-spend curve, not a daily figure) so it
    // gets the same fix.
    const forecastNext7d = forecast.horizons?.next7d;
    const ageDays = Math.max(1, (lifecycle.ageHours ?? 24) / 24);
    const dailySpendVelocity =
      forecast.method !== 'insufficient_history' && forecastNext7d
        ? forecastNext7d.spend / 7
        : Math.max(
            (trend.perMetric.spend?.ema3d ?? observedSpend) / ageDays,
            observedSpend / ageDays,
          );

    const marginPct = revenue.derivation?.marginPct ?? 0.4;
    const breakevenROAS = revenue.breakeven.roas || 2.5;
    const targetROAS =
      revenue.targetROAS && revenue.targetROAS > breakevenROAS
        ? revenue.targetROAS
        : breakevenROAS * 2;

    // Forward-looking check: is the 7-day forecast trending back toward
    // breakeven even though the campaign looks bad *today*? A real operator
    // wouldn't kill a campaign that the trend already shows recovering —
    // this dampens (not blocks) loss-avoidance actions when so.
    const forecastROAS7d = forecastNext7d?.roas ?? observedROAS;
    const forecastRecovering =
      forecast.method !== 'insufficient_history' &&
      forecastROAS7d > observedROAS &&
      forecastROAS7d >= breakevenROAS * 0.9;

    // Resolve the campaign name once so reasoning references a real name
    // instead of "campaign unknown". Non-blocking — falls back to id.
    let campaignName = 'this campaign';
    const ident = this.identity.values().next().value;
    if (this.campaignModel && ident?.campaignId) {
      try {
        const c = await this.campaignModel
          .findById(ident.campaignId)
          .select('name')
          .lean()
          .exec();
        const doc = c as { name?: string } | null;
        if (doc?.name) campaignName = doc.name;
      } catch {
        // ignore
      }
    }

    // Where this campaign ranks across the account, per PortfolioEngine.
    // Currently a thin signal (PortfolioEngine is still a weak stub) so it
    // only nudges score by ±15-20%, never gates — it will carry more
    // weight automatically once that engine is fixed.
    const portfolioTier = portfolio.ranking?.find(
      (r) => r.campaignId === ident?.campaignId,
    )?.tier;

    // Weekly budget headroom, in ₹/day terms — gates spend-increasing
    // actions (scale_adset/add_adset) so the agent never recommends growth
    // it can't actually afford for the rest of the week.
    const weeklyCapRemainingINR = business.budgetPolicy?.weeklyCapRemainingINR;
    const capExhausted =
      typeof weeklyCapRemainingINR === 'number' &&
      Number.isFinite(weeklyCapRemainingINR) &&
      weeklyCapRemainingINR <= dailySpendVelocity * 0.5;

    // memory.pastActions is scoped to THIS campaign and carries targetId per
    // entry (see MemoryEngine). Two tiers:
    //   - same exact target + action type worsened before → hard gate, this
    //     candidate is dropped outright (don't repeat the identical mistake
    //     on the identical ad/adset).
    //   - action type worsened SOMEWHERE ELSE in this campaign → soft
    //     caution, just dampens the score (buildAction's recentlyWorsened
    //     multiplier below).
    const worsenedActions = (memory.pastActions ?? []).filter(
      (p) => p.outcomeLabel === 'worsened',
    );
    const recentlyWorsenedSameTarget = new Set(
      worsenedActions.map((p) => `${p.targetId}::${p.actionType}`),
    );
    const recentlyWorsenedTypes = new Set(
      worsenedActions.map((p) => p.actionType),
    );

    // Account-wide creative history — which hook styles have actually
    // earned clicks here before, and which have historically flopped. Used
    // to make replace_creative/add_creative say WHAT to try next, not just
    // "refresh the creative" with no direction.
    const topWinningHooks = (memory.companyLearnings?.winningHooks ?? []).slice(0, 2);
    const topLosingHooks = (memory.companyLearnings?.losingHooks ?? []).slice(0, 2);

    const blockedSet = new Set(
      lifecycle.blockedActions
        .filter((b) => b.action !== '*')
        .map((b) => b.action),
    );
    const gateStarBlock = lifecycle.blockedActions.some((b) => b.action === '*');

    // ── Group signals by target ───────────────────────────────────────
    // Multiple corroborating signals on the same ad/adset/campaign must
    // synthesize into ONE decision citing all of them, not N mono-causal
    // duplicates competing for the operator's attention.
    const groups = new Map<
      string,
      { targetType: Signal['targetType']; targetId: string; signals: Signal[] }
    >();
    for (const s of signals) {
      const key = `${s.targetType}:${s.targetId}`;
      const g = groups.get(key);
      if (g) g.signals.push(s);
      else groups.set(key, { targetType: s.targetType, targetId: s.targetId, signals: [s] });
    }

    const candidates: RecommendedAction[] = [];
    const evidenceByActionId = new Map<
      string,
      { kind: string; reasoning: string; metrics: Record<string, number> }
    >();

    for (const group of groups.values()) {
      const { targetType, targetId, signals: groupSignals } = group;

      // Union of action types any signal on this target could justify.
      const actionTypesSeen = new Set<CampaignActionType>();
      for (const s of groupSignals) {
        for (const t of SIGNAL_TO_ACTIONS[s.kind] ?? []) {
          if (ACTION_SCOPE[t].includes(targetType)) actionTypesSeen.add(t);
        }
      }

      for (const type of actionTypesSeen) {
        // Every signal on this target that actually recommends `type` —
        // the "combine reasoning" step. If ctr_decay + creative_fatigue +
        // hook_burn all point at replace_creative on the same ad, this
        // builds ONE action citing all three, not three separate ones.
        const supporting = groupSignals.filter((s) =>
          (SIGNAL_TO_ACTIONS[s.kind] ?? []).includes(type),
        );
        if (supporting.length === 0) continue;

        const gatedBy: string[] = [];
        if (gateStarBlock) gatedBy.push('lifecycle:all-blocked');
        if (blockedSet.has(type)) gatedBy.push(`lifecycle:${lifecycle.stage}`);
        if (!confidence.gates.okToRecommend)
          gatedBy.push('confidence:not_okToRecommend');
        if (
          capExhausted &&
          (type === 'scale_adset' || type === 'add_adset')
        )
          gatedBy.push('business:weekly_cap_exhausted');
        if (recentlyWorsenedSameTarget.has(`${targetId}::${type}`))
          gatedBy.push('memory:same_target_recently_worsened');

        // For adset-level targets, use the adset's own metrics in the
        // reasoning + profit math — not the campaign's aggregate, which
        // can be profitable overall while individual adsets bleed.
        let scopedROAS = observedROAS;
        let scopedSpend = observedSpend;
        let scopedPurchases = observedPurchases;
        let scopedDailySpend = dailySpendVelocity;
        if (targetType === 'adset' && adSetLevel[targetId]) {
          const m = adSetLevel[targetId];
          scopedROAS = num(m.roas);
          scopedSpend = num(m.spend);
          scopedPurchases = num(m.purchases);
          // m.spend is also a lifetime total (same Meta date_preset='maximum'
          // fetch as the campaign level) — no per-adset age is available, so
          // the campaign's own age is the best available proxy, still far
          // more accurate than dividing a potentially months-old lifetime
          // total by a flat 7.
          scopedDailySpend = scopedSpend / ageDays;
        }

        // Does a genuine diagnosed root cause back this specific action —
        // i.e. it names one of the signals we're citing AND shares this
        // action's focus category? This is what makes diagnosis actually
        // influence action choice instead of being an unused dependency.
        const focuses = ACTION_FOCUS[type];
        const matchingRootCause = diagnosis.rootCauses.find(
          (rc) =>
            focuses.includes(rc.suggestedFocus) &&
            rc.evidenceSignals.some((k) => supporting.some((s) => s.kind === k)),
        );

        const action = this.buildAction({
          type,
          targetType,
          targetId,
          signals: supporting,
          gatedBy,
          observedROAS: scopedROAS,
          observedSpend: scopedSpend,
          observedPurchases: scopedPurchases,
          dailySpendVelocity: scopedDailySpend,
          marginPct,
          breakevenROAS,
          targetROAS,
          diagnosisNarrative: diagnosis.narrative,
          matchingRootCause,
          forecastRecovering,
          forecastROAS7d,
          portfolioTier,
          recentlyWorsened: recentlyWorsenedTypes.has(type),
          topWinningHooks,
          topLosingHooks,
          campaignName,
        });
        candidates.push(action);
        evidenceByActionId.set(action.actionId, {
          kind: supporting.map((s) => s.kind).join('+'),
          reasoning: supporting.map((s) => s.reasoning).join(' '),
          metrics: Object.assign({}, ...supporting.map((s) => s.metricEvidence)),
        });
      }
    }

    // ── shift_budget_between_adsets — cross-adset synthesis ──────────
    // Needs cross-adset context that no single signal has. Look for a clear
    // winner+loser pair inside the same campaign and propose a shift.
    const shiftAction = this.buildShiftBudgetAction({
      adSetLevel,
      breakevenROAS,
      marginPct,
      ageDays,
      campaignName,
      diagnosisNarrative: diagnosis.narrative,
      blockedSet,
      gateStarBlock,
      okToRecommend: confidence.gates.okToRecommend,
    });
    if (shiftAction) candidates.push(shiftAction);

    // Drop gated candidates (their gatedBy tag stays for observability).
    const filtered = candidates.filter((c) => c.gatedBy.length === 0);

    // Rank by score — which now folds in signal corroboration, diagnosis
    // agreement, forecast trajectory and portfolio context, not just the
    // raw ₹ estimate (see buildAction).
    filtered.sort((a, b) => b.score - a.score);

    // Persist to intelligence_decisions (LOCAL, shadow_mode_only).
    // Every write here has shadowModeOnly=true — the Execution Engine
    // is contractually forbidden from touching Meta while that flag is set.
    if (this.decisionModel && filtered.length > 0) {
      const cycleId = this.currentCycleId ?? '';
      const now = new Date();
      const expires = new Date(now.getTime() + 48 * 60 * 60 * 1000);

      // Resolve campaign name + metaCampaignId for reasoning + traceability.
      let metaCampaignId: string | undefined;
      let campaignNameForDoc: string | undefined = campaignName === 'this campaign' ? undefined : campaignName;
      if (this.campaignModel && ident?.campaignId) {
        try {
          const c = await this.campaignModel
            .findById(ident.campaignId)
            .select('name metaCampaignId')
            .lean()
            .exec();
          const doc = c as { name?: string; metaCampaignId?: string } | null;
          metaCampaignId = doc?.metaCampaignId;
          if (doc?.name) campaignNameForDoc = doc.name;
        } catch {
          // non-fatal — decision is still valid without meta id / name
        }
      }

      // Signal evidence per action, captured at construction time in
      // evidenceByActionId (supports multiple co-firing signals per action —
      // previously this was regex-recovered from the reasoning string,
      // which could only ever resolve to a single signal kind).
      const signalByAction = Object.fromEntries(evidenceByActionId);

      // ── Dedup: skip proposals for which an open shadow_review decision
      // already exists for (tenantId, targetId, actionType) inside the review
      // window. Prevents 30-min cascade from re-proposing the same thing.
      const tenantId = ident?.tenantId ?? '';
      const openKeys = new Set<string>();
      if (tenantId) {
        try {
          const existing = await this.decisionModel
            .find({
              tenantId,
              status: 'shadow_review',
              reviewWindowExpiresAt: { $gt: now },
              targetId: { $in: filtered.map((a) => a.targetId) },
              actionType: { $in: filtered.map((a) => a.type) },
            })
            .select('targetId actionType')
            .lean()
            .exec();
          for (const e of existing as Array<{ targetId: string; actionType: string }>) {
            openKeys.add(`${e.targetId}::${e.actionType}`);
          }
        } catch (err) {
          this.log.warn(`dedup lookup: ${(err as Error).message}`);
        }
      }

      const fresh = filtered.filter(
        (a) => !openKeys.has(`${a.targetId}::${a.type}`),
      );

      if (fresh.length === 0) {
        this.log.debug(
          `all ${filtered.length} proposals deduped against open shadow_review decisions`,
        );
      } else {
        const docs = fresh.map((a) => ({
          tenantId,
          campaignId: ident?.campaignId ?? '',
          metaCampaignId,
          campaignName: campaignNameForDoc,
          cycleId,
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
          confidence: a.expectedImpact.confidence,
          gatedBy: a.gatedBy,
          requiresHumanApproval: a.requiresHumanApproval,
          evidenceSnapshot: signalByAction[a.actionId],
          reviewWindowExpiresAt: expires,
          status: 'shadow_review',
          shadowModeOnly: true,
        }));

        try {
          await this.decisionModel.insertMany(docs, { ordered: false });
        } catch (err) {
          // Duplicate-key on cycleId+actionId is expected on re-runs.
          this.log.warn(
            `decisions insertMany: ${(err as Error).message}`,
          );
        }
      }
    }

    return { actions: filtered };
  }

  private buildAction(input: {
    type: CampaignActionType;
    targetType: 'campaign' | 'adset' | 'ad';
    targetId: string;
    signals: Signal[];
    gatedBy: string[];
    observedROAS: number;
    observedSpend: number;
    observedPurchases: number;
    dailySpendVelocity: number;
    marginPct: number;
    breakevenROAS: number;
    targetROAS: number;
    diagnosisNarrative: string;
    matchingRootCause?: DiagnosisData['rootCauses'][number];
    forecastRecovering: boolean;
    forecastROAS7d: number;
    portfolioTier?: 'A' | 'B' | 'C' | 'D';
    recentlyWorsened: boolean;
    topWinningHooks: string[];
    topLosingHooks: string[];
    campaignName: string;
  }): RecommendedAction {
    const {
      type,
      targetType,
      targetId,
      signals,
      gatedBy,
      observedROAS,
      observedSpend,
      observedPurchases,
      dailySpendVelocity,
      marginPct,
      breakevenROAS,
      diagnosisNarrative,
      matchingRootCause,
      forecastRecovering,
      forecastROAS7d,
      portfolioTier,
      recentlyWorsened,
      topWinningHooks,
      topLosingHooks,
      campaignName,
    } = input;

    const risk = RISK[type];

    // Corroboration: multiple independent signals agreeing on the same
    // action raises confidence more than any one of them alone (noisy-OR —
    // with a single signal this reduces to exactly that signal's strength,
    // so single-cause cases behave identically to before).
    const combinedStrength = 1 - signals.reduce((acc, s) => acc * (1 - s.strength), 1);
    const metricEvidence: Record<string, number> = Object.assign(
      {},
      ...signals.map((sig) => sig.metricEvidence),
    );

    // ── Expected profit delta over next 7 days (contribution profit) ──
    // Each action type has a distinct profit-mechanics model.
    let projectedProfitDelta7dINR = 0;
    let impactMetric = 'roas';
    let deltaPct = 0;
    let mechanicsExplanation = '';

    // Revenue basis for uplift-style actions (replace_creative, add_creative,
    // narrow_placement, dayparting): floored at breakevenROAS instead of the
    // raw observedROAS. Using observedROAS directly made the estimated ₹
    // gain from fixing a metric scale DOWN with how bad the campaign
    // currently is — the worse the ROAS, the smaller the "fix the CTR"
    // payoff looked, which mechanically buried creative/placement actions
    // under ROAS/budget actions exactly when they mattered most. The fix
    // being scored recovers performance TOWARD breakeven, so breakeven is
    // the right floor for "revenue per rupee after the fix" — and when the
    // campaign is already healthy (observedROAS > breakeven), we still use
    // the real observed number rather than overstating it.
    const revenueROASProxy = Math.max(observedROAS, breakevenROAS);

    switch (type) {
      case 'pause_adset':
      case 'pause_ad':
      case 'reduce_total_budget': {
        // If currently unprofitable, pausing avoids further losses.
        if (observedROAS > 0 && observedROAS < breakevenROAS) {
          const lossPerRupee = (breakevenROAS - observedROAS) * marginPct;
          projectedProfitDelta7dINR = dailySpendVelocity * 7 * lossPerRupee;
          const verb = type === 'reduce_total_budget' ? 'Cutting' : 'Stopping';
          mechanicsExplanation = `${verb} spend here saves an estimated ₹${projectedProfitDelta7dINR.toFixed(0)} of losses over the next 7 days at the current ₹${dailySpendVelocity.toFixed(0)}/day pace.`;
        } else {
          projectedProfitDelta7dINR = 0;
          mechanicsExplanation = `This campaign appears profitable today — pausing would forgo profit, not save it.`;
        }
        impactMetric = 'losses_avoided';
        deltaPct = 100;
        break;
      }
      case 'scale_adset': {
        // If clearly above breakeven, scaling grows profit — assume 20% budget lift
        // yields (impact*strength) ROAS in the new budget slice.
        if (observedROAS >= breakevenROAS * 1.2) {
          const uplift = 0.2 * combinedStrength; // scaled by corroborated signal confidence
          const newDailySpend = dailySpendVelocity * (1 + uplift);
          // Assume marginal ROAS is 90% of current (auction pushback)
          const marginalROAS = observedROAS * 0.9;
          const profitPerRupee = (marginalROAS - breakevenROAS) * marginPct;
          projectedProfitDelta7dINR =
            (newDailySpend - dailySpendVelocity) * 7 * profitPerRupee;
          mechanicsExplanation = `Scaling ${(uplift * 100).toFixed(0)}% of budget with expected marginal ROAS ${marginalROAS.toFixed(2)}× (10% haircut vs current). Adds ~₹${projectedProfitDelta7dINR.toFixed(0)} of profit over 7 days.`;
        }
        impactMetric = 'roas';
        deltaPct = 15;
        break;
      }
      case 'replace_creative':
      case 'add_creative': {
        // Replacing tired creative typically recovers ~half the CTR drop.
        // Profit gain proportional to CTR recovery × current CVR × spend.
        const ctrDrop = num(metricEvidence.dropPct) || 0.35;
        const ctrRecovery = ctrDrop * 0.5;
        // Rough: 1pp CTR recovery adds roughly (spend / cpc) more clicks →
        // more purchases at current CVR → more revenue. Approximate:
        const revenueMultiplier = 1 + ctrRecovery;
        const currentRevenue = revenueROASProxy * observedSpend;
        const newRevenue = currentRevenue * revenueMultiplier;
        const revenueGain = newRevenue - currentRevenue;
        projectedProfitDelta7dINR = (revenueGain / Math.max(1, observedSpend)) * dailySpendVelocity * 7 * marginPct;
        mechanicsExplanation = `Fresh creative typically restores ~50% of observed CTR drop (${(ctrDrop * 100).toFixed(0)}%). At current CVR, that's ~₹${projectedProfitDelta7dINR.toFixed(0)} more contribution profit over 7 days.`;
        // Account history — tells the operator WHAT to try, not just "make
        // something new". winningHooks/losingHooks are real aggregate CTR
        // stats across this account's own past ads, not a generic tip.
        const hookName = (h: string) => h.split(' (')[0];
        if (topWinningHooks.length > 0) {
          mechanicsExplanation += ` This account's best-performing hook styles are ${topWinningHooks.map(hookName).join(' and ')} — worth trying first.`;
        }
        if (topLosingHooks.length > 0) {
          mechanicsExplanation += ` ${topLosingHooks.map(hookName).join(' and ')} have historically underperformed here — avoid repeating those angles.`;
        }
        impactMetric = 'ctr';
        deltaPct = Math.round(ctrRecovery * 100);
        break;
      }
      case 'shift_budget_between_adsets': {
        // Assume the shift is between winner + loser; recover 15% of losing spend's loss + gain 10% on winner.
        if (observedROAS > 0 && observedROAS < breakevenROAS) {
          const lossPerRupee = (breakevenROAS - observedROAS) * marginPct;
          projectedProfitDelta7dINR = dailySpendVelocity * 7 * lossPerRupee * 0.3;
        } else {
          projectedProfitDelta7dINR = dailySpendVelocity * 7 * marginPct * 0.05;
        }
        mechanicsExplanation = `Reallocating 15-30% intra-campaign toward the observed better performer. Rough ₹${projectedProfitDelta7dINR.toFixed(0)} profit gain over 7 days.`;
        impactMetric = 'roas';
        deltaPct = 8;
        break;
      }
      case 'narrow_placement':
      case 'dayparting': {
        // These trim CPM waste — typically 5-10% profit uplift on displayed spend.
        const uplift = 0.06;
        if (observedROAS > 0) {
          const revenueGain = observedSpend * revenueROASProxy * uplift;
          projectedProfitDelta7dINR = (revenueGain / Math.max(1, observedSpend)) * dailySpendVelocity * 7 * marginPct;
        }
        mechanicsExplanation = `Focusing spend on the ${type === 'narrow_placement' ? 'best-performing placements' : 'best-performing hours'} typically frees ~6% of wasted spend. ~₹${projectedProfitDelta7dINR.toFixed(0)} added profit over 7 days.`;
        impactMetric = 'cpm';
        deltaPct = 6;
        break;
      }
      case 'add_adset': {
        // Fresh audience — assume incremental profit at 70% of current ROAS
        const marginalROAS = observedROAS * 0.7;
        if (marginalROAS > breakevenROAS) {
          const profitPerRupee = (marginalROAS - breakevenROAS) * marginPct;
          projectedProfitDelta7dINR = dailySpendVelocity * 7 * profitPerRupee * 0.5;
        }
        mechanicsExplanation = `New audience segment; assumes marginal ROAS at 70% of current (${(observedROAS * 0.7).toFixed(2)}×). ~₹${projectedProfitDelta7dINR.toFixed(0)} added profit over 7 days if it holds.`;
        impactMetric = 'incremental_purchases';
        deltaPct = 20;
        break;
      }
    }

    // ── Context multipliers — how confidently we RANK this action, layered
    // on top of the mechanical ₹ estimate above. These never rewrite the ₹
    // number itself (that stays an honest mechanical estimate); they decide
    // how loudly this action competes against others for review priority,
    // and they each add a line of genuine cross-engine reasoning.
    const isCutAction = type === 'pause_adset' || type === 'pause_ad' || type === 'reduce_total_budget';
    const isGrowthAction = type === 'scale_adset' || type === 'add_adset';

    let diagnosisMult = 1;
    let diagnosisLine = '';
    if (matchingRootCause) {
      diagnosisMult = 1 + matchingRootCause.confidence * 0.5;
      diagnosisLine = `Diagnosis agrees: "${matchingRootCause.hypothesis}" (${Math.round(matchingRootCause.confidence * 100)}% confidence) points at the same ${matchingRootCause.suggestedFocus} root cause.`;
    }

    let forecastMult = 1;
    let forecastLine = '';
    if (isCutAction && forecastRecovering) {
      forecastMult = 0.6;
      forecastLine = `Caveat: the 7-day forecast shows ROAS trending toward ${forecastROAS7d.toFixed(2)}× — already recovering, so this may be premature.`;
    }

    let portfolioMult = 1;
    let portfolioLine = '';
    if (portfolioTier === 'D' || portfolioTier === 'C') {
      if (isGrowthAction) {
        portfolioMult = 0.7;
        portfolioLine = `Portfolio context: this campaign ranks tier ${portfolioTier} account-wide — scaling a weak performer is lower priority than the ₹ number alone suggests.`;
      } else if (isCutAction) {
        portfolioMult = 1.15;
        portfolioLine = `Portfolio context: this campaign ranks tier ${portfolioTier} account-wide, reinforcing the case to cut losses here.`;
      }
    } else if (portfolioTier === 'A' && isGrowthAction) {
      portfolioMult = 1.15;
      portfolioLine = `Portfolio context: this campaign ranks tier A account-wide — a strong candidate for incremental budget.`;
    }

    let memoryMult = 1;
    let memoryLine = '';
    if (recentlyWorsened) {
      memoryMult = 0.85;
      memoryLine = `Caution: a ${humanize(type)}-type action worsened outcomes on another ad/adset in this campaign recently — weighted down accordingly.`;
    }

    // Score = |expected profit delta| discounted by risk, scaled by how
    // many signals corroborate it and by diagnosis/forecast/portfolio/
    // memory context. This is the ranking signal — genuinely multi-
    // parameter, not the single-metric ROAS-only ordering it used to be.
    const score = Math.round(
      (Math.abs(projectedProfitDelta7dINR) / RISK_MULT[risk]) *
        combinedStrength *
        diagnosisMult *
        forecastMult *
        portfolioMult *
        memoryMult,
    );

    // Plain-English condition summary — works both when the campaign is
    // solidly below breakeven ("losing X per ₹") and when it's barely below
    // ("break-even zone — not making profit"). Subject varies by target
    // level so adset-level actions don't read as if the whole campaign is
    // failing.
    const subject = targetType === 'adset'
      ? `The ad group in ${campaignName}`
      : campaignName;
    const roasGap = breakevenROAS - observedROAS;
    const gapIsMeaningful = roasGap > 0.05;
    const lossPerRupee = roasGap * marginPct;
    let conditionLine: string;
    if (observedROAS <= 0) {
      conditionLine = `${subject} has generated no tracked revenue on ₹${observedSpend.toFixed(0)} of spend so far.`;
    } else if (gapIsMeaningful) {
      conditionLine = `${subject} is running at ${observedROAS.toFixed(2)}× ROAS — below the ${breakevenROAS.toFixed(2)}× it needs to make a profit. Roughly ₹${lossPerRupee.toFixed(2)} is being lost for every ₹1 spent.`;
    } else if (observedROAS < breakevenROAS) {
      conditionLine = `${subject} is stuck in the break-even zone (${observedROAS.toFixed(2)}× ROAS vs ${breakevenROAS.toFixed(2)}× needed). It's not losing much, but it's not making profit either.`;
    } else {
      conditionLine = `${subject} is profitable — running at ${observedROAS.toFixed(2)}× ROAS above the ${breakevenROAS.toFixed(2)}× breakeven.`;
    }

    // Evidence chain — plain-English, no engine jargon in the strings. One
    // entry per corroborating signal (previously always exactly one).
    const evidenceChain: RecommendedAction['evidenceChain'] = [
      ...signals.map((sig) => ({ step: sig.reasoning, source: 'signal' })),
      {
        step: `Money: ${observedROAS.toFixed(2)}× ROAS observed, needs ${breakevenROAS.toFixed(2)}× to break even (contribution margin ${(marginPct * 100).toFixed(0)}%).`,
        source: 'revenue',
      },
      {
        step: `Spend pace: ~₹${dailySpendVelocity.toFixed(0)}/day across ${observedPurchases} purchases so far.`,
        source: 'snapshot',
      },
      {
        step: `Root cause guess: ${diagnosisNarrative}`,
        source: 'diagnosis',
      },
      ...(forecastLine ? [{ step: forecastLine, source: 'forecast' }] : []),
      ...(portfolioLine ? [{ step: portfolioLine, source: 'portfolio' }] : []),
      ...(memoryLine ? [{ step: memoryLine, source: 'memory' }] : []),
      ...((type === 'replace_creative' || type === 'add_creative') &&
      (topWinningHooks.length > 0 || topLosingHooks.length > 0)
        ? [
            {
              step: [
                topWinningHooks.length > 0 ? `Winning hooks on this account: ${topWinningHooks.join('; ')}.` : '',
                topLosingHooks.length > 0 ? `Losing hooks: ${topLosingHooks.join('; ')}.` : '',
              ]
                .filter(Boolean)
                .join(' '),
              source: 'memory',
            },
          ]
        : []),
    ];

    // Reasoning — one plain-English paragraph. No markdown, no jargon. When
    // more than one signal corroborates, say so up front instead of only
    // ever citing a single cause.
    const corroborationLine =
      signals.length > 1
        ? `${signals.length} independent signals agree here: ${signals.map((sig) => sig.kind.replace(/_/g, ' ')).join(', ')}.`
        : '';
    const reasoning = [
      `${humanizeSentence(type, campaignName)}.`,
      conditionLine,
      corroborationLine,
      mechanicsExplanation,
      diagnosisLine,
      forecastLine,
      portfolioLine,
      memoryLine,
    ]
      .filter(Boolean)
      .join(' ');

    return {
      actionId: randomUUID(),
      type,
      targetType,
      targetId,
      parameters: {},
      expectedImpact: {
        metric: impactMetric,
        deltaPct,
        confidence: combinedStrength,
      },
      expectedProfitDeltaINR7d: Math.round(projectedProfitDelta7dINR),
      reasoning,
      evidenceChain,
      risk,
      implementationCost: risk === 'low' ? 1 : risk === 'medium' ? 3 : 5,
      score,
      gatedBy,
      requiresHumanApproval: HUMAN_APPROVAL.includes(type),
    };
  }

  /**
   * Look inside the campaign's ad-sets for a clear winner+loser pair and
   * propose a shift_budget_between_adsets action. This is intentionally
   * synthesized in the Recommendation Engine (not signaled by SignalEngine)
   * because it requires cross-adset comparison.
   */
  private buildShiftBudgetAction(input: {
    adSetLevel: Record<string, Record<string, number>>;
    breakevenROAS: number;
    marginPct: number;
    ageDays: number;
    campaignName: string;
    diagnosisNarrative: string;
    blockedSet: Set<string>;
    gateStarBlock: boolean;
    okToRecommend: boolean;
  }): RecommendedAction | null {
    const {
      adSetLevel,
      breakevenROAS,
      marginPct,
      ageDays,
      campaignName,
      diagnosisNarrative,
      blockedSet,
      gateStarBlock,
      okToRecommend,
    } = input;

    const entries = Object.entries(adSetLevel);
    if (entries.length < 2 || breakevenROAS <= 0) return null;

    const enriched = entries
      .map(([id, m]) => ({
        id,
        spend: num(m.spend),
        roas: num(m.roas),
        purchases: num(m.purchases),
      }))
      .filter((a) => a.spend > 100);
    if (enriched.length < 2) return null;

    enriched.sort((a, b) => b.roas - a.roas);
    const winner = enriched[0];
    const loser = enriched[enriched.length - 1];

    const spreadOk = winner.roas - loser.roas >= 0.5;
    const winnerAboveBE = winner.roas > breakevenROAS * 1.1;
    const loserBelowBE = loser.roas > 0 && loser.roas < breakevenROAS * 0.95;
    const bothHaveVolume = winner.purchases >= 2 && loser.spend >= 300;

    if (!spreadOk || !winnerAboveBE || !loserBelowBE || !bothHaveVolume) {
      return null;
    }

    // Rough profit math for shifting ~30% of loser's daily spend to winner:
    // - loser side: 30% of loser.spend * (breakeven - loser.roas) * margin
    //   losses avoided over 7d, prorated by that fraction of loser.spend.
    // - winner side: same rupees earning (winner.roas - breakeven) * margin,
    //   discounted 80% (marginal ROAS < average ROAS at scale).
    const shiftFraction = 0.3;
    // loser.spend is a lifetime total (Meta date_preset='maximum'), not a
    // week's worth — same fix as elsewhere in this file, using campaign age
    // as the best available proxy for this ad set's own age.
    const loserDaily = loser.spend / ageDays;
    const shiftedDaily = loserDaily * shiftFraction;
    const lossAvoidedPerRupee = (breakevenROAS - loser.roas) * marginPct;
    const marginalWinnerROAS = winner.roas * 0.8;
    const profitPerRupeeOnWinner =
      Math.max(0, marginalWinnerROAS - breakevenROAS) * marginPct;
    const projectedProfitDelta7dINR = Math.round(
      shiftedDaily * 7 * (lossAvoidedPerRupee + profitPerRupeeOnWinner),
    );

    const risk = RISK.shift_budget_between_adsets;

    const gatedBy: string[] = [];
    if (gateStarBlock) gatedBy.push('lifecycle:all-blocked');
    if (blockedSet.has('shift_budget_between_adsets'))
      gatedBy.push('lifecycle:blocked');
    if (!okToRecommend) gatedBy.push('confidence:not_okToRecommend');

    const reasoning = [
      `The agent recommends reallocating budget within ${campaignName}.`,
      `Ad group ${loser.id.slice(-6)} is running at ${loser.roas.toFixed(2)}× ROAS (below the ${breakevenROAS.toFixed(2)}× breakeven), while ad group ${winner.id.slice(-6)} is at ${winner.roas.toFixed(2)}× — a ${(winner.roas - loser.roas).toFixed(2)}× gap inside the same campaign.`,
      `Moving ~30% of the loser's spend to the winner is projected to gain roughly ₹${projectedProfitDelta7dINR} of contribution profit over the next 7 days.`,
    ].join(' ');

    const evidenceChain: RecommendedAction['evidenceChain'] = [
      {
        step: `Winner ad group: ${winner.roas.toFixed(2)}× ROAS on ₹${winner.spend.toFixed(0)} across ${winner.purchases} purchases.`,
        source: 'snapshot',
      },
      {
        step: `Loser ad group: ${loser.roas.toFixed(2)}× ROAS on ₹${loser.spend.toFixed(0)}.`,
        source: 'snapshot',
      },
      {
        step: `Breakeven ROAS: ${breakevenROAS.toFixed(2)}× (contribution margin ${(marginPct * 100).toFixed(0)}%).`,
        source: 'revenue',
      },
      {
        step: `Root cause guess: ${diagnosisNarrative}`,
        source: 'diagnosis',
      },
    ];

    return {
      actionId: randomUUID(),
      type: 'shift_budget_between_adsets',
      targetType: 'adset',
      targetId: loser.id,
      parameters: {
        fromAdSetId: loser.id,
        toAdSetId: winner.id,
        shiftFraction,
      },
      expectedImpact: {
        metric: 'roas',
        deltaPct: 8,
        confidence: 0.7,
      },
      expectedProfitDeltaINR7d: projectedProfitDelta7dINR,
      reasoning,
      evidenceChain,
      risk,
      implementationCost: risk === 'low' ? 1 : risk === 'medium' ? 3 : 5,
      score: Math.round(Math.abs(projectedProfitDelta7dINR) / RISK_MULT[risk]),
      gatedBy,
      requiresHumanApproval: HUMAN_APPROVAL.includes(
        'shift_budget_between_adsets',
      ),
    };
  }

  protected computeConfidence(
    deps: ComputeDeps<'recommendation'>,
    data: RecommendationData,
  ): number {
    const base = deps.confidence!.data.overall;
    if (data.actions.length === 0) return base * 0.8;
    return base;
  }

  protected buildEvidence(
    _deps: ComputeDeps<'recommendation'>,
    data: RecommendationData,
  ): Evidence[] {
    return [
      {
        kind: 'context',
        ref: `actions:${data.actions.length}`,
        weight: 1,
      },
    ];
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function humanize(type: CampaignActionType): string {
  const map: Record<CampaignActionType, string> = {
    pause_ad: 'stop this ad',
    pause_adset: 'stop this ad group',
    scale_adset: 'increase this ad group budget',
    replace_creative: 'replace the creative',
    add_creative: 'add a new creative variant',
    add_adset: 'launch a new ad group',
    shift_budget_between_adsets: 'shift budget within campaign',
    reduce_total_budget: 'lower total budget',
    narrow_placement: 'focus placements',
    dayparting: 'set dayparting schedule',
  };
  return map[type] ?? type;
}

/** First sentence of the reasoning — "The agent recommends X on <campaign>". */
function humanizeSentence(type: CampaignActionType, campaignName: string): string {
  const map: Record<CampaignActionType, string> = {
    pause_ad: `The agent recommends pausing an ad on ${campaignName}`,
    pause_adset: `The agent recommends pausing the ad group on ${campaignName}`,
    scale_adset: `The agent recommends scaling budget on ${campaignName}`,
    replace_creative: `The agent recommends refreshing the creative on ${campaignName}`,
    add_creative: `The agent recommends adding a fresh creative variant on ${campaignName}`,
    add_adset: `The agent recommends launching a new ad group on ${campaignName}`,
    shift_budget_between_adsets: `The agent recommends reallocating budget within ${campaignName}`,
    reduce_total_budget: `The agent recommends lowering total daily budget on ${campaignName}`,
    narrow_placement: `The agent recommends narrowing placements on ${campaignName}`,
    dayparting: `The agent recommends setting a dayparting schedule on ${campaignName}`,
  };
  return map[type] ?? `${humanize(type)} on ${campaignName}`;
}
