import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Economics,
  contributionProfit,
  round,
  weightedROAS,
} from '../common/economics/economics';
import {
  TenantEconomics,
  TenantEconomicsService,
} from '../common/economics/tenant-economics.service';
import { Campaign } from '../campaigns/schemas/campaign.schema';
import { MetricTimeseries } from '../campaigns/schemas/metric-timeseries.schema';
import { Company } from '../companies/schemas/company.schema';
import { CreativePackage } from '../creative/schemas/creative-package.schema';
import { IntelligenceDecision } from '../intelligence/decisions/intelligence-decision.schema';
import { PipelineRun } from '../pipeline/schemas/pipeline-run.schema';
import { parseCampaignName } from './campaign-name.parser';
import { ObjectiveVerdict, evaluateObjective } from './objective-evaluation';
import {
  DashboardAlert,
  DashboardCampaignRow,
  DashboardInsight,
  DashboardOverview,
  FacetRollup,
  PortfolioRollup,
  TenantActivity,
  TrendDelta,
  WindowMetrics,
} from './dashboard.types';

/** Spend below which a zero-revenue campaign isn't worth alarming about. */
const ZERO_CONV_ALERT_MIN_SPEND = 2000;
/** Metrics older than this are stale enough that verdicts built on them lie. */
const STALE_METRICS_HOURS = 36;

const STATUS_LABELS: Record<string, string> = {
  active: 'Running',
  paused: 'Paused',
  pending_approval: 'Waiting for you',
  completed: 'Finished',
  failed: 'Failed',
  superseded: 'Replaced',
  draft: 'Draft',
};

const LEARNING_LABELS: Record<string, string> = {
  LEARNING: 'Still learning',
  LEARNING_LIMITED: 'Stuck in learning',
  ACTIVE: 'Optimised',
  NOT_DELIVERING: 'Not delivering',
};

