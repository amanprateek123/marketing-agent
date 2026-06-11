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
  META_ADS_LIBRARY = 'meta_ads_library',
  // Phase 9 — Agent Team leads
  STRATEGY_TEAM_LEAD = 'strategy_team_lead',
  CREATIVE_TEAM_LEAD = 'creative_team_lead',
  CAMPAIGN_REVIEW_LEAD = 'campaign_review_lead',
  // Learning
  CASE_STUDY_GENERATOR = 'case_study_generator',
  // Post-generation creative QA — vision check on rendered images
  CREATIVE_QA = 'creative_qa',
}

export type ClaudeModel = 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';

// Agents that use Haiku (cheap — scouts do data fetching, no reasoning needed)
export const HAIKU_AGENTS: AgentType[] = [
  AgentType.INSTAGRAM_SCOUT,
  AgentType.REDDIT_SCOUT,
  AgentType.TWITTER_SCOUT,
  AgentType.YOUTUBE_SCOUT,
  AgentType.MARKET_RESEARCH,
  AgentType.CASE_STUDY_GENERATOR,
  AgentType.DIGEST_WRITER,        // summarization — no reasoning needed
  AgentType.META_ADS_LIBRARY,        // ad library scraping — structured output, no deep reasoning
  AgentType.CREATIVE_QA,             // vision pass/fail on rendered images — perception, not reasoning
];

// Phase 9 team leads — get TeamCreate, Agent, SendMessage on top of web tools
export const TEAM_LEAD_AGENTS: AgentType[] = [
  AgentType.STRATEGY_TEAM_LEAD,
  AgentType.CREATIVE_TEAM_LEAD,
  AgentType.CAMPAIGN_REVIEW_LEAD,
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
  AgentType.CASE_STUDY_GENERATOR,
];

export interface RunAgentParams {
  tenantId: string;
  agentType: AgentType;
  systemPrompt: string;
  /**
   * Legacy: appended to systemPrompt. Used by all agents that haven't migrated yet.
   * New code should prefer `userContext` so tenant data lives in the user message,
   * separate from instructions.
   */
  liveContext: string;
  /**
   * Tenant data (products, prices, learnings, calendar, etc.) prepended to userMessage
   * under a `## TENANT CONTEXT` header. Keeps systemPrompt purely instructional.
   */
  userContext?: string;
  userMessage: string;
  model?: ClaudeModel;
  maxTurns?: number;
  runId?: string;
  /**
   * Extended thinking config. When set, the model can do hidden chain-of-thought
   * before emitting final output — useful for agents that must produce JSON-only
   * but need real reasoning (e.g. the audit agent at maxTurns=1).
   *
   * Accepted shapes (per Claude Agent SDK):
   *   { type: 'enabled', budgetTokens: 4000 }
   *   { type: 'adaptive' }                        // Opus 4.6+ only
   *   { type: 'disabled' }
   */
  thinking?: { type: 'enabled'; budgetTokens?: number } | { type: 'adaptive' } | { type: 'disabled' };
  /**
   * Skill names to preload into the agent's context per Claude Agent SDK's
   * `skills` option. Each name must match a directory in `.claude/skills/`.
   * Without this, skills sit on disk but are NOT in agent context — even if
   * the prompt references them. Pass the per-agent list from agent-skill-map.ts.
   */
  skills?: string[];
  /**
   * Explicit tool allowlist override. When set, takes precedence over the
   * NO_TOOL_AGENTS / TEAM_LEAD_AGENTS routing. Used by CREATIVE_QA, which
   * needs exactly ['Read'] to view a downloaded image file — vision via the
   * Read tool is the only image path through the Agent SDK.
   */
  allowedTools?: string[];
}

export interface AgentResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}
