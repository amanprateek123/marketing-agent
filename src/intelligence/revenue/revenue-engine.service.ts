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
import { RevenueData } from '../orchestrator/decision-context';
import { Company } from '../../companies/schemas/company.schema';

/**
 * Observed-first revenue interpretation.
 *
 * Reasoning ladder (in order of preference):
 *   1. OBSERVED — this campaign's own snapshot. AOV = revenue / purchases,
 *      CAC = spend / purchases; breakeven derived from observed AOV.
 *      Requires ≥3 purchases + ≥₹100 spend for stability.
 *   2. CONFIG — product.contributionMargin + refundRatePercent from the
 *      Company doc. Used when observed data is too thin.
 *   3. GENERIC — 40% margin, 0% refund. Last-resort default.
 *
 * The `derivation` field in the output tells downstream engines which
 * rung of the ladder produced these numbers, so signals + recommendations
 * can weight confidence accordingly.
 */
@Injectable()
export class RevenueEngine extends BaseEngine<
  'revenue',
  RevenueData & { derivation: RevenueDerivation }
> {
  readonly name = 'revenue' as const;
  readonly step = 5;
  readonly version = '1.2.0';
  readonly dependsOn = ['snapshot', 'objective', 'trend'] as const;

  private readonly identity = new Map<
    string,
    { tenantId: string; campaignId: string }
  >();

  constructor(
    sliceRepo: SliceRepository,
    eventBus: EngineEventBus,
    registry: EngineRegistry,
    @Optional()
    @InjectModel(Company.name)
    private readonly companyModel: Model<Company> | null,
  ) {
    super(sliceRepo, eventBus, registry);
  }

  @OnEvent('intelligence.trend.completed')
  async onTrendCompleted(payload: {
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

  /** Reads live company doc — output not byte-identical across replays. */
  protected isDeterministic(): boolean {
    return false;
  }

  protected async compute(
    deps: ComputeDeps<'revenue'>,
  ): Promise<RevenueData & { derivation: RevenueDerivation }> {
    const snap = deps.snapshot!;
    const objective = deps.objective!;
    const data = snap.data as {
      metrics?: {
        campaignLevel?: Record<string, number>;
        adSetLevel?: Record<string, Record<string, number>>;
      };
    };
    const cm = data.metrics?.campaignLevel ?? {};

    const revenueRelevant = ['sales', 'catalog_sales', 'retargeting'].includes(
      objective.data.objective,
    );
    if (!revenueRelevant) {
      return this.zero('objective_not_revenue');
    }

    const spend = num(cm.spend);
    const purchases = num(cm.purchases);
    const grossRevenue = num(cm.revenue);
    const observedROAS = num(cm.roas);
    const observedAOV = purchases > 0 ? grossRevenue / purchases : 0;
    const observedCAC = purchases > 0 ? spend / purchases : Infinity;

    // Load product config as PRIOR (not fact).
    const ident = this.identity.values().next().value;
    const product = await this.loadActiveProduct(ident?.tenantId);
    const configMarginPct = clamp(product?.contributionMargin ?? 0.4, 0.01, 0.99);
    const configRefundPct = clamp(
      (product?.refundRatePercent ?? 0) / 100,
      0,
      0.95,
    );

    // Decide rung. Observation is trustworthy when we have enough evidence.
    const enoughObserved = purchases >= 3 && spend >= 100;

    let method: RevenueDerivation['method'];
    let usedMarginPct = configMarginPct;
    let usedRefundPct = configRefundPct;
    const notes: string[] = [];

    if (enoughObserved && product) {
      method = 'observed';
      if (configMarginPct < 0.05) {
        notes.push(
          `Config margin ${(configMarginPct * 100).toFixed(1)}% below 5% floor — clamped for safety.`,
        );
        usedMarginPct = 0.05;
      }
      notes.push(
        `AOV observed = ₹${observedAOV.toFixed(0)} from ${purchases} purchases.`,
      );
      notes.push(
        `CAC observed = ₹${observedCAC.toFixed(0)}; observed ROAS ${observedROAS.toFixed(2)}×.`,
      );
    } else if (product) {
      method = 'config';
      notes.push(
        `Live data too thin (${purchases} purchases / ₹${spend.toFixed(0)} spend). Using product config as prior.`,
      );
    } else {
      method = 'generic';
      notes.push(
        'No product config found — using generic 40% margin default. Recommendation confidence will be capped.',
      );
    }

    // Breakeven ROAS = 1 / (net margin).
    const netMarginPct = usedMarginPct * (1 - usedRefundPct);
    const breakevenROAS = netMarginPct > 0 ? 1 / netMarginPct : Infinity;
    // The profit GOAL — not a flat company-wide number (that's meaningless
    // across products with different margins: a flat 2.0x would sit BELOW
    // breakeven for a 45%-margin product whose breakeven is ~2.22x). 2x
    // breakeven scales correctly per product and lands almost exactly on
    // "2 ROAS" for this account's primary ~97%-margin product.
    const targetROAS = Number.isFinite(breakevenROAS) ? breakevenROAS * 2 : Infinity;

    const netRevenue = grossRevenue; // snapshot revenue already refund-net
    const contributionMargin = netRevenue * usedMarginPct - spend;

    const isProfitable = observedROAS > 0 && observedROAS >= breakevenROAS;
    const daysSinceBreakeven = isProfitable ? 1 : 0;

    // Reasoning line — attached for the review UI.
    if (observedROAS > 0) {
      const gap = observedROAS - breakevenROAS;
      if (isProfitable) {
        notes.push(
          `Profitable: ROAS ${observedROAS.toFixed(2)}× is ${gap.toFixed(2)}× above breakeven ${breakevenROAS.toFixed(2)}× — every ₹1 in creates ₹${(gap * usedMarginPct).toFixed(2)} of contribution profit.`,
        );
      } else {
        notes.push(
          `Below breakeven: ROAS ${observedROAS.toFixed(2)}× is ${Math.abs(gap).toFixed(2)}× short of breakeven ${breakevenROAS.toFixed(2)}× — every ₹1 in loses ₹${(Math.abs(gap) * usedMarginPct).toFixed(2)}.`,
        );
      }
      if (Number.isFinite(targetROAS)) {
        if (observedROAS >= targetROAS) {
          notes.push(
            `At or above the ${targetROAS.toFixed(2)}× profit target — a scale candidate, not just breakeven-safe.`,
          );
        } else {
          const toGo = targetROAS - observedROAS;
          notes.push(
            `${toGo.toFixed(2)}× short of the ${targetROAS.toFixed(2)}× profit target (2× breakeven).`,
          );
        }
      }
    }

    const attributedByAdSet: Record<string, number> = {};
    for (const [id, m] of Object.entries(data.metrics?.adSetLevel ?? {})) {
      attributedByAdSet[id] = num(m.revenue);
    }
    const attributedByProduct: Record<string, number> = product?.name
      ? { [product.name]: grossRevenue }
      : {};

    // ROAS ≈ CTR × CVR × AOV × (impressions/spend), and impressions/spend is
    // ~constant over a short window (CPM doesn't jump day to day) — so a
    // log-additive decomposition of the CTR/CVR/AOV trend windows explains
    // most of the ROAS trend's own movement. Frequency isn't a multiplicand
    // of ROAS, so it's scored separately: it "contributes" only insofar as
    // it's rising while CTR is falling in the same window (fatigue
    // signature), which is the same relationship SignalEngine's
    // creative_fatigue rule already uses.
    const trend = deps.trend!.data;
    const trendDelta = (metric: string): number => {
      const v = trend.perMetric[metric]?.vsBaseline;
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v - 1 : 0;
    };
    const ctrDelta = trendDelta('ctr');
    const cvrDelta = trendDelta('cvr') || trendDelta('conversionRate');
    const aovDelta = trendDelta('aov');
    const freqDelta = trendDelta('frequency');

    const logChange = (d: number) => Math.log(Math.max(0.01, 1 + d));
    const logCtr = logChange(ctrDelta);
    const logCvr = logChange(cvrDelta);
    const logAov = logChange(aovDelta);
    const totalLog = Math.abs(logCtr) + Math.abs(logCvr) + Math.abs(logAov);

    const decomposition = {
      ctr: { contribution: totalLog > 0 ? round(logCtr / totalLog, 3) : 0, delta: round(ctrDelta, 4) },
      cvr: { contribution: totalLog > 0 ? round(logCvr / totalLog, 3) : 0, delta: round(cvrDelta, 4) },
      aov: { contribution: totalLog > 0 ? round(logAov / totalLog, 3) : 0, delta: round(aovDelta, 4) },
      frequency: {
        // Fatigue signature: frequency climbing while CTR falls in the same
        // window. Zero when either isn't true — this isn't a multiplicand
        // of ROAS, just a risk flag for "is fatigue plausibly the driver".
        contribution: round(Math.max(0, freqDelta) * Math.max(0, -ctrDelta), 3),
        delta: round(freqDelta, 4),
      },
    };

    return {
      grossRevenue: round(grossRevenue, 2),
      netRevenue: round(netRevenue, 2),
      contributionMargin: round(contributionMargin, 2),
      attributedByAdSet,
      attributedByProduct,
      roasDecomposition: decomposition,
      breakeven: {
        roas: round(breakevenROAS, 3),
        isProfitable,
        daysSinceBreakeven,
      },
      targetROAS: Number.isFinite(targetROAS) ? round(targetROAS, 3) : breakevenROAS,
      derivation: {
        method,
        product: product?.name ?? null,
        marginPct: round(usedMarginPct, 4),
        refundPct: round(usedRefundPct, 4),
        observedAOV: purchases > 0 ? round(observedAOV, 2) : null,
        observedCAC: purchases > 0 ? round(observedCAC, 2) : null,
        breakevenROAS: round(breakevenROAS, 3),
        notes,
      },
    };
  }

  private async loadActiveProduct(tenantId?: string): Promise<
    | {
        name: string;
        contributionMargin?: number;
        refundRatePercent?: number;
        conversionValue?: number;
      }
    | null
  > {
    if (!this.companyModel || !tenantId) return null;
    try {
      const company = await this.companyModel.findOne({ tenantId }).lean().exec();
      if (!company) return null;
      const raw =
        ((company as unknown as { products?: Array<Record<string, unknown>> }).products ?? []) as Array<
          Record<string, unknown>
        >;
      const active = raw.find((p) => p.active !== false) ?? raw[0];
      if (!active) return null;
      return {
        name: String(active.name ?? 'product'),
        contributionMargin: numOrUndef(active.contributionMargin),
        refundRatePercent: numOrUndef(active.refundRatePercent),
        conversionValue: numOrUndef(active.conversionValue),
      };
    } catch {
      return null;
    }
  }

  private zero(reason: string): RevenueData & { derivation: RevenueDerivation } {
    return {
      grossRevenue: 0,
      netRevenue: 0,
      contributionMargin: 0,
      attributedByAdSet: {},
      attributedByProduct: {},
      roasDecomposition: {
        ctr: { contribution: 0, delta: 0 },
        cvr: { contribution: 0, delta: 0 },
        aov: { contribution: 0, delta: 0 },
        frequency: { contribution: 0, delta: 0 },
      },
      breakeven: { roas: 0, isProfitable: false, daysSinceBreakeven: 0 },
      targetROAS: 0,
      derivation: {
        method: 'skipped',
        product: null,
        marginPct: 0,
        refundPct: 0,
        observedAOV: null,
        observedCAC: null,
        breakevenROAS: 0,
        notes: [reason],
      },
    };
  }

  protected computeConfidence(
    deps: ComputeDeps<'revenue'>,
    data: RevenueData & { derivation: RevenueDerivation },
  ): number {
    const cm =
      (deps.snapshot!.data as { metrics?: { campaignLevel?: Record<string, number> } })
        .metrics?.campaignLevel ?? {};
    const spend = num(cm.spend);
    const purchases = num(cm.purchases);

    switch (data.derivation.method) {
      case 'observed':
        if (spend >= 5000 && purchases >= 20) return 0.95;
        if (spend >= 1000 && purchases >= 10) return 0.85;
        return 0.7;
      case 'config':
        return 0.55;
      case 'generic':
        return 0.3;
      case 'skipped':
        return 0.5;
      default:
        return 0.5;
    }
  }

  protected buildEvidence(
    _deps: ComputeDeps<'revenue'>,
    data: RevenueData & { derivation: RevenueDerivation },
  ): Evidence[] {
    const ev: Evidence[] = [
      {
        kind: 'snapshot',
        ref: `revenue-observed:${data.derivation.method}`,
        weight: 1,
        note: data.derivation.notes[0] ?? '',
      },
    ];
    if (data.derivation.product) {
      ev.push({
        kind: 'company_config',
        ref: `product:${data.derivation.product}`,
        weight: data.derivation.method === 'observed' ? 0.4 : 1,
      });
    }
    return ev;
  }
}

// ── Reasoning surface for downstream engines ─────────────────────────
export interface RevenueDerivation {
  method: 'observed' | 'config' | 'generic' | 'skipped';
  product: string | null;
  marginPct: number;
  refundPct: number;
  observedAOV: number | null;
  observedCAC: number | null;
  breakevenROAS: number;
  notes: string[];
}

// ── Utility helpers ──────────────────────────────────────────────────
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
function round(v: number, dp: number): number {
  const m = Math.pow(10, dp);
  return Math.round(v * m) / m;
}
