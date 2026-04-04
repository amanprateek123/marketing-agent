export enum AgentType {
  INSTAGRAM_SCOUT = 'instagram_scout',
  REDDIT_SCOUT = 'reddit_scout',
  TWITTER_SCOUT = 'twitter_scout',
  YOUTUBE_SCOUT = 'youtube_scout',
  COORDINATOR = 'coordinator',
  COMPETITOR_RESEARCH = 'competitor_research',
  MARKET_RESEARCH = 'market_research',
  IDEA_POOL = 'idea_pool',
  DIGEST_WRITER = 'digest_writer',
  CREATIVE_PRODUCER = 'creative_producer',
  CAMPAIGN_CREATOR = 'campaign_creator',
  CAMPAIGN_AUDITOR = 'campaign_auditor',
  LEARNING_AGENT = 'learning_agent',
  PROMPT_GENERATOR = 'prompt_generator',
  CREATIVE_LEARNING_AGENT = 'creative_learning_agent',
  CAMPAIGN_LEARNING_AGENT = 'campaign_learning_agent',
  // Phase 9 — Agent Team leads
  STRATEGY_TEAM_LEAD = 'strategy_team_lead',
  CREATIVE_TEAM_LEAD = 'creative_team_lead',
  CAMPAIGN_REVIEW_LEAD = 'campaign_review_lead',
}

export type ClaudeModel = 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';

// Agents that use Haiku (cheap, single-turn, formatting tasks)
export const HAIKU_AGENTS: AgentType[] = [
  AgentType.MARKET_RESEARCH,
];

// Phase 9 team leads — get TeamCreate, Agent, SendMessage on top of web tools
export const TEAM_LEAD_AGENTS: AgentType[] = [
  AgentType.STRATEGY_TEAM_LEAD,
];

// Agents that don't need any tools (pure text generation — no web search needed)
export const NO_TOOL_AGENTS: AgentType[] = [
  AgentType.PROMPT_GENERATOR,
  AgentType.COORDINATOR,
  AgentType.IDEA_POOL,
  AgentType.DIGEST_WRITER,
  AgentType.CREATIVE_PRODUCER,
  AgentType.CAMPAIGN_CREATOR,
  AgentType.CAMPAIGN_AUDITOR,
  AgentType.LEARNING_AGENT,
  AgentType.CREATIVE_LEARNING_AGENT,
  AgentType.CAMPAIGN_LEARNING_AGENT,
];

export interface RunAgentParams {
  tenantId: string;
  agentType: AgentType;
  systemPrompt: string;
  liveContext: string;
  userMessage: string;
  model?: ClaudeModel;
  maxTurns?: number;
  runId?: string;
}

export interface AgentResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}
