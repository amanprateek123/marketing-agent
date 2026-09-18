import { Injectable, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import {
  SliceIdentity,
  SliceRepository,
} from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { Campaign } from '../../campaigns/schemas/campaign.schema';
import { BreakdownSnapshot } from '../../campaigns/schemas/breakdown-snapshot.schema';
import {
  OptimizationGoalSignalEvidence,
  Signal,
  SignalData,
  SignalKind,
  TrendData,
} from '../orchestrator/decision-context';
import { isRevenueObjective } from '../objective/kpi-profiles';
import { compareGoalEfficiencyPeers } from '../objective/goal-efficiency';
import { buildSnapshotGoalEfficiencyRows } from '../objective/goal-efficiency-snapshot';
import type { SnapshotData } from '../snapshot/snapshot.types';
import { hasEnoughElapsedTrendHistory } from '../trend/trend-readiness';

/**
 * These rules read purchases, ROAS or product breakeven. They are not merely
 * unhelpful for reach/click/engagement objectives; they can invert the truth
 * by calling a successful awareness campaign a failure for having no sales.
 */
const REVENUE_EVIDENCE_SIGNALS = new Set<SignalKind>([
  'cvr_collapse',
  'unprofitable_run',
  'winner_emerging',
  'winner_confirmed',
  'budget_saturation',
  'audience_exhaustion',
  'placement_leak',
]);

// Frequency is an observation, not a diagnosis. Warm/custom audiences are
// deliberately smaller than cold prospecting audiences, so they use a higher
// monitoring threshold. Downstream still requires corroborating evidence
// before frequency can justify a creative or placement action.
const COLD_FREQUENCY_MONITORING_THRESHOLD = 5.5;
const WARM_FREQUENCY_MONITORING_THRESHOLD = 8;

/**
 * Signals fired from observation, not from cached rules.
 *
 * For trend-derived rules we compare the CURRENT observation against this
 * campaign's own recent DAILY observations. Repeated intraday scheduler ticks
 * are collapsed by TrendEngine and cannot unlock these rules. Every signal
 * ships with a human-readable `reasoning` string built at fire-time explaining
 * exactly what evidence triggered it.
 */
@Injectable()
export class SignalEngine extends BaseEngine<'signal', SignalData> {
  readonly name = 'signal' as const;
  readonly step = 6;
  readonly version = '1.3.0';
  readonly dependsOn = [
    'snapshot',
    'objective',
    'lifecycle',
    'trend',
    'revenue',
  ] as const;

  private readonly identity = new Map<
    string,
    { tenantId: string; campaignId: string }
  >();

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
    @Optional()
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<Campaign> | null = null,
    @Optional()
    @InjectModel(BreakdownSnapshot.name)
    private readonly breakdownModel: Model<BreakdownSnapshot> | null = null,
  ) {
    super(sliceRepo, eventBus, registry);
  }

  @OnEvent('intelligence.revenue.completed')
  async onRevenueCompleted(payload: {
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
    deps: ComputeDeps<'signal'>,
    cycleId: string,
    identity: SliceIdentity,
  ): Promise<SignalData> {
    void cycleId;
    const snap = deps.snapshot!;
    const lifecycle = deps.lifecycle!;
    const trend = deps.trend! as { data: TrendData };
    const revenue = deps.revenue!;
    const objective = deps.objective!;
    const snapshotData = snap.data as unknown as SnapshotData;
    const metrics = snapshotData.metrics;
    const cm = metrics?.campaignLevel ?? {};
    const adSetLevel = metrics?.adSetLevel ?? {};
    const adLevel = metrics?.adLevel ?? {};
    const adEntities = snapshotData.entities?.ads ?? {};

    const ignored = new Set(objective.data.policy.ignoreSignals ?? []);
    const ident = identity;
    const targetId = ident?.campaignId ?? 'unknown';
    const signals: Signal[] = [];

    // Snapshot values
    const freq = num(cm.frequency);
    const ctr = num(cm.ctr);
    const cpc = num(cm.cpc);
    const spend = num(cm.spend);
    const impressions = num(cm.impressions);
    const purchases = num(cm.purchases);
    const clicks = num(cm.clicks);
    const roas = num(cm.roas);
    const cvr = num(cm.cvr);
    const revenueData = revenue.data as {
      breakeven: { roas: number; isProfitable: boolean };
      targetROAS?: number;
      financialDataAvailable?: boolean;
      derivation?: {
        method: string;
        breakevenROAS: number;
        marginPct: number;
      };
    };
    const revenueObjective = isRevenueObjective(objective.data.objective);
    const financialDataAvailable = revenueData.financialDataAvailable === true;
    const breakevenROAS = revenueData.breakeven.roas;
    // System scale heuristic (2x breakeven, per product — see RevenueEngine),
    // not an observed company target. Falls back to breakeven*2 for older
    // slices computed before this field existed.
    const targetROAS = revenueData.targetROAS ?? breakevenROAS * 2;
    const isProfitable = revenueData.breakeven.isProfitable;
    // Trend baselines — this campaign's own daily observations. Field names
    // retain their historical *7d/*3d suffix for persisted-contract
    // compatibility, but their unit is now daily observation, not raw tick.
    const emaCTR7 = trend.data.perMetric.ctr?.ema7d ?? 0;
    const emaFreq7 = trend.data.perMetric.frequency?.ema7d ?? 0;
    const emaReach7 = trend.data.perMetric.reach?.ema7d ?? 0;
    const slopeCTR3 = trend.data.perMetric.ctr?.slope3d ?? 0;
    const slopeROAS7 = trend.data.perMetric.roas?.slope7d ?? 0;
    const slopeSpend7 = trend.data.perMetric.spend?.slope7d ?? 0;
    const slopeReach7 = trend.data.perMetric.reach?.slope7d ?? 0;
    const hasBaseline = hasEnoughElapsedTrendHistory(trend.data);
    const trendObservationCount = trend.data.observationCount ?? 0;
    const trendElapsedDays = trend.data.windowElapsedDays ?? 0;

    const push = (
      kind: SignalKind,
      opts: {
        severity: Signal['severity'];
        targetType?: Signal['targetType'];
        target?: string;
        trigger: string;
        strength: number;
        metricEvidence: Record<string, number>;
        reasoning: string;
        goalEvidence?: OptimizationGoalSignalEvidence;
      },
    ) => {
      if (ignored.has(kind)) return;
      // Fail closed twice: first on campaign goal, then on attribution and
      // product economics. This also protects old objective profiles whose
      // ignoreSignals list did not enumerate every revenue-derived rule.
      if (REVENUE_EVIDENCE_SIGNALS.has(kind)) {
        if (!revenueObjective || !financialDataAvailable) return;
      }
      signals.push({
        kind,
        severity: opts.severity,
        targetType: opts.targetType ?? 'campaign',
        targetId: opts.target ?? targetId,
        metricEvidence: opts.metricEvidence,
        trigger: opts.trigger,
        strength: opts.strength,
        reasoning: opts.reasoning,
        goalEvidence: opts.goalEvidence,
        firstSeenAt: new Date(),
      });
    };

    // ── delivery_stalled — no delivery despite live spend ────────────
    if (spend > 50 && impressions === 0) {
      push('delivery_stalled', {
        severity: 'critical',
        strength: 1,
        trigger: 'spend>50 AND impressions=0',
        metricEvidence: { spend, impressions },
        reasoning: `Meta reports ₹${spend.toFixed(0)} spent but zero impressions delivered. Ad account or targeting is broken — check first.`,
      });
    }

    // ── learning_limited_locked — direct Meta signal ─────────────────
    if (lifecycle.data.metaLearningStage === 'LEARNING_LIMITED') {
      push('learning_limited_locked', {
        severity: 'warn',
        strength: 0.9,
        trigger: 'meta.learningStage=LEARNING_LIMITED',
        metricEvidence: {},
        reasoning: `Meta reports Learning Limited — this campaign doesn't get enough conversion events to leave the learning phase. It won't optimize normally until fed more.`,
      });
    }

    // Skip performance signals while in early stages
    const skipPerfStage =
      lifecycle.data.stage === 'learning' ||
      lifecycle.data.stage === 'launching';

    // ── creative_fatigue — freq up vs OWN baseline AND CTR declining
    if (!skipPerfStage) {
      const freqAboveBaseline = emaFreq7 > 0 && freq / emaFreq7 >= 1.4;
      const ctrDeclining = slopeCTR3 < -0.005;
      if (hasBaseline && freqAboveBaseline && ctrDeclining) {
        const ratio = freq / emaFreq7;
        push('creative_fatigue', {
          severity: freq > 4 ? 'critical' : 'warn',
          strength: Math.min(
            1,
            (ratio - 1) * 0.8 + Math.min(1, Math.abs(slopeCTR3) * 40),
          ),
          trigger:
            'freq/recentDailyBaseline>=1.4 AND recentDailyCTRTrend<-0.005',
          metricEvidence: {
            frequency: freq,
            frequencyBaseline: emaFreq7,
            ctrSlopePerDailyObservation: slopeCTR3,
            trendObservationCount,
            trendElapsedDays,
          },
          // slopeCTR3 is already in ctr's own percentage-point units (Meta's
          // convention: 0.95 means 0.95%) — no *100 needed to label it "pp".
          reasoning: `Frequency ${freq.toFixed(1)} is ${((ratio - 1) * 100).toFixed(0)}% above this campaign's recent daily-observation baseline of ${emaFreq7.toFixed(1)}, and CTR fell ${Math.abs(slopeCTR3).toFixed(2)} percentage points per daily observation across ${trendObservationCount} observations spanning ${trendElapsedDays.toFixed(1)} elapsed days. The audience is seeing these creatives too often — CTR loss confirms it.`,
        });
      }
    }

    // ── frequency_ceiling — absolute over-frequency ──────────────────
    if (freq > COLD_FREQUENCY_MONITORING_THRESHOLD) {
      push('frequency_ceiling', {
        severity: 'critical',
        strength: Math.min(1, (freq - COLD_FREQUENCY_MONITORING_THRESHOLD) / 3),
        trigger: 'freq>generalCampaignMonitoringThreshold(5.5)',
        metricEvidence: {
          frequency: freq,
          monitoringThreshold: COLD_FREQUENCY_MONITORING_THRESHOLD,
        },
        reasoning: `Campaign frequency is ${freq.toFixed(1)}, above the system's ${COLD_FREQUENCY_MONITORING_THRESHOLD.toFixed(1)} general early-warning threshold. Campaign rollups can mix warm and cold ad groups, so this only flags saturation risk; target-specific thresholds and corroborating trend or breakdown evidence are required before any action.`,
      });
    }

    // ── ctr_decay — CTR falling fast vs recent daily baseline ────────
    if (!skipPerfStage && hasBaseline && emaCTR7 > 0 && ctr > 0) {
      const drop = 1 - ctr / emaCTR7;
      if (drop >= 0.35) {
        push('ctr_decay', {
          severity: drop >= 0.5 ? 'critical' : 'warn',
          strength: Math.min(1, drop),
          trigger: 'ctr<0.65*recentDailyBaseline',
          metricEvidence: {
            ctr,
            ctrBaseline: emaCTR7,
            dropPct: round(drop, 3),
            trendObservationCount,
            trendElapsedDays,
          },
          // ctr/emaCTR7 are already percentage-point numbers (Meta's own
          // convention: 0.95 means 0.95%), not a 0-1 fraction — no *100 here.
          reasoning: `CTR is ${ctr.toFixed(2)}%, ${(drop * 100).toFixed(0)}% below this campaign's recent daily-observation baseline of ${emaCTR7.toFixed(2)}%, based on ${trendObservationCount} observations spanning ${trendElapsedDays.toFixed(1)} elapsed days. People are clicking less than they did on the same ad recently.`,
        });
      }
    }

    // ── cvr_collapse — traffic flowing but nobody converts ───────────
    if (clicks > 200 && purchases === 0) {
      push('cvr_collapse', {
        severity: 'critical',
        strength: 1,
        trigger: 'clicks>200 AND purchases=0',
        metricEvidence: { clicks, purchases, cvr },
        reasoning: `${clicks} people clicked and 0 bought. The audience→landing-page match is broken — either the wrong audience or a landing page that doesn't convert this traffic.`,
      });
    }

    // ── unprofitable_run — below breakeven with meaningful spend ─────
    if (breakevenROAS > 0 && spend > 500 && !isProfitable && roas > 0) {
      const gap = breakevenROAS - roas;
      const relativeGap = gap / breakevenROAS;
      const contribMarginProxy = revenueData.derivation?.marginPct ?? 0.4;
      const lossPerRupee = gap * contribMarginProxy;
      push('unprofitable_run', {
        severity: relativeGap >= 0.3 ? 'critical' : 'warn',
        strength: Math.min(1, relativeGap),
        trigger: 'roas<breakevenROAS AND spend>500',
        metricEvidence: {
          roas,
          breakevenROAS,
          gap: round(gap, 3),
          relativeGap: round(relativeGap, 3),
          spend,
        },
        reasoning:
          gap > 0.05
            ? `Return on spend is ${roas.toFixed(2)}× but this product needs ${breakevenROAS.toFixed(2)}× to break even. Roughly ₹${lossPerRupee.toFixed(2)} is being lost for every ₹1 spent.`
            : `Return on spend (${roas.toFixed(2)}×) is stuck at the break-even line (${breakevenROAS.toFixed(2)}×). The campaign isn't losing much, but it isn't making profit either.`,
      });
    }

    // ── winner_emerging — clearly above breakeven and moving toward the
    // system's scale heuristic
    if (roas >= breakevenROAS * 1.3 && purchases >= 5 && breakevenROAS > 0) {
      const marginPct = revenueData.derivation?.marginPct ?? 0.4;
      const profitPerRupee = (roas - breakevenROAS) * marginPct;
      const pctToTarget =
        targetROAS > breakevenROAS
          ? Math.min(1, (roas - breakevenROAS) / (targetROAS - breakevenROAS))
          : 1;
      push('winner_emerging', {
        severity: 'info',
        strength: Math.min(1, roas / breakevenROAS / 2),
        trigger: 'roas>=breakevenROAS*1.3 AND purchases>=5',
        metricEvidence: {
          roas,
          breakevenROAS,
          targetROAS,
          purchases,
        },
        reasoning: `ROAS ${roas.toFixed(2)}× is 30% or more above breakeven ${breakevenROAS.toFixed(2)}× with ${purchases} conversions — ${Math.round(pctToTarget * 100)}% of the way to the system's ${targetROAS.toFixed(2)}× scale heuristic (2× breakeven, not an observed business target). Each ₹1 in creates roughly ₹${profitPerRupee.toFixed(2)} of contribution profit. Scale candidate.`,
      });
    }

    // ── winner_confirmed — at the system's scale heuristic, sustained
    // volume, and non-negative trend backed by real elapsed daily history.
    if (
      hasBaseline &&
      roas >= targetROAS &&
      purchases >= 20 &&
      breakevenROAS > 0 &&
      slopeROAS7 >= 0
    ) {
      push('winner_confirmed', {
        severity: 'info',
        strength: 1,
        trigger:
          'roas>=systemScaleHeuristic AND purchases>=20 AND recentDailyROASTrend>=0',
        metricEvidence: {
          roas,
          breakevenROAS,
          targetROAS,
          purchases,
          roasSlopePerDailyObservation: slopeROAS7,
          trendObservationCount,
          trendElapsedDays,
        },
        reasoning: `${purchases} conversions at ${roas.toFixed(2)}× ROAS — at or above the system's ${targetROAS.toFixed(2)}× scale heuristic (2× breakeven, not an observed business target) — with ROAS non-declining across ${trendObservationCount} daily observations spanning ${trendElapsedDays.toFixed(1)} elapsed days. Confirmed scale candidate.`,
      });
    }

    // ── budget_saturation — high CPC + low volume ────────────────────
    if (cpc > 25 && purchases < 3 && spend > 500) {
      push('budget_saturation', {
        severity: 'warn',
        strength: 0.6,
        trigger: 'cpc>25 AND purchases<3 AND spend>500',
        metricEvidence: { cpc, purchases, spend },
        reasoning: `Meta charges ₹${cpc.toFixed(1)} per click but only ${purchases} of them converted despite ₹${spend.toFixed(0)} spent. Auction pressure is high relative to this audience's conversion probability.`,
      });
    }

    // ── audience_exhaustion — ROAS falling while spend rising ────────
    if (
      !skipPerfStage &&
      hasBaseline &&
      slopeROAS7 < -0.05 &&
      slopeSpend7 > 0
    ) {
      push('audience_exhaustion', {
        severity: 'warn',
        strength: Math.min(1, Math.abs(slopeROAS7)),
        trigger: 'recentDailyROASTrend<-0.05 AND recentDailySpendTrend>0',
        metricEvidence: {
          roasSlopePerDailyObservation: slopeROAS7,
          spendSlopePerDailyObservation: slopeSpend7,
          trendObservationCount,
          trendElapsedDays,
        },
        reasoning: `ROAS is falling across ${trendObservationCount} daily observations spanning ${trendElapsedDays.toFixed(1)} elapsed days while spend continues to grow. Meta is reaching further into the audience pool to spend the budget — the cheap high-intent buyers may be exhausted.`,
      });
    }

    // ── audience_saturation — reach has plateaued but spend keeps climbing ──
    // Distinct from audience_exhaustion (ROAS-decline-driven) and
    // frequency_ceiling (absolute freq threshold): this fires on the
    // earlier, more specific pattern of "no new people being found" — reach
    // essentially flat relative to its own baseline while frequency is
    // already meaningfully elevated and spend is still growing, i.e. the
    // extra budget is buying repeat impressions on the same people, not
    // expansion.
    if (
      !skipPerfStage &&
      hasBaseline &&
      emaReach7 > 0 &&
      Math.abs(slopeReach7) < 0.01 * emaReach7 &&
      freq >= 2.5 &&
      slopeSpend7 > 0
    ) {
      push('audience_saturation', {
        severity: freq >= 4 ? 'critical' : 'warn',
        strength: Math.min(1, (freq - 2.5) / 3),
        trigger:
          'reach flat across recentDailyObservations AND freq>=2.5 AND recentDailySpendTrend>0',
        metricEvidence: {
          reach: emaReach7,
          reachSlopePerDailyObservation: slopeReach7,
          frequency: freq,
          spendSlopePerDailyObservation: slopeSpend7,
          trendObservationCount,
          trendElapsedDays,
        },
        reasoning: `Reach stayed near ${emaReach7.toFixed(0)} people across ${trendObservationCount} daily observations spanning ${trendElapsedDays.toFixed(1)} elapsed days while frequency is ${freq.toFixed(1)} and spend keeps rising. The extra budget is buying repeat impressions on the same audience, not new people.`,
      });
    }

    // ── Ad-set level firings ─────────────────────────────────────────
    // Adsets are where actions land. Fire per-adset so downstream actions
    // (pause_adset, scale_adset) can target a real ID.
    //
    // Meta's /insights endpoint returns metrics for every adset that had
    // impressions in the window — even paused ones. Firing pause_adset on
    // an already-paused adset is noise. Look up the campaign's stored
    // metaAdSets (populated by the sync service with each adset's current
    // effective_status) and skip anything not ACTIVE.
    const marginPct = revenueData.derivation?.marginPct ?? 0.4;
    const adSetStatuses = new Map<string, string>();
    const adSetAudienceTypes = new Map<string, string>();
    let metaCampaignId: string | undefined;
    if (this.campaignModel && ident?.campaignId) {
      try {
        const c = (await this.campaignModel
          .findById(ident.campaignId)
          .select('metaAdSets metaCampaignId')
          .lean()
          .exec()) as {
          metaAdSets?: Array<{
            id?: string;
            status?: string;
            audienceType?: string;
            targetingDetail?: { customAudiences?: unknown[] };
            rawTargeting?: { custom_audiences?: unknown[] };
          }>;
          metaCampaignId?: string;
        } | null;
        metaCampaignId = c?.metaCampaignId;
        for (const as of c?.metaAdSets ?? []) {
          if (!as.id) continue;
          if (as.status)
            adSetStatuses.set(as.id, String(as.status).toUpperCase());
          const hasCustomAudience =
            (as.targetingDetail?.customAudiences?.length ?? 0) > 0 ||
            (as.rawTargeting?.custom_audiences?.length ?? 0) > 0;
          adSetAudienceTypes.set(
            as.id,
            hasCustomAudience
              ? 'custom'
              : String(as.audienceType ?? 'other').toLowerCase(),
          );
        }
      } catch {
        // non-fatal — we just won't be able to filter by status
      }
    }
    const isAdsetActive = (id: string): boolean => {
      // Unknown status → allow (better to propose than to silently skip when
      // we've never synced this adset's state).
      const s = adSetStatuses.get(id);
      return !s || s === 'ACTIVE';
    };
    // Common delivery/creative observations must also run for awareness,
    // reach and traffic campaigns, where breakeven ROAS is intentionally
    // unavailable. Revenue-derived signals still fail closed inside push().
    for (const [adSetId, m] of Object.entries(adSetLevel)) {
      if (!isAdsetActive(adSetId)) continue;
      const asSpend = num(m.spend);
      const asRoas = num(m.roas);
      const asPurchases = num(m.purchases);
      const asFreq = num(m.frequency);
      const asClicks = num(m.clicks);
      const asCpc = num(m.cpc);
      const asCtr = num(m.ctr);
      const asImpressions = num(m.impressions);

      // unprofitable_run — adset below breakeven with meaningful spend
      if (
        breakevenROAS > 0 &&
        asSpend > 300 &&
        asRoas > 0 &&
        asRoas < breakevenROAS
      ) {
        const gap = breakevenROAS - asRoas;
        const relativeGap = gap / breakevenROAS;
        const lossPerRupee = gap * marginPct;
        push('unprofitable_run', {
          severity: relativeGap >= 0.3 ? 'critical' : 'warn',
          strength: Math.min(1, relativeGap),
          targetType: 'adset',
          target: adSetId,
          trigger: 'adset.roas<breakevenROAS AND adset.spend>300',
          metricEvidence: {
            roas: asRoas,
            breakevenROAS,
            gap: round(gap, 3),
            relativeGap: round(relativeGap, 3),
            spend: asSpend,
            purchases: asPurchases,
          },
          reasoning: `This ad group is at ${asRoas.toFixed(2)}× ROAS on ₹${asSpend.toFixed(0)} of spend — below the ${breakevenROAS.toFixed(2)}× breakeven. Roughly ₹${lossPerRupee.toFixed(2)} lost per ₹1 spent here.`,
        });
      }

      // winner_emerging — adset clearly above breakeven, making progress
      // toward the system's scale heuristic
      if (
        !skipPerfStage &&
        breakevenROAS > 0 &&
        asRoas >= breakevenROAS * 1.3 &&
        asPurchases >= 3
      ) {
        const profitPerRupee = (asRoas - breakevenROAS) * marginPct;
        const pctToTarget =
          targetROAS > breakevenROAS
            ? Math.min(
                1,
                (asRoas - breakevenROAS) / (targetROAS - breakevenROAS),
              )
            : 1;
        push('winner_emerging', {
          severity: 'info',
          strength: Math.min(1, asRoas / breakevenROAS / 2),
          targetType: 'adset',
          target: adSetId,
          trigger: 'adset.roas>=breakevenROAS*1.3 AND adset.purchases>=3',
          metricEvidence: {
            roas: asRoas,
            breakevenROAS,
            targetROAS,
            purchases: asPurchases,
            spend: asSpend,
          },
          reasoning: `This ad group is at ${asRoas.toFixed(2)}× ROAS with ${asPurchases} purchases — 30%+ above breakeven ${breakevenROAS.toFixed(2)}×, ${Math.round(pctToTarget * 100)}% of the way to the system's ${targetROAS.toFixed(2)}× scale heuristic (2× breakeven, not an observed business target). Each ₹1 here creates roughly ₹${profitPerRupee.toFixed(2)} of contribution profit. Scale candidate.`,
        });
      }

      // winner_confirmed — at the system scale heuristic at adset level,
      // with sustained volume
      if (
        !skipPerfStage &&
        breakevenROAS > 0 &&
        asRoas >= targetROAS &&
        asPurchases >= 10
      ) {
        push('winner_confirmed', {
          severity: 'info',
          strength: 1,
          targetType: 'adset',
          target: adSetId,
          trigger: 'adset.roas>=targetROAS AND adset.purchases>=10',
          metricEvidence: {
            roas: asRoas,
            breakevenROAS,
            targetROAS,
            purchases: asPurchases,
          },
          reasoning: `Ad group has ${asPurchases} purchases at ${asRoas.toFixed(2)}× ROAS — at or above the system's ${targetROAS.toFixed(2)}× scale heuristic (2× breakeven, not an observed business target). Confirmed scale candidate.`,
        });
      }

      // frequency_ceiling — adset over-frequency
      const audienceType = adSetAudienceTypes.get(adSetId) ?? 'other';
      const warmAudience =
        audienceType === 'retarget' || audienceType === 'custom';
      const frequencyThreshold = warmAudience
        ? WARM_FREQUENCY_MONITORING_THRESHOLD
        : COLD_FREQUENCY_MONITORING_THRESHOLD;
      if (asFreq > frequencyThreshold) {
        push('frequency_ceiling', {
          severity: 'critical',
          strength: Math.min(1, (asFreq - frequencyThreshold) / 3),
          targetType: 'adset',
          target: adSetId,
          trigger: warmAudience
            ? 'adset.freq>warmAudienceMonitoringThreshold(8.0)'
            : 'adset.freq>coldAudienceMonitoringThreshold(5.5)',
          metricEvidence: {
            frequency: asFreq,
            spend: asSpend,
            monitoringThreshold: frequencyThreshold,
          },
          reasoning: `Ad group frequency is ${asFreq.toFixed(1)}, above the system's ${frequencyThreshold.toFixed(1)} ${warmAudience ? 'warm/custom' : 'cold/unknown'}-audience monitoring threshold. This is a saturation-risk observation, not proof of fatigue or a placement problem.`,
        });
      }

      // cvr_collapse — traffic but no conversions at adset level
      if (!skipPerfStage && asClicks > 100 && asPurchases === 0) {
        push('cvr_collapse', {
          severity: 'critical',
          strength: 1,
          targetType: 'adset',
          target: adSetId,
          trigger: 'adset.clicks>100 AND adset.purchases=0',
          metricEvidence: {
            clicks: asClicks,
            purchases: asPurchases,
            spend: asSpend,
          },
          reasoning: `Ad group had ${asClicks} clicks and 0 purchases. The audience → landing-page match is broken for this group.`,
        });
      }

      // budget_saturation — high CPC + low volume at adset level
      if (!skipPerfStage && asCpc > 25 && asPurchases < 3 && asSpend > 500) {
        push('budget_saturation', {
          severity: 'warn',
          strength: 0.6,
          targetType: 'adset',
          target: adSetId,
          trigger: 'adset.cpc>25 AND adset.purchases<3 AND adset.spend>500',
          metricEvidence: {
            cpc: asCpc,
            purchases: asPurchases,
            spend: asSpend,
          },
          reasoning: `Ad group at ₹${asCpc.toFixed(1)}/click but only ${asPurchases} of ${asClicks} clicks converted despite ₹${asSpend.toFixed(0)} spent.`,
        });
      }

      // ctr_decay — adset CTR far below the campaign's own 7d baseline.
      // No per-adset historical baseline exists, so the campaign-wide
      // emaCTR7 is used as the comparison point: this adset is under-
      // performing what this campaign's creatives typically do.
      if (
        !skipPerfStage &&
        hasBaseline &&
        emaCTR7 > 0 &&
        asImpressions >= 500 &&
        asCtr > 0
      ) {
        const asDrop = 1 - asCtr / emaCTR7;
        if (asDrop >= 0.35) {
          push('ctr_decay', {
            severity: asDrop >= 0.5 ? 'critical' : 'warn',
            strength: Math.min(1, asDrop),
            targetType: 'adset',
            target: adSetId,
            trigger:
              'adset.ctr<0.65*campaignRecentDailyBaseline AND adset.impressions>=500',
            metricEvidence: {
              ctr: asCtr,
              ctrBaseline: emaCTR7,
              dropPct: round(asDrop, 3),
              impressions: asImpressions,
              trendObservationCount,
              trendElapsedDays,
            },
            // asCtr/emaCTR7 are already percentage-point numbers — no *100.
            reasoning: `This ad group's CTR is ${asCtr.toFixed(2)}%, ${(asDrop * 100).toFixed(0)}% below the campaign's recent daily-observation baseline of ${emaCTR7.toFixed(2)}%, based on ${trendObservationCount} observations spanning ${trendElapsedDays.toFixed(1)} elapsed days. Its creative is underperforming what this campaign recently gets.`,
          });
        }
      }

      // creative_fatigue — adset frequency elevated vs campaign baseline
      // AND campaign-wide CTR trend declining. Same baseline-proxy
      // reasoning as ctr_decay above: no per-adset EMA exists yet.
      if (
        !skipPerfStage &&
        hasBaseline &&
        emaFreq7 > 0 &&
        asFreq / emaFreq7 >= 1.4 &&
        slopeCTR3 < -0.005
      ) {
        const asRatio = asFreq / emaFreq7;
        push('creative_fatigue', {
          severity: asFreq > 4 ? 'critical' : 'warn',
          strength: Math.min(
            1,
            (asRatio - 1) * 0.8 + Math.min(1, Math.abs(slopeCTR3) * 40),
          ),
          targetType: 'adset',
          target: adSetId,
          trigger:
            'adset.freq/campaignRecentDailyBase>=1.4 AND campaign.recentDailyCTRTrend<-0.005',
          metricEvidence: {
            frequency: asFreq,
            frequencyBaseline: emaFreq7,
            ctrSlopePerDailyObservation: slopeCTR3,
            trendObservationCount,
            trendElapsedDays,
          },
          // slopeCTR3 is already in ctr's own percentage-point units — no *100.
          reasoning: `This ad group's frequency is ${asFreq.toFixed(1)}, ${((asRatio - 1) * 100).toFixed(0)}% above the campaign's recent daily-observation baseline of ${emaFreq7.toFixed(1)}, while campaign-wide CTR fell ${Math.abs(slopeCTR3).toFixed(2)} percentage points per daily observation across ${trendObservationCount} observations spanning ${trendElapsedDays.toFixed(1)} elapsed days. This group's audience is likely seeing its creative too often.`,
        });
      }
    }

    // ── hook_burn — ad-level: video's opening hook isn't landing ─────
    // Distinct from creative_fatigue (frequency-driven, campaign-level):
    // this fires on a specific ad's own hook performance regardless of
    // frequency — videoP25 (watched past the opening ~3s equivalent) as a
    // fraction of impressions is the hook-engagement rate; low hook rate
    // AND low CTR together mean the opening isn't earning attention, not
    // just that the audience has seen it too many times.
    if (!skipPerfStage) {
      for (const [adId, m] of Object.entries(adLevel)) {
        if (m.format !== 'video') continue;
        if (!isActiveOrStatusUnknown(adEntities[adId])) continue;
        const adImpressions = finiteNumberOrUndefined(m.impressions);
        const adVideoP25 = finiteNumberOrUndefined(m.videoP25);
        const adCtr = finiteNumberOrUndefined(m.ctr);
        // `videoP25` is optional in the snapshot. Absence means Meta did not
        // provide hook-depth evidence; it is not an observed zero. CTR is
        // likewise required because the rule depends on both measurements.
        if (
          adImpressions === undefined ||
          adVideoP25 === undefined ||
          adCtr === undefined
        ) {
          continue;
        }
        if (adImpressions < 1000) continue; // not enough volume to trust the ratio
        const hookRate = adVideoP25 / adImpressions;
        // ctr here is Meta's own field convention: a percentage-point
        // number (0.95 means 0.95%), not a 0-1 fraction — same convention
        // as every other ctr read in this file. 1.0 below means "under 1%".
        if (hookRate < 0.15 && adCtr < 1.0) {
          push('hook_burn', {
            severity: hookRate < 0.08 ? 'critical' : 'warn',
            strength: Math.min(1, (0.15 - hookRate) / 0.15),
            targetType: 'ad',
            target: adId,
            trigger: 'ad.hookRate<0.15 AND ad.ctr<1.0(%) AND ad.format=video',
            metricEvidence: {
              hookRate: round(hookRate, 3),
              videoP25: adVideoP25,
              impressions: adImpressions,
              ctr: adCtr,
            },
            // hookRate is a genuine 0-1 fraction (videoP25/impressions raw
            // counts) so *100 is correct there; adCtr is already a
            // percentage-point number (Meta's convention) so it isn't.
            reasoning: `Only ${(hookRate * 100).toFixed(1)}% of the ${adImpressions.toLocaleString()} people who saw this video watched past the opening, and CTR is ${adCtr.toFixed(2)}%. The hook isn't earning attention.`,
          });
        }
      }
    }

    // Exact optimization-goal peer observations are independent of product
    // economics and broad campaign KPIs. The shared adapter + pure comparator
    // enforce exact parent, ACTIVE status, goal, window, source, currency and
    // attribution identity. These signals intentionally map to no action yet.
    for (const signal of buildOptimizationGoalSignals(snapshotData)) {
      if (!ignored.has(signal.kind)) signals.push(signal);
    }

    // ── placement_leak — one placement burning spend at far worse ROAS ──
    // Uses breakdown_snapshots (populated by the separate deep-sync cron,
    // not re-fetched here) rather than a live Meta call — this data already
    // exists, no reason to hit the API again for it.
    if (
      !skipPerfStage &&
      this.breakdownModel &&
      ident?.tenantId &&
      metaCampaignId &&
      roas > 0 &&
      spend > 0
    ) {
      try {
        const bd = await this.breakdownModel
          .findOne({
            tenantId: ident.tenantId,
            metaCampaignId,
            level: 'campaign',
            breakdownType: 'placement',
          })
          .lean()
          .exec();
        for (const row of bd?.rows ?? []) {
          const rowSpend = num(row.spend);
          const rowRoas = num(row.roas);
          const spendShare = rowSpend / spend;
          if (rowSpend < 300 || spendShare < 0.15) continue;
          if (rowRoas > 0 && rowRoas < roas * 0.5) {
            const placementName =
              [row.keys?.publisherPlatform, row.keys?.platformPosition]
                .filter(Boolean)
                .join(' / ') || 'unknown placement';
            push('placement_leak', {
              severity: rowRoas < breakevenROAS * 0.5 ? 'critical' : 'warn',
              strength: Math.min(1, (roas - rowRoas) / roas),
              trigger:
                'placement.spendShare>=0.15 AND placement.roas<campaignROAS*0.5',
              metricEvidence: {
                placementRoas: rowRoas,
                placementSpend: rowSpend,
                spendShare: round(spendShare, 3),
                campaignRoas: roas,
              },
              reasoning: `${placementName} is taking ${(spendShare * 100).toFixed(0)}% of spend (₹${rowSpend.toFixed(0)}) at ${rowRoas.toFixed(2)}× ROAS — less than half the campaign's overall ${roas.toFixed(2)}×. This placement is dragging the average down.`,
            });
          }
        }
      } catch {
        // non-fatal — breakdown data may not exist yet for this campaign
      }
    }

    return { signals };
  }

  protected computeConfidence(
    _deps: ComputeDeps<'signal'>,
    data: SignalData,
  ): number {
    if (data.signals.length === 0) return 0.8;
    const avgStrength =
      data.signals.reduce((s, x) => s + x.strength, 0) / data.signals.length;
    return Math.max(0.55, avgStrength);
  }

  protected buildEvidence(
    _deps: ComputeDeps<'signal'>,
    data: SignalData,
  ): Evidence[] {
    return [
      {
        kind: 'snapshot',
        ref: `signals:${data.signals.length}`,
        weight: 1,
        note: data.signals.map((s: Signal) => s.kind as SignalKind).join(','),
      },
    ];
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function finiteNumberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function isActiveOrStatusUnknown(entity?: {
  status?: string;
  effectiveStatus?: string;
}): boolean {
  const effectiveStatus = normalizeStatus(entity?.effectiveStatus);
  if (effectiveStatus) return effectiveStatus === 'ACTIVE';
  const status = normalizeStatus(entity?.status);
  return !status || status === 'ACTIVE';
}
function normalizeStatus(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase();
  return normalized || undefined;
}
function round(v: number, dp: number): number {
  const m = Math.pow(10, dp);
  return Math.round(v * m) / m;
}

function buildOptimizationGoalSignals(snapshot: SnapshotData): Signal[] {
  const signals: Signal[] = [];
  for (const level of ['adset', 'ad'] as const) {
    const rows = buildSnapshotGoalEfficiencyRows(snapshot, level);
    for (const target of rows) {
      const comparison = compareGoalEfficiencyPeers({
        target,
        siblings: rows,
      });
      if (
        comparison.status === 'insufficient' ||
        !comparison.current ||
        !comparison.baseline
      ) {
        continue;
      }

      const kind: SignalKind =
        comparison.status === 'laggard'
          ? 'optimization_goal_efficiency_lagging'
          : 'optimization_goal_efficiency_leading';
      const gapMultiple = comparison.relativeGap.observedMultiple;
      const observedGapPct =
        gapMultiple === null ? undefined : (gapMultiple - 1) * 100;
      const currentEfficiency = comparison.current.efficiency.value;
      const currency = target.provenance.currency;
      const goalEvidence: OptimizationGoalSignalEvidence = {
        optimizationGoal: target.optimizationGoal,
        resultMetric: comparison.current.result.metric,
        efficiencyMetric: comparison.current.efficiency.metric,
        efficiencyUnit: comparison.current.efficiency.unit,
        lowerIsBetter: comparison.current.efficiency.lowerIsBetter,
        current: {
          spend: comparison.current.spend,
          result: comparison.current.result.value,
          efficiency: currentEfficiency,
        },
        pooledSiblingBaseline: {
          peerCount: comparison.baseline.peerCount,
          peerIds: [...comparison.baseline.peerIds],
          spend: comparison.baseline.pooledSpend,
          result: comparison.baseline.pooledResult.value,
          efficiency: comparison.baseline.efficiency.value,
        },
        observedGap: {
          thresholdMultiple: comparison.relativeGap.thresholdMultiple,
          multiple: gapMultiple,
          unbounded: comparison.relativeGap.unbounded,
          direction:
            comparison.relativeGap.direction === 'worse' ? 'worse' : 'better',
        },
        window: {
          dateStart: target.provenance.dateStart,
          dateStop: target.provenance.dateStop,
          metricScope: target.provenance.metricScope,
        },
        sourceFingerprint: target.provenance.sourceFingerprint,
        currency,
        claimScope: 'observational_same_window_peer_comparison',
        causalClaim: false,
        expectedUplift: null,
      };
      const metricEvidence: Record<string, number> = {
        currentSpend: comparison.current.spend,
        currentResult: comparison.current.result.value,
        siblingBaselineEfficiency: comparison.baseline.efficiency.value,
        siblingBaselineSpend: comparison.baseline.pooledSpend,
        siblingBaselineResult: comparison.baseline.pooledResult.value,
        peerCount: comparison.baseline.peerCount,
        thresholdMultiple: comparison.relativeGap.thresholdMultiple,
        unboundedGap: comparison.relativeGap.unbounded ? 1 : 0,
        ...(currentEfficiency === null ? {} : { currentEfficiency }),
        ...(gapMultiple === null ? {} : { observedGapMultiple: gapMultiple }),
        ...(observedGapPct === undefined ? {} : { observedGapPct }),
      };
      const directionWord =
        comparison.status === 'laggard' ? 'worse' : 'better';
      const observedMultiple = comparison.relativeGap.unbounded
        ? 'an unbounded amount'
        : `${(gapMultiple ?? 0).toFixed(2)}x`;
      const currentLabel = formatEfficiency(
        currentEfficiency,
        comparison.current.efficiency.metric,
        currency,
      );
      const baselineLabel = formatEfficiency(
        comparison.baseline.efficiency.value,
        comparison.baseline.efficiency.metric,
        currency,
      );
      const subject = level === 'adset' ? 'Ad set' : 'Ad';
      const restraint =
        comparison.status === 'laggard'
          ? 'This establishes relative delivery inefficiency only; it does not establish whether creative, audience, placement, bid, landing page, or tracking caused it, and it predicts no uplift.'
          : 'This is a relative efficiency leader observation, not a confirmed winner, causal explanation, scale instruction, or future-uplift prediction.';

      signals.push({
        kind,
        severity:
          comparison.status === 'leader'
            ? 'info'
            : comparison.relativeGap.unbounded || (gapMultiple ?? 0) >= 2
              ? 'critical'
              : 'warn',
        targetType: level,
        targetId: target.entityId,
        metricEvidence,
        goalEvidence,
        trigger: `${target.optimizationGoal}:same_window_active_sibling_efficiency_gap>=${comparison.relativeGap.thresholdMultiple}x`,
        strength: comparison.relativeGap.unbounded
          ? 1
          : Math.min(1, 0.6 + Math.max(0, (gapMultiple ?? 1.5) - 1.5) * 0.2),
        reasoning: `Observed same-window comparison: ${subject} ${target.entityId}'s ${humanMetric(comparison.current.efficiency.metric)} is ${currentLabel}, ${observedMultiple} ${directionWord} than the pooled ${baselineLabel} baseline from ${comparison.baseline.peerCount} exact ACTIVE ${target.optimizationGoal} siblings. ${restraint}`,
        firstSeenAt: new Date(),
      });
    }
  }
  return signals;
}

function formatEfficiency(
  value: number | null,
  metric: string,
  currency: string,
): string {
  if (value === null) return 'unavailable because the observed result is zero';
  if (metric === 'raw_roas') return `${value.toFixed(2)}x`;
  const prefix = currency === 'INR' ? '₹' : `${currency} `;
  return `${prefix}${value.toFixed(2)}`;
}

function humanMetric(metric: string): string {
  return metric.replace(/_/g, ' ');
}
