import { EngineContext } from '../shared/engine-context';

// ── Slice payload types ──────────────────────────────────────────────────
// SnapshotData lives in snapshot.types.ts (imports fully typed there);
// re-declared loosely here to avoid a circular import at the DC level.
export type SnapshotData = { snapshotId: string; collectedAt: Date } & Record<
  string,
  unknown
>;

export type ObjectiveKey =
  | 'sales'
  | 'leads'
  | 'awareness'
  | 'traffic'
  | 'engagement'
  | 'video_views'
  | 'app_installs'
  | 'messages'
  | 'catalog_sales'
  | 'retargeting';

export interface ObjectiveData {
  objective: ObjectiveKey;
  source: 'campaign_field' | 'meta_objective' | 'company_default' | 'inferred';
  primaryKPI: string;
  supportingKPIs: string[];
  weights: Record<string, number>;
  thresholds: {
    healthy: Record<string, number>;
    warning: Record<string, number>;
    critical: Record<string, number>;
  };
  policy: {
    scaleBudgetIf: string;
    pauseIf: string;
    refreshCreativeIf: string;
    ignoreSignals?: string[];
  };
}

export type LifecycleStage =
  | 'draft'
  | 'pending_approval'
  | 'launching'
  | 'learning'
  | 'growing'
  | 'scaling'
  | 'stable'
  | 'fatigue'
  | 'recovery'
  | 'retirement'
  | 'unknown';

export interface LifecycleData {
  stage: LifecycleStage;
  ageHours: number;
  metaLearningStage?: string;
  progressionScore: number;
  nextExpectedStage: LifecycleStage;
  allowedActions: string[];
  blockedActions: Array<{ action: string; reason: string }>;
  monitoringCadenceMinutes: number;
  gates: {
    canPause: boolean;
    canScale: boolean;
    canReduceBudget: boolean;
    canReplaceCreative: boolean;
    canAddAudience: boolean;
  };
}

export interface TrendReading {
  slope7d: number;
  slope3d: number;
  ema7d: number;
  ema3d: number;
  velocity: number;
  acceleration: number;
  volatility: number;
  vsBaseline: number;
  windowSize: number;
}

export interface TrendData {
  perMetric: Record<string, TrendReading>;
  overallDirection: 'improving' | 'stable' | 'declining' | 'volatile';
  stabilityScore: number;
  anomalies: Array<{ metric: string; zScore: number; note: string }>;
  /**
   * Number of daily observations used by the trend math. This is deliberately
   * separate from the number of raw snapshots: a three-hour scheduler can
   * produce eight raw documents without creating eight days of evidence.
   */
  observationCount?: number;
  /** Real elapsed time covered by the daily observations in this trend. */
  windowElapsedDays?: number;
  /** Real elapsed time since the campaign's oldest stored snapshot. */
  historyDepthDays?: number;
  /** Distinct observed UTC dates inside the trailing seven-day window. */
  recentCoverageDays?: number;
  /** Share of UTC dates covered from the oldest recent observation to now. */
  recentCoverageRatio?: number;
  /** Largest gap in UTC calendar days between adjacent observations. */
  maxGapDays?: number;
  /** True only when history is elapsed, recent, and adequately contiguous. */
  trendReady?: boolean;
}

export interface RevenueData {
  grossRevenue: number;
  netRevenue: number;
  contributionMargin: number;
  /**
   * True only when this campaign is mapped to one configured product and that
   * product has valid contribution-margin inputs. A false value means every
   * breakeven/profit field is intentionally withheld rather than guessed.
   */
  economicsAvailable: boolean;
  /**
   * True only when the campaign's stored return has campaign-scoped,
   * machine-readable provenance. This distinguishes observed/config-derived
   * return from legacy values whose derivation is unknown.
   */
  revenueEvidenceAvailable: boolean;
  /**
   * Convenience gate for downstream financial decisions. Recommendation and
   * scale/pause logic must require this, not merely a non-zero ROAS.
   */
  financialDataAvailable: boolean;
  attributedByAdSet: Record<string, number>;
  attributedByProduct: Record<string, number>;
  roasDecomposition: {
    ctr: { contribution: number; delta: number };
    cvr: { contribution: number; delta: number };
    aov: { contribution: number; delta: number };
    frequency: { contribution: number; delta: number };
  };
  breakeven: {
    roas: number;
    isProfitable: boolean;
    daysSinceBreakeven: number;
  };
  /** System scale-planning heuristic, not an observed company target. It is
   *  currently derived as breakeven.roas * 2 so the planning threshold scales
   *  with product margin. */
  targetROAS: number;
}

