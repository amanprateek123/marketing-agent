import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'node:crypto';

/**
 * Stable identity for a proposed action within a cycle.
 *
 * Was randomUUID(), which made the `{cycleId, actionId}` unique index on
 * intelligence_decisions structurally unable to fire: two runs of the same
 * cycle minted different ids for the identical action, both inserted, and the
 * review UI showed the same suggestion twice ("4 options" that were really 2).
 * Hashing the action's own identity means a re-run collides with the first
 * insert and is rejected by the index, which is what that index was for.
 */
function stableActionId(
  cycleId: string,
  type: string,
  targetType: string,
  targetId: string,
): string {
  return createHash('sha1')
    .update(`${cycleId}|${type}|${targetType}|${targetId}`)
    .digest('hex')
    .slice(0, 32);
}
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import {
  SliceIdentity,
  SliceRepository,
} from '../shared/slice-repository.service';
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
  LifecycleData,
  ObjectiveData,
  OptimizationGoalSignalEvidence,
  RecommendationData,
  RecommendedAction,
  Signal,
  SignalKind,
  TrendData,
} from '../orchestrator/decision-context';
import {
  computeObjectiveMetric,
  isRevenueObjective,
  scoredMetricFor,
} from '../objective/kpi-profiles';
import { isSourceMetricsFresh } from '../snapshot/snapshot-freshness';

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
  'shift_budget_between_adsets',
  'reduce_total_budget',
];

/**
 * These signals are computed from purchases, ROAS, contribution margin or
 * breakeven. They are meaningful for sales objectives only. A reach, traffic
 * or lead campaign can legitimately have zero purchases, so allowing these
 * signals through would turn "doing its assigned job" into a false loss alarm.
 */
const REVENUE_ONLY_SIGNALS = new Set<SignalKind>([
  'cvr_collapse',
  'unprofitable_run',
  'winner_emerging',
  'winner_confirmed',
  'budget_saturation',
  'audience_exhaustion',
  'placement_leak',
]);

/** Minimum evidence needed before an observation can become a suggestion. */
const MIN_SIGNAL_CONFIDENCE = 0.5;
const MIN_DIAGNOSIS_CONFIDENCE = 0.5;

// A cause is not required to observe and contain a verified financial loss.
// This narrow exception never claims to fix ROAS: it only offers a bounded,
// human-reviewed throttle when a campaign has remained in Meta learning long
// enough, has meaningful conversion volume, and every source/economics gate is
// independently healthy. Young or weakly observed learning campaigns remain
// fully protected.
const LOSS_CONTAINMENT_MIN_AGE_HOURS = 7 * 24;
const LOSS_CONTAINMENT_MIN_SPEND_INR = 5_000;
const LOSS_CONTAINMENT_MIN_PURCHASES = 10;
const LOSS_CONTAINMENT_MAX_ROAS_TO_BREAKEVEN_RATIO = 0.7;

/**
 * Lifecycle exposes both an action allow-list and coarse capability gates.
 * Both are authoritative. The allow-list answers "is this lever appropriate
 * now?"; the capability gate answers "is this class of mutation safe now?".
 */
const ACTION_LIFECYCLE_GATE: Partial<
  Record<CampaignActionType, keyof LifecycleData['gates']>
> = {
  pause_ad: 'canPause',
  pause_adset: 'canPause',
  scale_adset: 'canScale',
  replace_creative: 'canReplaceCreative',
  add_creative: 'canReplaceCreative',
  add_adset: 'canAddAudience',
  reduce_total_budget: 'canReduceBudget',
};

/**
 * Which targetTypes each action is valid for. Prevents e.g. reduce_total_budget
 * from being emitted with an adset targetId (which the executor could not act on).
 */
// These scopes deliberately mirror ExecutionEngine's actual Meta mutations.
// A useful-sounding action at the wrong scope is not an executable proposal:
// placement and dayparting changes land on an ad set, while total-budget
// reduction lands on a campaign. Fail closed rather than reinterpret it later.
const ACTION_SCOPE: Record<
  CampaignActionType,
  Array<'campaign' | 'adset' | 'ad'>
> = {
  pause_ad: ['ad'],
  pause_adset: ['adset'],
  scale_adset: ['adset'],
  replace_creative: ['ad'],
  add_creative: ['adset'],
  add_adset: ['campaign'],
  shift_budget_between_adsets: ['adset'],
  reduce_total_budget: ['campaign'],
  narrow_placement: ['adset'],
  dayparting: ['adset'],
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
  // Exact goal outliers do not imply a cause. A lagging ad can be held for
  // review; creative replacement becomes eligible only when Diagnosis also
  // has same-ad creative evidence. Ad-set reallocation is built separately
  // because it requires a verified same-goal recipient.
  optimization_goal_efficiency_lagging: ['pause_ad', 'replace_creative'],
  optimization_goal_efficiency_leading: ['scale_adset'],
};

/**
 * Which DiagnosisEngine "focus" categories each action serves. Used to let
 * a genuine root-cause diagnosis pull weight toward the action that
 * actually addresses it, instead of every signal-implied action competing
 * on raw ₹ estimate alone.
 */
const ACTION_FOCUS: Record<CampaignActionType, DiagnosisFocus[]> = {
  pause_ad: ['creative', 'objective_mismatch', 'delivery_efficiency'],
  pause_adset: ['budget', 'objective_mismatch'],
  scale_adset: ['budget', 'delivery_efficiency'],
  replace_creative: ['creative'],
  add_creative: ['creative'],
  add_adset: ['audience'],
  shift_budget_between_adsets: ['budget', 'audience', 'delivery_efficiency'],
  reduce_total_budget: ['budget'],
  // Narrowing inventory is justified by placement evidence only. It is not
  // an audience-expansion lever and can worsen an already-high frequency.
  narrow_placement: ['placement'],
  dayparting: ['placement'],
};

/**
 * Some levers need evidence at the same dimension they mutate. High
 * frequency or audience saturation does not show that any placement is bad;
 * narrowing inventory can actually make frequency worse. Placement changes
 * therefore fail closed unless SignalEngine found a measured placement leak.
 */
const ACTION_REQUIRED_SIGNALS: Partial<
  Record<CampaignActionType, ReadonlySet<SignalKind>>
> = {
  narrow_placement: new Set<SignalKind>(['placement_leak']),
};

