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
