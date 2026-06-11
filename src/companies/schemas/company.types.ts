export interface AudienceSegment {
  name: string;                    // e.g. "career_anxious"
  description: string;             // e.g. "25-40 professionals worried about career"
  ageMin: number;
  ageMax: number;
  gender: 'all' | 'male' | 'female';
  interests: string[];             // Meta interest targeting keywords
  // Per-segment Meta locale targeting. Canonical language names (e.g. ['marathi'])
  // OR Meta locale IDs (e.g. [84]). When unset, resolver falls back to
  // product.languages, then to no locale filter. Lets one segment target Marathi
  // speakers while another targets Hindi within the same product.
  languages?: Array<string | number>;
  triggers: string[];              // what events make this audience search (seasonal, news)
  confidence: 'hypothesis' | 'low' | 'medium' | 'high';
  conversions: number;             // tracked over time
  avgCPA: number | null;           // tracked over time
}

export interface MetaAudience {
  id: string;                      // Meta audience ID
  name: string;                    // e.g. "Nadi_Report_Nov'25_Customer"
  type: 'custom' | 'lookalike';
  lookalikePercent?: number;       // 1, 2, 3 for lookalike audiences
  linkedSegment?: string;          // maps to audienceSegment.name
}

export interface ProductPerformance {
  totalConversions: number;
  avgCPA: number | null;
  avgROAS: number | null;
  bestHookStyle: string | null;
  bestPlatform: string | null;
  confidenceLevel: 'hypothesis' | 'low' | 'medium' | 'high';
}

export interface Product {
  name: string;
  price: number;
  currency: string;
  description: string;
  active: boolean;

  // Product marketing data
  landingUrl?: string;
  languages?: string[];              // e.g. ["hindi", "english", "tamil"]
  trendKeywords?: string[];          // keywords that connect trends to this product
  differentiators?: string[];        // what makes this product unique vs competitors

  // Conversion tracking
  conversionEvent?: string;          // Meta pixel event: "Purchase", "Lead", "CompleteRegistration", "Subscribe", or custom event name
  conversionValue?: number;          // revenue per conversion (e.g. 999 for ₹999 product) — used for ROAS calculation
  contributionMargin?: number;       // decimal 0-1 (e.g. 0.3 = 30% margin after COGS/shipping/fees). Drives breakeven ROAS = 1/margin. Falls back to vertical default when unset.
  /**
   * Percent of conversions that refund (0-95, e.g. 30 = 30% refund rate).
   * Pixel `value` params and conversionValue are GROSS bookings — for
   * refundable funnels the decision chain must optimize on NET revenue or it
   * scales campaigns that lose money ("ROAS 2.0" at 30% refunds is really 1.4).
   * Applied via getEffectiveConversionValue() / the refundRatePercent param on
   * MetaMetricsService — never haircut manually, or it double-counts.
   * Unset/0 = no refunds (current behavior).
   */
  refundRatePercent?: number;
  customEventName?: string;          // if conversionEvent is "CustomEvent", this is the event name (e.g. "NADI_REPORT_PURCHASE_COMPLETED")
  customConversionId?: string;       // Meta Custom Conversion ID — takes priority, sends pixel_id + custom_conversion_id to Meta
  pixelId?: string;                  // Meta Pixel ID if different from company.meta.pixelId
  /**
   * Meta ad-set optimization goal. Defaults to 'OFFSITE_CONVERSIONS' when unset.
   * Set to 'VALUE' for Value-Based Bidding on funnels where revenue per conversion
   * varies meaningfully (refundable bookings, tiered pricing). VBB requires the
   * Custom Conversion to be configured to use dynamic value from the pixel event,
   * and the frontend must fire correct `value` params. Setting 'VALUE' here also
   * suppresses COST_CAP bid strategy in meta-ads.service (incompatible combo).
   */
  metaOptimizationGoal?: string;
  /**
   * When true, all ad creative for this product OMITS price (₹X) from copy,
   * headlines, image overlays, and video CTA frames. Use for premium/spiritual
   * products where price-anchoring in cold ads kills exploration intent — the
   * landing page handles pricing after the curiosity hook has landed. Affects
   * creative-team prompts (skip "price in every variant" rule) and copy-writer
   * (strip price line from briefFacts product block). Default false = price
   * required in every variant (current behavior for proven mass-tier products).
   */
  hidePriceInCreative?: boolean;

