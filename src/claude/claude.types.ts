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
}

export type ClaudeModel = 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';

// Agents that use Haiku (cheap, single-turn, formatting tasks)
export const HAIKU_AGENTS: AgentType[] = [
  AgentType.MARKET_RESEARCH,
  AgentType.DIGEST_WRITER,
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
