import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CampaignDocument = HydratedDocument<Campaign>;

export type CampaignStatus =
  | 'pending_approval'
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'superseded';
/**
 * 'agent' = full AI pipeline (scout→brief→creative→review team) launched this.
 * 'human' = launched through the dashboard's manual Create Campaign form —
 *   a person supplied targeting + creative directly, no AI review team.
 * 'manual' = imported from Meta; the tenant created it directly in Ads Manager,
 *   we only observe it. Never launched or safety-rail-managed by this system.
 */
export type CampaignSource = 'agent' | 'manual' | 'human';

/**
 * 'agent' and 'human' campaigns were both launched BY this system (weekly
 * budget cap, audit safety rails, auto-pause all apply). 'manual' campaigns
 * were only ever imported for read-only tracking — treating them as managed
 * would apply budget caps and auto-pause to spend the tenant controls outside
 * this system entirely.
 */
export function isManagedCampaignSource(
  source: CampaignSource | string | undefined,
): boolean {
  return source === 'agent' || source === 'human';
}

@Schema({ collection: 'campaigns', timestamps: true })
export class Campaign {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ default: '' })
  name: string;

  @Prop({ index: true, default: '' })
  runId: string;

  @Prop({ index: true, default: '' })
  briefId: string;

  /**
   * Which product on the company this campaign sells — the operator's (or the
   * brief's) explicit choice, recorded at creation time.
   *
   * Load-bearing, not decorative: the landing URL, pixel, custom conversion /
   * custom event and conversion value all come from this product at launch.
   * Before this field existed, launch() re-derived the product by matching
   * campaignConfig.conversionEvent against the product list and fell back to
   * products[0] — which on 2026-07-27 shipped a "wish letter" campaign
   * pointing at a different product's landing page, pixel and custom
   * conversion, with no error raised. See resolve-campaign-product.ts.
   *
   * Empty only on campaigns created before this field (resolved from
   * briefId → CreativeBrief.product, or refused outright when ambiguous).
   */
  @Prop({ index: true, default: '' })
  productName: string;

  // 'agent' = launched by our system, 'manual' = synced from Meta (tenant created it)
  @Prop({ default: 'agent', index: true })
  source: CampaignSource;

  // Last time this campaign was synced from Meta
  @Prop()
  syncedAt?: Date;

  @Prop({ default: '' })
  topic: string;

  @Prop({ default: '' })
  angle: string;

  @Prop({ default: '' })
  creativePackageId: string;

  @Prop({ index: true, sparse: true, default: '' })
  metaCampaignId: string;

  @Prop({ default: '' })
  metaAccountId: string; // which Meta ad account this campaign was launched on

  @Prop({ required: true, default: 'pending_approval' })
  status: CampaignStatus;

  @Prop({ required: true })
  budget: number;

  @Prop({ required: true })
  objective: string;

  @Prop()
  launchedAt?: Date;

  // ── Campaign structure (synced from Meta; determines which levers exist) ──

  /** LOWEST_COST_WITHOUT_CAP / LOWEST_COST_WITH_BID_CAP / COST_CAP */
  @Prop({ default: '' })
  bidStrategy?: string;

  /** AUCTION / RESERVED */
  @Prop({ default: '' })
  buyingType?: string;

  /** AUTOMATED_SHOPPING_ADS = Advantage+ shopping campaign. GUIDED_CREATION = manual. */
  @Prop({ default: '' })
  smartPromotionType?: string;

  @Prop({ type: [String], default: [] })
  specialAdCategories?: string[];

  /** Account-currency units (already ÷100 from Meta's minor units). 0 = no cap. */
  @Prop({ default: 0 })
  spendCap?: number;

  /**
   * Where the budget lives — the lever map for budget actions.
   * 'abo' = adset budgets (shift_budget_between_adsets executable)
   * 'cbo' = campaign budget (Advantage campaign budget / CBO — only campaign-level budget moves)
   * 'asc' = Advantage+ shopping (campaign budget + creative levers only)
   */
  @Prop({ default: '' })
  budgetModel?: string;

  @Prop()
  stopTime?: Date;

  @Prop()
  approvedAt?: Date;

  @Prop()
  pausedAt?: Date;

  @Prop()
  pauseReason?: string;

  /**
   * Snapshot of company.promptsVersion at the moment this campaign was created.
   * Lets us correlate campaign performance with prompt-version drift over time
   * and answer "did campaigns generated under v3 outperform v4?" before
   * permanently rolling back to an older prompt version.
   */
  @Prop()
  promptsVersion?: number;

  // Live metrics (written back by auditor in Phase 6)
  @Prop({ default: 0 })
  spend: number;

  @Prop({ default: 0 })
  impressions: number;

  @Prop({ default: 0 })
  clicks: number;

  @Prop({ default: 0 })
  conversions: number;

  @Prop({ default: 0 })
  roas: number;

  /** Meta action_values sum (or fallback: conversions × product.conversionValue), NET of refund haircut. ₹. */
  @Prop({ default: 0 })
  revenue: number;

  @Prop({ default: 0 })
  ctr: number;

  @Prop({ default: 0 })
  cpc: number;

  @Prop({ default: 0 })
  reach: number;

  @Prop({ default: 0 })
  cpm: number;

  /** Average frequency across the campaign's lifetime window — feeds runSafetyRails' hard fatigue pause. */
  @Prop({ default: 0 })
  frequency: number;

  /**
   * `date_stop` of the campaign-level insights row — the last day Meta's
   * reporting pipeline actually covers. Feeds the audit staleness gate
   * (detects Meta's own reporting lag, distinct from our own sync recency —
   * see `syncedAt`). null = no insights row returned on the last sync.
   */
  @Prop({ type: String, default: null })
  dataAsOf?: string | null;

  /** Raw Meta effective_status (e.g. ADSET_PAUSED, WITH_ISSUES) — distinct from the internally-mapped `status` above. */
  @Prop({ default: '' })
  effectiveStatus?: string;

  @Prop()
  lastAuditedAt?: Date;

  @Prop({ type: [Object], default: [] })
  auditHistory: {
    auditedAt: Date;
    action: string;
    reason: string;
    metricsBefore: Record<string, number>;
  }[];

  // Phase 9 — Campaign Review Team data
  @Prop({ type: String, default: '' })
  reviewNotes: string;

  @Prop({ type: Object, default: null })
  reviewAdjustments: {
    budgetAdjusted: boolean;
    originalBudget: number;
    recommendedBudget: number;
    targetingNotes: string;
    timingNotes: string;
    scaleRules: string;
    pauseRules: string;
  };

  @Prop({ type: [Object], default: [] })
  reviewDebateLog: { round: number; from: string; summary: string }[];

  // Structured campaign config from Campaign Review Team
  @Prop({ type: Object, default: null })
  campaignConfig: {
    budget: number;
    objective: string;
    conversionEvent: string;
    conversionValue: number;
    adSets: {
      name: string;
      budgetPercent: number;
      audienceType: string;
      metaAudienceId?: string;
      excludeAudienceIds?: string[];
      ageMin?: number;
      ageMax?: number;
      gender?: string;
      geoLocations?: string[];
      /** Meta region keys — take precedence over geoLocations at launch. */
      geoStates?: string[];
      /** Meta city keys — take precedence over geoLocations at launch. */
      geoCities?: string[];
      /** Meta locale IDs for language targeting. */
      locales?: number[];
      /** Device OS targeting — 'iOS'/'Android' to split into per-platform ad sets. */
      userOs?: ('iOS' | 'Android')[];
      interests?: string[];
      optimizationGoal: string;
      ads: number[];
      creativeFormat?: 'video' | 'image' | 'both' | 'mixed' | 'carousel';
    }[];
    scaleRules: string;
    pauseRules: string;
  };

  /**
   * Raw Meta adsets + ads — populated by CampaignSyncService.syncActiveCampaigns
   * every 10 min, shown on dashboard. This is the canonical per-adset/per-ad
   * dataset the old audit loop and the intelligence cascade are being
   * consolidated onto (see campaign-sync.service.ts:720-792 for adsets,
   * :578-648 for ads — the object-literal construction there is ground
   * truth; this interface is documentation only, Mongoose stores it as
   * Mixed/[Object] so it isn't enforced).
   */
  @Prop({ type: [Object], default: [] })
  metaAdSets: {
    id: string;
    name: string;
    status: string;
    audienceType: string;
    dailyBudget: number;
    lifetimeBudget: number;
    optimizationGoal: string;
    // Money
    spend: number;
    revenue: number;
    roas: number;
    cpc: number;
    cpm: number;
    cpa: number;
    aov: number;
    // Reach / delivery
    impressions: number;
    reach: number;
    frequency: number;
    clicks: number;
    ctr: number;
    // Funnel
    conversions: number;
    addToCart: number;
    initiateCheckout: number;
    landingPageView: number;
    cvr: number;
    // Video watch counts + %
    videoP25: number;
    videoP50: number;
    videoP75: number;
    videoP100: number;
    videoP25Pct: number;
    videoP50Pct: number;
    videoP75Pct: number;
    videoP100Pct: number;
    // Rankings — Meta only computes these over a rolling 7d window; UNKNOWN
    // (any value outside ABOVE_AVERAGE/AVERAGE/BELOW_AVERAGE) comes through as undefined
    qualityRanking?: string;
    engagementRanking?: string;
    conversionRanking?: string;
    // Delivery insight
    learningStage: string;
    effectiveStatus: string;
    // Bidding / delivery config
    bidAmount: number;
    bidStrategy: string;
    billingEvent: string;
    attributionSpec?: unknown;
    promotedObject?: unknown;
    startTime: string;
    endTime: string;
    // Targeting — legacy summary strings (dashboard)
    age: string;
    gender: string;
    placement: string;
    audienceSize?: number;
    interests: string[];
    geo: string;
    // Full structured targeting (custom audiences, exclusions, regions/cities,
    // locales, Advantage flags) — see structureTargeting() in campaign-sync.service.ts
    targetingDetail?: Record<string, unknown>;
    rawTargeting?: Record<string, unknown>;
    dateStart: string;
    dateStop: string;
    ads: {
      id: string;
      name: string;
      status: string;
      effectiveStatus: string;
      hookStyle: string;
      format: string;
      creativeId: string;
      creativeName: string;
      creativeBody: string;
      creativeTitle: string;
      creativeCta: string;
      creativeLinkUrl: string;
      creativeVideoId: string;
      creativeImageHash: string;
      thumbnailUrl: string;
      isDynamicCreative: boolean;
      // Money (lifetime window)
      spend: number;
      revenue: number;
      roas: number;
      cpc: number;
      cpm: number;
      cpa: number;
      aov: number;
      // Reach / delivery
      impressions: number;
      reach: number;
      frequency: number;
      clicks: number;
      ctr: number;
      inlineLinkClicks: number;
      outboundClicks: number;
      linkCtr: number;
      // Funnel
      conversions: number;
      addToCart: number;
      initiateCheckout: number;
      landingPageView: number;
      cvr: number;
      // Rankings (7d window)
      qualityRanking?: string;
      engagementRanking?: string;
      conversionRanking?: string;
      // Video
      video3s: number;
      thruplay: number;
      hookRate: number;
      holdRate: number;
      videoP25: number;
      videoP50: number;
      videoP75: number;
      videoP100: number;
      videoP25Pct: number;
      videoP50Pct: number;
      videoP75Pct: number;
      videoP100Pct: number;
      dateStart: string;
      dateStop: string;
      // Recency window (7d) — fatigue/decay reads this, not lifetime
      last7d?: {
        spend: number;
        impressions: number;
        clicks: number;
        ctr: number;
        conversions: number;
        revenue: number;
        cpa: number;
      };
    }[];
  }[];

  // Meta ad set + ad IDs (populated after launch, updated by auditor)
  @Prop({ type: [Object], default: [] })
  adSets: {
    metaAdSetId: string;
    name: string;
    budgetPercent: number;
    audienceType: string;
    status: string;
    metrics?: {
      spend: number;
      impressions: number;
      clicks: number;
      conversions: number;
      ctr: number;
      cpc: number;
      cpa: number;
      frequency: number;
      reach: number;
    };
    ads: {
      metaAdId: string;
      copyVariantIndex: number;
      hookStyle: string;
      // Which creative format actually shipped — 'video', 'image', or 'carousel'.
      // Set at launch. Required for measuring 'mixed' ad sets (1 video + N image):
      // without this, audit + hookStyle learning conflate format-level performance
      // with hook-level performance because both are in the same ad set bucket.
      // 'carousel' = one ad with N linked cards (single entry per ad set).
      format?: 'video' | 'image' | 'carousel';
      status: string;
      metrics?: {
        spend: number;
        impressions: number;
        clicks: number;
        conversions: number;
        ctr: number;
        cpc: number;
      };
      ctrBaseline?: number; // first 48h average CTR (for fatigue detection)
      baselineSetAt?: Date;
      replacementHistory?: {
        oldHook: string;
        newHook: string;
        replacedAt: Date;
        reason: string;
      }[];
    }[];
  }[];

  /**
   * Set to true by the audit loop the first time any ad on this campaign
   * crosses the strict winner gate (ROAS ≥ 2× breakeven AND ≥10 conv on the ad).
   * Once set, the winning ad is upserted into company.learnings.hotWinners
   * and the Strategy Team's exploit-winner arm becomes eligible to clone it
   * in subsequent pipeline runs. Idempotent — never unset once true.
   */
  @Prop({ type: Boolean, default: false })
  winnerCandidate?: boolean;

  @Prop({ type: Date })
  winnerCandidateAt?: Date;

  /**
   * Demographic + placement breakdown snapshot — populated by the audit loop or
   * a dedicated breakdown-fetch job from meta-metrics.fetchDemographicBreakdown.
   * Each row is one (age × gender × publisher_platform × platform_position)
   * combination with its own performance. Used by the demographic analyzer to
   * write insights like "best demo+placement for product X is women 35-44 on
   * Reels". MVP: storage shape only — analyzer not yet wired.
   *
   * fetchedAt lets readers skip stale snapshots; refresh cadence should be
   * daily for active campaigns (~1 Graph API call per campaign per day).
   */
  @Prop({ type: Object, default: null })
  demographicBreakdown?: {
    fetchedAt: Date;
    rows: Array<{
      age: string;
      gender: string;
      publisherPlatform: string;
      platformPosition: string;
      spend: number;
      impressions: number;
      clicks: number;
      conversions: number;
      ctr: number;
      cpa: number;
    }>;
  } | null;

  // Pending optimization actions (auditor recommends, human approves or grace period expires)
  @Prop({ type: [Object], default: [] })
  pendingActions: {
    actionId: string;
    type:
      | 'pause_ad'
      | 'pause_adset'
      | 'scale_adset'
      | 'replace_creative'
      | 'add_creative'
      | 'add_adset';
    targetId: string; // Meta ad/adset/campaign ID
    targetName: string;
    reason: string;
    /**
     * Verdict-supplied priority: 'high' for safety-rail breaches and saturation
     * corrections; 'medium' / 'low' for opportunistic optimizations. Persisted
     * so downstream consumers (timing-guard review, audit history, Slack
     * notifications, dashboard) can see the original urgency level. Previously
     * was being dropped during the push() write — observers saw priority=undefined
     * even though the timing guard had used the real value upstream.
     */
    priority?: 'low' | 'medium' | 'high';
    metrics: Record<string, any>; // relevant metrics + action-specific params
    recommendedAt: Date;
    executeAt: Date; // recommendedAt + gracePeriod
    status: 'pending' | 'executed' | 'overridden' | 'expired';
    executedAt?: Date;
    /**
     * True when the action was auto-applied via the Layer 3 low-risk path
     * (AUTO_APPLY_TYPES = narrow_placement, add_creative, dayparting, small
     * shift_budget_between_adsets). Distinguishes "human approved this" from
     * "system applied this automatically per safety policy" in audit history.
     */
    autoApplied?: boolean;
    replacementStatus?: 'queued' | 'producing' | 'complete' | 'failed'; // replace/add creative only
  }[];

  /**
   * Progress of the most recent in-place Page swap (swap-page endpoint) —
   * clones each live ad's creative with a corrected page_id, no new campaign/
   * ad set/ad IDs. Runs fire-and-forget (40 ads × ~3 Meta calls each can take
   * minutes, same ALB-timeout reasoning as /sync above) — the dashboard polls
   * this field for live progress instead of waiting on the HTTP response.
   */
  @Prop({ type: Object, default: null })
  pageSwapStatus?: {
    status: 'running' | 'complete' | 'failed';
    targetPageId: string;
    total: number;
    swapped: number;
    failed: number;
    startedAt: Date;
    completedAt?: Date;
    results: Array<{
      adSetId: string;
      adId: string;
      status: 'swapped' | 'failed';
      newCreativeId?: string;
      error?: string;
    }>;
  } | null;
}

export const CampaignSchema = SchemaFactory.createForClass(Campaign);
