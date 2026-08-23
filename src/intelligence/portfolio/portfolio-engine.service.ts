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
import { ObjectiveKey, PortfolioData } from '../orchestrator/decision-context';
import { Campaign } from '../../campaigns/schemas/campaign.schema';
import {
  gradeObjectiveKpi,
  isRevenueObjective,
  mapMetaObjective,
  scoredMetricFor,
} from '../objective/kpi-profiles';

type PortfolioCampaignRow = {
  _id: { toString(): string } | string;
  objective?: string;
  spend?: number;
  revenue?: number;
  roas?: number;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  purchases?: number;
  ctr?: number;
  cpc?: number;
  cpm?: number;
};

type ComparableRow = PortfolioCampaignRow & {
  campaignId: string;
  metric: number | null;
};

/**
 * Cross-campaign comparison is scoped to campaigns pursuing the same
 * canonical objective. Comparing an awareness campaign's CPM with a sales
 * campaign's ROAS is not portfolio intelligence; it is a category error.
 *
 * Ranking is deliberately relative. It does not claim that a sibling is
 * profitable (that would require resolving every sibling's product economics)
 * and it never proposes a budget change on its own.
 */
@Injectable()
export class PortfolioEngine extends BaseEngine<'portfolio', PortfolioData> {
  readonly name = 'portfolio' as const;
  readonly step = 9;
  readonly version = '1.1.0';
  readonly dependsOn = [
    'snapshot',
    'objective',
    'revenue',
    'business',
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

  protected async compute(
    deps: ComputeDeps<'portfolio'>,
    cycleId: string,
  ): Promise<PortfolioData> {
    const snap = deps.snapshot!;
    const cm =
      (snap.data as { metrics?: { campaignLevel?: Record<string, number> } })
        .metrics?.campaignLevel ?? {};
    const revenue = deps.revenue!.data;
    const objective = deps.objective!.data.objective;
    const spend = (cm.spend as number) ?? 0;
    const roas = (cm.roas as number) ?? 0;

    // deps carries only engine-slice outputs, never identity fields — the
    // previous `deps as unknown as {campaignId}` cast always resolved to
    // undefined, so every ranking entry was silently keyed campaignId=''
    // and any downstream lookup by real campaignId could never match.
    const ident = this.identity.get(cycleId);
    const campaignId = ident?.campaignId ?? '';

    // Pull all active rows once, then canonicalize/filter in memory. Stored
    // objective values can be either modern OUTCOME_* enums or legacy Meta
    // names, so a literal Mongo equality would silently miss valid peers.
    const siblings =
      this.campaignModel && ident?.tenantId
        ? await this.campaignModel
            .find({ tenantId: ident.tenantId, status: 'active' })
            .select(
              '_id objective spend roas revenue impressions clicks conversions ctr cpc cpm',
            )
            .lean()
            .exec()
            .catch(() => [])
        : [];
    const siblingRows = siblings as unknown as PortfolioCampaignRow[];

    const sameObjective = siblingRows.filter(
      (campaign) => canonicalObjective(campaign.objective) === objective,
    );

    // The current snapshot is the freshest source for the campaign being
    // evaluated. Replace its possibly stale Campaign document, or add it when
    // the collection query did not contain it, without introducing campaigns
    // from another objective.
    const currentRow: PortfolioCampaignRow = {
      _id: campaignId,
      objective,
      spend,
      revenue: finite(cm.revenue),
      roas,
      impressions: finite(cm.impressions),
      clicks: finite(cm.clicks),
      conversions: finite(cm.conversions ?? cm.purchases),
      purchases: finite(cm.purchases),
      ctr: finite(cm.ctr),
      cpc: finite(cm.cpc),
      cpm: finite(cm.cpm),
    };
    const rowsById = new Map(
      sameObjective.map((campaign) => [rowId(campaign), campaign]),
    );
    rowsById.set(campaignId, currentRow);
    const comparableRows = [...rowsById.values()];

    const totalSpendAcct = comparableRows.reduce(
      (sum, campaign) => sum + finite(campaign.spend),
      0,
    );
    const totalRevenueAcct = comparableRows.reduce(
      (sum, campaign) => sum + finite(campaign.revenue),
      0,
    );
    const revenueObjective = isRevenueObjective(objective);
    const totalPortfolioROAS =
      revenueObjective && totalSpendAcct > 0
        ? totalRevenueAcct / totalSpendAcct
        : 0;
    // Herfindahl-style concentration of spend across active campaigns: 1.0
    // means all spend sits in one campaign (no diversification, one bad
    // week tanks the account); 1/N means it's spread evenly. Real signal
    // for whether this account is over-exposed to a single campaign.
    const concentration =
      totalSpendAcct > 0
        ? comparableRows.reduce(
            (sum, campaign) =>
              sum + (finite(campaign.spend) / totalSpendAcct) ** 2,
            0,
          )
        : 1;

    const metricSpec = scoredMetricFor(objective);
    const comparable: ComparableRow[] = comparableRows.map((campaign) => ({
      ...campaign,
      campaignId: rowId(campaign),
      metric: objectiveMetric(objective, campaign),
    }));
    const withEvidence = comparable
      .filter((campaign) => campaign.metric !== null)
      .sort((left, right) => {
        const delta = (left.metric ?? 0) - (right.metric ?? 0);
        return metricSpec.lowerIsBetter ? delta : -delta;
      });
    const withoutEvidence = comparable.filter(
      (campaign) => campaign.metric === null,
    );
    const ordered = [...withEvidence, ...withoutEvidence];
    const ranking: PortfolioData['ranking'] = ordered.map((campaign, index) => {
      if (campaign.metric === null) {
        return {
          campaignId: campaign.campaignId,
          score: 0,
          tier: 'D',
        };
      }
      const relativeScore =
        withEvidence.length <= 1
          ? 100
          : ((withEvidence.length - 1 - index) / (withEvidence.length - 1)) *
            100;
      return {
        campaignId: campaign.campaignId,
        score: Number(relativeScore.toFixed(2)),
        tier: relativeTier(index, withEvidence.length),
      };
    });

    // With no peers, a relative A/D label would be fabricated. Grade the
    // current campaign against its own objective threshold instead. Revenue
    // objectives additionally require campaign-specific economics before a
    // profitability tier is allowed.
    if (withEvidence.length === 1) {
      const onlyEvidence = ranking.find(
        (entry) => entry.campaignId === withEvidence[0].campaignId,
      );
      if (onlyEvidence && onlyEvidence.campaignId === campaignId) {
        onlyEvidence.tier = standaloneTier(
          objective,
          currentRow,
          revenue.financialDataAvailable === true,
          revenue.breakeven.roas,
          revenue.targetROAS,
        );
      }
    }

    const objectiveLabel = objective.replaceAll('_', ' ');
    const comparisonReason = `No budget change proposed; compared ${withEvidence.length} active ${objectiveLabel} campaign${withEvidence.length === 1 ? '' : 's'} by ${metricSpec.label}${metricSpec.lowerIsBetter ? ' (lower is better)' : ' (higher is better)'}.`;

    return {
      budgetProposals: [
        {
          campaignId,
          currentINR: spend,
          proposedINR: spend,
          delta: 0,
          reason: comparisonReason,
        },
      ],
      ranking,
      totalPortfolioROAS: Number(totalPortfolioROAS.toFixed(3)),
      concentration: Number(concentration.toFixed(3)),
    };
  }

  protected computeConfidence(
    _deps: ComputeDeps<'portfolio'>,
    data: PortfolioData,
  ): number {
    // The slice compares real peers but deliberately makes no allocation
    // change. Keep confidence below execution grade until outcome-calibrated
    // portfolio optimization exists.
    const hasRealSpend = (data.budgetProposals[0]?.currentINR ?? 0) > 0;
    return hasRealSpend ? 0.65 : 0.3;
  }

  protected buildEvidence(): Evidence[] {
    return [{ kind: 'context', ref: 'portfolio-same-objective', weight: 1 }];
  }
}

function rowId(campaign: PortfolioCampaignRow): string {
  return campaign._id?.toString?.() ?? String(campaign._id ?? '');
}

function finite(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

const OBJECTIVE_KEYS = new Set<ObjectiveKey>([
  'sales',
  'leads',
  'awareness',
  'traffic',
  'engagement',
  'video_views',
  'app_installs',
  'messages',
  'catalog_sales',
  'retargeting',
]);

function canonicalObjective(raw: string | undefined): ObjectiveKey | undefined {
  const fromMeta = mapMetaObjective(raw);
  if (fromMeta) return fromMeta;
  const canonical = raw?.trim().toLowerCase() as ObjectiveKey | undefined;
  return canonical && OBJECTIVE_KEYS.has(canonical) ? canonical : undefined;
}

/** Returns null when the denominator needed to judge the goal is absent. */
function objectiveMetric(
  objective: ObjectiveKey,
  campaign: PortfolioCampaignRow,
): number | null {
  const spend = finite(campaign.spend);
  const impressions = finite(campaign.impressions);
  const clicks = finite(campaign.clicks);
  const conversions = finite(campaign.conversions ?? campaign.purchases);
  const metric = scoredMetricFor(objective).metric;

  switch (metric) {
    case 'roas':
      return spend > 0
        ? finite(campaign.roas) || finite(campaign.revenue) / spend
        : null;
    case 'cpm':
      return impressions > 0
        ? (spend / impressions) * 1000
        : finite(campaign.cpm) > 0
          ? finite(campaign.cpm)
          : null;
    case 'cpc':
      return clicks > 0
        ? spend / clicks
        : finite(campaign.cpc) > 0
          ? finite(campaign.cpc)
          : null;
    case 'ctr':
      return impressions > 0
        ? (clicks / impressions) * 100
        : finite(campaign.ctr) > 0
          ? finite(campaign.ctr)
          : null;
    case 'cvr':
      return clicks > 0 ? (conversions / clicks) * 100 : null;
  }
}

function relativeTier(index: number, count: number): 'A' | 'B' | 'C' | 'D' {
  if (count <= 1) return 'C';
  const percentile = index / (count - 1);
  if (percentile <= 0.25) return 'A';
  if (percentile <= 0.5) return 'B';
  if (percentile <= 0.75) return 'C';
  return 'D';
}

function standaloneTier(
  objective: ObjectiveKey,
  campaign: PortfolioCampaignRow,
  financialDataAvailable: boolean,
  breakevenROAS: number,
  targetROAS: number,
): 'A' | 'B' | 'C' | 'D' {
  if (isRevenueObjective(objective)) {
    if (!financialDataAvailable) return 'C';
    const roas = objectiveMetric(objective, campaign) ?? 0;
    if (targetROAS > 0 && roas >= targetROAS) return 'A';
    if (breakevenROAS > 0 && roas >= breakevenROAS) return 'B';
    if (breakevenROAS > 0 && roas >= breakevenROAS * 0.7) return 'C';
    return 'D';
  }

  const grade = gradeObjectiveKpi(objective, {
    spend: finite(campaign.spend),
    revenue: finite(campaign.revenue),
    purchases: finite(campaign.purchases),
    conversions: finite(campaign.conversions),
    clicks: finite(campaign.clicks),
    impressions: finite(campaign.impressions),
  });
  if (grade.status === 'good') return 'A';
  if (grade.status === 'watch') return 'B';
  if (grade.status === 'bad') return 'D';
  return 'C';
}
