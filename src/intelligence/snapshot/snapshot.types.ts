import type {
  CampaignMetricEvidenceState,
  CampaignRevenueAttributionSource,
  CampaignRevenueBasis,
} from '../../campaigns/schemas/campaign.schema';

export interface GoalResultInputs {
  /** Exact Meta action_type counts; no generic purchase/lead relabeling. */
  actionCounts?: Record<string, number>;
  /** Exact Meta action_type values before refunds or configured fallbacks. */
  actionValuesGross?: Record<string, number>;
}

export interface MetricProvenance {
  /** True only when Meta returned this exact entity insight row. */
  rowObserved?: boolean;
  /** Whether every requested page/chunk completed for the source query. */
  fetchComplete?: boolean;
  state?: CampaignMetricEvidenceState;
  source?: string;
  /** Stable identity of query/window/attribution configuration, not values. */
  sourceFingerprint?: string;
  /** Exact account currency (uppercase ISO code); omitted when not persisted. */
  currency?: string;
  metricsSyncedAt?: Date;
  metricsLastAttemptedAt?: Date;
  dateStart?: string;
  dateStop?: string;
  attributionSpec?: unknown;
  promotedObject?: unknown;
  revenueBasis?: CampaignRevenueBasis;
  revenueAttributionSource?: CampaignRevenueAttributionSource;
  revenueAttributionActionTypes?: string[];
  /** Campaign-configured conversion alias total; identity stays in actionCounts. */
  canonicalConversions?: number;
  /** Canonical persisted refund-net revenue, regardless of its basis. */
  canonicalRevenueNet?: number;
  /** Exact selected Meta action value before refund/config transformations. */
  rawMetaActionValueGross?: number;
  /** Observed Meta value after only the configured refund adjustment. */
  rawMetaActionValueNet?: number;
  /** Explicit model; never interchangeable with rawMetaActionValueGross. */
  configuredRevenueEstimateNet?: number;
  goalResultInputs?: GoalResultInputs;
}

/**
 * Canonical metric shape for the intelligence pipeline. Every downstream
 * engine reads these fields — never Meta directly.
 */
export interface MetricSet {
  spend: number;
  revenue: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  cvr: number;
  purchases: number;
  addToCart: number;
  initiateCheckout: number;
  roas: number;
  aov: number;
  frequency: number;
  /** Optional deeper-funnel/delivery facts when the sync source exposes them. */
  landingPageViews?: number;
  inlineLinkClicks?: number;
  outboundClicks?: number;
  video3s?: number;
  thruplay?: number;
  provenance?: MetricProvenance;
}

export interface AdMetricSet extends MetricSet {
  hookStyle?: string;
  format?: 'image' | 'video' | 'carousel';
  copyVariantIndex?: number;
  qualityRanking?: 'ABOVE_AVERAGE' | 'AVERAGE' | 'BELOW_AVERAGE';
  engagementRanking?: 'ABOVE_AVERAGE' | 'AVERAGE' | 'BELOW_AVERAGE';
  conversionRanking?: 'ABOVE_AVERAGE' | 'AVERAGE' | 'BELOW_AVERAGE';
  videoP25?: number;
  videoP50?: number;
  videoP75?: number;
  videoP100?: number;
  /** A genuinely windowed comparison row; lifetime metrics remain above. */
  last7d?: Partial<MetricSet>;
}

export interface SnapshotCampaignEntity {
  id: string;
  name: string;
  productName?: string;
  objective?: string;
  /** Exact persisted Meta budget topology. Budget shifts are safe only for ABO. */
  budgetModel?: 'abo' | 'cbo' | 'asc';
  status?: string;
  effectiveStatus?: string;
}

export interface SnapshotAdSetEntity {
  id: string;
  name: string;
  status?: string;
  effectiveStatus?: string;
  audienceType?: string;
  optimizationGoal?: string;
}

export interface SnapshotAdEntity {
  id: string;
  /** Exact parent id when supplied by the source; never inferred from names. */
  adSetId?: string;
  name: string;
  status?: string;
  effectiveStatus?: string;
  creative?: {
    id?: string;
    name?: string;
    body?: string;
    title?: string;
    cta?: string;
    linkUrl?: string;
    videoId?: string;
    imageHash?: string;
    thumbnailUrl?: string;
    isDynamic?: boolean;
  };
}

/**
 * SnapshotData is the payload stored inside the `snapshot` slice of
 * DecisionContext. Every field here is either normalized-from-Meta or
 * derived deterministically from Meta payloads + company config.
 */
