import { Injectable, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { Campaign } from '../../campaigns/schemas/campaign.schema';
import {
  Signal,
  SignalData,
  SignalKind,
  TrendData,
} from '../orchestrator/decision-context';

/**
 * Signals fired from observation, not from cached rules.
 *
 * For each rule we compare the CURRENT observation against THIS CAMPAIGN'S
 * OWN 7-day baseline (via Trend Engine EMAs and slopes) rather than a
 * global threshold. Every signal ships with a human-readable `reasoning`
 * string built at fire-time explaining exactly what evidence triggered it.
 *
 * Fallback: when we don't have enough history (< 3 snapshots), we compare
 * against a conservative default. Signals fired via fallback have lower
 * strength (0.5-0.7) so downstream engines weight them accordingly.
 */
@Injectable()
export class SignalEngine extends BaseEngine<'signal', SignalData> {
  readonly name = 'signal' as const;
  readonly step = 6;
  readonly version = '1.1.0';
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
  private currentCycleId?: string;

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
    @Optional()
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<Campaign> | null = null,
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

  protected async compute(deps: ComputeDeps<'signal'>): Promise<SignalData> {
    const snap = deps.snapshot!;
    const lifecycle = deps.lifecycle!;
    const trend = deps.trend! as { data: TrendData };
    const revenue = deps.revenue!;
    const objective = deps.objective!;
    const metrics = (snap.data as {
      metrics?: {
        campaignLevel?: Record<string, number>;
        adSetLevel?: Record<string, Record<string, number>>;
      };
    }).metrics;
    const cm = metrics?.campaignLevel ?? {};
    const adSetLevel = metrics?.adSetLevel ?? {};

    const ignored = new Set(objective.data.policy.ignoreSignals ?? []);
    const ident = this.currentCycleId
      ? this.identity.get(this.currentCycleId)
      : undefined;
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
      derivation?: {
        method: string;
        breakevenROAS: number;
        marginPct: number;
      };
    };
    const breakevenROAS = revenueData.breakeven.roas;
    const isProfitable = revenueData.breakeven.isProfitable;
    const derivationMethod = revenueData.derivation?.method ?? 'unknown';

    // Trend baselines — THIS CAMPAIGN'S own past-7-day EMA + slopes
    const emaCTR7 = trend.data.perMetric.ctr?.ema7d ?? 0;
    const emaFreq7 = trend.data.perMetric.frequency?.ema7d ?? 0;
    const slopeCTR3 = trend.data.perMetric.ctr?.slope3d ?? 0;
    const slopeROAS7 = trend.data.perMetric.roas?.slope7d ?? 0;
    const slopeSpend7 = trend.data.perMetric.spend?.slope7d ?? 0;
    const historyWindow = trend.data.perMetric.ctr?.windowSize ?? 1;
    const hasBaseline = historyWindow >= 3;

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
      },
    ) => {
      if (ignored.has(kind)) return;
      signals.push({
        kind,
        severity: opts.severity,
        targetType: opts.targetType ?? 'campaign',
        targetId: opts.target ?? targetId,
        metricEvidence: opts.metricEvidence,
        trigger: opts.trigger,
        strength: opts.strength,
        reasoning: opts.reasoning,
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
      lifecycle.data.stage === 'learning' || lifecycle.data.stage === 'launching';

    // ── creative_fatigue — freq up vs OWN baseline AND CTR declining
    if (!skipPerfStage) {
      const freqAboveBaseline = emaFreq7 > 0 && freq / emaFreq7 >= 1.4;
      const ctrDeclining = slopeCTR3 < -0.005;
      if (hasBaseline && freqAboveBaseline && ctrDeclining) {
        const ratio = freq / emaFreq7;
        push('creative_fatigue', {
          severity: freq > 4 ? 'critical' : 'warn',
          strength: Math.min(1, (ratio - 1) * 0.8 + Math.min(1, Math.abs(slopeCTR3) * 40)),
          trigger: 'freq/base>=1.4 AND slopeCTR3d<-0.005',
          metricEvidence: {
            frequency: freq,
            frequencyBaseline: emaFreq7,
            ctrSlope3d: slopeCTR3,
          },
          reasoning: `Frequency ${freq.toFixed(1)} is ${((ratio - 1) * 100).toFixed(0)}% above this campaign's own 7-day baseline of ${emaFreq7.toFixed(1)}, and CTR has been dropping ${(Math.abs(slopeCTR3) * 100).toFixed(2)}pp per day for 3 days. The audience is seeing these creatives too often — CTR loss confirms it.`,
        });
      } else if (!hasBaseline && freq > 4 && slopeCTR3 < -0.01) {
        push('creative_fatigue', {
          severity: 'warn',
          strength: 0.55,
          trigger: 'freq>4 AND slopeCTR3d<-0.01 (baseline unavailable)',
          metricEvidence: { frequency: freq, ctrSlope3d: slopeCTR3 },
          reasoning: `Frequency ${freq.toFixed(1)} is high and CTR is falling ${(Math.abs(slopeCTR3) * 100).toFixed(2)}pp/day. Not enough history for this campaign to compare against its own baseline — confidence moderate.`,
        });
      }
    }

    // ── frequency_ceiling — absolute over-frequency ──────────────────
    if (freq > 5.5) {
      push('frequency_ceiling', {
        severity: 'critical',
        strength: Math.min(1, (freq - 5.5) / 3),
        trigger: 'freq>5.5',
        metricEvidence: { frequency: freq },
        reasoning: `Frequency ${freq.toFixed(1)} means every person reached saw ads ${freq.toFixed(1)} times on average. Above 5.5, incremental impressions rarely convert and CPMs waste.`,
      });
    }

    // ── ctr_decay — CTR falling fast vs OWN 7d baseline ─────────────
    if (!skipPerfStage && hasBaseline && emaCTR7 > 0 && ctr > 0) {
      const drop = 1 - ctr / emaCTR7;
      if (drop >= 0.35) {
        push('ctr_decay', {
          severity: drop >= 0.5 ? 'critical' : 'warn',
          strength: Math.min(1, drop),
          trigger: 'ctr<0.65*baseline',
          metricEvidence: {
            ctr,
            ctrBaseline: emaCTR7,
            dropPct: round(drop, 3),
          },
          reasoning: `CTR is ${(ctr * 100).toFixed(2)}%, ${(drop * 100).toFixed(0)}% below this campaign's own 7-day baseline of ${(emaCTR7 * 100).toFixed(2)}%. People are clicking less than they did on the same ad recently.`,
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
    if (
      !skipPerfStage &&
      breakevenROAS > 0 &&
      spend > 500 &&
      !isProfitable &&
      roas > 0
    ) {
      const gap = breakevenROAS - roas;
      const contribMarginProxy = revenueData.derivation?.marginPct ?? 0.4;
      const lossPerRupee = gap * contribMarginProxy;
      push('unprofitable_run', {
        severity: 'critical',
        strength: Math.min(1, gap / breakevenROAS),
        trigger: 'roas<breakevenROAS AND spend>500',
        metricEvidence: {
          roas,
          breakevenROAS,
          gap: round(gap, 3),
          spend,
        },
        reasoning:
          gap > 0.05
            ? `Return on spend is ${roas.toFixed(2)}× but this product needs ${breakevenROAS.toFixed(2)}× to break even. Roughly ₹${lossPerRupee.toFixed(2)} is being lost for every ₹1 spent.`
            : `Return on spend (${roas.toFixed(2)}×) is stuck at the break-even line (${breakevenROAS.toFixed(2)}×). The campaign isn't losing much, but it isn't making profit either.`,
      });
    }

    // ── winner_emerging — clearly above breakeven with real conversions
    if (roas >= breakevenROAS * 1.3 && purchases >= 5 && breakevenROAS > 0) {
      const marginPct = revenueData.derivation?.marginPct ?? 0.4;
      const profitPerRupee = (roas - breakevenROAS) * marginPct;
      push('winner_emerging', {
        severity: 'info',
        strength: Math.min(1, roas / breakevenROAS / 2),
        trigger: 'roas>=breakevenROAS*1.3 AND purchases>=5',
        metricEvidence: { roas, breakevenROAS, purchases, slopeROAS7 },
        reasoning: `ROAS ${roas.toFixed(2)}× is 30% or more above breakeven ${breakevenROAS.toFixed(2)}× with ${purchases} conversions. Each ₹1 in creates roughly ₹${profitPerRupee.toFixed(2)} of contribution profit. Scale candidate.`,
      });
    }

    // ── winner_confirmed — sustained profitability + volume + non-negative slope
    if (
      roas >= breakevenROAS * 1.8 &&
      purchases >= 20 &&
      breakevenROAS > 0 &&
      slopeROAS7 >= 0
    ) {
      push('winner_confirmed', {
        severity: 'info',
        strength: 1,
        trigger: 'roas>=breakevenROAS*1.8 AND purchases>=20 AND slopeROAS7d>=0',
        metricEvidence: { roas, breakevenROAS, purchases, slopeROAS7 },
        reasoning: `${purchases} conversions at ${roas.toFixed(2)}× ROAS (80%+ above breakeven ${breakevenROAS.toFixed(2)}×) with ROAS trend non-negative over 7 days. Confirmed winner — protect and scale.`,
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
        trigger: 'slopeROAS7d<-0.05 AND slopeSpend7d>0',
        metricEvidence: {
          slopeROAS7d: slopeROAS7,
          slopeSpend7d: slopeSpend7,
        },
        reasoning: `ROAS is dropping at ${(Math.abs(slopeROAS7) * 100).toFixed(1)}% per day while spend continues to grow. Meta is reaching further into the audience pool to spend the budget — the cheap high-intent buyers are exhausted.`,
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
    if (this.campaignModel && ident?.campaignId) {
      try {
        const c = (await this.campaignModel
          .findById(ident.campaignId)
          .select('metaAdSets')
          .lean()
          .exec()) as { metaAdSets?: Array<{ id?: string; status?: string }> } | null;
        for (const as of c?.metaAdSets ?? []) {
          if (as.id && as.status) adSetStatuses.set(as.id, String(as.status).toUpperCase());
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
    if (!skipPerfStage && breakevenROAS > 0) {
      for (const [adSetId, m] of Object.entries(adSetLevel)) {
        if (!isAdsetActive(adSetId)) continue;
        const asSpend = num(m.spend);
        const asRoas = num(m.roas);
        const asPurchases = num(m.purchases);
        const asFreq = num(m.frequency);
        const asClicks = num(m.clicks);
        const asCpc = num(m.cpc);

        // unprofitable_run — adset below breakeven with meaningful spend
        if (asSpend > 300 && asRoas > 0 && asRoas < breakevenROAS) {
          const gap = breakevenROAS - asRoas;
          const lossPerRupee = gap * marginPct;
          push('unprofitable_run', {
            severity: gap > 0.3 ? 'critical' : 'warn',
            strength: Math.min(1, gap / breakevenROAS),
            targetType: 'adset',
            target: adSetId,
            trigger: 'adset.roas<breakevenROAS AND adset.spend>300',
            metricEvidence: {
              roas: asRoas,
              breakevenROAS,
              gap: round(gap, 3),
              spend: asSpend,
              purchases: asPurchases,
            },
            reasoning: `This ad group is at ${asRoas.toFixed(2)}× ROAS on ₹${asSpend.toFixed(0)} of spend — below the ${breakevenROAS.toFixed(2)}× breakeven. Roughly ₹${lossPerRupee.toFixed(2)} lost per ₹1 spent here.`,
          });
        }

        // winner_emerging — adset clearly above breakeven with real conversions
        if (asRoas >= breakevenROAS * 1.3 && asPurchases >= 3) {
          const profitPerRupee = (asRoas - breakevenROAS) * marginPct;
          push('winner_emerging', {
            severity: 'info',
            strength: Math.min(1, asRoas / breakevenROAS / 2),
            targetType: 'adset',
            target: adSetId,
            trigger: 'adset.roas>=breakevenROAS*1.3 AND adset.purchases>=3',
            metricEvidence: {
              roas: asRoas,
              breakevenROAS,
              purchases: asPurchases,
              spend: asSpend,
            },
            reasoning: `This ad group is at ${asRoas.toFixed(2)}× ROAS with ${asPurchases} purchases — 30%+ above breakeven ${breakevenROAS.toFixed(2)}×. Each ₹1 here creates roughly ₹${profitPerRupee.toFixed(2)} of contribution profit. Scale candidate.`,
          });
        }

        // winner_confirmed — sustained volume + profitability at adset level
        if (asRoas >= breakevenROAS * 1.8 && asPurchases >= 10) {
          push('winner_confirmed', {
            severity: 'info',
            strength: 1,
            targetType: 'adset',
            target: adSetId,
            trigger: 'adset.roas>=breakevenROAS*1.8 AND adset.purchases>=10',
            metricEvidence: {
              roas: asRoas,
              breakevenROAS,
              purchases: asPurchases,
            },
            reasoning: `Ad group has ${asPurchases} purchases at ${asRoas.toFixed(2)}× ROAS — 80%+ above breakeven ${breakevenROAS.toFixed(2)}×. Confirmed winner.`,
          });
        }

        // frequency_ceiling — adset over-frequency
        if (asFreq > 5.5) {
          push('frequency_ceiling', {
            severity: 'critical',
            strength: Math.min(1, (asFreq - 5.5) / 3),
            targetType: 'adset',
            target: adSetId,
            trigger: 'adset.freq>5.5',
            metricEvidence: { frequency: asFreq, spend: asSpend },
            reasoning: `Ad group frequency is ${asFreq.toFixed(1)}. Every person reached saw ads that many times on average — incremental impressions rarely convert.`,
          });
        }

        // cvr_collapse — traffic but no conversions at adset level
        if (asClicks > 100 && asPurchases === 0) {
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
        if (asCpc > 25 && asPurchases < 3 && asSpend > 500) {
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

  protected buildEvidence(_deps: ComputeDeps<'signal'>, data: SignalData): Evidence[] {
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
function round(v: number, dp: number): number {
  const m = Math.pow(10, dp);
  return Math.round(v * m) / m;
}