export type SignalKind =
  | 'creative_fatigue'
  | 'audience_saturation'
  | 'budget_saturation'
  | 'delivery_stalled'
  | 'frequency_ceiling'
  | 'ctr_decay'
  | 'cvr_collapse'
  | 'placement_leak'
  | 'hook_burn'
  | 'unprofitable_run'
  | 'winner_emerging'
  | 'winner_confirmed'
  | 'audience_exhaustion'
  | 'learning_limited_locked';

export interface Signal {
  kind: SignalKind;
  severity: 'info' | 'warn' | 'critical';
  targetType: 'campaign' | 'adset' | 'ad';
  targetId: string;
  /** Raw numeric evidence that fired the rule. */
  metricEvidence: Record<string, number>;
  /** Machine-readable rule label (e.g. "freq_above_baseline_1.5x AND ctr_below_baseline_0.7x"). */
  trigger: string;
  /** 0..1 confidence in this signal being real (not noise). */
  strength: number;
  /** Human-readable reasoning — surfaced to the operator in the review UI. */
  reasoning: string;
  firstSeenAt: Date;
}

export interface SignalData {
  signals: Signal[];
}

export interface DiagnosisData {
  rootCauses: Array<{
    hypothesis: string;
    /**
     * The exact entity whose evidence supports this hypothesis. Optional only
     * so historical persisted slices remain readable; every new diagnosis
     * writes both fields and recommendations fail closed when they are absent.
     */
    targetType?: Signal['targetType'];
    targetId?: string;
    evidenceSignals: SignalKind[];
    supportingTrends: string[];
    confidence: number;
    suggestedFocus:
      | 'creative'
      | 'audience'
      | 'budget'
      | 'placement'
      | 'objective_mismatch';
  }>;
  leakDiagnosis:
    | 'creative_leak'
    | 'audience_lp_leak'
    | 'chronic_unprofitable'
    | 'auction_leak'
    | 'data_gap'
    | 'creative_diversity_leak'
    | 'fragmentation'
    | 'none';
  narrative: string;
}

export interface BusinessData {
  activePromotions: Array<{ name: string; expiresAt: Date; discount?: number }>;
  seasonalContext: string;
  competitorPressure: 'low' | 'medium' | 'high';
  inventoryStatus?: 'in_stock' | 'low' | 'oos';
  budgetPolicy: {
    weeklyCapINR: number;
    weeklyCapUsedINR: number;
    weeklyCapRemainingINR: number;
    perCampaignCapINR: number;
  };
  forbiddenTopics: string[];
  daypartingConstraints?: Record<
    string,
    { startHour: number; endHour: number }
  >;
}

export interface PortfolioData {
  budgetProposals: Array<{
    campaignId: string;
    currentINR: number;
    proposedINR: number;
    delta: number;
    reason: string;
  }>;
  ranking: Array<{
    campaignId: string;
    score: number;
    tier: 'A' | 'B' | 'C' | 'D';
  }>;
  totalPortfolioROAS: number;
  concentration: number;
}

export interface ForecastPoint {
  spend: number;
  revenue: number;
  roas: number;
  conversions: number;
  band: {
    lowSpend: number;
    highSpend: number;
    lowRevenue: number;
    highRevenue: number;
  };
}

export interface ForecastData {
  horizons: {
    next24h: ForecastPoint;
    next72h: ForecastPoint;
    next7d: ForecastPoint;
    next30d: ForecastPoint;
  };
  method: 'ema_projection' | 'linear' | 'seasonal' | 'insufficient_history';
  /** The real calendar evidence that selected `method`. */
  history?: {
    observationCount: number;
    elapsedDays: number;
    minimumObservationCount: number;
    minimumElapsedDays: number;
  };
}

