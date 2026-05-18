export interface AudienceSegment {
  name: string;                    // e.g. "career_anxious"
  description: string;             // e.g. "25-40 professionals worried about career"
  ageMin: number;
  ageMax: number;
  gender: 'all' | 'male' | 'female';
  interests: string[];             // Meta interest targeting keywords
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
  customEventName?: string;          // if conversionEvent is "CustomEvent", this is the event name (e.g. "NADI_REPORT_PURCHASE_COMPLETED")
  customConversionId?: string;       // Meta Custom Conversion ID — takes priority, sends pixel_id + custom_conversion_id to Meta
  pixelId?: string;                  // Meta Pixel ID if different from company.meta.pixelId

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
    ctr: number;                 // CTR % at time of extraction
    sampleSize: number;          // total impressions when measured
    extractedAt: Date;
  }>;
}

export interface CampaignLearnings {
  audienceScores: Record<string, number>;  // audience segment → avg ROAS
  platformROAS: Record<string, number>;    // platform → avg ROAS
  budgetInsights: string[];                // budget size/structure patterns
  timingInsights: string[];                // day of week, season, time of day patterns
  objectiveInsights: string[];             // which objectives work for this brand
}

export interface CausalInsight {
  finding: string;           // human-readable pattern
  isolatedVariable: string;  // which variable was isolated (format, hook, audience, etc.)
  controlledFor: string[];   // what was held constant across compared campaigns
  rootCause: 'creative_issue' | 'audience_mismatch' | 'format_mismatch' | 'topic_exhaustion' | 'timing_issue' | 'budget_issue';
  confidence: number;        // 0.0–1.0
  dataPoints: number;        // how many campaigns this is based on
}

export interface CompanyLearnings {
  version: number;
  updatedAt: Date;
  topicScores: Record<string, number>;   // topic → performance score (cross-cutting)
  creative: CreativeLearnings;
  campaign: CampaignLearnings;
  causalInsights: CausalInsight[];
}
