import { ObjectiveVerdict } from './objective-evaluation';
import { CampaignFacets } from './campaign-name.parser';

/**
 * The complete tenant picture, computed server-side.
 *
 * Design rule: the dashboard RENDERS, it does not CALCULATE. Every number a
 * user can see is derived here, against the tenant's real margin, so the same
 * verdict appears on every surface. The previous split — frontend doing its
 * own arithmetic over a raw campaign list — produced two tiles that disagreed
 * with each other (an unweighted mean ROAS of 0.92 next to a total-derived
 * "money earned" implying 0.99) and health thresholds hardcoded to a 1.5x
 * target that had nothing to do with this tenant's economics.
 */

export type AlertSeverity = 'critical' | 'warning' | 'info';

export type AlertKind =
  | 'meta_disconnected'
  | 'no_margin_configured'
  | 'budget_cap_misconfigured'
  | 'zero_conversion_spend'
  | 'portfolio_below_breakeven'
  | 'campaign_losing_badly'
  | 'learning_limited'
  | 'stale_metrics'
  | 'pending_approvals'
  | 'pending_actions'
  | 'objective_off_target'
  | 'pipeline_stalled';

export interface DashboardAlert {
  kind: AlertKind;
  severity: AlertSeverity;
  /** One-line plain-English statement of the problem. */
  title: string;
  /** Why it matters, with the numbers that triggered it. */
  detail: string;
  /** Money implicated, when the alert is financial. */
  amount?: number;
  /** What to actually do about it. */
  suggestedAction?: string;
  /** Dashboard route this alert should link to. */
  href?: string;
  campaignId?: string;
  campaignName?: string;
}

export interface WindowMetrics {
  spend: number;
  revenue: number;
  /** Spend-weighted, never an unweighted mean of per-campaign ROAS. */
  roas: number;
  conversions: number;
  clicks: number;
  impressions: number;
  ctr: number;
  cvr: number;
  cpc: number;
  cpm: number;
  aov: number;
  cac: number;
  /** revenue x margin - spend. The number that sums correctly. */
  contributionProfit: number;
  campaignCount: number;
}

export interface PortfolioRollup extends WindowMetrics {
  isProfitable: boolean;
  /** roas - breakevenROAS. Negative means every rupee destroys value. */
  gapToBreakeven: number;
  /** roas / targetROAS, as a 0-1+ fraction. */
  pctOfTarget: number;
  /** Spend sitting in campaigns below breakeven. */
  spendBelowBreakeven: number;
  pctSpendBelowBreakeven: number;
  /** Total contribution lost by below-breakeven campaigns only. */
  moneyAtRisk: number;
  campaignsBelowBreakeven: number;
  /** Spend across EVERY objective, including non-revenue ones. */
  totalSpendAllObjectives: number;
  /** Spend on awareness / traffic / app / engagement objectives. */
  nonRevenueSpend: number;
  nonRevenueCampaigns: number;
  nonRevenueOffTarget: number;
}

export interface TrendDelta {
  spendPct: number | null;
  revenuePct: number | null;
  roasPct: number | null;
  contributionAbs: number;
  direction: 'improving' | 'declining' | 'flat';
}

export interface KpiReading {
  key: string;
  label: string;
  value: number;
  display: string;
  target: number | null;
  targetDisplay: string | null;
  direction: 'higher_better' | 'lower_better';
  status: 'good' | 'watch' | 'bad' | 'neutral';
}

export interface DashboardCampaignRow {
  id: string;
  name: string;
  /** Name with date stamps and structural tokens stripped. */
  displayName: string;
  status: string;
  statusLabel: string;
  metaCampaignId?: string;

  spend: number;
  revenue: number;
  roas: number;
  conversions: number;
  clicks: number;
  impressions: number;
  ctr: number;
  cvr: number;

  contributionProfit: number;
  /** roas - breakevenROAS for this campaign. */
  gapToBreakeven: number;
  /** This campaign's OWN product economics — products can differ. */
  breakevenROAS: number;
  targetROAS: number;
  marginPct: number;
  /** Currency amount above/below the breakeven line — the sort key. */
  moneyAtRisk: number;

  /** Raw Meta objective string, e.g. OUTCOME_AWARENESS. */
  objective: string;
  objectiveKey: string;
  objectiveLabel: string;
  /** False for awareness/traffic/app/engagement — ROAS is not their yardstick. */
  isRevenueObjective: boolean;
  /** The KPI this campaign is actually judged on, with its own target. */
  primaryKpi: KpiReading;
  costPerResult: number | null;
  costPerResultDisplay: string | null;

