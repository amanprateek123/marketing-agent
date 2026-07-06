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
  RecommendationData,
  RecommendedAction,
  Signal,
  SignalKind,
  TrendData,
} from '../orchestrator/decision-context';

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
const ACTION_SCOPE: Record<CampaignActionType, Array<'campaign' | 'adset' | 'ad'>> = {
  pause_ad: ['ad', 'adset'],
  pause_adset: ['adset'],
  scale_adset: ['adset'],
  replace_creative: ['ad', 'adset'],
  add_creative: ['adset', 'campaign'],
  add_adset: ['campaign'],
  shift_budget_between_adsets: ['campaign', 'adset'],
  reduce_total_budget: ['campaign'],
  narrow_placement: ['campaign', 'adset'],
  dayparting: ['campaign'],
};

/**
 * Signal → suggested action mapping. Kept deterministic — the *scoring*
 * happens on top of this using observed evidence.
 */
const SIGNAL_TO_ACTIONS: Partial<Record<SignalKind, CampaignActionType[]>> = {
  creative_fatigue: ['replace_creative', 'add_creative'],
  hook_burn: ['replace_creative', 'add_creative'],
  ctr_decay: ['replace_creative'],
  cvr_collapse: ['pause_adset', 'replace_creative'],
  frequency_ceiling: ['narrow_placement', 'dayparting'],
  audience_saturation: ['narrow_placement', 'shift_budget_between_adsets'],
  audience_exhaustion: ['shift_budget_between_adsets', 'add_adset'],
  budget_saturation: ['reduce_total_budget'],
  delivery_stalled: ['shift_budget_between_adsets'],
  placement_leak: ['narrow_placement'],
  unprofitable_run: ['pause_adset', 'reduce_total_budget'],
  winner_emerging: ['scale_adset'],
  winner_confirmed: ['scale_adset'],
  learning_limited_locked: ['shift_budget_between_adsets'],
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
    const revenue = deps.revenue!.data as {
      breakeven: { roas: number; isProfitable: boolean };
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
    // Approximate daily spend from 3d slope + current
    const dailySpendVelocity = Math.max(
      (trend.perMetric.spend?.ema3d ?? observedSpend) / 3,
      observedSpend / 7,
    );

    const marginPct = revenue.derivation?.marginPct ?? 0.4;
    const breakevenROAS = revenue.breakeven.roas || 2.5;

    // Resolve the campaign name once so reasoning references a real name
    // instead of "campaign unknown". Non-blocking — falls back to id.
    let campaignName = 'this campaign';
    if (this.campaignModel) {
      const ident = this.identity.values().next().value;
      if (ident?.campaignId) {
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
    }

    const blockedSet = new Set(
      lifecycle.blockedActions
        .filter((b) => b.action !== '*')
        .map((b) => b.action),
    );
    const gateStarBlock = lifecycle.blockedActions.some((b) => b.action === '*');

    const candidates: RecommendedAction[] = [];
    for (const s of signals) {
      const actionTypes = SIGNAL_TO_ACTIONS[s.kind] ?? [];
      for (const type of actionTypes) {
        // Skip actions that don't apply at this signal's target level
        // (e.g. reduce_total_budget from an adset-level unprofitable_run).
        if (!ACTION_SCOPE[type].includes(s.targetType)) continue;

        const gatedBy: string[] = [];
        if (gateStarBlock) gatedBy.push('lifecycle:all-blocked');
        if (blockedSet.has(type)) gatedBy.push(`lifecycle:${lifecycle.stage}`);
        if (!confidence.gates.okToRecommend)
          gatedBy.push('confidence:not_okToRecommend');

        // For adset-level signals, use the adset's own metrics in the
        // reasoning + profit math — not the campaign's aggregate, which
        // can be profitable overall while individual adsets bleed.
        let scopedROAS = observedROAS;
        let scopedSpend = observedSpend;
        let scopedPurchases = observedPurchases;
        let scopedDailySpend = dailySpendVelocity;
        if (s.targetType === 'adset' && adSetLevel[s.targetId]) {
          const m = adSetLevel[s.targetId];
          scopedROAS = num(m.roas);
          scopedSpend = num(m.spend);
          scopedPurchases = num(m.purchases);
          scopedDailySpend = scopedSpend / 7;
        }

        candidates.push(
          this.buildAction({
            type,
            signal: s,
            gatedBy,
            observedROAS: scopedROAS,
            observedSpend: scopedSpend,
            observedPurchases: scopedPurchases,
            dailySpendVelocity: scopedDailySpend,
            marginPct,
            breakevenROAS,
            diagnosisNarrative: diagnosis.narrative,
            campaignName,
          }),
        );
      }
    }

    // ── shift_budget_between_adsets — cross-adset synthesis ──────────
    // Needs cross-adset context that no single signal has. Look for a clear
    // winner+loser pair inside the same campaign and propose a shift.
    const shiftAction = this.buildShiftBudgetAction({
      adSetLevel,
      breakevenROAS,
      marginPct,
      dailySpendVelocity,
      campaignName,
      diagnosisNarrative: diagnosis.narrative,
      blockedSet,
      gateStarBlock,
      okToRecommend: confidence.gates.okToRecommend,
    });
    if (shiftAction) candidates.push(shiftAction);

    // Drop gated candidates (their gatedBy tag stays for observability).
    const filtered = candidates.filter((c) => c.gatedBy.length === 0);

    // Rank by expected ₹ profit delta (positive = profit gain, negative = loss avoided).
    filtered.sort(
      (a, b) => Math.abs(b.expectedProfitDeltaINR7d) - Math.abs(a.expectedProfitDeltaINR7d),
    );

    // Persist to intelligence_decisions (LOCAL, shadow_mode_only).
    // Every write here has shadowModeOnly=true — the Execution Engine
    // is contractually forbidden from touching Meta while that flag is set.
    if (this.decisionModel && filtered.length > 0) {
      const ident = this.identity.values().next().value;
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

      // Attach signal evidence to each action for review
      const signalByAction: Record<
        string,
        { kind: string; reasoning: string; metrics: Record<string, number> }
      > = {};
      for (const action of filtered) {
        const kindMatch = action.evidenceChain[0]?.step.match(/'([^']+)'/)?.[1];
        const originalSignal = signals.find((s) => s.kind === kindMatch);
        if (originalSignal) {
          signalByAction[action.actionId] = {
            kind: originalSignal.kind,
            reasoning: originalSignal.reasoning,
            metrics: originalSignal.metricEvidence,
          };
        }
      }

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
    signal: Signal;
    gatedBy: string[];
    observedROAS: number;
    observedSpend: number;
    observedPurchases: number;
    dailySpendVelocity: number;
    marginPct: number;
    breakevenROAS: number;
    diagnosisNarrative: string;
    campaignName: string;
  }): RecommendedAction {
    const {
      type,
      signal: s,
      gatedBy,
      observedROAS,
      observedSpend,
      observedPurchases,
      dailySpendVelocity,
      marginPct,
      breakevenROAS,
      diagnosisNarrative,
      campaignName,
    } = input;

    const risk = RISK[type];

    // ── Expected profit delta over next 7 days (contribution profit) ──
    // Each action type has a distinct profit-mechanics model.
    let projectedProfitDelta7dINR = 0;
    let impactMetric = 'roas';
    let deltaPct = 0;
    let mechanicsExplanation = '';

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
          const uplift = 0.2 * s.strength; // scaled by signal confidence
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
        const ctrDrop = num(s.metricEvidence.dropPct) || 0.35;
        const ctrRecovery = ctrDrop * 0.5;
        // Rough: 1pp CTR recovery adds roughly (spend / cpc) more clicks →
        // more purchases at current CVR → more revenue. Approximate:
        const revenueMultiplier = 1 + ctrRecovery;
        const currentRevenue = observedROAS * observedSpend;
        const newRevenue = currentRevenue * revenueMultiplier;
        const revenueGain = newRevenue - currentRevenue;
        projectedProfitDelta7dINR = (revenueGain / Math.max(1, observedSpend)) * dailySpendVelocity * 7 * marginPct;
        mechanicsExplanation = `Fresh creative typically restores ~50% of observed CTR drop (${(ctrDrop * 100).toFixed(0)}%). At current CVR, that's ~₹${projectedProfitDelta7dINR.toFixed(0)} more contribution profit over 7 days.`;
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
          const revenueGain = observedSpend * observedROAS * uplift;
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

    // Score = |expected profit delta| discounted by risk. Ranks larger-impact
    // low-risk actions above smaller-impact high-risk ones.
    const score = Math.round(
      (Math.abs(projectedProfitDelta7dINR) / RISK_MULT[risk]) * s.strength,
    );

    // Plain-English condition summary — works both when the campaign is
    // solidly below breakeven ("losing X per ₹") and when it's barely below
    // ("break-even zone — not making profit"). Subject varies by target
    // level so adset-level actions don't read as if the whole campaign is
    // failing.
    const subject = s.targetType === 'adset'
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

    // Evidence chain — plain-English, no engine jargon in the strings.
    const evidenceChain: RecommendedAction['evidenceChain'] = [
      {
        step: s.reasoning,
        source: 'signal',
      },
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
    ];

    // Reasoning — one plain-English paragraph. No markdown, no jargon.
    const reasoning = [
      `${humanizeSentence(type, campaignName)}.`,
      conditionLine,
      mechanicsExplanation,
    ]
      .filter(Boolean)
      .join(' ');

    return {
      actionId: randomUUID(),
      type,
      targetType: s.targetType,
      targetId: s.targetId,
      parameters: {},
      expectedImpact: {
        metric: impactMetric,
        deltaPct,
        confidence: s.strength,
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
    dailySpendVelocity: number;
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
    const loserDaily = loser.spend / 7;
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
