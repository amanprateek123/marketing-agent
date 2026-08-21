import { ObjectiveVerdict } from './objective-evaluation';
import { CampaignFacets } from './campaign-name.parser';
import type {
  CampaignRevenueAttributionSource,
  CampaignRevenueBasis,
} from '../campaigns/schemas/campaign.schema';

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
  /** 'agent' | 'human' | 'manual' — see isManagedCampaignSource for what this gates. */
  source: string;
  /** How this record qualifies for the Agent Achievement cohort, if at all. */
  toolOwnership: ToolImpactOwnership | null;

  spend: number;
  revenue: number;
  revenueBasis: CampaignRevenueBasis;
  revenueAttributionSource: CampaignRevenueAttributionSource;
  revenueAttributionActionTypes: string[];
  roas: number;
  /** Meta-attributed revenue minus ad spend. No product-margin adjustment. */
  returnSurplus: number;
  /**
   * Raw ad-spend-return verdict for sales objectives. Null means ROAS is not
   * an applicable/observable yardstick (non-sales objective or no spend).
   */
  isRawRoasProfitable: boolean | null;
  rawRoasVerdict:
    | 'returned_more_than_spend'
    | 'break_even'
    | 'returned_less_than_spend'
    | 'no_spend'
    | 'not_applicable';
  /** Server-authoritative membership stage for the Agent Achievement ledger. */
  toolImpactStage:
    | 'outside_scope'
    | 'created_unverified'
    | 'verified_zero_spend'
    | 'with_spend_immature'
    | 'mature';
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

/**
 * What THIS TOOL has actually done, as opposed to the account-wide picture in
 * DashboardOverview (which includes campaigns the marketing team runs in Meta
 * directly and this system has never touched). Defaults to autonomous
 * `agent` campaigns; callers can request `managed` to include dashboard-
 * authored `human` campaigns. Imported `manual` campaigns never belong here
 * unless their strict legacy AGENT_<topic>_<date> launch marker identifies a
 * pre-source-field autonomous launch; that weaker evidence stays disclosed.
 */
export type ToolImpactScope = 'agent' | 'managed';

export type ToolImpactOwnershipEvidence =
  | 'persisted_agent_source'
  | 'persisted_human_source'
  | 'legacy_agent_name';

export interface ToolImpactOwnership {
  actor: 'agent' | 'human';
  evidence: ToolImpactOwnershipEvidence;
  /** Legacy names are deterministic evidence, but weaker than a stored source. */
  confidence: 'recorded' | 'name_inferred';
}

export interface ToolImpactDurationStats {
  sampleSize: number;
  medianHours: number | null;
  p90Hours: number | null;
  /** Exact timestamp pair used; prevents a proxy being presented as fact. */
  basis: string;
}

export interface ToolImpactCohortStageCounts {
  created: number;
  launched: number;
  withSpend: number;
  mature: number;
}

export interface ToolImpactRawOutcome {
  /** Every verified launch in the requested tool-owned cohort. */
  campaigns: number;
  /** The measured population used for both numerator and denominator. */
  campaignsWithSpend: number;
  spend: number;
  attributedReturn: number;
  revenueBasis: Array<{
    basis: CampaignRevenueBasis;
    campaignCount: number;
    spend: number;
    revenue: number;
    weightedRoas: number;
  }>;
  containsModeledOrUnknownRevenue: boolean;
  weightedRoas: number;
  returnSurplus: number;
  returnPosition: 'above' | 'equal' | 'below' | 'no_spend';
  /** True only when persisted attributed action value >= ad spend. */
  metOneXActionValueThreshold: boolean;
  thresholdRule: 'weighted_attributed_roas_gte_1';
  nonSalesCampaigns: number;
  nonSalesSpend: number;
}

export interface ToolImpactOverview {
  tenantId: string;
  generatedAt: string;

  scope: {
    requested: ToolImpactScope;
    includedSources: Array<'agent' | 'human'>;
    label: string;
    /** The exact predicate represented by all impact figures below. */
    cohortRule: string;
  };

  methodology: {
    version: 'attributed_action_value_roas_v1';
    headlineMetric: 'attributed_action_value_roas';
    revenueLabel: string;
    actionValueRoasFormula: 'sum(attributedReturn) / sum(adSpend)';
    returnSurplusFormula: 'sum(attributedReturn) - sum(adSpend)';
    thresholdRule: 'weighted attributed-action-value ROAS >= 1.0x';
    verifiedLaunchRule: string;
    maturityRule: string;
    metricsWindow: 'campaign-lifetime';
    warnings: string[];
  };