/**
 * Builds the complete tenant picture in one pass.
 *
 * Everything the dashboard shows is derived here against the tenant's real
 * margin. Nothing is left for the frontend to compute — see the note on
 * DashboardOverview for why.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly economics: TenantEconomicsService,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<Campaign>,
    @InjectModel(Company.name)
    private readonly companyModel: Model<Company>,
    @InjectModel(MetricTimeseries.name)
    private readonly timeseriesModel: Model<MetricTimeseries>,
    @InjectModel(PipelineRun.name)
    private readonly runModel: Model<PipelineRun>,
    @InjectModel(CreativePackage.name)
    private readonly creativeModel: Model<CreativePackage>,
    @InjectModel(IntelligenceDecision.name)
    private readonly decisionModel: Model<IntelligenceDecision>,
  ) {}

  async getOverview(
    tenantId: string,
    windowDays = 30,
  ): Promise<DashboardOverview> {
    const now = new Date();
    const from = new Date(now.getTime() - windowDays * 864e5);
    const prevFrom = new Date(from.getTime() - windowDays * 864e5);

    const econ = await this.economics.forTenant(tenantId);

    // Every query is tenantId-scoped — non-negotiable per project rule 3.
    const [company, campaigns, runs, creatives, decisions] = await Promise.all([
      this.companyModel.findOne({ tenantId }).lean().exec(),
      this.campaignModel.find({ tenantId }).lean().exec(),
      this.runModel
        .find({ tenantId })
        .sort({ startedAt: -1 })
        .limit(50)
        .lean()
        .exec(),
      this.creativeModel.find({ tenantId }).select('status images video carouselCards').lean().exec(),
      this.decisionModel
        .find({ tenantId, status: 'pending' })
        .select('_id')
        .lean()
        .exec(),
    ]);

    const { windowByCampaign, prevByCampaign, hasTimeseries } =
      await this.loadWindowedMetrics(tenantId, from, prevFrom, now);

    const metricsSource = hasTimeseries ? 'timeseries' : 'campaign-lifetime';

    const knownProducts: string[] = (
      ((company as any)?.products ?? []) as Array<{ name?: string }>
    )
      .map((p) => String(p?.name ?? '').trim())
      .filter(Boolean);

    const rows = campaigns.map((c) =>
      this.buildRow(c, econ, windowByCampaign, hasTimeseries, now, knownProducts),
    );

    // Rows that belong to THIS window. With real timeseries a campaign
    // qualifies if it spent inside the window regardless of launch date;
    // without it, launch date is the only filter available.
    const windowRows = hasTimeseries
      ? rows.filter((r) => r.spend > 0 || r.status === 'active' || r.status === 'pending_approval')
      : rows.filter(
          (r) =>
            !r.launchedAt ||
            new Date(r.launchedAt).getTime() >= from.getTime(),
        );

    const portfolio = this.rollUp(windowRows, econ);

    // Lifetime reads the campaign documents' own running totals, NOT the row
    // objects — those carry windowed figures whenever the timeseries is
    // available, which would make "lifetime" a duplicate of the window and
    // silently understate everything spent before it.
    const lifetimeItems = campaigns.map((c: any) => {
      const spend = num(c.spend);
      const revenue =
        num(c.revenue) > 0
          ? num(c.revenue)
          : num(c.roas) > 0
            ? num(c.roas) * spend
            : 0;
      // Each campaign's own product margin — same reason as buildRow.
      const product = parseCampaignName(c.name ?? c.topic, knownProducts).product;
      const rowEcon = this.economics.forProduct(econ, product);
      return {
        spend,
        revenue,
        conversions: num(c.conversions),
        clicks: num(c.clicks),
        impressions: num(c.impressions),
        contributionProfit: contributionProfit(spend, revenue, rowEcon),
      };
    });
    const lifetimeBase = this.baseMetrics(
      lifetimeItems,
      econ,
      sum(lifetimeItems.map((i) => i.contributionProfit)),
    );
    const lifetime = {
      ...lifetimeBase,
      isProfitable: lifetimeBase.contributionProfit >= 0,
    };

    const previous = hasTimeseries
      ? this.baseMetrics(
          campaigns.map((c) => {
            const key = String(c.metaCampaignId ?? '');
            const m = prevByCampaign.get(key);
            return {
              spend: m?.spend ?? 0,
              revenue: m?.revenue ?? 0,
              conversions: m?.conversions ?? 0,
              clicks: m?.clicks ?? 0,
              impressions: m?.impressions ?? 0,
            };
          }),
          econ,
        )
      : null;

    const trend = previous ? this.buildTrend(portfolio, previous) : null;

    const activity = this.buildActivity(
      company,
      campaigns,
      runs,
      creatives,
      decisions.length,
      from,
      now,
    );

    const alerts = this.buildAlerts(
      econ,
      portfolio,
      windowRows,
      activity,
      company,
      tenantId,
    );

    return {
      tenantId,
      companyName: (company as any)?.name ?? null,
      industry: (company as any)?.industry ?? null,
      generatedAt: now.toISOString(),
      window: {
        days: windowDays,
        from: from.toISOString(),
        to: now.toISOString(),
        label: `Last ${windowDays} days`,
        metricsSource,
      },
      economics: {
        productName: econ.productName,
        marginPct: econ.marginPct,
        refundPct: econ.refundPct,
        netMarginPct: econ.netMarginPct,
        breakevenROAS: econ.breakevenROAS,
        targetROAS: econ.targetROAS,
        method: econ.method,
        isEstimated: econ.method === 'generic-default',
        hasMixedMargins: econ.hasMixedMargins,
        byProduct: Object.values(econ.byProduct).map((p) => ({
          productName: p.productName,
          marginPct: p.marginPct,
          breakevenROAS: p.breakevenROAS,
          targetROAS: p.targetROAS,
        })),
        notes: econ.notes,
      },
      portfolio,
      lifetime,
      previous,
      trend,
      alerts,
      campaigns: windowRows,
      facets: {
        byProduct: this.facetRollup(windowRows, econ, (r) => r.facets.product),
        byFunnel: this.facetRollup(windowRows, econ, (r) => r.facets.funnelLabel),
        byBudgetModel: this.facetRollup(windowRows, econ, (r) =>
          r.facets.budgetModel.toUpperCase(),
        ),
        byLanguage: this.facetRollup(
          windowRows,
          econ,
          (r) => r.facets.language ?? 'unspecified',
        ),
        byObjective: this.facetRollup(windowRows, econ, (r) => r.objectiveLabel),
      },
      insights: this.buildInsights(company),
      activity,
    };
  }

  // ─── Metrics loading ───────────────────────────────────────────────────

  /**
   * True windowed metrics from daily rows when the timeseries has been
   * synced. Without it there is no way to slice a campaign's lifetime totals
   * by date, so the caller falls back and the response says so.
   */
  private async loadWindowedMetrics(
    tenantId: string,
    from: Date,
    prevFrom: Date,
    now: Date,
  ): Promise<{
    windowByCampaign: Map<string, RawMetrics>;
    prevByCampaign: Map<string, RawMetrics>;
    hasTimeseries: boolean;
  }> {
    const windowByCampaign = new Map<string, RawMetrics>();
    const prevByCampaign = new Map<string, RawMetrics>();

    try {
      const rows = await this.timeseriesModel
        .find({
          tenantId,
          level: 'campaign',
          date: { $gte: toDateKey(prevFrom), $lte: toDateKey(now) },
        })
        .lean()
        .exec();

      if (!rows.length) {
        return { windowByCampaign, prevByCampaign, hasTimeseries: false };
      }

      const fromKey = toDateKey(from);
      for (const r of rows as any[]) {
        const target = r.date >= fromKey ? windowByCampaign : prevByCampaign;
        const key = String(r.metaCampaignId ?? r.entityId ?? '');
        const acc = target.get(key) ?? emptyRaw();
        acc.spend += num(r.spend);
        acc.revenue += num(r.revenue);
        acc.conversions += num(r.conversions);
        acc.clicks += num(r.clicks);
        acc.impressions += num(r.impressions);
        target.set(key, acc);
      }
      return { windowByCampaign, prevByCampaign, hasTimeseries: true };
    } catch (err: any) {
      this.logger.warn(
        `Timeseries rollup failed for ${tenantId}, falling back to campaign lifetime totals: ${err.message}`,
      );
      return { windowByCampaign, prevByCampaign, hasTimeseries: false };
    }
  }

  // ─── Row building ──────────────────────────────────────────────────────

  private buildRow(
    c: any,
    tenantEcon: TenantEconomics,
    windowByCampaign: Map<string, RawMetrics>,
    hasTimeseries: boolean,
    now: Date,
    knownProducts: string[],
  ): DashboardCampaignRow {
    const facets = parseCampaignName(c.name ?? c.topic, knownProducts);
    // Judge this campaign against ITS product's margin, not the account's
    // headline one. Falls back to the headline when the campaign name could
    // not be attributed to a configured product.
    const econ = this.economics.forProduct(tenantEcon, facets.product);
    const windowed = hasTimeseries
      ? windowByCampaign.get(String(c.metaCampaignId ?? '')) ?? emptyRaw()
      : {
          spend: num(c.spend),
          revenue: num(c.revenue),
          conversions: num(c.conversions),
          clicks: num(c.clicks),
          impressions: num(c.impressions),
        };

    const spend = windowed.spend;
    // Campaign.revenue can lag behind roas x spend on partially-synced rows;
    // prefer the explicit revenue field and only derive when it's absent.
    const revenue =
      windowed.revenue > 0
        ? windowed.revenue
        : num(c.roas) > 0
          ? num(c.roas) * spend
          : 0;

    const launchedAt = c.launchedAt ? new Date(c.launchedAt) : null;
    const endedAt = c.stopTime ? new Date(c.stopTime) : null;
    const ageHours = launchedAt
      ? Math.max(0, (now.getTime() - launchedAt.getTime()) / 36e5)
      : null;
    const effectiveEnd = endedAt && endedAt < now ? endedAt : now;
    const daysRunning = launchedAt
      ? Math.max(
          0,
          Math.round((effectiveEnd.getTime() - launchedAt.getTime()) / 864e5),
        )
      : null;

    const roas = weightedROAS(spend, revenue);
    const profit = contributionProfit(spend, revenue, econ);

    // Judge against the goal this campaign was actually given. A reach or
    // app-promotion campaign has no purchase expectation, so scoring it on
    // ROAS reports a failure for a campaign doing exactly what it was told.
    const evaluation = evaluateObjective({
      objectiveRaw: c.objective,
      metrics: {
        spend,
        revenue,
        conversions: num(windowed.conversions),
        clicks: num(windowed.clicks),
        impressions: num(windowed.impressions),
        reach: num(c.reach),
        frequency: num(c.frequency),
      },
      econ,
      ageHours,
      status: c.status ?? 'unknown',
    });
    const verdict = evaluation.verdict;

    const dataAsOf = c.dataAsOf ? new Date(c.dataAsOf) : null;
    const dataAgeHours = dataAsOf
      ? Math.max(0, (now.getTime() - dataAsOf.getTime()) / 36e5)
      : null;

    const learningStage = this.rollUpLearningStage(c);

    return {
      id: String(c._id),
      name: c.name ?? c.topic ?? 'Untitled',
      displayName: facets.label,
      status: c.status ?? 'unknown',
      statusLabel: STATUS_LABELS[c.status] ?? c.status ?? '—',
      metaCampaignId: c.metaCampaignId ?? undefined,

      spend: round(spend, 2),
      revenue: round(revenue, 2),
      roas: round(roas, 3),
      conversions: num(windowed.conversions),
      clicks: num(windowed.clicks),
      impressions: num(windowed.impressions),
      ctr:
        windowed.impressions > 0
          ? round((windowed.clicks / windowed.impressions) * 100, 3)
          : 0,
      cvr:
        windowed.clicks > 0
          ? round((windowed.conversions / windowed.clicks) * 100, 3)
          : 0,

      contributionProfit: round(profit, 2),
      gapToBreakeven: round(roas - econ.breakevenROAS, 3),
      breakevenROAS: econ.breakevenROAS,
      targetROAS: econ.targetROAS,
      marginPct: econ.marginPct,
      // Sort key. Only revenue objectives can put money "at risk" — an
      // awareness campaign's spend is the cost of the impressions it was
      // asked to buy, not a shortfall against revenue nobody expected.
      moneyAtRisk:
        evaluation.isRevenueObjective && profit < 0 ? round(Math.abs(profit), 2) : 0,

      objective: evaluation.objectiveRaw,
      objectiveKey: evaluation.objectiveKey,
      objectiveLabel: evaluation.objectiveLabel,
      isRevenueObjective: evaluation.isRevenueObjective,
      primaryKpi: evaluation.primaryKpi,
      costPerResult: evaluation.costPerResult,
      costPerResultDisplay: evaluation.costPerResultDisplay,

      verdict,
      verdictLabel: evaluation.verdictLabel,
      severity: evaluation.severity,
      isActionable: this.isActionable(c.status, verdict),
      nextAction: evaluation.nextAction,

      facets,

      launchedAt: launchedAt?.toISOString() ?? null,
      endedAt: endedAt?.toISOString() ?? null,
      daysRunning,
      ageHours: ageHours != null ? round(ageHours, 1) : null,

      budget: num(c.budget),
      spendCap: num(c.spendCap),
      capRisk: this.detectCapRisk(c),

      learningStage,
      learningStageLabel: learningStage
        ? (LEARNING_LABELS[learningStage] ?? learningStage)
        : null,

      dataAsOf: dataAsOf?.toISOString() ?? null,
      dataAgeHours: dataAgeHours != null ? round(dataAgeHours, 1) : null,
      isStale:
        c.status === 'active' &&
        dataAgeHours != null &&
        dataAgeHours > STALE_METRICS_HOURS,
    };
  }

  /**
   * Meta reports learning stage per ad set. A campaign is only "optimised"
   * when nothing inside it is still learning — the worst stage wins, because
   * one LEARNING_LIMITED ad set is enough to hold back delivery.
   */
  private rollUpLearningStage(c: any): string | null {
    const stages: string[] = (c.metaAdSets ?? [])
      .map((a: any) => a?.learningStage)
      .filter(Boolean);
    if (!stages.length) return null;
    const priority = [
      'NOT_DELIVERING',
      'LEARNING_LIMITED',
      'LEARNING',
      'ACTIVE',
    ];
    for (const p of priority) if (stages.includes(p)) return p;
    return stages[0];
  }

  /**
   * A lifetime cap below daily budget x planned run length is guaranteed to
   * be breached — it is arithmetic, knowable before a rupee is spent. This
   * account learned it the expensive way: a ₹20,000 cap against ₹2,500/day
   * over 10 days blew through around day 8.
   */
  private detectCapRisk(c: any): DashboardCampaignRow['capRisk'] {
    const cap = num(c.spendCap);
    const daily = num(c.budget);
    if (cap <= 0 || daily <= 0) return null;

    const start = c.launchedAt ? new Date(c.launchedAt) : null;
    const stop = c.stopTime ? new Date(c.stopTime) : null;
    if (!start || !stop) return null;

    const plannedDays = Math.max(
      1,
      Math.ceil((stop.getTime() - start.getTime()) / 864e5),
    );
    const projectedSpend = daily * plannedDays;
    if (projectedSpend <= cap) return null;

    return {
      dailyBudget: round(daily, 2),
      plannedDays,
      projectedSpend: round(projectedSpend, 2),
      cap: round(cap, 2),
      overrunBy: round(projectedSpend - cap, 2),
    };
  }

  private isActionable(status: string, verdict: ObjectiveVerdict): boolean {
    // A finished campaign cannot be acted on. Labelling it "Needs action"
    // trains people to ignore the chip everywhere else.
    if (status !== 'active' && status !== 'pending_approval') return false;
    return verdict !== 'attribution_pending' && verdict !== 'no_spend';
  }

  // ─── Aggregation ───────────────────────────────────────────────────────

  /**
   * @param econ Used ONLY when `precomputedProfit` is absent — i.e. when every
   *   item genuinely shares one margin. Aggregating a mixed-product set with a
   *   single margin is wrong in a way that hides losses: applying the
   *   97%-margin product's rate to revenue earned by a 45%-margin product
   *   overstates contribution by more than half of that revenue.
   * @param precomputedProfit Sum of per-row contribution, each already
   *   computed against its own product's margin.
   */
  private baseMetrics(
    items: Array<{
      spend: number;
      revenue: number;
      conversions: number;
      clicks: number;
      impressions: number;
    }>,
    econ: Economics,
    precomputedProfit?: number,
  ): WindowMetrics {
    const spend = sum(items.map((i) => i.spend));
    const revenue = sum(items.map((i) => i.revenue));
    const conversions = sum(items.map((i) => i.conversions));
    const clicks = sum(items.map((i) => i.clicks));
    const impressions = sum(items.map((i) => i.impressions));

    return {
      spend: round(spend, 2),
      revenue: round(revenue, 2),
      roas: round(weightedROAS(spend, revenue), 3),
      conversions,
      clicks,
      impressions,
      ctr: impressions > 0 ? round((clicks / impressions) * 100, 3) : 0,
      cvr: clicks > 0 ? round((conversions / clicks) * 100, 3) : 0,
      cpc: clicks > 0 ? round(spend / clicks, 2) : 0,
      cpm: impressions > 0 ? round((spend / impressions) * 1000, 2) : 0,
      aov: conversions > 0 ? round(revenue / conversions, 2) : 0,
      cac: conversions > 0 ? round(spend / conversions, 2) : 0,
      contributionProfit: round(
        precomputedProfit ?? contributionProfit(spend, revenue, econ),
        2,
      ),
      campaignCount: items.filter((i) => i.spend > 0).length,
    };
  }

  private rollUp(
    rows: DashboardCampaignRow[],
    econ: Economics,
  ): PortfolioRollup {
    // ROAS is only meaningful over campaigns that were asked for revenue.
    // Including awareness / app-promotion / traffic spend in the denominator
    // drags the headline down with money that was never supposed to come back
    // as tracked purchases — this account has 139 app-promotion campaigns
    // reporting in-app events, and folding those in makes the sales side look
    // far worse than it is.
    const revenueRows = rows.filter((r) => r.isRevenueObjective);
    const otherRows = rows.filter((r) => !r.isRevenueObjective);

    const base = this.baseMetrics(
      revenueRows,
      econ,
      sum(revenueRows.map((r) => r.contributionProfit)),
    );

    const losers = revenueRows.filter(
      (r) =>
        r.spend > 0 &&
        (r.verdict === 'below_breakeven' ||
          r.verdict === 'losing_badly' ||
          r.verdict === 'no_conversions'),
    );
    const spendBelowBreakeven = sum(losers.map((r) => r.spend));

    const offTargetOther = otherRows.filter(
      (r) => r.verdict === 'underperforming' || r.verdict === 'failing',
    );

    return {
      ...base,
      totalSpendAllObjectives: round(sum(rows.map((r) => r.spend)), 2),
      nonRevenueSpend: round(sum(otherRows.map((r) => r.spend)), 2),
      nonRevenueCampaigns: otherRows.filter((r) => r.spend > 0).length,
      nonRevenueOffTarget: offTargetOther.length,
      // Profit, not the ROAS-vs-breakeven comparison. Across products with
      // different margins there is no single breakeven the portfolio ROAS can
      // be measured against — but summed contribution is always well defined.
      isProfitable: base.contributionProfit >= 0,
      gapToBreakeven: round(base.roas - econ.breakevenROAS, 3),
      pctOfTarget:
        econ.targetROAS > 0 ? round(base.roas / econ.targetROAS, 3) : 0,
      spendBelowBreakeven: round(spendBelowBreakeven, 2),
      pctSpendBelowBreakeven:
        base.spend > 0 ? round(spendBelowBreakeven / base.spend, 3) : 0,
      moneyAtRisk: round(sum(losers.map((r) => r.moneyAtRisk)), 2),
      campaignsBelowBreakeven: losers.length,
    };
  }

  private facetRollup(
    rows: DashboardCampaignRow[],
    econ: Economics,
    keyOf: (r: DashboardCampaignRow) => string,
  ): FacetRollup[] {
    const totalSpend = sum(rows.map((r) => r.spend));
    const groups = new Map<string, DashboardCampaignRow[]>();
    for (const r of rows) {
      if (r.spend <= 0) continue;
      const k = keyOf(r) || 'unspecified';
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }

    return [...groups.entries()]
      .map(([key, items]) => {
        const m = this.baseMetrics(
          items,
          econ,
          sum(items.map((i) => i.contributionProfit)),
        );
        return {
          key,
          label: key,
          campaignCount: items.length,
          spend: m.spend,
          revenue: m.revenue,
          roas: m.roas,
          contributionProfit: m.contributionProfit,
          isProfitable: m.roas >= econ.breakevenROAS,
          spendShare: totalSpend > 0 ? round(m.spend / totalSpend, 3) : 0,
        };
      })
      .sort((a, b) => b.spend - a.spend);
  }

  private buildTrend(
    current: WindowMetrics,
    previous: WindowMetrics,
  ): TrendDelta {
    const pct = (now: number, before: number): number | null =>
      before > 0 ? round(((now - before) / before) * 100, 1) : null;

    const roasPct = pct(current.roas, previous.roas);
    const contributionAbs = round(
      current.contributionProfit - previous.contributionProfit,
      2,
    );

    let direction: TrendDelta['direction'] = 'flat';
    if (roasPct != null && Math.abs(roasPct) >= 5) {
      direction = roasPct > 0 ? 'improving' : 'declining';
    } else if (Math.abs(contributionAbs) > 1) {
      direction = contributionAbs > 0 ? 'improving' : 'declining';
    }

    return {
      spendPct: pct(current.spend, previous.spend),
      revenuePct: pct(current.revenue, previous.revenue),
      roasPct,
      contributionAbs,
      direction,
    };
  }

  // ─── Alerts ────────────────────────────────────────────────────────────

  /**
   * Real problems, severity-ranked — not just the approval queue.
   *
   * The old dashboard rendered "All caught up 🎉" whenever nothing was
   * pending approval, while four of five campaigns sat below breakeven. An
   * empty approval queue is not the same as a healthy account.
   */
  private buildAlerts(
    econ: Economics & { method: string },
    portfolio: PortfolioRollup,
    rows: DashboardCampaignRow[],
    activity: TenantActivity,
    company: any,
    tenantId: string,
  ): DashboardAlert[] {
    const alerts: DashboardAlert[] = [];
    const base = `/dashboard/${tenantId}`;

    if (!activity.meta.connected) {
      alerts.push({
        kind: 'meta_disconnected',
        severity: 'critical',
        title: 'Meta is not connected',
        detail:
          'Without a Meta access token nothing can be synced, audited, or launched.',
        suggestedAction: 'Add your Meta Ads token in Settings.',
        href: `${base}/settings`,
      });
    }

    if (portfolio.spend > 0 && !portfolio.isProfitable) {
      alerts.push({
        kind: 'portfolio_below_breakeven',
        severity: 'critical',
        title: `The account is below breakeven (${portfolio.roas.toFixed(2)}x vs ${econ.breakevenROAS.toFixed(2)}x)`,
        detail:
          `${formatPct(portfolio.pctSpendBelowBreakeven)} of sales-objective spend sits in campaigns that lose money. ` +
          `Contribution profit for this window is ${formatMoney(portfolio.contributionProfit)}.` +
          (portfolio.nonRevenueSpend > 0
            ? ` A further ${formatMoney(portfolio.nonRevenueSpend)} sits in awareness/traffic/app campaigns, judged on their own goals and excluded from this figure.`
            : ''),
        amount: portfolio.moneyAtRisk,
        suggestedAction:
          'Cut or fix the losing campaigns before adding new ones.',
        href: `${base}/campaigns`,
      });
    }

    for (const r of rows) {
      if (r.capRisk) {
        alerts.push({
          kind: 'budget_cap_misconfigured',
          severity: 'critical',
          title: `"${r.displayName}" will breach its spend cap`,
          detail:
            `₹${r.capRisk.dailyBudget.toLocaleString('en-IN')}/day over ${r.capRisk.plannedDays} days projects to ` +
            `${formatMoney(r.capRisk.projectedSpend)} against a ${formatMoney(r.capRisk.cap)} cap — ` +
            `an overrun of ${formatMoney(r.capRisk.overrunBy)} is arithmetically guaranteed.`,
          amount: r.capRisk.overrunBy,
          suggestedAction:
            'Raise the cap or lower the daily budget so they agree.',
          href: `${base}/campaigns/${r.id}`,
          campaignId: r.id,
          campaignName: r.name,
        });
      }

      // Gated on isRevenueObjective: a reach campaign reporting no purchases
      // is not a tracking fault, it is a campaign doing its job. Firing this
      // for one sends the operator to debug a pixel that was never involved.
      if (
        r.isRevenueObjective &&
        r.verdict === 'no_conversions' &&
        r.spend >= ZERO_CONV_ALERT_MIN_SPEND
      ) {
        alerts.push({
          kind: 'zero_conversion_spend',
          severity: 'critical',
          title: `"${r.displayName}" has spent ${formatMoney(r.spend)} with zero sales`,
          detail:
            `Running ${r.daysRunning ?? '?'} days with no attributed revenue. ` +
            'This is past any attribution window — it is a result, not missing data.',
          amount: r.spend,
          suggestedAction: r.nextAction ?? 'Check tracking, then pause.',
          href: `${base}/campaigns/${r.id}`,
          campaignId: r.id,
          campaignName: r.name,
        });
      }

      if (
        r.isRevenueObjective &&
        r.verdict === 'losing_badly' &&
        r.status === 'active'
      ) {
        alerts.push({
          kind: 'campaign_losing_badly',
          severity: 'warning',
          title: `"${r.displayName}" is at ${r.roas.toFixed(2)}x — less than half of breakeven`,
          detail: `It has destroyed ${formatMoney(r.moneyAtRisk)} of contribution so far.`,
          amount: r.moneyAtRisk,
          suggestedAction: 'Pause it.',
          href: `${base}/campaigns/${r.id}`,
          campaignId: r.id,
          campaignName: r.name,
        });
      }

      if (
        !r.isRevenueObjective &&
        r.verdict === 'failing' &&
        r.status === 'active' &&
        r.spend >= ZERO_CONV_ALERT_MIN_SPEND
      ) {
        alerts.push({
          kind: 'objective_off_target',
          severity: 'warning',
          title: `"${r.displayName}" is missing its ${r.objectiveLabel.toLowerCase()} goal`,
          detail:
            `${r.primaryKpi.label} is ${r.primaryKpi.display} against a target of ` +
            `${r.primaryKpi.targetDisplay ?? 'n/a'}. Judged on its own objective, not on sales.`,
          amount: r.spend,
          suggestedAction: r.nextAction ?? 'Refresh creative or narrow the audience.',
          href: `${base}/campaigns/${r.id}`,
          campaignId: r.id,
          campaignName: r.name,
        });
      }

      if (r.learningStage === 'LEARNING_LIMITED' && r.status === 'active') {
        alerts.push({
          kind: 'learning_limited',
          severity: 'warning',
          title: `"${r.displayName}" is stuck in Meta's learning phase`,
          detail:
            'Delivery stays unoptimised below ~50 conversions/week. Consolidate ad sets or widen the audience.',
          suggestedAction: 'Merge ad sets to concentrate conversion volume.',
          href: `${base}/campaigns/${r.id}`,
          campaignId: r.id,
          campaignName: r.name,
        });
      }

      if (r.isStale) {
        alerts.push({
          kind: 'stale_metrics',
          severity: 'info',
          title: `"${r.displayName}" has stale numbers`,
          detail: `Last synced ${Math.round(r.dataAgeHours ?? 0)}h ago — any verdict here may be out of date.`,
          suggestedAction: 'Run a campaign sync.',
          href: `${base}/campaigns/${r.id}`,
          campaignId: r.id,
          campaignName: r.name,
        });
      }
    }

    if (econ.method === 'generic-default') {
      alerts.push({
        kind: 'no_margin_configured',
        severity: 'warning',
        title: 'Profit numbers are based on a guessed margin',
        detail:
          'No contribution margin is set for this product, so breakeven is assumed rather than known. Every profit figure here inherits that assumption.',
        suggestedAction: 'Set the product margin in Settings.',
        href: `${base}/settings`,
      });
    }

    if (activity.queue.pendingApprovalCampaigns > 0) {
      alerts.push({
        kind: 'pending_approvals',
        severity: 'info',
        title: `${activity.queue.pendingApprovalCampaigns} campaign(s) waiting for approval`,
        detail: 'Nothing launches until you review them.',
        href: `${base}/approvals`,
      });
    }

    if (activity.queue.pendingActions + activity.queue.pendingDecisions > 0) {
      alerts.push({
        kind: 'pending_actions',
        severity: 'info',
        title: `${activity.queue.pendingActions + activity.queue.pendingDecisions} suggested change(s) waiting`,
        detail: 'The optimiser has proposed changes that need a decision.',
        href: `${base}/proposed-actions`,
      });
    }

    const rank = { critical: 0, warning: 1, info: 2 };
    return alerts.sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] ||
        (b.amount ?? 0) - (a.amount ?? 0),
    );
  }

  // ─── Activity ──────────────────────────────────────────────────────────

  private buildActivity(
    company: any,
    campaigns: any[],
    runs: any[],
    creatives: any[],
    pendingDecisions: number,
    from: Date,
    now: Date,
  ): TenantActivity {
    const meta = company?.meta ?? null;
    const runsInWindow = runs.filter(
      (r) => new Date(r.startedAt).getTime() >= from.getTime(),
    );

    let ready = 0;
    let producing = 0;
    let failed = 0;
    let allRejected = 0;
    for (const p of creatives) {
      if (p.status === 'pending') producing++;
      else if (p.status === 'failed') failed++;
      else if (p.status === 'completed') {
        const usableImages = (p.images ?? []).filter(
          (i: any) => i?.imageUrl && !i.rejected,
        ).length;
        const usableVideo = !!p.video?.videoUrl && !p.video?.rejected;
        const usableCards = (p.carouselCards ?? []).filter(
          (c: any) => c?.imageUrl,
        ).length;
        if (usableImages || usableVideo || usableCards) ready++;
        else allRejected++;
      }
    }

    const activeWithData = campaigns.filter(
      (c) => c.status === 'active' && c.dataAsOf,
    );
    const ages = activeWithData.map(
      (c) => (now.getTime() - new Date(c.dataAsOf).getTime()) / 36e5,
    );
    const lastSync = campaigns
      .map((c) => (c.syncedAt ? new Date(c.syncedAt).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);

    const pendingActions = campaigns.reduce(
      (s, c) =>
        s +
        (c.pendingActions ?? []).filter((a: any) => a?.status === 'pending')
          .length,
      0,
    );

    return {
      meta: {
        connected: !!meta?.accessToken,
        accountId: meta?.accountId ?? null,
        businessId: meta?.businessId ?? null,
        accountCount: (meta?.accountIds ?? []).length || (meta?.accountId ? 1 : 0),
        pixelId: meta?.pixelId ?? null,
        pageId: meta?.pageId ?? null,
      },
      pipeline: {
        lastRunAt: runs[0]?.startedAt
          ? new Date(runs[0].startedAt).toISOString()
          : null,
        lastRunStatus: runs[0]?.status ?? null,
        lastRunId: runs[0]?.runId ?? null,
        runsInWindow: runsInWindow.length,
        runningNow: runs.filter(
          (r) => r.status === 'running' || r.status === 'pending',
        ).length,
        failedInWindow: runsInWindow.filter((r) => r.status === 'failed').length,
      },
      creatives: {
        total: creatives.length,
        ready,
        producing,
        failed,
        allRejected,
      },
      queue: {
        pendingApprovalCampaigns: campaigns.filter(
          (c) => c.status === 'pending_approval',
        ).length,
        pendingActions,
        pendingDecisions,
      },
      sync: {
        lastSyncAt: lastSync > 0 ? new Date(lastSync).toISOString() : null,
        stalestCampaignHours: ages.length ? round(Math.max(...ages), 1) : null,
        staleCampaignCount: ages.filter((h) => h > STALE_METRICS_HOURS).length,
      },
    };
  }

  // ─── Insights ──────────────────────────────────────────────────────────

  /**
   * Causal insights, ranked and weight-tagged.
   *
   * `strength` exists so the UI can stop rendering a 60%-confidence, N=2
   * finding at the same visual weight as an established fact.
   */
  private buildInsights(company: any): DashboardInsight[] {
    const raw: any[] = company?.learnings?.causalInsights ?? [];
    return [...raw]
      .sort(
        (a, b) =>
          num(b.confidence) * Math.log(1 + num(b.dataPoints)) -
          num(a.confidence) * Math.log(1 + num(a.dataPoints)),
      )
      .slice(0, 8)
      .map((i, idx) => {
        const confidence = num(i.confidence);
        const dataPoints = num(i.dataPoints);
        const strength: DashboardInsight['strength'] =
          confidence >= 0.75 && dataPoints >= 5
            ? 'strong'
            : confidence >= 0.5 && dataPoints >= 3
              ? 'moderate'
              : 'weak';
        return {
          id: `${i.rootCause ?? 'insight'}-${idx}`,
          finding: String(i.finding ?? ''),
          confidence,
          dataPoints,
          strength,
          category: i.rootCause ?? null,
          recommendation: i.isolatedVariable
            ? `Isolated variable: ${i.isolatedVariable}`
            : null,
          createdAt: i.lastSeenAt
            ? new Date(i.lastSeenAt).toISOString()
            : i.firstSeenAt
              ? new Date(i.firstSeenAt).toISOString()
              : null,
        };
      });
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

interface RawMetrics {
  spend: number;
  revenue: number;
  conversions: number;
  clicks: number;
  impressions: number;
}

function emptyRaw(): RawMetrics {
  return { spend: 0, revenue: 0, conversions: 0, clicks: 0, impressions: 0 };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatMoney(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
}

function formatPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