  // Audience data
  audienceSegments?: AudienceSegment[];
  metaAudiences?: MetaAudience[];

  // Performance data (populated by Learning Team over time)
  performance?: ProductPerformance;
}

export interface Service {
  name: string;
  description: string;
  active: boolean;
}

export interface Promotion {
  name: string;
  details: string;
  expiresAt: Date;
}

export interface DeliveryConfig {
  slackWebhook?: string;
  whatsappNumber?: string;
  email?: string;
  notionDatabaseId?: string;
}

export type MetaSpecialAdCategory = 'CREDIT' | 'EMPLOYMENT' | 'HOUSING' | 'ISSUES_ELECTIONS_POLITICS';

export interface MetaAdsConfig {
  accessToken: string;    // Meta Ads API access token (per tenant)
  accountId: string;      // Primary Meta Ads account ID (e.g. act_123456)
  accountIds?: string[];  // All Meta Ads account IDs — importer pulls from all of them
  pixelId?: string;       // Meta Pixel for conversion tracking (shared across accounts)
  pageId?: string;        // Facebook Page ID for ad identity
  /**
   * Meta-required special-ad-categories declaration. MUST be set for tenants in
   * regulated verticals — credit (loans/EMI), employment (hiring/jobs), housing
   * (rentals/sales), or social issues / elections / politics. Running ads in
   * these verticals without the declaration is a high-severity Meta policy
   * violation and risks Business Manager restriction.
   */
  specialAdCategories?: MetaSpecialAdCategory[];
}

export interface CompanyPrompts {
  instagramScout: string;
  redditScout: string;
  twitterScout: string;
  youtubeScout: string;
  coordinator: string;
  competitorResearch: string;
  marketResearch: string;
  metaAdsLibrary: string;
  ideaPool: string;
  digestWriter: string;
  campaignCreator: string;
  // Phase 9 — agent team lead prompts
  intelligenceLead?: string;
  strategyTeamLead?: string;
  creativeTeamLead?: string;
}

// Phase 9 — rolling 7-day observations written by Performance Marketing Expert
export interface WeeklySignals {
  observations: string[];
  lastUpdated: Date;
}

export interface CompanySignals {
  weekly: WeeklySignals;
}

export type CampaignStrategy = 'conservative' | 'balanced' | 'experimental';

export interface PipelineConfig {
  mode: 'daily' | 'weekly';
  ideasPerRun: number;       // how many ideas to generate per run (1-10)
  autoSwitch: boolean;       // auto switch daily → weekly after cold start
  coldStartDays: number;     // days to run daily before switching (default 14)
  campaignStrategy: CampaignStrategy;  // controls risk tolerance for all teams
  // conservative: only proven winners — hooks, audiences, formats with data
  // balanced (default): proven winners + 1 new test idea per run
  // experimental: all new ideas, maximum testing, higher risk
  pauseGracePeriodHours: number;     // hours before auto-pausing a flagged ad/ad set (default: 12)
  scaleRequiresApproval: boolean;    // scaling budget always needs human approval (default: true)
  teamMode: 'cli' | 'sequential';   // cli = 2-agent tmux debate (~100% quality, ~65% reliable); sequential = 2 runAgent() calls (~95% quality, ~99% reliable)

  // Heygen avatar video config — set once per tenant via settings
  // Discover IDs via GET /v2/avatars and GET /v2/voices on Heygen API
  heygenAvatarId?: string;          // e.g. "Priya_public_..." — pick an Indian-looking avatar from /v2/avatars
  heygenVoiceId?: string;           // e.g. Hindi voice from /v2/voices filtered by language="Hindi"
  heygenBackgroundUrl?: string;     // optional image URL for background; defaults to dark navy #1a1a2e
}

export interface CreativeLearnings {
  winningHooks: string[];        // hook styles that drove high CTR
  losingHooks: string[];         // hook styles that consistently underperformed
  winningFormats: string[];      // formats (Reels, Stories, Feed) with best engagement
  losingFormats: string[];       // formats to avoid for this brand
  ctaInsights: string[];         // which CTA styles drive conversions
  copyToneInsights: string[];    // tone patterns that resonate (aspirational, urgent, etc.)
  visualInsights: string[];      // image/video patterns that performed well