export interface SnapshotData {
  snapshotId: string;
  collectedAt: Date;
  freshnessSec: number;
  metrics: {
    campaignLevel: MetricSet;
    adSetLevel: Record<string, MetricSet>;
    adLevel: Record<string, AdMetricSet>;
  };
  /**
   * Immutable entity labels and hierarchy captured beside the metrics.
   * Historical slices may omit this; consumers must then show unresolved
   * labels instead of guessing joins from names or URLs.
   */
  entities?: {
    campaign: SnapshotCampaignEntity;
    adSets: Record<string, SnapshotAdSetEntity>;
    ads: Record<string, SnapshotAdEntity>;
  };
  meta: {
    learningStage?:
      | 'LEARNING'
      | 'LEARNING_LIMITED'
      | 'ACTIVE'
      | 'NOT_DELIVERING';
    deliveryStatus?: string;
    accountId: string;
    /**
     * Raw Meta objective (OUTCOME_SALES, OUTCOME_TRAFFIC, …).
     *
     * Carried on the SLICE, not just the persisted snapshot document.
     * ObjectiveEngine reads its objective from the slice it receives through
     * the DAG; `rawCampaign` is written only to the Mongo snapshot doc, so the
     * engine's lookup found nothing and silently fell back to 'sales' for
     * EVERY campaign — including the 139 app-promotion, 67 lead, 17 traffic,
     * 12 engagement and 4 awareness campaigns on this account, whose profiles
     * exist precisely so they are NOT scored on ROAS.
     */
    objective?: string;
    /** Scope of campaign-level totals supplied by the source adapter. */
    metricScope?: 'lifetime' | 'window';
  };
  missingFields: string[];
}

/**
 * Raw Meta Graph API payload as returned by the fetcher. Kept loosely
 * typed because Meta's shape drifts across API versions — the builder
 * is the only place that touches these fields.
 */
export interface RawMetaCampaign {
  id?: string;
  name?: string;
  productName?: string;
  objective?: string;
  budgetModel?: 'abo' | 'cbo' | 'asc';
  status?: string;
  effective_status?: string;
  account_id?: string;
  learning_stage?: string;
  metricProvenance?: MetricProvenance;
  insights?: {
    spend?: number | string;
    impressions?: number | string;
    reach?: number | string;
    clicks?: number | string;
    ctr?: number | string;
    cpc?: number | string;
    cpm?: number | string;
    frequency?: number | string;
    actions?: Array<{ action_type: string; value: number | string }>;
    action_values?: Array<{ action_type: string; value: number | string }>;
  };
}

export interface RawMetaAdSet {
  id?: string;
  name?: string;
  status?: string;
  effectiveStatus?: string;
  audienceType?: string;
  optimizationGoal?: string;
  landingPageViews?: number;
  inlineLinkClicks?: number;
  thruplay?: number;
  metricProvenance?: MetricProvenance;
  insights?: RawMetaCampaign['insights'];
}

export interface RawMetaAd {
  id?: string;
  name?: string;
  adSetId?: string;
  status?: string;
  effectiveStatus?: string;
  hookStyle?: string;
  format?: 'image' | 'video' | 'carousel';
  copyVariantIndex?: number;
  creativeId?: string;
  creativeName?: string;
  creativeBody?: string;
  creativeTitle?: string;
  creativeCta?: string;
  creativeLinkUrl?: string;
  creativeVideoId?: string;
  creativeImageHash?: string;
  thumbnailUrl?: string;
  isDynamicCreative?: boolean;
  landingPageViews?: number;
  inlineLinkClicks?: number;
  outboundClicks?: number;
  video3s?: number;
  thruplay?: number;
  last7d?: RawMetaCampaign['insights'];
  last7dMetricProvenance?: MetricProvenance;
  metricProvenance?: MetricProvenance;
  quality_ranking?: string;
  engagement_ranking?: string;
  conversion_ranking?: string;
  insights?: RawMetaCampaign['insights'] & {
    video_p25_watched_actions?: Array<{ value: number | string }>;
    video_p50_watched_actions?: Array<{ value: number | string }>;
    video_p75_watched_actions?: Array<{ value: number | string }>;
    video_p100_watched_actions?: Array<{ value: number | string }>;
  };
}

/**
 * The full payload the fetcher returns. Consumed by SnapshotBuilder.
 */
export interface RawMetaBundle {
  campaign: RawMetaCampaign;
  adSets: Record<string, RawMetaAdSet>;
  ads: Record<string, RawMetaAd>;
  metaWindowStart: Date;
  metaWindowEnd: Date;
  /**
   * When the persisted source metrics were actually synchronized. `null`
   * explicitly means unknown; absence preserves the legacy/live-fetch
   * contract where metaWindowEnd is the source timestamp.
   */
  sourceMetricsSyncedAt?: Date | null;
  metricScope?: 'lifetime' | 'window';
}

/**
 * Minimal product info the builder needs to compute revenue.
 */
export interface ProductForRevenue {
  name: string;
  conversionValue?: number;
  contributionMargin?: number;
  refundRatePercent?: number;
}