  verdict: ObjectiveVerdict;
  verdictLabel: string;
  severity: 'good' | 'watch' | 'bad' | 'neutral';
  /** Distinguishes "nothing to do here" from "we can't tell yet". */
  isActionable: boolean;
  nextAction: string | null;

  facets: CampaignFacets;

  launchedAt: string | null;
  endedAt: string | null;
  daysRunning: number | null;
  ageHours: number | null;

  budget: number;
  spendCap: number;
  /** Set when daily budget x planned days overruns the hard cap. */
  capRisk: {
    dailyBudget: number;
    plannedDays: number;
    projectedSpend: number;
    cap: number;
    overrunBy: number;
  } | null;

  learningStage: string | null;
  learningStageLabel: string | null;

  /** Freshness of the metrics behind this row. */
  dataAsOf: string | null;
  dataAgeHours: number | null;
  isStale: boolean;
}

export interface FacetRollup {
  key: string;
  label: string;
  campaignCount: number;
  spend: number;
  revenue: number;
  roas: number;
  contributionProfit: number;
  isProfitable: boolean;
  /** Share of total account spend, 0-1. */
  spendShare: number;
}

export interface DashboardInsight {
  id: string;
  finding: string;
  confidence: number;
  dataPoints: number;
  /** Low-n findings are rendered with less visual weight than facts. */
  strength: 'strong' | 'moderate' | 'weak';
  category: string | null;
  recommendation: string | null;
  createdAt: string | null;
}

export interface TenantActivity {
  meta: {
    connected: boolean;
    accountId: string | null;
    businessId: string | null;
    accountCount: number;
    pixelId: string | null;
    pageId: string | null;
  };
  pipeline: {
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunId: string | null;
    runsInWindow: number;
    runningNow: number;
    failedInWindow: number;
  };
  creatives: {
    total: number;
    ready: number;
    producing: number;
    failed: number;
    allRejected: number;
  };
  queue: {
    pendingApprovalCampaigns: number;
    pendingActions: number;
    pendingDecisions: number;
  };
  sync: {
    lastSyncAt: string | null;
    stalestCampaignHours: number | null;
    staleCampaignCount: number;
  };
}

export interface DashboardEconomics {
  productName: string | null;
  marginPct: number;
  refundPct: number;
  netMarginPct: number;
  breakevenROAS: number;
  targetROAS: number;
  method: 'product-config' | 'generic-default';
  /** True when breakeven rests on a guessed margin — UI must caveat it. */
  isEstimated: boolean;
  /** True when products differ enough that one headline breakeven misleads. */
  hasMixedMargins: boolean;
  byProduct: Array<{
    productName: string | null;
    marginPct: number;
    breakevenROAS: number;
    targetROAS: number;
  }>;
  notes: string[];
}

export interface DashboardOverview {
  tenantId: string;
  companyName: string | null;
  industry: string | null;
  generatedAt: string;

  window: {
    days: number;
    from: string;
    to: string;
    label: string;
    /**
     * 'timeseries' = genuinely windowed from daily MetricTimeseries rows.
     * 'campaign-lifetime' = timeseries not synced, so figures are each
     * campaign's lifetime total filtered to campaigns launched in the window.
     * The UI must say which, because the second is NOT a time slice and
     * silently presenting it as one is how a lifetime total ends up stacked
     * next to a 10-day table as though they were the same period.
     */
    metricsSource: 'timeseries' | 'campaign-lifetime';
  };

  economics: DashboardEconomics;

  /** Window-scoped rollup — what the campaign table below actually sums to. */
  portfolio: PortfolioRollup;
  /** All-time totals, explicitly labelled so the two are never confused. */
  lifetime: WindowMetrics & { isProfitable: boolean };
  /** Same window, immediately preceding period. Null when history is short. */
  previous: WindowMetrics | null;
  trend: TrendDelta | null;

  alerts: DashboardAlert[];
  campaigns: DashboardCampaignRow[];

  facets: {
    byProduct: FacetRollup[];
    byFunnel: FacetRollup[];
    byBudgetModel: FacetRollup[];
    byLanguage: FacetRollup[];
    byObjective: FacetRollup[];
  };

  insights: DashboardInsight[];
  activity: TenantActivity;
}