  /**
   * Hook saturation per (audienceType → hookStyle → { pct, updatedAt }).
   * Updated by the audit loop after each campaign-level signal-detector pass.
   * Per-entry timestamps enable decay: LiveContextBuilder filters entries older
   * than ~14 days so the generator isn't permanently locked out of a hookStyle
   * after one over-exposure event.
   *
   * Pre-B2 this was a flat number map merged via Math.max — monotonic, never
   * decayed, by month 3 the generator was restricted to 2-3 hookStyles for
   * the broadest audience. Now: each audit overwrites per-entry with current
   * value + timestamp; readers filter by age.
   */
  audienceHookSaturation?: Record<string, Record<string, { pct: number; updatedAt: Date }>>;
  audienceHookSaturationUpdatedAt?: Date;

  /**
   * Verbatim winning hook lines extracted from past Day-7 quick scans. Stored
   * as exemplars (not just hookStyle labels) so the Creative Team can anchor
   * on real examples of phrasings that converted, not abstract category names.
   * Top 5 by CTR are injected into Call 1 prompt as inspiration (NOT for direct
   * copying — the LLM should learn the pattern, not repeat the line).
   */
  winningExemplars?: Array<{
    hookLine: string;            // verbatim primaryText opening line
    hookStyle: string;
    audienceSegment?: string;    // which audience this won on
    /**
     * Which product this exemplar won FOR. Without it, a Nadi Leaf brief
     * anchored on Nadi Report's winners (different price tier, different
     * buyer intent) — the cross-product exemplar leak. Readers filter by
     * brief.product first, falling back to the full pool when thin.
     */
    product?: string;
    ctr: number;                 // CTR % at time of extraction
    sampleSize: number;          // total impressions when measured
    extractedAt: Date;
  }>;

  /**
   * Recent live within-campaign variant comparisons that CONTRADICT historical
   * winningHooks/losingHooks claims. Populated by the live arbitrator inside
   * the Day-7 quick scan when a campaign with 3+ variants and ≥₹3K spend on
   * its leader produces a CPA ranking where the live winner's hookStyle is
   * currently in `losingHooks` OR strictly outranks another hookStyle that
   * is itself listed earlier in `winningHooks`.
   *
   * The bar is intentionally lower than `winningExemplars` (which requires
   * ≥10 conversions per ad). Counter-signals are recency-weighted *flags* —
   * they don't move the historical lists; they surface fresh disconfirming
   * evidence into LiveContext so the Creative Team and Campaign Review Team
   * see "your historical pain_point claim was beaten head-to-head by
   * curiosity_gap last week."
   *
   * Decay in LiveContext: only entries from the last 21 days are rendered.
   */
  liveCounterSignals?: Array<{
    winningHookStyle: string;     // the hookStyle that won live
    losingHookStyle: string;      // the historical "winner" (or higher-ranked) hookStyle that lost
    audienceType: string;         // which audience the head-to-head ran on
    productName?: string;
    campaignId: string;           // for traceability
    winnerCPA: number;
    loserCPA: number;
    deltaCPA: number;             // loserCPA - winnerCPA (positive = loser was worse)
    winnerSpend: number;
    observedAt: Date;
  }>;
}

/**
 * Per-audience ROAS entry. Old data may have stored a bare `number` here —
 * readers MUST handle the union (see normalizeAudienceScore() in live-context.builder.ts).
 *
 * `n` is the campaign count that produced this ROAS. Anything < 5 is low-confidence
 * and Campaign Review may not override the strategist's audience pick citing it alone.
 */
export interface AudienceScoreEntry {
  roas: number;
  n: number;            // sample size — campaigns aggregated into this score
  updatedAt: Date;
}

/**
 * Distinguishes "audience underperforms" from "offer-audience fit issue."
 * Written when a causal insight is audience_mismatch BUT CTR was healthy and
 * conversions collapsed — i.e. the audience clicked, the offer/lander didn't close.
 * Without this, the same finding tanks `audienceScores[audienceType]` and the
 * audience gets permanently exiled even though the real fix is offer/lander/price.
 */
export interface OfferAudienceFitIssue {
  audienceType: string;     // e.g. "retarget", "lookalike", "advantage_plus"
  productName: string;      // which product hit the friction
  issue: string;            // human-readable description of the fit gap
  dataPoints: number;       // # of campaigns observed with the same pattern
  lastUpdated: Date;
}

