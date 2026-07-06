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
  meta: {
    learningStage?: 'LEARNING' | 'LEARNING_LIMITED' | 'ACTIVE' | 'NOT_DELIVERING';
    deliveryStatus?: string;
    accountId: string;
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
  objective?: string;
  status?: string;
  effective_status?: string;
  account_id?: string;
  learning_stage?: string;
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
  audienceType?: string;
  insights?: RawMetaCampaign['insights'];
}

export interface RawMetaAd {
  id?: string;
  name?: string;
  hookStyle?: string;
  format?: 'image' | 'video' | 'carousel';
  copyVariantIndex?: number;
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