export interface ConfidenceData {
  overall: number;
  perEngine: Record<string, number>;
  quality: {
    /** Seconds between source sync and analysis; -1 means unknown. */
    dataFreshnessSec: number;
    /** Explicit action gate; historical rows may omit it. */
    sourceDataFresh?: boolean;
    snapshotCoverage: number;
    historyDepthDays: number;
    statisticalPower: number;
  };
  gates: {
    okToRecommend: boolean;
    okToExecute: boolean;
    reasonsBlocked: string[];
  };
}

export interface MemoryData {
  /**
   * Scoped to THIS campaign only (see MemoryEngine.compute /
   * ActionOutcomeService.listRecentForCampaign) — every entry also carries
   * the Meta ad/adset/campaign id it targeted, so consumers can gate on
   * "this exact ad set already tried this and it backfired," not just
   * "this action type backfired somewhere in the account."
   */
  pastActions: Array<{
    actionType: string;
    targetId: string;
    executedAt: Date;
    outcomeLabel: 'improved' | 'worsened' | 'neutral' | 'inconclusive';
    context: string;
  }>;
  causalInsights: Array<{
    finding: string;
    confidence: number;
    isolatedVariable: string;
  }>;
  similarPastCycles: Array<{
    cycleId: string;
    similarity: number;
    outcome: string;
  }>;
  companyLearnings: {
    winningHooks: string[];
    losingHooks: string[];
    winningExemplars: Array<{ hookLine: string; ctr: number }>;
    audienceHookSaturation: Record<string, Record<string, number>>;
  };
}

export type CampaignActionType =
  | 'pause_ad'
  | 'pause_adset'
  | 'scale_adset'
  | 'replace_creative'
  | 'add_creative'
  | 'add_adset'
  | 'shift_budget_between_adsets'
  | 'reduce_total_budget'
  | 'narrow_placement'
  | 'dayparting';

export interface RecommendedAction {
  actionId: string;
  type: CampaignActionType;
  targetType: 'campaign' | 'adset' | 'ad';
  targetId: string;
  parameters: Record<string, unknown>;
  expectedImpact: {
    metric: string;
    deltaPct: number;
    confidence: number;
  };
  /** Expected ₹ contribution profit delta over the next 7 days if applied. */
  expectedProfitDeltaINR7d: number;
  /** Human-readable reasoning shown in the review UI. */
  reasoning: string;
  /** Evidence chain: signals + trends + revenue derivations that back this action. */
  evidenceChain: Array<{ step: string; source: string }>;
  risk: 'low' | 'medium' | 'high';
  implementationCost: number;
  score: number;
  gatedBy: string[];
  requiresHumanApproval: boolean;
}

export interface RecommendationData {
  actions: RecommendedAction[];
  /**
   * Debug/observability only — never used to gate anything downstream.
   * Lets a "0 decisions proposed" cycle answer "because no signal fired" vs.
   * "because N candidates were gated" without re-deriving it from scratch.
   */
  candidatesConsidered?: number;
  /** Tally of each gatedBy tag across all candidates before filtering. */
  gateReasonCounts?: Record<string, number>;
}

export interface ExplainabilityData {
  perAction: Record<
    string,
    {
      summary: string;
      reasoning: string;
      evidenceChain: Array<{ step: string; source: string }>;
      counterfactual?: string;
      llmRendered?: string;
    }
  >;
}

export interface AppliedAction {
  actionId: string;
  appliedActionId: string;
  metaResponseId?: string;
  appliedAt: Date;
  rollback: {
    supported: boolean;
    payload?: Record<string, unknown>;
  };
}

export interface ExecutionData {
  applied: AppliedAction[];
  deferred: Array<{ actionId: string; reason: string; retryAt?: Date }>;
  failed: Array<{
    actionId: string;
    error: string;
    rollback: 'attempted' | 'not_needed' | 'failed';
  }>;
}

export interface LearningData {
  measurements: Array<{
    appliedActionId: string;
    horizon: '24h' | '72h';
    outcomeLabel: 'improved' | 'worsened' | 'neutral' | 'inconclusive';
    delta: Record<string, number>;
  }>;
  calibrations: Array<{
    engine: string;
    field: string;
    predicted: number;
    actual: number;
    calibrationError: number;
  }>;
  updates: Array<{
    target: 'threshold' | 'weight' | 'prompt';
    key: string;
    oldValue: unknown;
    newValue: unknown;
    reason: string;
  }>;
}