export interface CampaignLearnings {
  audienceScores: Record<string, AudienceScoreEntry | number>;  // audience segment → avg ROAS (entry preferred; number is legacy) — TENANT-AGGREGATE (no product attribution)
  platformROAS: Record<string, number>;    // platform → avg ROAS
  budgetInsights: string[];                // budget size/structure patterns
  timingInsights: string[];                // day of week, season, time of day patterns
  objectiveInsights: string[];             // which objectives work for this brand
  /**
   * Offer-audience fit issues — see OfferAudienceFitIssue. Separate from
   * audienceScores so an offer-fit problem on retargeting at one price point
   * doesn't permanently brand the audience as bad.
   */
  offerAudienceFitIssues?: OfferAudienceFitIssue[];
  /**
   * Per-product audience-ROAS breakdown. audienceScores above is tenant-aggregate
   * and conflates economics across products with very different price tiers
   * (e.g. lookalike ROAS on ₹1,799 Nadi Report ≠ on ₹10K Nadi Leaf). This field
   * keeps the breakdown so LiveContext can render the right scope per brief:
   *
   *   audienceScoresByProduct["Nadi Report"]["lookalike"] = { roas: 2.8, n: 12 }
   *   audienceScoresByProduct["Nadi Leaf Reading"]["lookalike"] = { roas: ?, n: 0 }
   *
   * Readers should prefer this for per-brief context. Fall back to tenant-aggregate
   * audienceScores ONLY with explicit "may not transfer" framing. Writer populates
   * both fields in parallel so existing readers keep working during migration.
   */
  audienceScoresByProduct?: Record<string, Record<string, AudienceScoreEntry>>;
}

export interface CausalInsight {
  finding: string;           // human-readable pattern
  isolatedVariable: string;  // which variable was isolated (format, hook, audience, etc.)
  controlledFor: string[];   // what was held constant across compared campaigns
  rootCause: 'creative_issue' | 'audience_mismatch' | 'format_mismatch' | 'topic_exhaustion' | 'timing_issue' | 'budget_issue';
  confidence: number;        // 0.0–1.0
  dataPoints: number;        // how many campaigns this is based on
  /**
   * Product the insight applies to (when known). Used as part of the cluster
   * key in appendOrConsolidateCausalInsight to merge near-duplicate N=1 entries
   * into a single high-confidence finding instead of accumulating 6 lookalikes.
   */
  productName?: string;
  /**
   * Optional product/audience tags written by the consolidator so future
   * merges can preserve and increment metadata across rebuilds.
   */
  audienceType?: string;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
}

/**
 * A live or recently-paused winning ad — used to drive the "exploit" arm in
 * the Strategy Team and inspire next-week briefs that clone the winner's
 * hookStyle × audienceType × format × budget tier while varying topic/angle.
 *
 * Written by the audit loop at Day ≥ 3 when an AD (not just ad set) crosses
 * a strict winner gate: ROAS ≥ 2× breakeven AND ≥10 conversions on that ad.
 * Read by Strategy Team (clone arm), Creative Team (anchor pattern), and
 * Campaign Review (skip cold-start budget cut for clones).
 *
 * Recency-decayed in LiveContext (60d window) so an old winner doesn't
 * permanently override exploration.
 */
export interface HotWinner {
  campaignId: string;          // source campaign Mongo _id
  briefId: string;
  metaAdId: string;            // the specific winning ad
  productName?: string;
  hookStyle: string;
  audienceType: string;        // e.g. 'advantage_plus', 'lookalike', 'retarget'
  format?: 'video' | 'image' | 'carousel';
  topic?: string;              // for diversifying clones (avoid repeating the exact topic)
  hookLine?: string;           // verbatim primaryText opening line (anchor pattern, NOT for copy-paste)
  spend: number;
  conversions: number;
  cpa: number;
  roas: number;
  ctr: number;
  budgetTier: number;          // the daily budget the winner was launched at — clones default to this
  observedAt: Date;
}

export interface CompanyLearnings {
  version: number;
  updatedAt: Date;
  topicScores: Record<string, number>;   // topic → performance score (cross-cutting)
  creative: CreativeLearnings;
  campaign: CampaignLearnings;
  causalInsights: CausalInsight[];
  /**
   * Top recent winning ads, capped at MAX_HOT_WINNERS, recency-decayed to 60d
   * by readers. Drives the Strategy Team's exploit-winner arm.
   */
  hotWinners?: HotWinner[];
}
