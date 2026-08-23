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
import {
  Company,
  CompanyDocument,
} from '../../companies/schemas/company.schema';
import {
  Campaign,
  CampaignRevenueAttributionSource,
  CampaignRevenueBasis,
} from '../../campaigns/schemas/campaign.schema';
import { tryResolveCampaignProduct } from '../../campaigns/campaign-creator/resolve-campaign-product';
import { parseCampaignName } from '../../dashboard/campaign-name.parser';

/**
 * Observed-first revenue interpretation.
 *
 * Reasoning ladder (in order of preference):
 *   1. OBSERVED — this campaign's own snapshot. AOV = revenue / purchases,
 *      CAC = spend / purchases; breakeven derived from observed AOV.
 *      Requires ≥3 purchases + ≥₹100 spend for stability.
 *   2. CONFIG — product.contributionMargin + refundRatePercent from the
 *      Company doc. Used when observed data is too thin.
 *   3. UNAVAILABLE — product identity or contribution margin is unresolved.
 *      Financial judgements are withheld; the engine never substitutes the
 *      tenant's first product or a generic margin.
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
  readonly version = '1.3.0';
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
    @Optional()
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<Campaign> | null,
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
    cycleId: string,
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

    const attributedByAdSet: Record<string, number> = {};
    for (const [id, m] of Object.entries(data.metrics?.adSetLevel ?? {})) {
      attributedByAdSet[id] = num(m.revenue);
    }

    // Product identity and stored-return provenance are both decision inputs.
    // Neither may be inferred from array position: differently-margined
    // products can coexist within the same tenant.
    const ident = this.identity.get(cycleId);
    const resolution = await this.resolveProductForCampaign(
      ident?.tenantId,
      ident?.campaignId,
    );
    const product = resolution.product;
    const revenueQuality = classifyRevenueEvidence(
      resolution.revenueBasis,
      resolution.revenueAttributionSource,
      grossRevenue,
    );
    const revenueEvidenceAvailable = revenueQuality !== 'unavailable';

    if (!product) {
      return this.unavailableEconomics({
        grossRevenue,
        purchases,
        spend,
        attributedByAdSet,
        resolution,
        revenueQuality,
        reason:
          resolution.productResolutionError ??
          'Campaign product could not be resolved without guessing.',
      });
    }

    const rawMarginPct = product.contributionMargin;
    if (
      rawMarginPct == null ||
      !Number.isFinite(rawMarginPct) ||
      rawMarginPct <= 0 ||
      rawMarginPct > 1
    ) {
      return this.unavailableEconomics({
        grossRevenue,
        purchases,
        spend,
        attributedByAdSet,
        resolution,
        revenueQuality,
        reason:
          rawMarginPct == null
            ? `Product "${product.name}" has no contributionMargin configured.`
            : `Product "${product.name}" has invalid contributionMargin ${String(rawMarginPct)}; expected a decimal greater than 0 and at most 1.`,
      });
    }

    const rawRefundRatePercent = product.refundRatePercent ?? 0;
    if (
      !Number.isFinite(rawRefundRatePercent) ||
      rawRefundRatePercent < 0 ||
      rawRefundRatePercent > 95
    ) {
      return this.unavailableEconomics({
        grossRevenue,
        purchases,
        spend,
        attributedByAdSet,
        resolution,
        revenueQuality,
        reason: `Product "${product.name}" has invalid refundRatePercent ${String(rawRefundRatePercent)}; expected 0 to 95.`,
      });
    }

    const configMarginPct = rawMarginPct;
    const configRefundPct = rawRefundRatePercent / 100;

    // Decide rung. Observation is trustworthy when we have enough evidence.
    const enoughObserved = purchases >= 3 && spend >= 100;

    const method: RevenueDerivation['method'] = enoughObserved
      ? 'observed'
      : 'config';
    const usedMarginPct = configMarginPct;
    const usedRefundPct = configRefundPct;
    const notes: string[] = [];

    if (resolution.productResolution === 'name_match') {
      notes.push(
        `Product attributed from the legacy campaign name ("${product.name}") because no productName was recorded at launch.`,
      );
    } else if (resolution.productResolution === 'sole_active') {
      notes.push(
        `Product attributed to "${product.name}" because it is the tenant's only active product.`,
      );
    }

    appendRevenueEvidenceNote(
      notes,
      revenueQuality,
      resolution.revenueBasis,
      resolution.revenueAttributionSource,
    );
    if (usedRefundPct > 0) {
      notes.push(
        `Snapshot return is already net of the configured ${(usedRefundPct * 100).toFixed(1)}% refund rate; breakeven does not apply that haircut a second time.`,
      );
    }

    if (enoughObserved) {
      notes.push(
        `AOV observed = ₹${observedAOV.toFixed(0)} from ${purchases} purchases.`,
      );
      notes.push(
        `CAC observed = ₹${observedCAC.toFixed(0)}; observed ROAS ${observedROAS.toFixed(2)}×.`,
      );
    } else {
      notes.push(
        `Live data too thin (${purchases} purchases / ₹${spend.toFixed(0)} spend). Using product config as prior.`,
      );
    }

    // Snapshot revenue and ROAS are already refund-net: SnapshotBuilder applies
    // the product refund haircut before this engine runs. Applying it again in
    // breakeven would double-count refunds (e.g. a 50% margin / 20% refund
    // product would be judged against 2.50x even though net-return ROAS breaks
    // even at 2.00x). Therefore breakeven divides by contribution margin only.
    const breakevenROAS = usedMarginPct > 0 ? 1 / usedMarginPct : Infinity;
    // System scale-planning heuristic — not a measured or company-configured
    // target. A flat account-wide number is meaningless across products with
    // different margins, so the current heuristic uses 2x breakeven. Keep the
    // distinction explicit anywhere this value is surfaced to an operator.
    const targetROAS = Number.isFinite(breakevenROAS)
      ? breakevenROAS * 2
      : Infinity;

    const netRevenue = grossRevenue; // snapshot revenue already refund-net
    const financialDataAvailable = revenueEvidenceAvailable;
    const contributionMargin = financialDataAvailable
      ? netRevenue * usedMarginPct - spend
      : 0;

    const isProfitable =
      financialDataAvailable &&
      observedROAS > 0 &&
      observedROAS >= breakevenROAS;
    // A single cumulative snapshot can tell us whether the campaign is above
    // breakeven now, but not how long it has stayed there. Leave duration at
    // zero until a dedicated daily profitability series actually derives it.
    const daysSinceBreakeven = 0;

    // Reasoning line — attached for the review UI.
    if (financialDataAvailable && observedROAS > 0) {
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
            `At or above the system's ${targetROAS.toFixed(2)}× scale heuristic (2× breakeven, not an observed business target) — a scale candidate, not just breakeven-safe.`,
          );
        } else {
          const toGo = targetROAS - observedROAS;
          notes.push(
            `${toGo.toFixed(2)}× short of the system's ${targetROAS.toFixed(2)}× scale heuristic (2× breakeven, not an observed business target).`,
          );
        }
      }
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
      ctr: {
        contribution: totalLog > 0 ? round(logCtr / totalLog, 3) : 0,
        delta: round(ctrDelta, 4),
      },
      cvr: {
        contribution: totalLog > 0 ? round(logCvr / totalLog, 3) : 0,
        delta: round(cvrDelta, 4),
      },
      aov: {
        contribution: totalLog > 0 ? round(logAov / totalLog, 3) : 0,
        delta: round(aovDelta, 4),
      },
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
      economicsAvailable: true,
      revenueEvidenceAvailable,
      financialDataAvailable,
      attributedByAdSet,
      attributedByProduct,
      roasDecomposition: decomposition,
      breakeven: {
        roas: round(breakevenROAS, 3),
        isProfitable,
        daysSinceBreakeven,
      },
      targetROAS: Number.isFinite(targetROAS)
        ? round(targetROAS, 3)
        : breakevenROAS,
      derivation: {
        method,
        product: product?.name ?? null,
        productResolution: resolution.productResolution,
        productResolutionError: resolution.productResolutionError,
        revenueBasis: resolution.revenueBasis,
        revenueAttributionSource: resolution.revenueAttributionSource,
        revenueQuality,
        marginPct: round(usedMarginPct, 4),
        refundPct: round(usedRefundPct, 4),
        observedAOV: purchases > 0 ? round(observedAOV, 2) : null,
        observedCAC: purchases > 0 ? round(observedCAC, 2) : null,
        breakevenROAS: round(breakevenROAS, 3),
        notes,
      },
    };
  }

  /**
   * Which product THIS campaign is actually selling — not "the tenant's one
   * active product," which silently used the same margin for every campaign
   * regardless of which of the tenant's (possibly many, differently-margined)
   * products it advertises. On this tenant specifically: Nadi Report (97%
   * margin, 1.03x breakeven) sits alongside Nadi Leaf Reading (45%, 2.22x) —
   * judging a Nadi Leaf campaign against Nadi Report's breakeven understates
   * how badly it's underperforming by more than 2x. Same bug class the
   * dashboard already fixed (see economics.ts) for the account-wide view;
   * this closes it for the recommendation engine specifically.
   *
   * Fail-closed resolution order:
   *   1. campaign.productName — authoritative when set.
   *   2. Heuristic name match (parseCampaignName) — for older campaigns
   *      launched before productName was recorded at create time.
   *   3. Tenant's sole active product — only when there is exactly one choice.
   * Anything ambiguous returns an explicit unresolved result. An invalid
   * recorded productName is not allowed to fall through to a name heuristic.
   */
  private async resolveProductForCampaign(
    tenantId?: string,
    campaignId?: string,
  ): Promise<RevenueResolutionContext> {
    if (!this.companyModel) {
      return unresolvedContext('Company model is unavailable.');
    }
    if (!tenantId) {
      return unresolvedContext('Tenant identity is unavailable.');
    }
    try {
      const company = await this.companyModel
        .findOne({ tenantId })
        .lean()
        .exec();
      if (!company) {
        return unresolvedContext(`Tenant "${tenantId}" was not found.`);
      }
      const products = ((
        company as unknown as { products?: Array<Record<string, unknown>> }
      ).products ?? []) as Array<Record<string, unknown>>;
      if (!products.length) {
        return unresolvedContext(
          `Tenant "${tenantId}" has no products configured.`,
        );
      }

      const campaign =
        campaignId && this.campaignModel
          ? await this.campaignModel
              .findOne({ _id: campaignId, tenantId })
              .select('name productName revenueBasis revenueAttributionSource')
              .lean()
              .exec()
          : null;
      const campaignDoc = campaign as {
        name?: unknown;
        productName?: unknown;
        revenueBasis?: unknown;
        revenueAttributionSource?: unknown;
      } | null;
      const campaignName = String(campaignDoc?.name ?? '').trim();
      const campaignProductName = campaign
        ? String(campaignDoc?.productName ?? '').trim()
        : '';
      const provenance = {
        revenueBasis: normalizeRevenueBasis(campaignDoc?.revenueBasis),
        revenueAttributionSource: normalizeRevenueAttributionSource(
          campaignDoc?.revenueAttributionSource,
        ),
      };

      if (campaignProductName) {
        const strict = tryResolveCampaignProduct(
          company as unknown as CompanyDocument,
          {
            productName: campaignProductName,
            name: campaignName || undefined,
          },
        );
        if (strict.resolution) {
          return {
            product: toProductShape(strict.resolution.product),
            productResolution: 'campaign_field',
            productResolutionError: null,
            ...provenance,
          };
        }
        return unresolvedContext(
          strict.error ??
            `Recorded product "${campaignProductName}" could not be resolved.`,
          provenance,
        );
      }

      if (campaignName) {
        const knownNames = products
          .map((p) => String(p.name ?? ''))
          .filter(Boolean);
        const facets = parseCampaignName(campaignName, knownNames);
        const byName = products.find(
          (p) => String(p.name ?? '') === facets.product,
        );
        if (byName) {
          return {
            product: toProductShape(byName),
            productResolution: 'name_match',
            productResolutionError: null,
            ...provenance,
          };
        }
      }

      const active = products.filter((p) => p.active !== false);
      if (active.length === 1) {
        return {
          product: toProductShape(active[0]),
          productResolution: 'sole_active',
          productResolutionError: null,
          ...provenance,
        };
      }

      const names = active
        .map((p) => `"${String(p.name ?? 'unnamed')}"`)
        .join(', ');
      return unresolvedContext(
        `Campaign has no recorded product and its name does not match a configured product. Tenant has ${active.length} active products (${names || 'none'}); refusing to guess.`,
        provenance,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Revenue product resolution failed for tenant=${tenantId} campaign=${campaignId ?? 'unknown'}: ${message}`,
      );
      return unresolvedContext(`Product resolution failed: ${message}`);
    }
  }

  private unavailableEconomics(input: {
    grossRevenue: number;
    purchases: number;
    spend: number;
    attributedByAdSet: Record<string, number>;
    resolution: RevenueResolutionContext;
    revenueQuality: RevenueEvidenceQuality;
    reason: string;
  }): RevenueData & { derivation: RevenueDerivation } {
    const {
      grossRevenue,
      purchases,
      spend,
      attributedByAdSet,
      resolution,
      revenueQuality,
      reason,
    } = input;
    const product = resolution.product;
    const notes = [
      `${reason} Breakeven, contribution profit, and financial recommendations are withheld.`,
    ];
    appendRevenueEvidenceNote(
      notes,
      revenueQuality,
      resolution.revenueBasis,
      resolution.revenueAttributionSource,
    );
    const revenueEvidenceAvailable = revenueQuality !== 'unavailable';

    return {
      grossRevenue: round(grossRevenue, 2),
      netRevenue: round(grossRevenue, 2),
      contributionMargin: 0,
      economicsAvailable: false,
      revenueEvidenceAvailable,
      financialDataAvailable: false,
      attributedByAdSet,
      attributedByProduct: product?.name
        ? { [product.name]: round(grossRevenue, 2) }
        : {},
      roasDecomposition: zeroDecomposition(),
      breakeven: { roas: 0, isProfitable: false, daysSinceBreakeven: 0 },
      targetROAS: 0,
      derivation: {
        method: 'unavailable',
        product: product?.name ?? null,
        productResolution: resolution.productResolution,
        productResolutionError: resolution.productResolutionError ?? reason,
        revenueBasis: resolution.revenueBasis,
        revenueAttributionSource: resolution.revenueAttributionSource,
        revenueQuality,
        marginPct: 0,
        refundPct: round((product?.refundRatePercent ?? 0) / 100, 4),
        observedAOV: purchases > 0 ? round(grossRevenue / purchases, 2) : null,
        observedCAC: purchases > 0 ? round(spend / purchases, 2) : null,
        breakevenROAS: 0,
        notes,
      },
    };
  }

  private zero(
    reason: string,
  ): RevenueData & { derivation: RevenueDerivation } {
    return {
      grossRevenue: 0,
      netRevenue: 0,
      contributionMargin: 0,
      economicsAvailable: false,
      revenueEvidenceAvailable: false,
      financialDataAvailable: false,
      attributedByAdSet: {},
      attributedByProduct: {},
      roasDecomposition: zeroDecomposition(),
      breakeven: { roas: 0, isProfitable: false, daysSinceBreakeven: 0 },
      targetROAS: 0,
      derivation: {
        method: 'skipped',
        product: null,
        productResolution: 'not_applicable',
        productResolutionError: null,
        revenueBasis: 'unknown',
        revenueAttributionSource: 'unknown',
        revenueQuality: 'unavailable',
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
      (
        deps.snapshot!.data as {
          metrics?: { campaignLevel?: Record<string, number> };
        }
      ).metrics?.campaignLevel ?? {};
    const spend = num(cm.spend);
    const purchases = num(cm.purchases);

    let confidence: number;
    switch (data.derivation.method) {
      case 'observed':
        if (spend >= 5000 && purchases >= 20) confidence = 0.95;
        else if (spend >= 1000 && purchases >= 10) confidence = 0.85;
        else confidence = 0.7;
        break;
      case 'config':
        confidence = 0.55;
        break;
      case 'unavailable':
        return 0;
      case 'skipped':
        return 0.5;
      default:
        return 0;
    }

    if (data.derivation.productResolution === 'name_match') {
      confidence = Math.min(confidence, 0.65);
    } else if (data.derivation.productResolution === 'sole_active') {
      confidence = Math.min(confidence, 0.8);
    }

    if (data.derivation.revenueQuality === 'configured_estimate') {
      confidence = Math.min(confidence, 0.6);
    } else if (data.derivation.revenueQuality === 'unavailable') {
      confidence = Math.min(confidence, 0.2);
    }
    return confidence;
  }

  protected buildEvidence(
    _deps: ComputeDeps<'revenue'>,
    data: RevenueData & { derivation: RevenueDerivation },
  ): Evidence[] {
    const ev: Evidence[] = [
      {
        kind: 'snapshot',
        ref: `revenue:${data.derivation.revenueBasis}:${data.derivation.revenueAttributionSource}`,
        weight:
          data.derivation.revenueQuality === 'observed'
            ? 1
            : data.derivation.revenueQuality === 'configured_estimate'
              ? 0.6
              : 0.1,
        note: data.derivation.notes[0] ?? '',
      },
    ];
    if (data.derivation.product) {
      ev.push({
        kind: 'company_config',
        ref: `product:${data.derivation.product}:${data.derivation.productResolution}`,
        weight: data.derivation.method === 'observed' ? 0.4 : 1,
      });
    }
    return ev;
  }
}

// ── Reasoning surface for downstream engines ─────────────────────────
export interface RevenueDerivation {
  method: 'observed' | 'config' | 'unavailable' | 'skipped';
  product: string | null;
  productResolution: ProductResolutionMethod;
  productResolutionError: string | null;
  revenueBasis: CampaignRevenueBasis;
  revenueAttributionSource: CampaignRevenueAttributionSource;
  revenueQuality: RevenueEvidenceQuality;
  marginPct: number;
  refundPct: number;
  observedAOV: number | null;
  observedCAC: number | null;
  breakevenROAS: number;
  notes: string[];
}

export type ProductResolutionMethod =
  | 'campaign_field'
  | 'name_match'
  | 'sole_active'
  | 'unresolved'
  | 'not_applicable';

export type RevenueEvidenceQuality =
  | 'observed'
  | 'configured_estimate'
  | 'unavailable';

interface ResolvedRevenueProduct {
  name: string;
  contributionMargin?: number;
  refundRatePercent?: number;
  conversionValue?: number;
}

interface RevenueResolutionContext {
  product: ResolvedRevenueProduct | null;
  productResolution: ProductResolutionMethod;
  productResolutionError: string | null;
  revenueBasis: CampaignRevenueBasis;
  revenueAttributionSource: CampaignRevenueAttributionSource;
}

// ── Utility helpers ──────────────────────────────────────────────────
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function toProductShape(p: {
  name?: unknown;
  contributionMargin?: unknown;
  refundRatePercent?: unknown;
  conversionValue?: unknown;
}): ResolvedRevenueProduct {
  return {
    name: String(p.name ?? 'product'),
    contributionMargin: numOrUndef(p.contributionMargin),
    refundRatePercent: numOrUndef(p.refundRatePercent),
    conversionValue: numOrUndef(p.conversionValue),
  };
}

function unresolvedContext(
  reason: string,
  provenance: Pick<
    RevenueResolutionContext,
    'revenueBasis' | 'revenueAttributionSource'
  > = {
    revenueBasis: 'unknown',
    revenueAttributionSource: 'unknown',
  },
): RevenueResolutionContext {
  return {
    product: null,
    productResolution: 'unresolved',
    productResolutionError: reason,
    ...provenance,
  };
}

function normalizeRevenueBasis(value: unknown): CampaignRevenueBasis {
  return value === 'meta_action_value' ||
    value === 'configured_conversion_value' ||
    value === 'no_attributed_revenue'
    ? value
    : 'unknown';
}

function normalizeRevenueAttributionSource(
  value: unknown,
): CampaignRevenueAttributionSource {
  return value === 'custom_conversion' ||
    value === 'custom_event' ||
    value === 'standard_event' ||
    value === 'app_event' ||
    value === 'account_fallback' ||
    value === 'unresolved'
    ? value
    : 'unknown';
}

function classifyRevenueEvidence(
  basis: CampaignRevenueBasis,
  source: CampaignRevenueAttributionSource,
  revenue: number,
): RevenueEvidenceQuality {
  const campaignScoped =
    source === 'custom_conversion' ||
    source === 'custom_event' ||
    source === 'standard_event' ||
    source === 'app_event';
  if (!campaignScoped) return 'unavailable';
  if (basis === 'meta_action_value') return 'observed';
  if (basis === 'configured_conversion_value') return 'configured_estimate';
  if (basis === 'no_attributed_revenue' && revenue === 0) return 'observed';
  return 'unavailable';
}

function appendRevenueEvidenceNote(
  notes: string[],
  quality: RevenueEvidenceQuality,
  basis: CampaignRevenueBasis,
  source: CampaignRevenueAttributionSource,
): void {
  if (quality === 'observed') {
    notes.push(`Return provenance: ${basis} via ${source}.`);
  } else if (quality === 'configured_estimate') {
    notes.push(
      `Return is estimated from configured conversion value via ${source}; it is not recorded Meta action value.`,
    );
  } else {
    notes.push(
      `Return provenance is unavailable (${basis} via ${source}); profitability and financial actions are withheld.`,
    );
  }
}

function zeroDecomposition(): RevenueData['roasDecomposition'] {
  return {
    ctr: { contribution: 0, delta: 0 },
    cvr: { contribution: 0, delta: 0 },
    aov: { contribution: 0, delta: 0 },
    frequency: { contribution: 0, delta: 0 },
  };
}
function round(v: number, dp: number): number {
  const m = Math.pow(10, dp);
  return Math.round(v * m) / m;
}
