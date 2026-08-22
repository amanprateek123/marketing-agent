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
import { CampaignIntelligenceCycle } from '../intelligence/orchestrator/cycle.schema';
import { ExecutedAction } from '../learning/schemas/executed-action.schema';
import { PipelineRun } from '../pipeline/schemas/pipeline-run.schema';
import { parseCampaignName } from './campaign-name.parser';
import { ObjectiveVerdict, evaluateObjective } from './objective-evaluation';
import { isTrustedProductScopedTimeseriesRevenue } from '../campaigns/meta-ads/timeseries-revenue-provenance.util';
import {
  DashboardAlert,
  DashboardCampaignRow,
  DashboardInsight,
  DashboardOverview,
  FacetRollup,
  PortfolioRollup,
  TenantActivity,
  ToolImpactDailyPerformance,
  ToolImpactOverview,
  ToolImpactScope,
  TrendDelta,
  WindowMetrics,
} from './dashboard.types';
import {
  buildRawRoasOutcome,
  buildToolImpactCohort,
  campaignIsMature,
  classifyToolOwnership,
  durationStats,
  isVerifiedToolLaunch,
  TOOL_IMPACT_MATURITY_DAYS,
} from './tool-impact.helpers';

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
    @InjectModel(CampaignIntelligenceCycle.name)
    private readonly cycleModel: Model<CampaignIntelligenceCycle>,
    @InjectModel(ExecutedAction.name)
    private readonly executedActionModel: Model<ExecutedAction>,
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
      this.creativeModel
        .find({ tenantId })
        .select('status images video carouselCards')
        .lean()
        .exec(),
      this.decisionModel
        // 'pending' isn't a real DecisionStatus (see intelligence-decision.schema.ts) —
        // a decision sits in 'shadow_review' until a human approves/rejects it or it
        // expires. Querying the wrong string silently returned [] here, so the
        // "optimiser decisions waiting on you" tile always read 0.
        .find({ tenantId, status: 'shadow_review' })
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
      this.buildRow(
        c,
        econ,
        windowByCampaign,
        hasTimeseries,
        now,
        knownProducts,
      ),
    );

    // Rows that belong to THIS window. With real timeseries a campaign
    // qualifies if it spent inside the window regardless of launch date;
    // without it, launch date is the only filter available.
    const windowRows = hasTimeseries
      ? rows.filter(
          (r) =>
            r.spend > 0 ||
            r.status === 'active' ||
            r.status === 'pending_approval',
        )
      : rows.filter(
          (r) =>
            !r.launchedAt || new Date(r.launchedAt).getTime() >= from.getTime(),
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
      const product = parseCampaignName(
        c.name ?? c.topic,
        knownProducts,
      ).product;
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
        byFunnel: this.facetRollup(
          windowRows,
          econ,
          (r) => r.facets.funnelLabel,
        ),
        byBudgetModel: this.facetRollup(windowRows, econ, (r) =>
          r.facets.budgetModel.toUpperCase(),
        ),
        byLanguage: this.facetRollup(
          windowRows,
          econ,
          (r) => r.facets.language ?? 'unspecified',
        ),
        byObjective: this.facetRollup(
          windowRows,
          econ,
          (r) => r.objectiveLabel,
        ),
      },
      insights: this.buildInsights(company),
      activity,
    };
  }

  /**
   * Auditable product impact, isolated from campaigns created in Ads Manager.
   *
   * Default scope is deliberately `agent`: a dashboard-created campaign proves
   * that the product can launch safely, but it does not prove autonomous
   * research/creative/decision quality. `scope=managed` expands the operational
   * footprint to agent + human without ever admitting imported manual rows.
   */
  async getToolImpact(
    tenantId: string,
    scope: ToolImpactScope = 'agent',
  ): Promise<ToolImpactOverview> {
    const now = new Date();
    const econ = await this.economics.forTenant(tenantId);
    const [company, campaigns] = await Promise.all([
      this.companyModel.findOne({ tenantId }).lean().exec(),
      this.campaignModel.find({ tenantId }).lean().exec(),
    ]);

    const allCampaigns = campaigns as any[];
    const cohort = buildToolImpactCohort(
      allCampaigns,
      scope,
      now,
      TOOL_IMPACT_MATURITY_DAYS,
    );
    const launchedCampaigns = cohort.launched as any[];
    const exactCampaignIds = launchedCampaigns.map((c) => String(c._id));

    // Every downstream evidence query is joined to the exact verified-launch
    // campaign ids. A tenant-wide decision/cycle total would quietly credit
    // the tool for intelligence generated against marketing-team campaigns.
    const exactCampaignFilter = {
      tenantId,
      campaignId: { $in: exactCampaignIds },
    };

    const agentCampaigns = (cohort.selected as any[]).filter(
      (campaign) => classifyToolOwnership(campaign)?.actor === 'agent',
    );

    const [decisions, cycles, executedActions, pipelineRuns] =
      await Promise.all([
        exactCampaignIds.length
          ? this.decisionModel
              .find(exactCampaignFilter)
              .sort({ createdAt: -1 })
              .lean()
              .exec()
          : Promise.resolve([]),
        exactCampaignIds.length
          ? this.cycleModel
              .find(exactCampaignFilter)
              .select('campaignId startedAt completedAt status')
              .lean()
              .exec()
          : Promise.resolve([]),
        exactCampaignIds.length
          ? this.executedActionModel
              .find(exactCampaignFilter)
              .sort({ executedAt: -1 })
              .lean()
              .exec()
          : Promise.resolve([]),
        // Status totals must include persisted runs that died before creating
        // a Campaign document. A retry may update the same run record, so this
        // is explicitly a final/current record distribution—not attempt rate.
        this.runModel
          .find({ tenantId })
          .select(
            'runId status startedAt completedAt campaignId metaCampaignId',
          )
          .sort({ startedAt: -1 })
          .lean()
          .exec(),
      ]);

    const knownProducts: string[] = (
      ((company as any)?.products ?? []) as Array<{ name?: string }>
    )
      .map((p) => String(p?.name ?? '').trim())
      .filter(Boolean);

    // hasTimeseries=false is intentional: this evidence page declares its
    // metricsWindow as campaign-lifetime and shows freshness separately.
    const cohortRows = (cohort.selected as any[]).map((c) =>
      this.buildRow(c, econ, new Map(), false, now, knownProducts),
    );
    const launchedIdSet = new Set(exactCampaignIds);
    const rows = cohortRows.filter((row) => launchedIdSet.has(row.id));
    const authoritativeProductByMetaId = new Map(
      launchedCampaigns.map((campaign) => [
        String(campaign.metaCampaignId ?? ''),
        String(campaign.productName ?? '').trim(),
      ]),
    );
    const dailyPerformance = await this.loadToolImpactDailyPerformance(
      tenantId,
      rows.filter((row) => isKnownToolImpactRevenueObjective(row.objective)),
      authoritativeProductByMetaId,
    );
    const portfolio = this.rollUp(rows, econ);
    const rawOutcome = buildRawRoasOutcome(rows);
    const matureIdSet = new Set(
      (cohort.mature as any[]).map((campaign) => String(campaign._id)),
    );
    const matureRawOutcome = buildRawRoasOutcome(
      rows.filter((row) => matureIdSet.has(row.id)),
    );

    const byStatus: Record<string, number> = {};
    for (const c of launchedCampaigns) {
      byStatus[c.status ?? 'unknown'] =
        (byStatus[c.status ?? 'unknown'] ?? 0) + 1;
    }

    const topWinner =
      rows
        .filter((r) => r.isRevenueObjective && r.contributionProfit > 0)
        .sort((a, b) => b.contributionProfit - a.contributionProfit)[0] ?? null;
    const bestRawResult =
      rows
        .filter((r) => r.spend > 0)
        .sort(
          (a, b) => b.returnSurplus - a.returnSurplus || b.roas - a.roas,
        )[0] ?? null;

    const decisionsByStatus = {
      shadow_review: 0,
      approved: 0,
      rejected: 0,
      expired: 0,
    };
    const actionTypeCounts = new Map<string, number>();
    for (const d of decisions as any[]) {
      const status = d.status as keyof typeof decisionsByStatus;
      if (status in decisionsByStatus) decisionsByStatus[status]++;
      const actionType = String(d.actionType ?? 'unknown');
      actionTypeCounts.set(
        actionType,
        (actionTypeCounts.get(actionType) ?? 0) + 1,
      );
    }
    const openWithEstimate = (decisions as any[]).filter(
      (d) =>
        d.status === 'shadow_review' &&
        Number.isFinite(Number(d.expectedProfitDeltaINR7d)),
    );
    const highestExpected = openWithEstimate.length
      ? Math.max(
          ...openWithEstimate.map((d) => Number(d.expectedProfitDeltaINR7d)),
        )
      : null;
    const examples = openWithEstimate
      .sort(
        (a, b) =>
          Number(b.expectedProfitDeltaINR7d) -
          Number(a.expectedProfitDeltaINR7d),
      )
      .slice(0, 5)
      .map((d) => ({
        campaignName: d.campaignName ?? 'Unknown campaign',
        actionType: d.actionType,
        reasoning: d.reasoning ?? '',
        expectedProfitDeltaINR7d: round(Number(d.expectedProfitDeltaINR7d), 2),
        isModelEstimate: true as const,
        status: d.status,
      }));

    const outcomesByLabel = {
      improved: 0,
      worsened: 0,
      neutral: 0,
      inconclusive: 0,
    };
    for (const action of executedActions as any[]) {
      const label = action.outcomeLabel as keyof typeof outcomesByLabel;
      if (label in outcomesByLabel) outcomesByLabel[label]++;
    }
    const finalized72h = (executedActions as any[]).filter(
      (a) => a.status === 'final',
    ).length;
    const conclusive72h =
      outcomesByLabel.improved +
      outcomesByLabel.worsened +
      outcomesByLabel.neutral;
    const latestExecutedAt = (executedActions as any[])
      .map((a) => a.executedAt)
      .filter((at) => isFiniteDate(at))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

    const campaignsWatched = new Set(
      (cycles as any[]).map((c) => String(c.campaignId)),
    ).size;
    const lastCycleAt = (cycles as any[])
      .map((c) => c.completedAt ?? c.startedAt)
      .filter((at) => isFiniteDate(at))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

    const agentById = new Map(
      agentCampaigns.map((campaign) => [String(campaign._id), campaign]),
    );
    const agentByRunId = new Map(
      agentCampaigns
        .filter((campaign) => String(campaign.runId ?? '').trim())
        .map((campaign) => [String(campaign.runId), campaign]),
    );
    const agentByMetaId = new Map(
      agentCampaigns
        .filter((campaign) => String(campaign.metaCampaignId ?? '').trim())
        .map((campaign) => [String(campaign.metaCampaignId), campaign]),
    );
    const joinedRuns = (pipelineRuns as any[])
      .map((run) => ({
        run,
        campaign:
          agentById.get(String(run.campaignId ?? '')) ??
          agentByRunId.get(String(run.runId ?? '')) ??
          agentByMetaId.get(String(run.metaCampaignId ?? '')),
      }))
      .filter((joined) => joined.campaign != null);
    const runCompleted = (pipelineRuns as any[]).filter(
      (run) => run.status === 'completed',
    ).length;
    const runFailed = (pipelineRuns as any[]).filter(
      (run) => run.status === 'failed',
    ).length;
    const approvalReadyDurations = joinedRuns
      .map(({ run, campaign }) =>
        hoursBetween(run.startedAt, campaign.createdAt),
      )
      .filter((duration): duration is number => duration != null);
    const liveDurations = joinedRuns
      .map(({ run, campaign }) =>
        hoursBetween(run.startedAt, campaign.launchedAt),
      )
      .filter((duration): duration is number => duration != null);

    const spendingLaunches = launchedCampaigns.filter(
      (campaign) => num(campaign.spend) > 0,
    );
    // `syncedAt` only proves that a sync process touched the document. A
    // failed Meta insights fetch can update syncedAt while preserving old
    // metrics, so it must never make financial evidence appear fresh.
    const freshnessDates = spendingLaunches
      .map((campaign) => campaign.dataAsOf)
      .filter((at) => isFiniteDate(at))
      .map((at) => new Date(at));
    const freshnessPopulation = spendingLaunches.length;
    // A completed/paused campaign naturally has an old final coverage date;
    // ongoing staleness is actionable only for campaigns that are still live.
    const staleCampaigns = spendingLaunches.filter((campaign) => {
      if (campaign.status !== 'active' || !isFiniteDate(campaign.dataAsOf)) {
        return false;
      }
      return (
        (now.getTime() - new Date(campaign.dataAsOf).getTime()) / 36e5 >
        STALE_METRICS_HOURS
      );
    }).length;
    const campaignsWithoutFreshness =
      freshnessPopulation - freshnessDates.length;
    const freshnessStatus: ToolImpactOverview['freshness']['status'] =
      freshnessDates.length === 0
        ? 'unknown'
        : staleCampaigns > 0 || campaignsWithoutFreshness > 0
          ? 'partially_stale'
          : 'fresh';
    const freshnessMs = freshnessDates.map((at) => at.getTime());

    const includedSources: Array<'agent' | 'human'> =
      scope === 'managed' ? ['agent', 'human'] : ['agent'];
    const methodologyWarnings = [
      'Attributed-action-value ROAS here means persisted attributed action value divided by ad spend. A value at or above 1.0x only says that attributed action value met or exceeded ad spend; it does not prove collected cash or include COGS, fulfilment, payment fees, tax, or operating costs.',
      'Return provenance is disclosed per campaign: Meta-reported action_value for the configured conversion action (refund-adjusted where configured), Meta-attributed conversions multiplied by configured product value, no attributed return, or unknown derivation. Meta action_value can represent a purchase or an assigned value for another conversion; it is not proof of collected cash.',
      'Persisted attributed return is not reconciled company-ledger cash. Reconcile unknown rows and any external founder claim with Ads Manager and your order ledger.',
      'Figures are campaign-lifetime totals and Meta can revise recent attribution. Check freshness before quoting them.',
      'The daily chart contains only persisted campaign-day rows for verified sales launches; missing dates are omitted, not filled with zero. Legacy daily return without product-scoped provenance is disclosed separately and never counted as verified attributed return.',
      'A daily return row is verified only when its product came from an exact persisted Campaign.productName match and its Meta fetch completed. The configuration fingerprint records the conversion/value config used at sync time; this page validates its presence and shape, not equality with today’s product config.',
      'Observed post-action outcomes are before/after measurements, not randomized causal proof.',
      'Executed-action outcomes are scoped to these campaign IDs, but legacy outcome records do not contain intelligence decision IDs. They are a campaign-level action track record, not a one-to-one audit of the proposals displayed above.',
      'Pipeline status includes every persisted run record, including records that failed before campaign creation. Retries can reuse and update a run record, so this is a current/final run-record distribution—not a per-attempt success rate. Duration statistics include only records joinable to an agent campaign; approval-ready time uses campaign.createdAt as the persisted proxy.',
    ];

    return {
      tenantId,
      generatedAt: now.toISOString(),
      scope: {
        requested: scope,
        includedSources,
        label:
          scope === 'agent'
            ? 'AI-launched campaigns'
            : 'All campaigns launched through Meridian',
        cohortRule:
          scope === 'agent'
            ? "actor=agent from persisted source='agent'; impact metrics require a verified Meta launch"
            : "actor=agent/human from persisted source='agent' or source='human'; impact metrics require a verified Meta launch",
      },
      methodology: {
        version: 'attributed_action_value_roas_v1',
        headlineMetric: 'attributed_action_value_roas',
        revenueLabel:
          'Persisted attributed return, with observed, configured-estimate, zero-return, or unknown derivation disclosed per campaign',
        actionValueRoasFormula: 'sum(attributedReturn) / sum(adSpend)',
        returnSurplusFormula: 'sum(attributedReturn) - sum(adSpend)',
        thresholdRule: 'weighted attributed-action-value ROAS >= 1.0x',
        verifiedLaunchRule:
          "tool ownership is recorded in persisted source='agent' or source='human' AND metaCampaignId is non-empty AND launchedAt is valid",
        maturityRule: `verified launch AND spend > 0 AND at least ${TOOL_IMPACT_MATURITY_DAYS} days since launchedAt`,
        metricsWindow: 'campaign-lifetime',
        warnings: methodologyWarnings,
      },
      cohort: {
        ...cohort.summary,
        campaigns: cohortRows,
      },
      freshness: {
        latestMetricsAt: freshnessMs.length
          ? new Date(Math.max(...freshnessMs)).toISOString()
          : null,
        oldestMetricsAt: freshnessMs.length
          ? new Date(Math.min(...freshnessMs)).toISOString()
          : null,
        campaignsWithKnownFreshness: freshnessDates.length,
        campaignsWithoutFreshness,
        staleCampaigns,
        staleAfterHours: STALE_METRICS_HOURS,
        status: freshnessStatus,
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
      dailyPerformance,
      automation: {
        pipelineRuns: {
          total: pipelineRuns.length,
          completed: runCompleted,
          failed: runFailed,
          inProgress: pipelineRuns.length - runCompleted - runFailed,
          completionRatePct:
            pipelineRuns.length > 0
              ? round((runCompleted / pipelineRuns.length) * 100, 1)
              : 0,
          failureRatePct:
            pipelineRuns.length > 0
              ? round((runFailed / pipelineRuns.length) * 100, 1)
              : 0,
        },
        timeToApprovalReady: durationStats(
          approvalReadyDurations,
          'PipelineRun.startedAt → Campaign.createdAt (approval-ready proxy)',
        ),
        timeToLive: durationStats(
          liveDurations,
          'PipelineRun.startedAt → Campaign.launchedAt',
        ),
        cyclesRun: cycles.length,
        cyclesCompleted: (cycles as any[]).filter(
          (cycle) => cycle.status === 'completed',
        ).length,
        cyclesFailed: (cycles as any[]).filter(
          (cycle) => cycle.status === 'failed',
        ).length,
        campaignsWatched,
        lastCycleAt: lastCycleAt ? new Date(lastCycleAt).toISOString() : null,
        cadenceLabel: 'Scheduled automatically — plus on demand',
      },
      diagnosis: {
        decisionsProposed: decisions.length,
        decisionFunnel: {
          proposed: decisions.length,
          open: decisionsByStatus.shadow_review,
          approved: decisionsByStatus.approved,
          rejected: decisionsByStatus.rejected,
          expired: decisionsByStatus.expired,
          executed: (decisions as any[]).filter((d) =>
            isFiniteDate(d.executedAt),
          ).length,
          executionFailed: (decisions as any[]).filter((d) =>
            Boolean(String(d.executionError ?? '').trim()),
          ).length,
        },
        byStatus: decisionsByStatus,
        byActionType: [...actionTypeCounts.entries()]
          .map(([actionType, count]) => ({ actionType, count }))
          .sort((a, b) => b.count - a.count),
        modelEstimates: {
          label: 'Model estimate — not realized return',
          openDecisionsWithEstimate: openWithEstimate.length,
          highestExpectedProfitDeltaINR7d:
            highestExpected == null ? null : round(highestExpected, 2),
          areSummed: false,
          notSummedReason:
            'Open recommendations can be alternatives or affect the same budget, so adding them would double-count hypothetical value.',
        },
        observedOutcomes: {
          label: 'Observed post-action outcomes — not causal proof',
          recorded: executedActions.length,
          awaiting24h: (executedActions as any[]).filter(
            (a) => a.status === 'pending',
          ).length,
          measured24h: (executedActions as any[]).filter((a) =>
            Boolean(a.metricsAtT24h),
          ).length,
          finalized72h,
          conclusive72h,
          byLabel: outcomesByLabel,
          improvedRatePct:
            conclusive72h > 0
              ? round((outcomesByLabel.improved / conclusive72h) * 100, 1)
              : null,
          latestExecutedAt: latestExecutedAt
            ? new Date(latestExecutedAt).toISOString()
            : null,
        },
        examples,
      },
      launched: {
        totalCampaigns: launchedCampaigns.length,
        byStatus,
        withSpend: cohort.withSpend.length,
        mature: cohort.mature.length,
        rawOutcome,
        matureRawOutcome,
        portfolio,
        topWinner,
        bestRawResult,
        campaigns: rows,
      },
    };
  }

  // ─── Metrics loading ───────────────────────────────────────────────────

  /**
   * Daily evidence for the exact verified sales-launch cohort. The campaign
   * documents remain the lifetime source of truth above; this method exposes
   * only real persisted campaign-day rows and never manufactures missing
   * dates. Rows written before product-scoped attribution was introduced are
   * still valid spend observations, but their return is deliberately withheld.
   */
  private async loadToolImpactDailyPerformance(
    tenantId: string,
    salesCampaigns: DashboardCampaignRow[],
    authoritativeProductByMetaId: ReadonlyMap<string, string>,
  ): Promise<ToolImpactDailyPerformance> {
    const calculationVersion = 'product_scoped_v1' as const;
    const metaCampaignIds = [
      ...new Set(
        salesCampaigns
          .map((campaign) => String(campaign.metaCampaignId ?? '').trim())
          .filter(Boolean),
      ),
    ];
    const lifetimeSpend = round(
      sum(salesCampaigns.map((campaign) => campaign.spend)),
      2,
    );
    const lifetimeAttributedReturn = round(
      sum(salesCampaigns.map((campaign) => campaign.revenue)),
      2,
    );
    const empty = (
      warning: string | null,
      observedAbsenceConfirmed = false,
    ): ToolImpactDailyPerformance => ({
      source: 'metric_timeseries_campaign_daily',
      dateBasis: 'meta_ad_account_date_start',
      cohort: 'verified_sales_launches',
      calculationVersion,
      coverage: {
        status: 'none',
        eligibleCampaigns: metaCampaignIds.length,
        campaignsWithRows: 0,
        campaignsWithoutRows: metaCampaignIds.length,
        observedDates: 0,
        campaignDateRows: 0,
        firstDate: null,
        lastDate: null,
        observedSpend: 0,
        lifetimeSpend,
        spendCoveragePct:
          observedAbsenceConfirmed && lifetimeSpend > 0 ? 0 : null,
        observedPersistedAttributedReturn: 0,
        lifetimeAttributedReturn,
      },
      returnCoverage: {
        status: 'none',
        trustedRows: 0,
        untrustedRows: 0,
        campaignsWithTrustedRows: 0,
        legacyRowsExcludedFromReturn: 0,
        warning,
      },
      series: [],
    });

    if (metaCampaignIds.length === 0) {
      return empty(
        'No verified sales launches are available for a daily series.',
      );
    }

    let rows: any[];
    try {
      rows = (await this.timeseriesModel
        .find({
          tenantId,
          level: 'campaign',
          metaCampaignId: { $in: metaCampaignIds },
        })
        .select(
          'metaCampaignId date spend revenue revenueBasis revenueAttributionSource revenueAttributionActionTypes revenueCalculationVersion revenueFetchCompleteness campaignProductName resolvedProductName productResolutionEvidence revenueConfigFingerprint',
        )
        .sort({ date: 1 })
        .lean()
        .exec()) as any[];
    } catch (err: any) {
      this.logger.warn(
        `Tool impact daily series failed for ${tenantId}: ${err.message}`,
      );
      return empty('Persisted daily rows could not be loaded.');
    }

    const exactMetaIds = new Set(metaCampaignIds);
    const validRows = rows.filter(
      (row) =>
        exactMetaIds.has(String(row.metaCampaignId ?? '')) &&
        isValidDateKey(String(row.date ?? '')),
    );
    if (validRows.length === 0) {
      return empty(
        'No persisted daily rows exist for the verified sales cohort.',
        true,
      );
    }

    const rowIsReturnTrusted = (row: any): boolean => {
      return isTrustedProductScopedTimeseriesRevenue(
        row,
        authoritativeProductByMetaId.get(String(row.metaCampaignId ?? '')),
      );
    };

    type DayAccumulator = {
      spend: number;
      knownAttributedReturn: number;
      persistedAttributedReturn: number;
      rows: number;
      trustedRows: number;
      campaigns: Set<string>;
      trustedCampaigns: Set<string>;
    };
    const byDate = new Map<string, DayAccumulator>();
    const campaignsWithRows = new Set<string>();
    const campaignsWithTrustedRows = new Set<string>();
    let trustedRows = 0;
    let legacyRowsExcludedFromReturn = 0;

    for (const row of validRows) {
      const metaCampaignId = String(row.metaCampaignId);
      const date = String(row.date);
      const trusted = rowIsReturnTrusted(row);
      const day = byDate.get(date) ?? {
        spend: 0,
        knownAttributedReturn: 0,
        persistedAttributedReturn: 0,
        rows: 0,
        trustedRows: 0,
        campaigns: new Set<string>(),
        trustedCampaigns: new Set<string>(),
      };
      day.spend += num(row.spend);
      day.persistedAttributedReturn += num(row.revenue);
      day.rows++;
      day.campaigns.add(metaCampaignId);
      campaignsWithRows.add(metaCampaignId);
      if (trusted) {
        day.knownAttributedReturn += num(row.revenue);
        day.trustedRows++;
        day.trustedCampaigns.add(metaCampaignId);
        campaignsWithTrustedRows.add(metaCampaignId);
        trustedRows++;
      } else if (row.revenueCalculationVersion !== calculationVersion) {
        legacyRowsExcludedFromReturn++;
      }
      byDate.set(date, day);
    }

    const series = [...byDate.entries()].map(([date, day]) => {
      const returnCoverage: 'complete' | 'partial' | 'none' =
        day.trustedRows === day.rows
          ? 'complete'
          : day.trustedRows > 0
            ? 'partial'
            : 'none';
      const attributedReturn =
        returnCoverage === 'complete'
          ? round(day.knownAttributedReturn, 2)
          : null;
      return {
        date,
        spend: round(day.spend, 2),
        attributedReturn,
        knownAttributedReturn: round(day.knownAttributedReturn, 2),
        persistedAttributedReturn: round(day.persistedAttributedReturn, 2),
        weightedRoas:
          attributedReturn != null && day.spend > 0
            ? round(attributedReturn / day.spend, 6)
            : null,
        campaignsReporting: day.campaigns.size,
        trustedReturnCampaigns: day.trustedCampaigns.size,
        returnCoverage,
      };
    });
    const untrustedRows = validRows.length - trustedRows;
    const observedSpend = round(sum(validRows.map((row) => num(row.spend))), 2);
    const observedPersistedAttributedReturn = round(
      sum(validRows.map((row) => num(row.revenue))),
      2,
    );
    const spendReconciliationTolerance = Math.max(1, lifetimeSpend * 0.001);
    const spendReconciles =
      Math.abs(observedSpend - lifetimeSpend) <= spendReconciliationTolerance;
    const coverageStatus: 'complete' | 'partial' =
      campaignsWithRows.size === metaCampaignIds.length && spendReconciles
        ? 'complete'
        : 'partial';
    const returnCoverageStatus: 'complete' | 'partial' | 'none' =
      trustedRows === validRows.length
        ? 'complete'
        : trustedRows > 0
          ? 'partial'
          : 'none';

    return {
      source: 'metric_timeseries_campaign_daily',
      dateBasis: 'meta_ad_account_date_start',
      cohort: 'verified_sales_launches',
      calculationVersion,
      coverage: {
        status: coverageStatus,
        eligibleCampaigns: metaCampaignIds.length,
        campaignsWithRows: campaignsWithRows.size,
        campaignsWithoutRows: metaCampaignIds.length - campaignsWithRows.size,
        observedDates: series.length,
        campaignDateRows: validRows.length,
        firstDate: series[0]?.date ?? null,
        lastDate: series[series.length - 1]?.date ?? null,
        observedSpend,
        lifetimeSpend,
        spendCoveragePct:
          lifetimeSpend > 0
            ? round((observedSpend / lifetimeSpend) * 100, 1)
            : null,
        observedPersistedAttributedReturn,
        lifetimeAttributedReturn,
      },
      returnCoverage: {
        status: returnCoverageStatus,
        trustedRows,
        untrustedRows,
        campaignsWithTrustedRows: campaignsWithTrustedRows.size,
        legacyRowsExcludedFromReturn,
        warning:
          untrustedRows > 0
            ? `${untrustedRows} campaign-day row(s) lack verified product-scoped return provenance. Their spend is shown, but their return is excluded from attributedReturn.`
            : null,
      },
      series,
    };
  }

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
    const parsedFacets = parseCampaignName(c.name ?? c.topic, knownProducts);
    const explicitProductName = String(c.productName ?? '').trim();
    // campaign.productName is set from the selected product at creation and is
    // authoritative. Name parsing exists only for legacy rows where that field
    // predates the campaign — never let a naming heuristic override explicit
    // provenance on the impact page (or any other dashboard surface).
    const facets = explicitProductName
      ? {
          ...parsedFacets,
          product: explicitProductName,
          matched: [
            ...parsedFacets.matched.filter(
              (match) => !match.startsWith('product:'),
            ),
            `product:${explicitProductName}`,
          ],
        }
      : parsedFacets;
    // Judge this campaign against ITS product's margin, not the account's
    // headline one. Falls back to the headline when the campaign name could
    // not be attributed to a configured product.
    const econ = this.economics.forProduct(tenantEcon, facets.product);
    const windowed = hasTimeseries
      ? (windowByCampaign.get(String(c.metaCampaignId ?? '')) ?? emptyRaw())
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
    const revenueDerivedFromLegacyRoas =
      windowed.revenue <= 0 && num(c.roas) > 0 && spend > 0;
    const revenue =
      windowed.revenue > 0
        ? windowed.revenue
        : revenueDerivedFromLegacyRoas
          ? num(c.roas) * spend
          : 0;

    const launchedAt = isFiniteDate(c.launchedAt)
      ? new Date(c.launchedAt)
      : null;
    const endedAt = isFiniteDate(c.stopTime) ? new Date(c.stopTime) : null;
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
    const returnSurplus = revenue - spend;
    const roundedReturnSurplus = round(returnSurplus, 2);
    const rawRoasVerdict: DashboardCampaignRow['rawRoasVerdict'] =
      !evaluation.isRevenueObjective
        ? 'not_applicable'
        : spend <= 0
          ? 'no_spend'
          : roundedReturnSurplus === 0
            ? 'break_even'
            : roundedReturnSurplus > 0
              ? 'returned_more_than_spend'
              : 'returned_less_than_spend';
    const toolOwnership = classifyToolOwnership(c);
    const verifiedToolLaunch = isVerifiedToolLaunch(c);
    const toolImpactStage: DashboardCampaignRow['toolImpactStage'] =
      !toolOwnership
        ? 'outside_scope'
        : !verifiedToolLaunch
          ? 'created_unverified'
          : spend <= 0
            ? 'verified_zero_spend'
            : campaignIsMature(c, now, TOOL_IMPACT_MATURITY_DAYS)
              ? 'mature'
              : 'with_spend_immature';

    const dataAsOf = isFiniteDate(c.dataAsOf) ? new Date(c.dataAsOf) : null;
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
      source: c.source ?? 'manual',
      toolOwnership,

      spend: round(spend, 2),
      revenue: round(revenue, 2),
      revenueBasis: revenueDerivedFromLegacyRoas
        ? 'unknown'
        : c.revenueBasis === 'meta_action_value' ||
            c.revenueBasis === 'configured_conversion_value' ||
            c.revenueBasis === 'no_attributed_revenue'
          ? c.revenueBasis
          : 'unknown',
      revenueAttributionSource: c.revenueAttributionSource ?? 'unknown',
      revenueAttributionActionTypes: Array.isArray(
        c.revenueAttributionActionTypes,
      )
        ? c.revenueAttributionActionTypes
        : [],
      roas: round(roas, 6),
      returnSurplus: roundedReturnSurplus,
      isRawRoasProfitable:
        evaluation.isRevenueObjective && spend > 0
          ? roundedReturnSurplus >= 0
          : null,
      rawRoasVerdict,
      toolImpactStage,
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
        evaluation.isRevenueObjective && profit < 0
          ? round(Math.abs(profit), 2)
          : 0,

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
          suggestedAction:
            r.nextAction ?? 'Refresh creative or narrow the audience.',
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
        accountCount:
          (meta?.accountIds ?? []).length || (meta?.accountId ? 1 : 0),
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
        failedInWindow: runsInWindow.filter((r) => r.status === 'failed')
          .length,
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

const TOOL_IMPACT_REVENUE_OBJECTIVES = new Set([
  'OUTCOME_SALES',
  'SALES',
  'CONVERSIONS',
  'OUTCOME_CONVERSIONS',
  'PRODUCT_CATALOG_SALES',
  'CATALOG_SALES',
  'OUTCOME_CATALOG_SALES',
  'RETARGETING',
  'RETARGETING_SALES',
]);

/**
 * Deliberately stricter than the global dashboard evaluator, whose historical
 * compatibility fallback treats an unmapped objective as sales. Founder
 * evidence admits only an explicit, known revenue objective.
 */
function isKnownToolImpactRevenueObjective(value: unknown): boolean {
  return TOOL_IMPACT_REVENUE_OBJECTIVES.has(
    String(value ?? '')
      .trim()
      .toUpperCase(),
  );
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

function isFiniteDate(value: unknown): boolean {
  if (!value) return false;
  return Number.isFinite(new Date(value as Date | string).getTime());
}

function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && toDateKey(date) === value;
}

function hoursBetween(start: unknown, end: unknown): number | null {
  if (!isFiniteDate(start) || !isFiniteDate(end)) return null;
  const duration =
    (new Date(end as Date | string).getTime() -
      new Date(start as Date | string).getTime()) /
    36e5;
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
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