/**
 * Recommendation Engine v1.3
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
  readonly version = '1.3.0';
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
    try {
      await this.execute(payload.cycleId);
    } finally {
      this.identity.delete(payload.cycleId);
    }
  }

  protected async identityFromDeps(cycleId: string) {
    return this.identity.get(cycleId) ?? { tenantId: '', campaignId: '' };
  }

  protected async compute(
    deps: ComputeDeps<'recommendation'>,
    cycleId: string,
    identity: SliceIdentity,
  ): Promise<RecommendationData> {
    const signals = (deps.signal!.data.signals ?? []) as Signal[];
    const objective = deps.objective!.data;
    const revenueObjective = isRevenueObjective(objective.objective);
    const lifecycle = deps.lifecycle!.data;
    const confidence = deps.confidence!.data;
    const diagnosis = deps.diagnosis!.data;
    const business = deps.business!.data;
    const forecast = deps.forecast!.data;
    const memory = deps.memory!.data;
    const portfolio = deps.portfolio!.data;
    const revenue = deps.revenue!.data as {
      economicsAvailable?: boolean;
      revenueEvidenceAvailable?: boolean;
      financialDataAvailable?: boolean;
      breakeven: { roas: number; isProfitable: boolean };
      targetROAS: number;
      derivation?: {
        method: string;
        marginPct: number;
        breakevenROAS: number;
      };
    };
    const snapshot = deps.snapshot!.data as {
      snapshotId?: string;
      freshnessSec?: number;
      metrics?: {
        campaignLevel?: Record<string, number>;
        adSetLevel?: Record<string, Record<string, number>>;
        adLevel?: Record<string, Record<string, number>>;
      };
      entities?: {
        campaign?: { budgetModel?: 'abo' | 'cbo' | 'asc' };
      };
    };
    const trend = deps.trend!.data as TrendData;
    // ConfidenceEngine is the primary readiness gate, but Recommendation is
    // also a hard boundary. This protects replayed/legacy confidence slices
    // that may say okToRecommend even though the source campaign metrics are
    // stale or have no machine-readable freshness at all.
    const sourceMetricsFresh = isSourceMetricsFresh(snapshot.freshnessSec);

    // Objective policy is a second line of defence behind SignalEngine. It
    // also protects replayed/older slices which may have been produced before
    // objective-aware signal suppression existed.
    const policyIgnoredSignals = new Set(objective.policy.ignoreSignals ?? []);
    const goalCompatibleSignals = signals.filter(
      (signal) =>
        !policyIgnoredSignals.has(signal.kind) &&
        (revenueObjective || !REVENUE_ONLY_SIGNALS.has(signal.kind)),
    );

    const cm = snapshot.metrics?.campaignLevel ?? {};
    const adSetLevel = snapshot.metrics?.adSetLevel ?? {};
    const adLevel = snapshot.metrics?.adLevel ?? {};
    const campaignBudgetModel = snapshot.entities?.campaign?.budgetModel;
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
    const economicsAvailable =
      !revenueObjective || revenue.economicsAvailable === true;
    const revenueEvidenceAvailable =
      !revenueObjective || revenue.revenueEvidenceAvailable === true;
    const financialDataAvailable =
      !revenueObjective || revenue.financialDataAvailable === true;
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
    let campaignSource: 'agent' | 'human' | 'manual' | undefined;
    const ident = identity;
    if (this.campaignModel) {
      try {
        const c = await this.campaignModel
          .findById(ident.campaignId)
          .select('name source')
          .lean()
          .exec();
        const doc = c as {
          name?: string;
          source?: 'agent' | 'human' | 'manual';
        } | null;
        if (doc?.name) campaignName = doc.name;
        campaignSource = doc?.source;
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
    const topWinningHooks = (memory.companyLearnings?.winningHooks ?? []).slice(
      0,
      2,
    );
    const topLosingHooks = (memory.companyLearnings?.losingHooks ?? []).slice(
      0,
      2,
    );

    const blockedSet = new Set(
      lifecycle.blockedActions
        .filter((b) => b.action !== '*')
        .map((b) => b.action),
    );
    const allowedSet = new Set(lifecycle.allowedActions);
    const gateStarBlock = lifecycle.blockedActions.some(
      (b) => b.action === '*',
    );

    // ── Group signals by target ───────────────────────────────────────
    // Multiple corroborating signals on the same ad/adset/campaign must
    // synthesize into ONE decision citing all of them, not N mono-causal
    // duplicates competing for the operator's attention.
    const groups = new Map<
      string,
      { targetType: Signal['targetType']; targetId: string; signals: Signal[] }
    >();
    for (const s of goalCompatibleSignals) {
      const key = `${s.targetType}:${s.targetId}`;
      const g = groups.get(key);
      if (g) g.signals.push(s);
      else
        groups.set(key, {
          targetType: s.targetType,
          targetId: s.targetId,
          signals: [s],
        });
    }

    const candidates: RecommendedAction[] = [];
    const evidenceByActionId = new Map<
      string,
      {
        signalKind: string;
        signalReasoning: string;
        metrics: Record<string, number>;
      }
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

        const lossContainmentOnly =
          type === 'reduce_total_budget' &&
          targetType === 'campaign' &&
          lifecycle.stage === 'learning' &&
          (lifecycle.ageHours ?? 0) >= LOSS_CONTAINMENT_MIN_AGE_HOURS &&
          revenueObjective &&
          sourceMetricsFresh &&
          economicsAvailable &&
          revenueEvidenceAvailable &&
          financialDataAvailable &&
          observedSpend >= LOSS_CONTAINMENT_MIN_SPEND_INR &&
          observedPurchases >= LOSS_CONTAINMENT_MIN_PURCHASES &&
          observedROAS > 0 &&
          breakevenROAS > 0 &&
          observedROAS / breakevenROAS <=
            LOSS_CONTAINMENT_MAX_ROAS_TO_BREAKEVEN_RATIO &&
          confidence.overall >= 0.5 &&
          (confidence.perEngine?.snapshot ?? 0) >= 0.6 &&
          (confidence.quality?.statisticalPower ?? 0) >= 0.5 &&
          !forecastRecovering &&
          supporting.some(
            (signal) =>
              signal.kind === 'unprofitable_run' &&
              signal.strength >= MIN_SIGNAL_CONFIDENCE,
          );

        const gatedBy: string[] = [];
        const scopedMetricRow =
          targetType === 'campaign'
            ? cm
            : targetType === 'adset'
              ? (adSetLevel[targetId] ?? cm)
              : adLevel[targetId];
        if (targetType === 'ad' && !scopedMetricRow) {
          gatedBy.push('evidence:target_metrics_unavailable');
        }
        if (gateStarBlock) gatedBy.push('lifecycle:all-blocked');
        if (blockedSet.has(type)) gatedBy.push(`lifecycle:${lifecycle.stage}`);
        if (!allowedSet.has(type) && !lossContainmentOnly)
          gatedBy.push(`lifecycle:${lifecycle.stage}:not_allowed`);
        const lifecycleGate = ACTION_LIFECYCLE_GATE[type];
        if (
          lifecycleGate &&
          !lifecycle.gates[lifecycleGate] &&
          !lossContainmentOnly
        ) {
          gatedBy.push(
            `lifecycle:${lifecycle.stage}:${snakeCase(lifecycleGate)}=false`,
          );
        }
        if (!confidence.gates.okToRecommend && !lossContainmentOnly)
          gatedBy.push('confidence:not_okToRecommend');
        if (!sourceMetricsFresh)
          gatedBy.push('source_metrics:stale_or_unknown');
        if (!economicsAvailable) gatedBy.push('economics:unavailable');
        if (!revenueEvidenceAvailable)
          gatedBy.push('revenue:evidence_unavailable');
        if (
          economicsAvailable &&
          revenueEvidenceAvailable &&
          !financialDataAvailable
        )
          gatedBy.push('financial_data:unavailable');
        if (capExhausted && (type === 'scale_adset' || type === 'add_adset'))
          gatedBy.push('business:weekly_cap_exhausted');
        const exactGoalSignal = supporting.find(
          (signal) => signal.goalEvidence,
        );
        if (
          exactGoalSignal &&
          type === 'scale_adset' &&
          campaignBudgetModel !== 'abo'
        ) {
          gatedBy.push('action:goal_scale_requires_verified_abo_budget');
        }
        if (type === 'shift_budget_between_adsets')
          gatedBy.push('action:requires_cross_adset_pair');
        if (recentlyWorsenedSameTarget.has(`${targetId}::${type}`))
          gatedBy.push('memory:same_target_recently_worsened');

        const requiredSignals = ACTION_REQUIRED_SIGNALS[type];
        if (
          requiredSignals &&
          !supporting.some((signal) => requiredSignals.has(signal.kind))
        ) {
          gatedBy.push('evidence:placement_breakdown_required');
        }
        // Current signals do not retain the allow-list or hourly schedule
        // required by Meta. An action with `{}` parameters is advisory text,
        // not an apply-ready recommendation, so keep it out of the review UI.
        if (type === 'narrow_placement') {
          gatedBy.push('action:publisher_platforms_unresolved');
        }
        if (type === 'dayparting') {
          gatedBy.push('action:schedule_unresolved');
        }
        // `add_adset` still depends on the legacy executor deriving/falling
        // back across audience, product, landing-page, budget and creative
        // state. Do not surface an approval card for an action the final
        // boundary must reject. Re-enable only when Recommendation persists a
        // complete immutable launch contract for every one of those inputs.
        if (type === 'add_adset') {
          gatedBy.push('action:add_adset_launch_contract_incomplete');
        }

        // Ad-level reasoning and profit math must use the exact ad row. A
        // profitable campaign/ad set must never mask a bleeding child ad;
        // when the ad row is absent the candidate is gated above instead of
        // borrowing a higher-level aggregate.
        let scopedROAS = targetType === 'ad' ? 0 : observedROAS;
        let scopedSpend = targetType === 'ad' ? 0 : observedSpend;
        let scopedPurchases = targetType === 'ad' ? 0 : observedPurchases;
        let scopedDailySpend = targetType === 'ad' ? 0 : dailySpendVelocity;
        const hasExactNonCampaignRow =
          (targetType === 'adset' && Boolean(adSetLevel[targetId])) ||
          (targetType === 'ad' && Boolean(adLevel[targetId]));
        if (hasExactNonCampaignRow && scopedMetricRow) {
          const m = scopedMetricRow;
          scopedROAS = num(m.roas);
          scopedSpend = num(m.spend);
          scopedPurchases = num(m.purchases);
          // m.spend is also a lifetime total (same Meta date_preset='maximum'
          // fetch as the campaign level) — no per-target age is available, so
          // the campaign's own age is the best available proxy, still far
          // more accurate than dividing a potentially months-old lifetime
          // total by a flat 7.
          scopedDailySpend = scopedSpend / ageDays;
        }

        // Does a genuine diagnosed root cause back this exact target and
        // action? Every signal in the diagnosis must occur in this target's
        // supporting evidence. An ad-set diagnosis cannot lend confidence to
        // its sibling (or to a campaign-level action) merely because the same
        // signal kind fired somewhere else.
        const focuses = ACTION_FOCUS[type];
        const matchingRootCause = diagnosis.rootCauses.find(
          (rc) =>
            rc.targetType === targetType &&
            rc.targetId === targetId &&
            focuses.includes(rc.suggestedFocus) &&
            rc.evidenceSignals.length > 0 &&
            rc.evidenceSignals.every((k) =>
              supporting.some((s) => s.kind === k),
            ),
        );

        const strongestSignalConfidence = Math.max(
          ...supporting.map((signal) => signal.strength),
        );
        if (strongestSignalConfidence < MIN_SIGNAL_CONFIDENCE) {
          gatedBy.push(
            `signal:weak(${strongestSignalConfidence.toFixed(2)}<${MIN_SIGNAL_CONFIDENCE.toFixed(2)})`,
          );
        }
        if (!matchingRootCause && !lossContainmentOnly) {
          gatedBy.push('diagnosis:no_matching_root_cause');
        } else if (
          matchingRootCause &&
          matchingRootCause.confidence < MIN_DIAGNOSIS_CONFIDENCE
        ) {
          gatedBy.push(
            `diagnosis:weak(${matchingRootCause.confidence.toFixed(2)}<${MIN_DIAGNOSIS_CONFIDENCE.toFixed(2)})`,
          );
        }

        const scopedMetrics = scopedMetricRow ?? {};

        const action = this.buildAction({
          cycleId,
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
          diagnosisNarrative: matchingRootCause
            ? `Exact-target hypothesis: ${matchingRootCause.hypothesis} (${Math.round(matchingRootCause.confidence * 100)}% confidence).`
            : diagnosis.narrative,
          matchingRootCause,
          forecastRecovering,
          forecastROAS7d,
          portfolioTier,
          recentlyWorsened: recentlyWorsenedTypes.has(type),
          topWinningHooks,
          topLosingHooks,
          campaignName,
          objective,
          objectiveMetricValue: metricValueForObjective(
            objective,
            scopedMetrics,
          ),
          lossContainmentOnly,
        });
        if (!Number.isFinite(action.score) || action.score <= 0) {
          action.gatedBy.push('quality:zero_score');
        }
        candidates.push(action);
        evidenceByActionId.set(action.actionId, {
          signalKind: supporting.map((s) => s.kind).join('+'),
          signalReasoning: supporting.map((s) => s.reasoning).join(' '),
          metrics: Object.assign(
            {},
            ...supporting.map((s) => s.metricEvidence),
          ),
        });
      }
    }

    // ── shift_budget_between_adsets — cross-adset synthesis ──────────
    // Prefer the exact same-window optimization-goal contract. It supplies a
    // verified donor and recipient without inventing a causal uplift. The
    // older revenue-only shortcut remains as a fallback for sales campaigns.
    const exactGoalShiftAction = this.buildGoalShiftBudgetAction({
      cycleId,
      signals: goalCompatibleSignals,
      campaignName,
      campaignBudgetModel,
      lifecycle,
      blockedSet,
      allowedSet,
      gateStarBlock,
      okToRecommend: confidence.gates.okToRecommend && sourceMetricsFresh,
      sourceMetricsFresh,
      diagnosis,
    });
    if (exactGoalShiftAction) {
      if (
        !Number.isFinite(exactGoalShiftAction.score) ||
        exactGoalShiftAction.score <= 0
      ) {
        exactGoalShiftAction.gatedBy.push('quality:zero_score');
      }
      candidates.push(exactGoalShiftAction);
      const sourceSignal = goalCompatibleSignals.find(
        (signal) =>
          signal.kind === 'optimization_goal_efficiency_lagging' &&
          signal.targetType === 'adset' &&
          signal.targetId === exactGoalShiftAction.targetId,
      );
      if (sourceSignal) {
        evidenceByActionId.set(exactGoalShiftAction.actionId, {
          signalKind: sourceSignal.kind,
          signalReasoning: sourceSignal.reasoning,
          metrics: { ...sourceSignal.metricEvidence },
        });
      }
    }

    const shiftAction = exactGoalShiftAction
      ? null
      : this.buildShiftBudgetAction({
          cycleId,
          adSetLevel,
          breakevenROAS,
          marginPct,
          ageDays,
          campaignName,
          objective,
          economicsAvailable,
          revenueEvidenceAvailable,
          financialDataAvailable,
          blockedSet,
          allowedSet,
          lifecycle,
          gateStarBlock,
          okToRecommend: confidence.gates.okToRecommend && sourceMetricsFresh,
        });
    if (shiftAction) {
      if (!sourceMetricsFresh) {
        shiftAction.gatedBy.push('source_metrics:stale_or_unknown');
      }
      if (!Number.isFinite(shiftAction.score) || shiftAction.score <= 0) {
        shiftAction.gatedBy.push('quality:zero_score');
      }
      candidates.push(shiftAction);
    }

    // Drop gated candidates (their gatedBy tag stays for observability).
    const ungated = candidates.filter((c) => c.gatedBy.length === 0);

    // Collapse the same lever proposed at two scopes.
    //
    // Signals fire independently at campaign and ad-set level, and
    // ACTION_SCOPE deliberately allows several action types at both — so a
    // winner_emerging on a single-ad-set campaign produces "increase budget
    // (whole campaign)" AND "increase budget (ad group)", which move the exact
    // same money. The reviewer sees two options and no way to tell them apart.
    //
    // Only collapses when the campaign genuinely has one ad set. With two or
    // more, campaign-level and ad-set-level budget changes are different
    // decisions (all ad sets vs one) and both deserve to be offered.
    const adSetCount = Object.keys(adSetLevel ?? {}).length;
    const filtered =
      adSetCount <= 1
        ? ungated.filter((c) => {
            if (c.targetType !== 'campaign') return true;
            // Drop the campaign-scoped twin; the ad-set target is the more
            // specific one and maps directly to a Meta ad-set id, whereas the
            // campaign target carries our internal campaign id.
            return !ungated.some(
              (o) => o.type === c.type && o.targetType === 'adset',
            );
          })
        : ungated;

    // Rank by score — which now folds in signal corroboration, diagnosis
    // agreement, forecast trajectory and portfolio context, not just the
    // raw ₹ estimate (see buildAction).
    filtered.sort((a, b) => b.score - a.score);

    // Persist to intelligence_decisions (LOCAL, shadow_mode_only).
    // Every write here has shadowModeOnly=true — the Execution Engine
    // is contractually forbidden from touching Meta while that flag is set.
    if (this.decisionModel && filtered.length > 0) {
      const now = new Date();
      const expires = new Date(now.getTime() + 48 * 60 * 60 * 1000);

      // Resolve campaign name + metaCampaignId for reasoning + traceability.
      let metaCampaignId: string | undefined;
      let campaignNameForDoc: string | undefined =
        campaignName === 'this campaign' ? undefined : campaignName;
      if (this.campaignModel && ident?.campaignId) {
        try {
          const c = await this.campaignModel
            .findById(ident.campaignId)
            .select('name metaCampaignId source')
            .lean()
            .exec();
          const doc = c as {
            name?: string;
            metaCampaignId?: string;
            source?: 'agent' | 'human' | 'manual';
          } | null;
          metaCampaignId = doc?.metaCampaignId;
          if (doc?.name) campaignNameForDoc = doc.name;
          campaignSource = doc?.source ?? campaignSource;
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
              // Legacy rows omit the objective/KPI contract. They must not
              // suppress the first fresh goal-aware proposal for 48 hours;
              // the read path keeps the newest equivalent row visible.
              decisionContractVersion: 'goal_aware_v1',
              // Likewise, create one fresh review-ready proposal when the
              // open row predates the bounded Step-14 OpenAI critic. Once a
              // decision has that contract, normal 48h dedup resumes.
              intelligenceReviewVersion: 'intelligence_review_v1',
              reviewWindowExpiresAt: { $gt: now },
              targetId: { $in: filtered.map((a) => a.targetId) },
              actionType: { $in: filtered.map((a) => a.type) },
            })
            .select('targetId actionType')
            .lean()
            .exec();
          for (const e of existing as Array<{
            targetId: string;
            actionType: string;
          }>) {
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
          campaignSource,
          cycleId,
          snapshotId: snapshot.snapshotId,
          actionId: a.actionId,
          actionType: a.type,
          targetType: a.targetType,
          targetId: a.targetId,
          parameters: a.parameters,
          decisionContractVersion: 'goal_aware_v1',
          objective: objective.objective,
          primaryKPI: objective.primaryKPI,
          expectedImpact: a.expectedImpact,
          financialDataAvailable: revenueObjective
            ? financialDataAvailable
            : undefined,
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
          this.log.warn(`decisions insertMany: ${(err as Error).message}`);
        }
      }
    }

    const gateReasonCounts: Record<string, number> = {};
    for (const c of candidates) {
      for (const reason of c.gatedBy) {
        gateReasonCounts[reason] = (gateReasonCounts[reason] ?? 0) + 1;
      }
    }

    return {
      actions: filtered,
      candidatesConsidered: candidates.length,
      gateReasonCounts,
    };
  }

  private buildAction(input: {
    cycleId: string;
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
    objective: ObjectiveData;
    objectiveMetricValue: number;
    lossContainmentOnly: boolean;
  }): RecommendedAction {
    const {
      cycleId,
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
      objective,
      objectiveMetricValue,
      lossContainmentOnly,
    } = input;

    const risk = RISK[type];
    const revenueObjective = isRevenueObjective(objective.objective);

    // Corroboration: multiple independent signals agreeing on the same
    // action raises confidence more than any one of them alone (noisy-OR —
    // with a single signal this reduces to exactly that signal's strength,
    // so single-cause cases behave identically to before).
    const combinedStrength = combineSignalStrength(signals);
    const metricEvidence: Record<string, number> = Object.assign(
      {},
      ...signals.map((sig) => sig.metricEvidence),
    );
    const goalEvidence = signals.find(
      (signal) => signal.goalEvidence,
    )?.goalEvidence;

    // ── Expected profit delta over next 7 days (contribution profit) ──
    // Each action type has a distinct profit-mechanics model.
    let projectedProfitDelta7dINR = 0;
    let impactMetric = 'roas';
    let deltaPct = 0;
    let mechanicsExplanation = '';
    let goalScoreBasis = 0;
    let parameters: Record<string, unknown> = {};

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

    if (goalEvidence) {
      // The comparator supplies a measured peer gap, not an intervention
      // forecast. Preserve the exact goal metric and keep economic impact at
      // zero until an executed action has its own 24h/72h outcome evidence.
      impactMetric = goalEvidence.efficiencyMetric;
      deltaPct = 0;
      projectedProfitDelta7dINR = 0;
      const gapMultiple = goalEvidence.observedGap.multiple;
      const gapLabel = goalEvidence.observedGap.unbounded
        ? 'an unbounded gap'
        : `${(gapMultiple ?? 0).toFixed(2)}x`;
      goalScoreBasis = Math.max(
        100,
        Math.round(100 * finiteSortValue(gapMultiple ?? Number.NaN)),
      );
      parameters = {
        optimizationGoal: goalEvidence.optimizationGoal,
        validationMetric: goalEvidence.efficiencyMetric,
        evidenceWindow: { ...goalEvidence.window },
        claimScope: goalEvidence.claimScope,
        ...(type === 'scale_adset' ? { scalePercent: 10 } : {}),
      };
      mechanicsExplanation = `${goalMechanic(type)} The exact ${words(goalEvidence.efficiencyMetric)} is ${formatExactGoalEfficiency(goalEvidence.current.efficiency, goalEvidence)} versus a pooled ${formatExactGoalEfficiency(goalEvidence.pooledSiblingBaseline.efficiency, goalEvidence)} baseline from ${goalEvidence.pooledSiblingBaseline.peerCount} active same-goal siblings (${gapLabel} ${goalEvidence.observedGap.direction}). This is observed evidence; no causal uplift or economic gain is estimated.`;
    } else if (revenueObjective) {
      switch (type) {
        case 'pause_adset':
        case 'pause_ad':
        case 'reduce_total_budget': {
          // If currently unprofitable, pausing avoids further losses.
          if (observedROAS > 0 && observedROAS < breakevenROAS) {
            const lossPerRupee = (breakevenROAS - observedROAS) * marginPct;
            const reductionFraction = type === 'reduce_total_budget' ? 0.2 : 1;
            projectedProfitDelta7dINR =
              dailySpendVelocity * 7 * lossPerRupee * reductionFraction;
            mechanicsExplanation =
              type === 'reduce_total_budget'
                ? `A 20% budget reduction limits modeled additional loss by roughly ₹${projectedProfitDelta7dINR.toFixed(0)} over the next 7 days if the current ₹${dailySpendVelocity.toFixed(0)}/day pace and economics persist. It does not assume ROAS will improve.`
                : `Stopping spend here saves an estimated ₹${projectedProfitDelta7dINR.toFixed(0)} of losses over the next 7 days at the current ₹${dailySpendVelocity.toFixed(0)}/day pace.`;
          } else {
            projectedProfitDelta7dINR = 0;
            mechanicsExplanation = `This campaign appears profitable today — pausing would forgo profit, not save it.`;
          }
          impactMetric = 'losses_avoided';
          if (type === 'reduce_total_budget') {
            parameters = { reductionPercent: 20 };
            deltaPct = 20;
          } else {
            deltaPct = 100;
          }
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
          projectedProfitDelta7dINR =
            (revenueGain / Math.max(1, observedSpend)) *
            dailySpendVelocity *
            7 *
            marginPct;
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
            projectedProfitDelta7dINR =
              dailySpendVelocity * 7 * lossPerRupee * 0.3;
          } else {
            projectedProfitDelta7dINR =
              dailySpendVelocity * 7 * marginPct * 0.05;
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
            projectedProfitDelta7dINR =
              (revenueGain / Math.max(1, observedSpend)) *
              dailySpendVelocity *
              7 *
              marginPct;
          }
          mechanicsExplanation = `Focusing spend on the ${type === 'narrow_placement' ? 'best-performing placements' : 'best-performing hours'} typically frees ~6% of wasted spend. ~₹${projectedProfitDelta7dINR.toFixed(0)} added profit over 7 days.`;
          impactMetric = 'cpm';
          // CPM is a cost metric: improvement is a decrease. Decision Trace
          // renders the sign literally (positive = "up"), so +6 incorrectly
          // promised that the action would make CPM worse.
          deltaPct = -6;
          break;
        }
        case 'add_adset': {
          // Fresh audience — assume incremental profit at 70% of current ROAS
          const marginalROAS = observedROAS * 0.7;
          if (marginalROAS > breakevenROAS) {
            const profitPerRupee = (marginalROAS - breakevenROAS) * marginPct;
            projectedProfitDelta7dINR =
              dailySpendVelocity * 7 * profitPerRupee * 0.5;
          }
          mechanicsExplanation = `New audience segment; assumes marginal ROAS at 70% of current (${(observedROAS * 0.7).toFixed(2)}×). ~₹${projectedProfitDelta7dINR.toFixed(0)} added profit over 7 days if it holds.`;
          impactMetric = 'incremental_purchases';
          deltaPct = 20;
          break;
        }
      }
    } else {
      const goalMetric = scoredMetricFor(objective.objective);
      // Without a same-goal, same-window peer baseline or a prior measured
      // outcome for this exact lever, a percentage uplift would be invented.
      // Keep the action testable but explicitly unquantified.
      deltaPct = 0;
      impactMetric = goalMetric.metric;
      goalScoreBasis = 100;
      const currentValue = formatGoalMetric(
        goalMetric.metric,
        objectiveMetricValue,
      );
      mechanicsExplanation = `${goalMechanic(type)} The current ${goalMetric.label.toLowerCase()} is ${currentValue}. No causal uplift is estimated; the exact goal metric must be measured after the controlled action.`;

      if (
        (type === 'replace_creative' || type === 'add_creative') &&
        (topWinningHooks.length > 0 || topLosingHooks.length > 0)
      ) {
        const hookName = (hook: string) => hook.split(' (')[0];
        if (topWinningHooks.length > 0) {
          mechanicsExplanation += ` Proven account hooks to test first: ${topWinningHooks.map(hookName).join(' and ')}.`;
        }
        if (topLosingHooks.length > 0) {
          mechanicsExplanation += ` Avoid previously weak hooks: ${topLosingHooks.map(hookName).join(' and ')}.`;
        }
      }
    }

    // ── Context multipliers — how confidently we RANK this action, layered
    // on top of the mechanical ₹ estimate above. These never rewrite the ₹
    // number itself (that stays an honest mechanical estimate); they decide
    // how loudly this action competes against others for review priority,
    // and they each add a line of genuine cross-engine reasoning.
    const isCutAction =
      type === 'pause_adset' ||
      type === 'pause_ad' ||
      type === 'reduce_total_budget';
    const isGrowthAction = type === 'scale_adset' || type === 'add_adset';

    let diagnosisMult = 1;
    let diagnosisLine = '';
    if (matchingRootCause) {
      diagnosisMult = 1 + matchingRootCause.confidence * 0.5;
      diagnosisLine = goalEvidence
        ? `Diagnosis preserves the boundary: ${matchingRootCause.hypothesis} (${Math.round(matchingRootCause.confidence * 100)}% evidence confidence).`
        : revenueObjective
          ? `Diagnosis agrees: "${matchingRootCause.hypothesis}" (${Math.round(matchingRootCause.confidence * 100)}% confidence) points at the same ${matchingRootCause.suggestedFocus} root cause.`
          : `Diagnosis agrees at ${Math.round(matchingRootCause.confidence * 100)}% confidence and points at the same ${matchingRootCause.suggestedFocus} cause.`;
    }

    let forecastMult = 1;
    let forecastLine = '';
    if (
      revenueObjective &&
      !goalEvidence &&
      isCutAction &&
      forecastRecovering
    ) {
      forecastMult = 0.6;
      forecastLine = `Caveat: the 7-day forecast shows ROAS trending toward ${forecastROAS7d.toFixed(2)}× — already recovering, so this may be premature.`;
    }

    let portfolioMult = 1;
    let portfolioLine = '';
    if (!goalEvidence && (portfolioTier === 'D' || portfolioTier === 'C')) {
      if (isGrowthAction) {
        portfolioMult = 0.7;
        portfolioLine = `Portfolio context: this campaign ranks tier ${portfolioTier} account-wide — scaling a weak performer is lower priority than its isolated estimate suggests.`;
      } else if (isCutAction) {
        portfolioMult = 1.15;
        portfolioLine = revenueObjective
          ? `Portfolio context: this campaign ranks tier ${portfolioTier} account-wide, reinforcing the case to cut losses here.`
          : `Portfolio context: this campaign ranks tier ${portfolioTier} account-wide, reinforcing the case to reduce inefficient delivery here.`;
      }
    } else if (!goalEvidence && portfolioTier === 'A' && isGrowthAction) {
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
    const scoreBasis = goalEvidence
      ? goalScoreBasis
      : revenueObjective
        ? Math.abs(projectedProfitDelta7dINR)
        : goalScoreBasis;
    const score = Math.round(
      (scoreBasis / RISK_MULT[risk]) *
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
    const subject =
      targetType === 'adset'
        ? `The ad group in ${campaignName}`
        : targetType === 'ad'
          ? `Ad ${targetId} in ${campaignName}`
          : campaignName;
    let conditionLine: string;
    if (goalEvidence) {
      conditionLine = `${subject} is an observed ${goalEvidence.optimizationGoal} ${goalEvidence.observedGap.direction === 'worse' ? 'laggard' : 'leader'} on ${words(goalEvidence.efficiencyMetric)} against exact active siblings in the same reporting window.`;
    } else if (!revenueObjective) {
      const goalMetric = scoredMetricFor(objective.objective);
      conditionLine = `${subject} is assigned the ${objective.objective.replace(/_/g, ' ')} objective. Its current ${goalMetric.label.toLowerCase()} is ${formatGoalMetric(goalMetric.metric, objectiveMetricValue)}.`;
    } else {
      const roasGap = breakevenROAS - observedROAS;
      const gapIsMeaningful = roasGap > 0.05;
      const lossPerRupee = roasGap * marginPct;
      if (observedROAS <= 0) {
        conditionLine = `${subject} has generated no tracked revenue on ₹${observedSpend.toFixed(0)} of spend so far.`;
      } else if (gapIsMeaningful) {
        conditionLine = `${subject} is running at ${observedROAS.toFixed(2)}× ROAS — below the ${breakevenROAS.toFixed(2)}× it needs to make a profit. Roughly ₹${lossPerRupee.toFixed(2)} is being lost for every ₹1 spent.`;
      } else if (observedROAS < breakevenROAS) {
        conditionLine = `${subject} is stuck in the break-even zone (${observedROAS.toFixed(2)}× ROAS vs ${breakevenROAS.toFixed(2)}× needed). It's not losing much, but it's not making profit either.`;
      } else {
        conditionLine = `${subject} is profitable — running at ${observedROAS.toFixed(2)}× ROAS above the ${breakevenROAS.toFixed(2)}× breakeven.`;
      }
    }

    // Evidence chain — plain-English, no engine jargon in the strings. One
    // entry per corroborating signal (previously always exactly one).
    const evidenceChain: RecommendedAction['evidenceChain'] = [
      ...signals.map((sig) => ({ step: sig.reasoning, source: 'signal' })),
      ...(goalEvidence
        ? [
            {
              step: `Exact Meta goal: ${goalEvidence.optimizationGoal}; measured KPI: ${words(goalEvidence.efficiencyMetric)}; current ${formatExactGoalEfficiency(goalEvidence.current.efficiency, goalEvidence)}; pooled sibling baseline ${formatExactGoalEfficiency(goalEvidence.pooledSiblingBaseline.efficiency, goalEvidence)}.`,
              source: 'snapshot',
            },
            {
              step: 'Claim boundary: same-window peer observation only; causality and future uplift are not established.',
              source: 'safety_policy',
            },
          ]
        : revenueObjective
          ? [
              {
                step: `Money: ${observedROAS.toFixed(2)}× ROAS observed, needs ${breakevenROAS.toFixed(2)}× to break even (contribution margin ${(marginPct * 100).toFixed(0)}%).`,
                source: 'revenue',
              },
              {
                step: `Spend pace: ~₹${dailySpendVelocity.toFixed(0)}/day across ${observedPurchases} purchases so far.`,
                source: 'snapshot',
              },
            ]
          : [
              {
                step: `Goal: ${objective.objective.replace(/_/g, ' ')}; primary KPI: ${objective.primaryKPI}.`,
                source: 'objective',
              },
              {
                step: `${scoredMetricFor(objective.objective).label}: ${formatGoalMetric(scoredMetricFor(objective.objective).metric, objectiveMetricValue)} on ₹${observedSpend.toFixed(0)} spend.`,
                source: 'snapshot',
              },
            ]),
      {
        step: lossContainmentOnly
          ? `Containment guard: the root cause is unresolved, so this is a bounded 20% human-review throttle—not a claim that ROAS will improve. Evidence threshold: ≥${LOSS_CONTAINMENT_MIN_AGE_HOURS / 24} days, ≥₹${LOSS_CONTAINMENT_MIN_SPEND_INR.toLocaleString('en-IN')} spend, and ≥${LOSS_CONTAINMENT_MIN_PURCHASES} purchases.`
          : goalEvidence
            ? `Diagnosis boundary: ${diagnosisNarrative}`
            : revenueObjective
              ? `Root cause: ${diagnosisNarrative}`
              : `Goal-compatible root-cause confidence: ${Math.round((matchingRootCause?.confidence ?? 0) * 100)}%; focus: ${matchingRootCause?.suggestedFocus ?? 'unresolved'}.`,
        source: lossContainmentOnly ? 'safety_policy' : 'diagnosis',
      },
      ...(forecastLine ? [{ step: forecastLine, source: 'forecast' }] : []),
      ...(portfolioLine ? [{ step: portfolioLine, source: 'portfolio' }] : []),
      ...(memoryLine ? [{ step: memoryLine, source: 'memory' }] : []),
      ...((type === 'replace_creative' || type === 'add_creative') &&
      (topWinningHooks.length > 0 || topLosingHooks.length > 0)
        ? [
            {
              step: [
                topWinningHooks.length > 0
                  ? `Winning hooks on this account: ${topWinningHooks.join('; ')}.`
                  : '',
                topLosingHooks.length > 0
                  ? `Losing hooks: ${topLosingHooks.join('; ')}.`
                  : '',
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
      lossContainmentOnly
        ? `The causal diagnosis is unresolved; this is loss containment for human review, not an optimization-uplift claim.`
        : '',
      diagnosisLine,
      forecastLine,
      portfolioLine,
      memoryLine,
    ]
      .filter(Boolean)
      .join(' ');

    return {
      actionId: stableActionId(cycleId, type, targetType, targetId),
      type,
      targetType,
      targetId,
      parameters,
      expectedImpact: {
        metric: impactMetric,
        deltaPct,
        confidence: combinedStrength,
        basis: goalEvidence
          ? 'observed_gap'
          : revenueObjective
            ? 'modeled'
            : 'not_estimated',
        ...(goalEvidence?.current.efficiency !== null &&
        goalEvidence?.current.efficiency !== undefined
          ? { currentValue: goalEvidence.current.efficiency }
          : !revenueObjective && Number.isFinite(objectiveMetricValue)
            ? { currentValue: objectiveMetricValue }
            : {}),
        ...(goalEvidence
          ? {
              siblingBaselineValue:
                goalEvidence.pooledSiblingBaseline.efficiency,
              ...(goalEvidence.observedGap.multiple === null
                ? {}
                : {
                    observedGapPct:
                      Math.round(
                        (goalEvidence.observedGap.multiple - 1) * 1000,
                      ) / 10,
                  }),
            }
          : {}),
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
   * Build a bounded ABO reallocation from two independently-qualified exact
   * goal signals. This is an observed same-window peer gap, never a forecast
   * that the gap will persist after money moves.
   */
  private buildGoalShiftBudgetAction(input: {
    cycleId: string;
    signals: Signal[];
    campaignName: string;
    campaignBudgetModel?: 'abo' | 'cbo' | 'asc';
    lifecycle: LifecycleData;
    blockedSet: Set<string>;
    allowedSet: Set<string>;
    gateStarBlock: boolean;
    okToRecommend: boolean;
    sourceMetricsFresh: boolean;
    diagnosis: DiagnosisData;
  }): RecommendedAction | null {
    const laggards = input.signals.filter(
      (signal) =>
        signal.kind === 'optimization_goal_efficiency_lagging' &&
        signal.targetType === 'adset' &&
        signal.goalEvidence,
    );
    const leaders = input.signals.filter(
      (signal) =>
        signal.kind === 'optimization_goal_efficiency_leading' &&
        signal.targetType === 'adset' &&
        signal.goalEvidence,
    );
    if (laggards.length === 0 || leaders.length === 0) return null;

    const pairs = laggards.flatMap((laggard) =>
      leaders
        .filter(
          (leader) =>
            leader.targetId !== laggard.targetId &&
            exactGoalEvidenceMatches(
              laggard.goalEvidence!,
              leader.goalEvidence!,
            ) &&
            laggard.goalEvidence!.pooledSiblingBaseline.peerIds.includes(
              leader.targetId,
            ),
        )
        .map((leader) => ({ laggard, leader })),
    );
    if (pairs.length === 0) return null;

    pairs.sort((left, right) => {
      const leftGap = goalPairMultiple(
        left.laggard.goalEvidence!,
        left.leader.goalEvidence!,
      );
      const rightGap = goalPairMultiple(
        right.laggard.goalEvidence!,
        right.leader.goalEvidence!,
      );
      return finiteSortValue(rightGap) - finiteSortValue(leftGap);
    });
    const { laggard, leader } = pairs[0];
    const evidence = laggard.goalEvidence!;
    const leaderEvidence = leader.goalEvidence!;
    const pairMultiple = goalPairMultiple(evidence, leaderEvidence);
    const shiftPercent = 10;
    const gatedBy: string[] = [];

    if (input.campaignBudgetModel !== 'abo') {
      gatedBy.push('action:goal_shift_requires_verified_abo_budget');
    }
    if (input.gateStarBlock) gatedBy.push('lifecycle:all-blocked');
    if (input.blockedSet.has('shift_budget_between_adsets')) {
      gatedBy.push('lifecycle:blocked');
    }
    if (!input.allowedSet.has('shift_budget_between_adsets')) {
      gatedBy.push(`lifecycle:${input.lifecycle.stage}:not_allowed`);
    }
    if (!input.okToRecommend) gatedBy.push('confidence:not_okToRecommend');
    if (!input.sourceMetricsFresh) {
      gatedBy.push('source_metrics:stale_or_unknown');
    }
    const diagnosis = input.diagnosis.rootCauses.find(
      (cause) =>
        cause.targetType === 'adset' &&
        cause.targetId === laggard.targetId &&
        cause.suggestedFocus === 'delivery_efficiency' &&
        cause.evidenceSignals.includes('optimization_goal_efficiency_lagging'),
    );
    if (!diagnosis) {
      gatedBy.push('diagnosis:no_matching_root_cause');
    } else if (diagnosis.confidence < MIN_DIAGNOSIS_CONFIDENCE) {
      gatedBy.push(
        `diagnosis:weak(${diagnosis.confidence.toFixed(2)}<${MIN_DIAGNOSIS_CONFIDENCE.toFixed(2)})`,
      );
    }

    const currentValue = evidence.current.efficiency;
    const leaderValue = leaderEvidence.current.efficiency;
    if (leaderValue === null) return null;
    const observedGapPct = Number.isFinite(pairMultiple)
      ? Math.round((pairMultiple - 1) * 1000) / 10
      : undefined;
    const metricLabel = words(evidence.efficiencyMetric);
    const gapText = Number.isFinite(pairMultiple)
      ? `${pairMultiple.toFixed(2)}x`
      : 'an unbounded amount';
    const reasoning = [
      `Reallocate 10% of the donor ad set's allocation inside ${input.campaignName}.`,
      `Ad set ${laggard.targetId} is ${gapText} less efficient on ${metricLabel} than exact same-window ${evidence.optimizationGoal} leader ${leader.targetId}.`,
      `This is an observational ABO reallocation for human review; it does not claim the recipient caused the difference or promise future uplift.`,
    ].join(' ');
    const evidenceChain: RecommendedAction['evidenceChain'] = [
      {
        step: laggard.reasoning,
        source: 'signal',
      },
      {
        step: leader.reasoning,
        source: 'signal',
      },
      {
        step: `Like-for-like gate: ${evidence.optimizationGoal}, ${evidence.window.dateStart} to ${evidence.window.dateStop}, ${evidence.currency}, ${evidence.pooledSiblingBaseline.peerCount} eligible peers, identical source and attribution identity.`,
        source: 'snapshot',
      },
      {
        step: 'Safety policy: ABO only, 10% donor shift, shadow review, human approval, and no causal-uplift estimate.',
        source: 'safety_policy',
      },
    ];

    return {
      actionId: stableActionId(
        input.cycleId,
        'shift_budget_between_adsets',
        'adset',
        laggard.targetId,
      ),
      type: 'shift_budget_between_adsets',
      targetType: 'adset',
      targetId: laggard.targetId,
      parameters: {
        fromAdSetId: laggard.targetId,
        toAdSetId: leader.targetId,
        shiftPercent,
        optimizationGoal: evidence.optimizationGoal,
        validationMetric: evidence.efficiencyMetric,
        evidenceWindow: { ...evidence.window },
        claimScope: evidence.claimScope,
      },
      expectedImpact: {
        metric: evidence.efficiencyMetric,
        deltaPct: 0,
        confidence: Math.min(laggard.strength, leader.strength),
        basis: 'observed_gap',
        ...(currentValue === null ? {} : { currentValue }),
        siblingBaselineValue: leaderValue,
        ...(observedGapPct === undefined ? {} : { observedGapPct }),
      },
      expectedProfitDeltaINR7d: 0,
      reasoning,
      evidenceChain,
      risk: 'low',
      implementationCost: 1,
      score: Math.round(
        100 *
          Math.min(laggard.strength, leader.strength) *
          Math.min(3, finiteSortValue(pairMultiple)),
      ),
      gatedBy,
      requiresHumanApproval: true,
    };
  }

  /**
   * Look inside the campaign's ad-sets for a clear winner+loser pair and
   * propose a shift_budget_between_adsets action. This is intentionally
   * synthesized in the Recommendation Engine (not signaled by SignalEngine)
   * because it requires cross-adset comparison.
   */
  private buildShiftBudgetAction(input: {
    cycleId: string;
    adSetLevel: Record<string, Record<string, number>>;
    breakevenROAS: number;
    marginPct: number;
    ageDays: number;
    campaignName: string;
    objective: ObjectiveData;
    economicsAvailable: boolean;
    revenueEvidenceAvailable: boolean;
    financialDataAvailable: boolean;
    blockedSet: Set<string>;
    allowedSet: Set<string>;
    lifecycle: LifecycleData;
    gateStarBlock: boolean;
    okToRecommend: boolean;
  }): RecommendedAction | null {
    const {
      cycleId,
      adSetLevel,
      breakevenROAS,
      marginPct,
      ageDays,
      campaignName,
      objective,
      economicsAvailable,
      revenueEvidenceAvailable,
      financialDataAvailable,
      blockedSet,
      allowedSet,
      lifecycle,
      gateStarBlock,
      okToRecommend,
    } = input;

    // Cross-adset synthesis below is explicitly ROAS/breakeven based. Goal
    // campaigns still get shift suggestions when objective-compatible
    // audience/delivery signals support them, through buildAction above; they
    // must never enter this revenue-only shortcut.
    if (!isRevenueObjective(objective.objective)) return null;

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
    const shiftPercent = 30;
    // loser.spend is a lifetime total (Meta date_preset='maximum'), not a
    // week's worth — same fix as elsewhere in this file, using campaign age
    // as the best available proxy for this ad set's own age.
    const loserDaily = loser.spend / ageDays;
    const shiftedDaily = loserDaily * (shiftPercent / 100);
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
    if (!allowedSet.has('shift_budget_between_adsets'))
      gatedBy.push(`lifecycle:${lifecycle.stage}:not_allowed`);
    if (!okToRecommend) gatedBy.push('confidence:not_okToRecommend');
    if (!economicsAvailable) gatedBy.push('economics:unavailable');
    if (!revenueEvidenceAvailable) gatedBy.push('revenue:evidence_unavailable');
    if (
      economicsAvailable &&
      revenueEvidenceAvailable &&
      !financialDataAvailable
    )
      gatedBy.push('financial_data:unavailable');
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
    ];

    return {
      actionId: stableActionId(
        cycleId,
        'shift_budget_between_adsets',
        'adset',
        loser.id,
      ),
      type: 'shift_budget_between_adsets',
      targetType: 'adset',
      targetId: loser.id,
      parameters: {
        fromAdSetId: loser.id,
        toAdSetId: winner.id,
        shiftPercent,
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

function exactGoalEvidenceMatches(
  left: OptimizationGoalSignalEvidence,
  right: OptimizationGoalSignalEvidence,
): boolean {
  return (
    left.optimizationGoal === right.optimizationGoal &&
    left.resultMetric === right.resultMetric &&
    left.efficiencyMetric === right.efficiencyMetric &&
    left.efficiencyUnit === right.efficiencyUnit &&
    left.lowerIsBetter === right.lowerIsBetter &&
    left.window.dateStart === right.window.dateStart &&
    left.window.dateStop === right.window.dateStop &&
    left.window.metricScope === right.window.metricScope &&
    left.sourceFingerprint === right.sourceFingerprint &&
    left.currency === right.currency &&
    left.claimScope === 'observational_same_window_peer_comparison' &&
    right.claimScope === 'observational_same_window_peer_comparison' &&
    left.causalClaim === false &&
    right.causalClaim === false &&
    left.expectedUplift === null &&
    right.expectedUplift === null
  );
}

function goalPairMultiple(
  laggard: OptimizationGoalSignalEvidence,
  leader: OptimizationGoalSignalEvidence,
): number {
  const laggardValue = laggard.current.efficiency;
  const leaderValue = leader.current.efficiency;
  if (leaderValue === null || leaderValue < 0) return Number.NaN;
  if (laggardValue === null) {
    return laggard.lowerIsBetter ? Number.NaN : Number.POSITIVE_INFINITY;
  }
  if (laggardValue < 0) return Number.NaN;
  if (laggard.lowerIsBetter) {
    if (leaderValue === 0) return Number.POSITIVE_INFINITY;
    return laggardValue / leaderValue;
  }
  if (laggardValue === 0) return Number.POSITIVE_INFINITY;
  return leaderValue / laggardValue;
}

function finiteSortValue(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return 10;
  return Number.isFinite(value) ? value : 0;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function combineSignalStrength(signals: Signal[]): number {
  return 1 - signals.reduce((acc, signal) => acc * (1 - signal.strength), 1);
}

function metricValueForObjective(
  objective: ObjectiveData,
  metrics: Record<string, number>,
): number {
  const goalMetric = scoredMetricFor(objective.objective).metric;
  const computed = computeObjectiveMetric(goalMetric, {
    spend: num(metrics.spend),
    revenue: num(metrics.revenue),
    purchases: num(metrics.purchases),
    conversions: num(metrics.conversions ?? metrics.purchases),
    clicks: num(metrics.clicks),
    impressions: num(metrics.impressions),
  });

  // Direct Meta metric is a useful fallback when the raw operands are absent
  // in an older replayed slice. Prefer recomputation when operands exist so
  // rate units stay consistent with Objective Engine grading.
  return computed || num(metrics[goalMetric]);
}

function goalMechanic(type: CampaignActionType): string {
  const mechanics: Record<CampaignActionType, string> = {
    pause_ad:
      'Pausing the weak delivery unit prevents more inefficient goal events.',
    pause_adset:
      'Pausing the weak audience segment concentrates delivery on stronger goal performance.',
    scale_adset:
      'A controlled budget increase expands the strongest goal-performing segment.',
    replace_creative:
      'Refreshing the creative addresses the observed attention decline.',
    add_creative:
      'Adding a creative variant gives delivery a fresh way to reach the assigned audience.',
    add_adset:
      'Adding an audience segment tests incremental delivery against the assigned goal.',
    shift_budget_between_adsets:
      'Reallocating budget concentrates delivery on the better goal-performing segment.',
    reduce_total_budget:
      'Reducing budget limits inefficient delivery while the goal signal is repaired.',
    narrow_placement:
      'Narrowing placements removes delivery surfaces implicated by the observed signal.',
    dayparting:
      'Dayparting concentrates delivery in the stronger observed time windows.',
  };
  return mechanics[type];
}

function formatGoalMetric(metric: string, value: number): string {
  if (metric === 'ctr' || metric === 'cvr') return `${value.toFixed(2)}%`;
  if (metric === 'cpc' || metric === 'cpm') return `₹${value.toFixed(2)}`;
  return value.toFixed(2);
}

function formatExactGoalEfficiency(
  value: number | null,
  evidence: OptimizationGoalSignalEvidence,
): string {
  if (value === null) return 'undefined because the observed result is zero';
  if (evidence.efficiencyMetric === 'raw_roas') return `${value.toFixed(2)}x`;
  const prefix = evidence.currency === 'INR' ? '₹' : `${evidence.currency} `;
  return `${prefix}${value.toFixed(2)}`;
}

function words(value: string): string {
  return value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
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
function humanizeSentence(
  type: CampaignActionType,
  campaignName: string,
): string {
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