  cohort: ToolImpactCohortStageCounts & {
    maturityDays: number;
    bySource: {
      agent: ToolImpactCohortStageCounts;
      human: ToolImpactCohortStageCounts;
    };
    ownershipEvidence: {
      persistedAgentSource: number;
      persistedHumanSource: number;
      legacyAgentName: number;
    };
    /**
     * Mutually exclusive first-failed-stage buckets. Together with `mature`,
     * these reconcile to the complete source population considered.
     */
    exclusions: Array<{
      code:
        | 'manual_source'
        | 'unrecognized_source'
        | 'human_outside_agent_scope'
        | 'missing_meta_campaign_id'
        | 'missing_launched_at'
        | 'zero_spend'
        | 'not_mature';
      stage: 'scope' | 'verified_launch' | 'with_spend' | 'mature';
      count: number;
      description: string;
    }>;
    /**
     * Complete selected-source evidence ledger, including created records that
     * never reached a verified Meta launch. Never use this array for ROAS.
     */
    campaigns: DashboardCampaignRow[];
  };

  freshness: {
    latestMetricsAt: string | null;
    oldestMetricsAt: string | null;
    campaignsWithKnownFreshness: number;
    campaignsWithoutFreshness: number;
    staleCampaigns: number;
    staleAfterHours: number;
    status: 'fresh' | 'partially_stale' | 'unknown';
  };

  economics: DashboardEconomics;

  automation: {
    pipelineRuns: {
      /** Every persisted tenant run record, including records without a campaign. */
      total: number;
      completed: number;
      failed: number;
      inProgress: number;
      completionRatePct: number;
      failureRatePct: number;
    };
    timeToApprovalReady: ToolImpactDurationStats;
    timeToLive: ToolImpactDurationStats;
    /** Scheduled/on-demand intelligence cycles for exact cohort campaigns. */
    cyclesRun: number;
    cyclesCompleted: number;
    cyclesFailed: number;
    /** Distinct campaigns that have ever gone through a cycle. */
    campaignsWatched: number;
    lastCycleAt: string | null;
    cadenceLabel: string;
  };

  diagnosis: {
    decisionsProposed: number;
    decisionFunnel: {
      proposed: number;
      open: number;
      approved: number;
      rejected: number;
      expired: number;
      executed: number;
      executionFailed: number;
    };
    byStatus: Record<
      'shadow_review' | 'approved' | 'rejected' | 'expired',
      number
    >;
    byActionType: Array<{ actionType: string; count: number }>;
    modelEstimates: {
      label: 'Model estimate — not realized return';
      openDecisionsWithEstimate: number;
      highestExpectedProfitDeltaINR7d: number | null;
      /** Alternatives can overlap, so their forecasts are intentionally not summed. */
      areSummed: false;
      notSummedReason: string;
    };
    observedOutcomes: {
      label: 'Observed post-action outcomes — not causal proof';
      recorded: number;
      awaiting24h: number;
      measured24h: number;
      finalized72h: number;
      conclusive72h: number;
      byLabel: Record<
        'improved' | 'worsened' | 'neutral' | 'inconclusive',
        number
      >;
      improvedRatePct: number | null;
      latestExecutedAt: string | null;
    };
    /** A handful of the highest-impact open decisions, for the "here's what it found" beat. */
    examples: Array<{
      campaignName: string;
      actionType: string;
      reasoning: string;
      expectedProfitDeltaINR7d: number;
      isModelEstimate: true;
      status: string;
    }>;
  };

  launched: {
    /** Verified launches only: included source + Meta id + launchedAt. */
    totalCampaigns: number;
    byStatus: Record<string, number>;
    /** Campaigns that actually spent money, vs paused/failed at zero spend. */
    withSpend: number;
    mature: number;
    rawOutcome: ToolImpactRawOutcome;
    /** Same raw-return calculation restricted to D7-mature launches. */
    matureRawOutcome: ToolImpactRawOutcome;
    portfolio: PortfolioRollup;
    /** Kept for the existing economics view; never use as this page's headline. */
    topWinner: DashboardCampaignRow | null;
    /** Highest raw return surplus among verified launches with spend. */
    bestRawResult: DashboardCampaignRow | null;
    campaigns: DashboardCampaignRow[];
  };
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
