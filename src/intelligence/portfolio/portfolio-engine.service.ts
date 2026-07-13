import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { PortfolioData } from '../orchestrator/decision-context';
import { Campaign } from '../../campaigns/schemas/campaign.schema';

/**
 * Tier/score are still computed for THIS campaign only (a per-sibling
 * breakeven-accurate tier for every campaign in the account would need each
 * one's own product/margin resolved — a bigger lift deferred for now). But
 * totalPortfolioROAS, concentration, and this campaign's percentile standing
 * ARE genuinely computed across the tenant's active campaigns via the synced
 * Campaign collection, not self-referential — see compute() below.
 */
@Injectable()
export class PortfolioEngine extends BaseEngine<'portfolio', PortfolioData> {
  readonly name = 'portfolio' as const;
  readonly step = 9;
  readonly version = '1.0.0';
  readonly dependsOn = ['snapshot', 'objective', 'revenue', 'business'] as const;

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
    private readonly campaignModel: Model<Campaign> | null,
  ) {
    super(sliceRepo, eventBus, registry);
  }

  /**
   * Portfolio depends on both revenue (via trend chain) AND business
   * (via objective chain). These fire in parallel — race condition.
   * We subscribe to BOTH events and gate execution on both slices
   * being present in the store.
   */
  private readonly readyGate = new Set<string>();

  @OnEvent('intelligence.business.completed')
  async onBusinessCompleted(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
  }): Promise<void> {
    await this.gateAndExecute(payload, 'business');
  }

  @OnEvent('intelligence.revenue.completed')
  async onRevenueCompleted(payload: {
    cycleId: string;
    tenantId: string;
    campaignId: string;
  }): Promise<void> {
    await this.gateAndExecute(payload, 'revenue');
  }

  private async gateAndExecute(
    payload: { cycleId: string; tenantId: string; campaignId: string },
    from: 'business' | 'revenue',
  ): Promise<void> {
    // Track which of the two arrival events has fired for this cycle.
    const key = `${payload.cycleId}:${from}`;
    this.readyGate.add(key);
    const otherKey = `${payload.cycleId}:${from === 'business' ? 'revenue' : 'business'}`;
    if (!this.readyGate.has(otherKey)) {
      // Still waiting for the other side.
      this.identity.set(payload.cycleId, {
        tenantId: payload.tenantId,
        campaignId: payload.campaignId,
      });
      return;
    }
    // Both dependencies present — safe to execute exactly once.
    this.readyGate.delete(key);
    this.readyGate.delete(otherKey);
    try {
      await this.execute(payload.cycleId);
    } finally {
      this.identity.delete(payload.cycleId);
    }
  }

  protected async identityFromDeps(cycleId: string) {
    return this.identity.get(cycleId) ?? { tenantId: '', campaignId: '' };
  }

  protected async compute(deps: ComputeDeps<'portfolio'>): Promise<PortfolioData> {
    const snap = deps.snapshot!;
    const cm = (snap.data as { metrics?: { campaignLevel?: Record<string, number> } })
      .metrics?.campaignLevel ?? {};
    const revenue = deps.revenue!.data;
    const spend = (cm.spend as number) ?? 0;
    const roas = (cm.roas as number) ?? 0;

    // deps carries only engine-slice outputs, never identity fields — the
    // previous `deps as unknown as {campaignId}` cast always resolved to
    // undefined, so every ranking entry was silently keyed campaignId=''
    // and any downstream lookup by real campaignId could never match.
    const ident = this.identity.values().next().value;
    const campaignId = ident?.campaignId ?? '';

    // Genuine cross-campaign context: every other ACTIVE campaign in this
    // tenant, pulled from the synced Campaign collection (has its own
    // roas/spend/revenue already — no extra Meta call needed). Previously
    // totalPortfolioROAS and concentration were both fake — totalPortfolioROAS
    // was literally just this campaign's own roas re-labeled, and
    // concentration was hardcoded to 1 always, regardless of how many
    // campaigns existed or how spend was actually split between them.
    const siblings =
      this.campaignModel && ident?.tenantId
        ? await this.campaignModel
            .find({ tenantId: ident.tenantId, status: 'active' })
            .select('_id spend roas revenue')
            .lean()
            .exec()
            .catch(() => [])
        : [];
    const siblingRows = siblings as unknown as Array<{
      _id: { toString(): string };
      spend?: number;
      roas?: number;
      revenue?: number;
    }>;

    const totalSpendAcct = siblingRows.reduce((s, c) => s + (c.spend ?? 0), 0);
    const totalRevenueAcct = siblingRows.reduce((s, c) => s + (c.revenue ?? 0), 0);
    const totalPortfolioROAS =
      totalSpendAcct > 0 ? totalRevenueAcct / totalSpendAcct : roas;
    // Herfindahl-style concentration of spend across active campaigns: 1.0
    // means all spend sits in one campaign (no diversification, one bad
    // week tanks the account); 1/N means it's spread evenly. Real signal
    // for whether this account is over-exposed to a single campaign.
    const concentration =
      totalSpendAcct > 0
        ? siblingRows.reduce((s, c) => s + ((c.spend ?? 0) / totalSpendAcct) ** 2, 0)
        : 1;

    // Where THIS campaign's ROAS actually stands among its siblings — not
    // just against its own breakeven. Only meaningful with ≥2 comparable
    // (spending) siblings; otherwise stays neutral (0.5) rather than
    // fabricating a percentile from nothing.
    const others = siblingRows.filter(
      (c) => c._id.toString() !== campaignId && (c.spend ?? 0) > 0,
    );
    const percentileRank =
      others.length >= 2
        ? others.filter((c) => (c.roas ?? 0) < roas).length / others.length
        : 0.5;

    // Score = margin + roas boost; tier by roas relative to THIS product's
    // own breakeven/target — not a flat account-wide number. A hardcoded
    // "roas>=2 is tier A" bucket is meaningless across products with
    // different margins (the same flaw the flat targetROAS design was
    // rejected for elsewhere in this cascade): a 1.8x ROAS product with a
    // 1.2x breakeven is a strong A-tier performer; a 1.8x ROAS product with
    // a 2.5x breakeven is bleeding money and should never rank A.
    const score = Number((revenue.contributionMargin + roas * spend * 0.1).toFixed(2));
    const breakevenROAS = revenue.breakeven.roas || 2.5;
    const targetROAS =
      revenue.targetROAS && revenue.targetROAS > breakevenROAS
        ? revenue.targetROAS
        : breakevenROAS * 2;
    let tier: 'A' | 'B' | 'C' | 'D' =
      roas >= targetROAS
        ? 'A'
        : roas >= breakevenROAS
          ? 'B'
          : roas >= breakevenROAS * 0.7
            ? 'C'
            : 'D';
    // Cross-campaign nudge: a campaign that clears its own breakeven math
    // but is still the account's worst performer (bottom quartile among
    // real siblings) shouldn't rank as cleanly "B" as one that's both
    // profitable AND ahead of the pack — and a campaign near the top
    // quartile shouldn't get stuck at the "D" floor just because this
    // account-wide comparison found nothing better right now.
    if (others.length >= 2) {
      if (percentileRank <= 0.25 && tier === 'B') tier = 'C';
      if (percentileRank >= 0.75 && tier === 'D') tier = 'C';
    }

    return {
      budgetProposals: [
        {
          campaignId,
          currentINR: spend,
          proposedINR: spend,
          delta: 0,
          reason: 'single-campaign scope',
        },
      ],
      ranking: [{ campaignId, score, tier }],
      totalPortfolioROAS: Number(totalPortfolioROAS.toFixed(3)),
      concentration: Number(concentration.toFixed(3)),
    };
  }

  protected computeConfidence(
    _deps: ComputeDeps<'portfolio'>,
    data: PortfolioData,
  ): number {
    // Still genuinely single-campaign scoped — no real cross-campaign
    // optimization yet (see class doc) — so this can never claim full
    // confidence, but a data-backed rating beats an always-0.6 stub that
    // reports the same "confidence" whether or not there's any real spend
    // behind the ranking.
    const hasRealSpend = (data.budgetProposals[0]?.currentINR ?? 0) > 0;
    return hasRealSpend ? 0.65 : 0.3;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'context', ref: 'portfolio-single-campaign', weight: 1 }];
  }
}