export interface DecisionContext {
  // Identity
  cycleId: string;
  tenantId: string;
  campaignId: string;
  metaCampaignId?: string;
  runId?: string;

  // Timing
  startedAt: Date;
  completedAt?: Date;
  timings: Record<string, number>;

  // Feature flags this cycle used
  featureFlags: {
    intelligenceV2: boolean;
    contextsEnabled: number;
    executeEnabled: boolean;
    shadowCompareInDashboard: boolean;
  };

  // Engine outputs (populated in strict order by engines subscribing to
  // upstream .completed events; undefined until that engine's slice
  // lands in intelligence_engine_outputs)
  snapshot?: EngineContext<SnapshotData>;
  objective?: EngineContext<ObjectiveData>;
  lifecycle?: EngineContext<LifecycleData>;
  trend?: EngineContext<TrendData>;
  revenue?: EngineContext<RevenueData>;
  signal?: EngineContext<SignalData>;
  diagnosis?: EngineContext<DiagnosisData>;
  business?: EngineContext<BusinessData>;
  portfolio?: EngineContext<PortfolioData>;
  forecast?: EngineContext<ForecastData>;
  confidence?: EngineContext<ConfidenceData>;
  memory?: EngineContext<MemoryData>;
  recommendation?: EngineContext<RecommendationData>;
  explainability?: EngineContext<ExplainabilityData>;
  execution?: EngineContext<ExecutionData>;
  learning?: EngineContext<LearningData>;

  // Cross-cutting collectors
  errors: Array<{
    engine: string;
    step: number;
    message: string;
    stack?: string;
    fatal: boolean;
    at: Date;
  }>;
  skipped: Array<{ engine: string; reason: string }>;
  audit: Array<{
    engine: string;
    kind: 'started' | 'completed' | 'skipped' | 'failed';
    at: Date;
  }>;
}

export const ENGINE_SLICE_KEYS = [
  'snapshot',
  'objective',
  'lifecycle',
  'trend',
  'revenue',
  'signal',
  'diagnosis',
  'business',
  'portfolio',
  'forecast',
  'confidence',
  'memory',
  'recommendation',
  'explainability',
  'execution',
  'learning',
] as const;

export type EngineSliceKey = (typeof ENGINE_SLICE_KEYS)[number];

export function isEngineSliceKey(k: string): k is EngineSliceKey {
  return (ENGINE_SLICE_KEYS as readonly string[]).includes(k);
}

// Ordered pipeline positions — the DAG asserter uses this to validate that
// no engine depends on an engine with a higher step number.
export const ENGINE_STEP: Record<EngineSliceKey, number> = {
  snapshot: 1,
  objective: 2,
  lifecycle: 3,
  trend: 4,
  revenue: 5,
  signal: 6,
  diagnosis: 7,
  business: 8,
  portfolio: 9,
  forecast: 10,
  confidence: 11,
  memory: 12,
  recommendation: 13,
  explainability: 14,
  execution: 15,
  learning: 16,
};

// Default feature flag values — engines respect these at runtime.
export const DEFAULT_FEATURE_FLAGS: DecisionContext['featureFlags'] = {
  intelligenceV2: false,
  contextsEnabled: 0,
  executeEnabled: false,
  shadowCompareInDashboard: false,
};

export function createDecisionContext(input: {
  cycleId: string;
  tenantId: string;
  campaignId: string;
  metaCampaignId?: string;
  featureFlags?: Partial<DecisionContext['featureFlags']>;
}): DecisionContext {
  return {
    cycleId: input.cycleId,
    tenantId: input.tenantId,
    campaignId: input.campaignId,
    metaCampaignId: input.metaCampaignId,
    startedAt: new Date(),
    timings: {},
    featureFlags: { ...DEFAULT_FEATURE_FLAGS, ...(input.featureFlags ?? {}) },
    errors: [],
    skipped: [],
    audit: [],
  };
}

export function assertHas<K extends EngineSliceKey>(
  dc: DecisionContext,
  key: K,
): asserts dc is DecisionContext & Required<Pick<DecisionContext, K>> {
  if (!dc[key]) {
    throw new Error(`DecisionContext missing required engine output: ${key}`);
  }
}
