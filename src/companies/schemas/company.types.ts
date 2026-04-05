export interface Product {
  name: string;
  price: number;
  currency: string;
  description: string;
  active: boolean;
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

export interface MetaAdsConfig {
  accessToken: string;    // Meta Ads API access token (per tenant)
  accountId: string;      // Meta Ads account ID (e.g. act_123456)
  pixelId?: string;       // Meta Pixel for conversion tracking
  pageId?: string;        // Facebook Page ID for ad identity
}

export interface CompanyPrompts {
  instagramScout: string;
  redditScout: string;
  twitterScout: string;
  youtubeScout: string;
  coordinator: string;
  competitorResearch: string;
  marketResearch: string;
  ideaPool: string;
  digestWriter: string;
  campaignCreator: string;
  // Phase 9 — agent team lead prompts
  intelligenceLead?: string;
}

// Phase 9 — rolling 7-day observations written by Performance Marketing Expert
export interface WeeklySignals {
  observations: string[];
  lastUpdated: Date;
}

export interface CompanySignals {
  weekly: WeeklySignals;
}

export interface PipelineConfig {
  mode: 'daily' | 'weekly';
  ideasPerRun: number;       // how many ideas to generate per run (1-10)
  autoSwitch: boolean;       // auto switch daily → weekly after cold start
  coldStartDays: number;     // days to run daily before switching (default 14)
}

export interface CreativeLearnings {
  winningHooks: string[];        // hook styles that drove high CTR
  losingHooks: string[];         // hook styles that consistently underperformed
  winningFormats: string[];      // formats (Reels, Stories, Feed) with best engagement
  losingFormats: string[];       // formats to avoid for this brand
  ctaInsights: string[];         // which CTA styles drive conversions
  copyToneInsights: string[];    // tone patterns that resonate (aspirational, urgent, etc.)
  visualInsights: string[];      // image/video patterns that performed well
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
