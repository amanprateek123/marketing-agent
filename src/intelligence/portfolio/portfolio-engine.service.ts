import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseEngine } from '../shared/base-engine';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import { EngineRegistry } from '../shared/engine-registry';
import { SliceRepository } from '../shared/slice-repository.service';
import { Evidence } from '../shared/engine-context';
import { ComputeDeps } from '../shared/engine.interface';
import { PortfolioData } from '../orchestrator/decision-context';

/**
 * PR-N: campaign-scoped placeholder implementation.
 * True tenant-scoped batch optimization lands in a follow-up when the
 * orchestrator supports tenant-batched cycles.
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

    const ident = deps as unknown as { campaignId?: string };
    const campaignId = ident.campaignId ?? '';

    // Score = margin + roas boost; tier by roas bucket.
    const score = Number((revenue.contributionMargin + roas * spend * 0.1).toFixed(2));
    const tier: 'A' | 'B' | 'C' | 'D' =
      roas >= 2 ? 'A' : roas >= 1.5 ? 'B' : roas >= 1 ? 'C' : 'D';

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
      totalPortfolioROAS: Number(roas.toFixed(3)),
      concentration: 1,
    };
  }

  protected computeConfidence(): number {
    return 0.6;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'context', ref: 'portfolio-single-campaign', weight: 1 }];
  }
}
