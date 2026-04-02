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
}

export interface PipelineConfig {
  mode: 'daily' | 'weekly';
  ideasPerRun: number;       // how many ideas to generate per run (1-10)
  autoSwitch: boolean;       // auto switch daily → weekly after cold start
  coldStartDays: number;     // days to run daily before switching (default 14)
}

export interface CompanyLearnings {
  version: number;
  updatedAt: Date;
  topicScores: Record<string, number>;
  winningPatterns: {
    hooks: string[];
    formats: string[];
    audiences: string[];
  };
  losingPatterns: {
    hooks: string[];
    formats: string[];
  };
  audienceInsights: string[];
}
