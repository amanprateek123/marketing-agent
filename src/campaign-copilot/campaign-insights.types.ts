/**
 * Contracts for Copilot "Queries" mode — asking questions about campaigns that
 * already ran, as opposed to planning a new one.
 *
 * The deliberate split here: the CAMPAIGN IS RESOLVED DETERMINISTICALLY in
 * TypeScript, never by the model. The resolved context is returned alongside
 * the answer so the UI can show exactly which campaign, ad sets and ads were
 * read — the operator can see the model was pointed at the right thing before
 * they trust a word of the answer.
 */

export type InsightsResolutionMethod =
  | 'explicit_selection'
  | 'name_match'
  | 'only_candidate'
  | 'unresolved';

export interface InsightsAdSnapshot {
  id: string;
  name: string;
  status: string;
  format: string | null;
  hookStyle: string | null;
  spend: number;
  roas: number | null;
  ctr: number | null;
  cvr: number | null;
  conversions: number;
  impressions: number;
  frequency: number | null;
  /** Video-only; null for static creatives so "no data" never reads as zero. */
  holdRate: number | null;
  creativeTitle: string | null;
  creativeCta: string | null;
  thumbnailUrl: string | null;
}

export interface InsightsAdSetSnapshot {
  id: string;
  name: string;
  status: string;
  optimizationGoal: string | null;
  audienceType: string | null;
  dailyBudget: number | null;
  spend: number;
  roas: number | null;
  ctr: number | null;
  cvr: number | null;
  conversions: number;
  impressions: number;
  frequency: number | null;
  ads: InsightsAdSnapshot[];
}

/** One segment inside a breakdown — an age bucket, an hour, a placement. */
export interface InsightsBreakdownRow {
  /** Human-readable segment label, e.g. "25-34 female" or "monday". */
  segment: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  conversions: number;
  /** Null when Meta returned no trusted revenue for this segment. */
  revenue: number | null;
  cpa: number | null;
  roas: number | null;
}

/**
 * Performance split along one dimension. Deep-sync already stores these per
 * campaign; without them the analyst can only see totals and has to answer
 * "which age group buys?" or "what time converts?" with nothing at all.
 */
export interface InsightsBreakdown {
  /** age_gender | placement | region | country | hourly | dow | creative copy. */
  dimension: string;
  /** Insights window these rows cover, e.g. "last_30d". */
  window: string;
  /** When Meta was last read for this dimension, so stale splits are visible. */
  fetchedAt: string | null;
  /** Segments carried, highest spend first. */
  rows: InsightsBreakdownRow[];
  /** Set when lower-spend segments were dropped to keep the payload small. */
  omittedSegments: number;
}

export interface InsightsCampaignSnapshot {
  campaignId: string;
  metaCampaignId: string | null;
  name: string;
  status: string;
  /** 'manual' campaigns are read-only: Meridian can diagnose, never change. */
  source: string;
  objective: string | null;
  productName: string | null;
  dailyBudget: number | null;
  spend: number;
  revenue: number | null;
  roas: number | null;
  ctr: number | null;
  cvr: number | null;
  conversions: number;
  impressions: number;
  frequency: number | null;
  breakevenRoas: number | null;
  marginPct: number | null;
  /** Freshness of the underlying Meta metrics, so stale data is visible. */
  dataAsOf: string | null;
  launchedAt: string | null;
  adSets: InsightsAdSetSnapshot[];
  /**
   * Performance splits for this campaign. Empty when deep-sync has not yet
   * recorded any — which the analyst must report as "not collected" rather
   * than answering the question from campaign totals.
   */
  breakdowns: InsightsBreakdown[];
}

/** What the UI shows in the right-hand panel to prove the right target was read. */
export interface InsightsResolvedContext {
  resolvedBy: InsightsResolutionMethod;
  /** Human-readable explanation of how this campaign was chosen. */
  resolutionNote: string;
  campaign: InsightsCampaignSnapshot | null;
  coverage: {
    adSetsRead: number;
    adsRead: number;
  };
  /** Things the operator should know before trusting the answer. */
  caveats: string[];
  /** Other campaigns that also matched, so a wrong pick is obvious. */
  alternatives: Array<{ campaignId: string; name: string; status: string }>;
}

export interface InsightsAskResult {
  answer: string;
  context: InsightsResolvedContext;
  model: string | null;
  /** False when no campaign could be resolved — the UI asks the user to pick. */
  answered: boolean;
}
