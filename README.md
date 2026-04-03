# BriefOS — Phase-by-Phase Build Guide

> **Stack:** Node.js + NestJS + TypeScript + Claude Code SDK + MongoDB + BullMQ + Redis + Meta Ads MCP
>
> **Runtime:** Node.js (not Bun — bottleneck is AI API calls, not runtime speed)
>
> **Framework:** NestJS (DI, modules, guards, interceptors — built for this complexity)
>
> **Timeline:** 12 weeks across 8 phases
>
> **Last Updated:** April 2026

---

## Table of Contents

1. [Pre-Build Setup](#pre-build-setup)
2. [Phase 1 — Foundation (Week 1–2)](#phase-1--foundation-week-12)
3. [Phase 2 — Intelligence Pipeline + Scout Validation (Week 3–5)](#phase-2--intelligence-pipeline--scout-validation-week-35)
4. [Phase 3 — Scheduling + Delivery (Week 6)](#phase-3--scheduling--delivery-week-6)
5. [Phase 4 — Creative Production (Week 7–8)](#phase-4--creative-production-week-78)
6. [Phase 5 — Campaign Execution (Week 9)](#phase-5--campaign-execution-week-9)
7. [Phase 6 — Auditor + Optimizer (Week 10)](#phase-6--auditor--optimizer-week-10)
8. [Phase 7 — Learning System (Week 11)](#phase-7--learning-system-week-11)
9. [Phase 8 — Production + Multi-Tenant (Week 12)](#phase-8--production--multi-tenant-week-12)
10. [Phase 9 — Agent Team Review System (Planned)](#phase-9--agent-team-review-system-planned)
11. [Project Structure (Final)](#project-structure-final)
12. [Environment Variables](#environment-variables)
13. [Docker Compose](#docker-compose)
14. [Database Collections Reference](#database-collections-reference)
15. [API Routes Reference](#api-routes-reference)
16. [Skills Reference](#skills-reference)
17. [Key Decisions Log](#key-decisions-log)

---

## Pre-Build Setup

### 1. Initialize NestJS Project

```bash
# Install NestJS CLI globally
npm install -g @nestjs/cli

# Create project
nest new briefos --strict --package-manager npm

# Navigate into project
cd briefos
```

### 2. Install Core Dependencies

```bash
# NestJS ecosystem
npm install @nestjs/mongoose mongoose
npm install @nestjs/bullmq bullmq ioredis
npm install @nestjs/config
npm install @nestjs/throttler
npm install @nestjs/schedule

# Claude Code SDK
npm install @anthropic-ai/claude-code

# HTTP client (for external APIs)
npm install axios

# Validation
npm install class-validator class-transformer

# AWS S3
npm install @aws-sdk/client-s3

# Utilities
npm install uuid dayjs lodash
npm install -D @types/lodash @types/uuid
```

### 3. Setup .claude/ Directory

```bash
mkdir -p .claude/skills .claude/agents .claude/commands

# Create CLAUDE.md — project context for Claude Code SDK
touch .claude/CLAUDE.md

# Create MCP config for Meta Ads
touch .claude/mcp.json
```

**.claude/mcp.json:**
```json
{
  "mcpServers": {
    "meta-ads": {
      "command": "npx",
      "args": ["-y", "@pipeboard/meta-ads-mcp"],
      "env": {
        "META_ADS_ACCESS_TOKEN": "${META_ADS_ACCESS_TOKEN}",
        "META_ADS_ACCOUNT_ID": "${META_ADS_ACCOUNT_ID}"
      }
    }
  }
}
```

### 4. Copy Skills Into .claude/skills/

```
.claude/skills/
├── — from coreyhaines31/marketingskills —
├── paid-ads/
├── ad-creative/
├── product-marketing-context/
├── marketing-psychology/
├── competitor-alternatives/
├── customer-research/
├── copywriting/
├── social-content/
│
├── — from everything-claude-code —
├── continuous-learning-v2/
├── autonomous-loops/
├── cost-aware-llm-pipeline/
├── verification-loop/
├── iterative-retrieval/
└── market-research/
```

### 5. Setup Environment

```bash
cp .env.example .env
# Fill in all keys (see Environment Variables section below)
```

---

## Phase 1 — Foundation (Week 1–2)

> **Goal:** Working NestJS app with MongoDB, Claude Code SDK wrapper, company CRUD, and Prompt Generator with hybrid architecture.
>
> **Exit Criteria:** Can register a company, auto-generate 9 agent prompts, and verify prompts are stored in MongoDB.

### Step 1.1 — NestJS App Structure + Config Module

Create the base module structure:

```
src/
├── app.module.ts                    # Root module — imports all feature modules
├── main.ts                          # Bootstrap NestJS app
├── config/
│   ├── config.module.ts             # @nestjs/config setup
│   └── configuration.ts             # Typed config factory
```

**What to build:**

- `main.ts` — bootstrap with `NestFactory.create()`, set global prefix `/api/v1`, enable CORS, set port from config
- `configuration.ts` — typed config loading from .env using `@nestjs/config`:
  - `mongo.uri`
  - `redis.url`
  - `claude.apiKey`
  - `meta.accessToken`, `meta.accountId`
  - `n8n.webhookUrl`, `n8n.webhookSecret`
  - `aws.accessKeyId`, `aws.secretAccessKey`, `aws.s3Bucket`, `aws.region`
  - `ideogram.apiKey`, `fal.apiKey`, `kling.apiKey`
  - `app.port`, `app.env`
- `app.module.ts` — import `ConfigModule.forRoot({ isGlobal: true })` and `MongooseModule.forRootAsync()`

### Step 1.2 — MongoDB Connection + Base Schemas

```
src/
├── database/
│   └── database.module.ts           # MongooseModule.forRootAsync()
```

**What to build:**

- `database.module.ts` — async MongoDB connection using config service
- Ensure connection uses `briefos` database name
- Add connection event logging (connected, error, disconnected)

### Step 1.3 — Companies Module

```
src/
├── companies/
│   ├── companies.module.ts
│   ├── companies.controller.ts
│   ├── companies.service.ts
│   ├── schemas/
│   │   ├── company.schema.ts        # CompanyProfile + MarketingRequirements
│   │   └── company.types.ts         # TypeScript interfaces
│   ├── dto/
│   │   ├── create-company.dto.ts    # Validation with class-validator
│   │   └── update-company.dto.ts
│   └── prompt-generator/
│       ├── prompt-generator.service.ts
│       └── live-context.builder.ts  # Runtime data injection
```

**company.schema.ts — Key Fields:**

```typescript
// CompanyProfile (set once at registration)
{
  tenantId: string;              // unique, indexed
  name: string;
  industry: string;
  products: Product[];           // { name, price, currency, description, active }
  services: Service[];
  targetAudience: string;
  audiencePersonas: string[];
  customerLanguage: string[];
  tone: string;
  avoid: string[];
  competitors: string[];
  platforms: string[];           // ["instagram", "reddit", "twitter", "youtube"]
  geography: string;
  language: string;
  uniqueValue: string;
  calendarContext: string;
  competitorNotes: string;
  brandGuidelines: string;
  delivery: {
    slackWebhook?: string;
    whatsappNumber?: string;
    email?: string;
    notionDatabaseId?: string;
  };
}

// MarketingRequirements (set once, updatable anytime)
{
  weeklyBudgetCap: number;
  maxBudgetPerCampaign: number;
  maxBudgetScalePercent: number;
  primaryObjective: 'conversions' | 'awareness' | 'traffic' | 'leads';
  targetROAS?: number;
  targetCPA?: number;
  pauseIfROASBelow?: number;
  pauseIfCTRBelow?: number;
  pauseIfFrequencyAbove?: number;
  pauseAfterDaysInLearning?: number;
  scaleIfROASAbove?: number;
  forbiddenTopics: string[];
  preferredFormats: string[];
  campaignsPerRun: number;
  runFrequency: 'weekly' | 'biweekly';
}

// Generated — not set by user
{
  prompts: {
    instagramScout: string;
    redditScout: string;
    twitterScout: string;
    youtubeScout: string;
    coordinator: string;
    competitorResearch: string;
    marketResearch: string;
    ideaPool: string;
    digestWriter: string;
  };
  learnings: {
    version: number;
    updatedAt: Date;
    topicScores: Record<string, number>;
    winningPatterns: { hooks: string[]; formats: string[]; audiences: string[] };
    losingPatterns: { hooks: string[]; formats: string[] };
    audienceInsights: string[];
  };
}
```

**companies.controller.ts — Routes:**

```
POST   /api/v1/companies                        → create company + auto-generate prompts
GET    /api/v1/companies                        → list all (no prompts in response)
GET    /api/v1/companies/:tenantId              → full details
PUT    /api/v1/companies/:tenantId              → update profile/requirements
POST   /api/v1/companies/:tenantId/regenerate   → re-run prompt generation manually
```

**companies.service.ts — Key Logic:**

- `create()` → validate DTO → save to MongoDB → call `promptGenerator.generate()` → save prompts
- `update()` → save changes → if prompt-relevant fields changed (products, tone, audience, competitors, brandGuidelines) → auto-call `promptGenerator.generate()`
- `findByTenantId()` → return full company document
- `list()` → return all companies WITHOUT prompts field (projection)

### Step 1.4 — Claude Code SDK Wrapper

```
src/
├── claude/
│   ├── claude.module.ts
│   ├── claude.service.ts            # Wraps query() from @anthropic-ai/claude-code
│   ├── schemas/
│   │   └── usage-log.schema.ts      # Every query() call logged
│   └── claude.types.ts              # AgentType enum, model routing config
```

**claude.service.ts — Core Methods:**

```typescript
import { query } from '@anthropic-ai/claude-code';

@Injectable()
export class ClaudeService {
  // Core method — every agent call goes through here
  async runAgent(params: {
    tenantId: string;
    agentType: AgentType;
    systemPrompt: string;        // Strategic prompt from MongoDB
    liveContext: string;          // Runtime data from LiveContextBuilder
    userMessage: string;         // The actual task
    model?: 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';
    maxTurns?: number;
    runId?: string;
  }): Promise<AgentResult> {

    const finalSystemPrompt = `${params.systemPrompt}\n\n${params.liveContext}`;

    const result = await query({
      prompt: params.userMessage,
      options: {
        model: params.model || 'claude-sonnet-4-6',
        systemPrompt: finalSystemPrompt,
        maxTurns: params.maxTurns || 10,
        cwd: process.cwd(),      // gives access to .claude/ config
      },
    });

    // Log usage
    await this.logUsage({
      tenantId: params.tenantId,
      runId: params.runId,
      agent: params.agentType,
      model: params.model || 'claude-sonnet-4-6',
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
      costUSD: this.calculateCost(result.usage, params.model),
      timestamp: new Date(),
    });

    return {
      content: result.content,
      usage: result.usage,
    };
  }

  // Model routing helper
  getModel(agentType: AgentType): string {
    const haikuAgents = [AgentType.MARKET_RESEARCH, AgentType.DIGEST_WRITER];
    return haikuAgents.includes(agentType)
      ? 'claude-haiku-4-5-20251001'
      : 'claude-sonnet-4-6';
  }
}
```

**AgentType enum:**
```typescript
enum AgentType {
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
```

### Step 1.5 — Prompt Generator (Hybrid Architecture)

**prompt-generator.service.ts:**

```typescript
@Injectable()
export class PromptGeneratorService {
  // Reads all 14 skill files + company profile
  // Single query() call to Claude Sonnet
  // Writes 9 agent prompts — NO hardcoded products/prices/dates
  async generate(tenantId: string): Promise<CompanyPrompts> {

    const company = await this.companyService.findByTenantId(tenantId);
    const skillContents = await this.readAllSkills();

    const result = await this.claudeService.runAgent({
      tenantId,
      agentType: AgentType.PROMPT_GENERATOR,
      systemPrompt: PROMPT_GENERATOR_SYSTEM_PROMPT, // see below
      liveContext: '',  // not needed for prompt generation
      userMessage: JSON.stringify({
        companyProfile: company,
        skills: skillContents,
      }),
      model: 'claude-sonnet-4-6',
      maxTurns: 5,
    });

    // Parse 9 prompts from response
    const prompts = this.parsePrompts(result.content);

    // Validate each prompt (optional Haiku validation call)
    await this.validatePrompts(prompts, company);

    // Save to MongoDB
    await this.companyService.updatePrompts(tenantId, prompts);

    return prompts;
  }
}
```

**PROMPT_GENERATOR_SYSTEM_PROMPT (key instruction):**

```
You are a prompt engineering expert specializing in marketing AI agents.

CRITICAL RULES:
1. NEVER hardcode any product names, prices, offers, or calendar dates into the system prompts.
   These will be injected at runtime as live operational data.
2. Reference products/prices as "the company's current product catalog" or "active offerings"
3. Reference calendar events as "upcoming calendar events" or "current seasonal context"
4. Focus ONLY on: brand voice, audience psychology, frameworks, competitor positioning,
   strategic patterns, and proven methodologies from the skills provided.
5. Each prompt must be deeply specific to THIS company's industry, tone, and audience —
   but generic enough that price/product changes don't require regeneration.

Write 9 agent system prompts using the company profile and skill frameworks provided.
Return as JSON with keys: instagramScout, redditScout, twitterScout, youtubeScout,
coordinator, competitorResearch, marketResearch, ideaPool, digestWriter
```

**live-context.builder.ts:**

```typescript
@Injectable()
export class LiveContextBuilder {
  // Called before every agent query() — injects fresh data from MongoDB
  build(company: CompanyDocument): string {
    return `
## CURRENT PRODUCTS & PRICING (LIVE DATA — always use these, never cached values)
${company.products.filter(p => p.active).map(p => `- ${p.name}: ${p.currency}${p.price} — ${p.description}`).join('\n')}

## ACTIVE PROMOTIONS
${company.activePromotions?.length ? company.activePromotions.map(p => `- ${p.name}: ${p.details} (expires: ${p.expiresAt})`).join('\n') : 'None currently active'}

## UPCOMING CALENDAR EVENTS
${company.calendarContext}

## CURRENT LEARNINGS (v${company.learnings?.version || 0})
${company.learnings ? JSON.stringify(company.learnings, null, 2) : 'No learnings yet — first run'}
    `.trim();
  }
}
```

### Step 1.6 — Validation & Testing

- [ ] Register a test company via `POST /api/v1/companies` with 91Astrology profile
- [ ] Verify 9 prompts are generated and stored in MongoDB
- [ ] Verify prompts do NOT contain hardcoded prices or product names
- [ ] Update a product price via `PUT /api/v1/companies/:tenantId`
- [ ] Verify prompts are auto-regenerated (if prompt-relevant field changed)
- [ ] Verify `LiveContextBuilder.build()` returns current prices
- [ ] Check `usage_logs` collection has the prompt generation call logged

---

## Phase 2 — Intelligence Pipeline + Scout Validation (Week 3–5)

> **Goal:** Full intelligence pipeline — 4 scouts with deep research, coordinator, competitor/market research, idea pool, digest. Plus 1 week of scout quality validation.
>
> **Exit Criteria:** Pipeline produces ranked briefs with scores. Scout output passes manual quality review (avg 3.5+/5 across 20 runs).

### Step 2.1 — Pipeline Run Schema + State Machine

```
src/
├── pipeline/
│   ├── pipeline.module.ts
│   ├── schemas/
│   │   ├── pipeline-run.schema.ts
│   │   ├── scout-output.schema.ts
│   │   ├── scout-signal.schema.ts   # Signal freshness tracking
│   │   ├── intelligence-brief.schema.ts
│   │   └── creative-brief.schema.ts
```

**pipeline-run.schema.ts:**

```typescript
{
  tenantId: string;
  runId: string;                    // uuid
  status: 'pending' | 'scouts_running' | 'scouts_enriching' | 'intelligence_running'
        | 'idea_pool_running' | 'completed' | 'failed';
  phase: string;                    // current phase label
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  briefsGenerated: number;
  selectedBriefId?: string;
  costUSD: number;                  // accumulated from usage_logs
}
```

### Step 2.2 — Scout Base Service

```
src/
├── pipeline/
│   ├── scouts/
│   │   ├── scout-base.service.ts    # Deep research pattern + verification loop
│   │   ├── instagram.scout.ts
│   │   ├── reddit.scout.ts
│   │   ├── twitter.scout.ts
│   │   └── youtube.scout.ts
```

**scout-base.service.ts — Deep Research Pattern:**

Every scout follows this pattern (inspired by gpt-researcher, implemented natively):

```typescript
@Injectable()
export abstract class ScoutBase {
  abstract platform: string;
  abstract buildResearchPrompt(company: CompanyDocument, liveContext: string): string;

  async execute(company: CompanyDocument, runId: string): Promise<ScoutOutput> {
    const liveContext = this.liveContextBuilder.build(company);
    const systemPrompt = company.prompts[`${this.platform}Scout`];

    // The scout agent itself uses Claude's built-in web_search + the research
    // methodology baked into its system prompt by the Prompt Generator.
    // The system prompt instructs it to:
    //   1. Generate 4-5 diverse search queries from different angles
    //   2. Run them via web_search (built into Claude Code SDK)
    //   3. For Reddit/YouTube — also call platform APIs via bash tool
    //   4. Fetch full page content for top URLs
    //   5. Synthesize into structured findings with engagement data
    //   6. Score each signal on: recency, engagement proof, specificity, source quality

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      agentType: this.getAgentType(),
      systemPrompt,
      liveContext,
      userMessage: this.buildResearchPrompt(company, liveContext),
      maxTurns: 10,
      runId,
    });

    // Verification loop — validate JSON structure, retry if invalid (max 3)
    const output = await this.verifyAndParse(result, company, runId);

    // Store to scout_outputs
    await this.saveOutput(company.tenantId, runId, output);

    // Store individual signals to scout_signals (freshness tracking)
    await this.saveSignals(company.tenantId, output.trending_topics);

    return output;
  }
}
```

**Expected ScoutOutput structure:**

```typescript
interface ScoutOutput {
  platform: string;
  phase: 'A' | 'B';
  trending_topics: TrendingTopic[];
  format_insights: string[];
  hook_examples: string[];
  raw_summary: string;
}

interface TrendingTopic {
  topic: string;
  angle: string;                   // specific angle, not just topic name
  engagementProof: {
    metric: string;                // "upvotes", "views", "shares"
    value: number;
    source: string;                // URL
  };
  recency: 'high' | 'medium';     // high = last 7 days, medium = last 30
  specificity: 'high' | 'medium'; // specific angle vs generic topic
  sourceQuality: 'high' | 'medium';
  signalScore: number;            // composite score 1-10
  hash: string;                   // for dedup in scout_signals
}
```

### Step 2.3 — Platform-Specific Scout Implementations

**reddit.scout.ts:**
- System prompt instructs agent to use bash tool for Reddit API calls
- `curl "https://oauth.reddit.com/r/{subreddit}/hot?limit=25"` with auth headers
- Extracts real upvote counts, comment counts, post age
- Cross-references with web_search for broader Reddit discussion

**youtube.scout.ts:**
- Uses YouTube Data API via bash tool
- `curl "https://www.googleapis.com/youtube/v3/search?part=snippet&q={query}&type=video&order=viewCount&publishedAfter={7_days_ago}"` 
- Gets real view counts, publish dates, channel subscriber counts

**instagram.scout.ts:**
- Primarily web_search based (no public API)
- Supplemented by Apify scraper calls if configured
- Focuses on hashtag volume trends, reel format patterns, hook styles

**twitter.scout.ts:**
- Web_search for viral topics and tone signals
- Social listening proxy if configured
- Extracts engagement patterns, trending angles, language patterns

### Step 2.4 — Scout Coordinator

```
src/
├── pipeline/
│   ├── coordinator/
│   │   └── coordinator.service.ts
```

**coordinator.service.ts:**

- Receives all 4 Phase A scout outputs
- Runs Phase B enrichment: each scout reads the other 3 outputs
- Cross-platform validation: topic on 2+ platforms = HIGH confidence, 1 platform = MEDIUM
- Deduplicates topics across platforms
- Produces merged signal list with confidence scores

### Step 2.5 — Intelligence Agents

```
src/
├── pipeline/
│   ├── intelligence/
│   │   ├── competitor-research.service.ts
│   │   └── market-research.service.ts
```

**competitor-research.service.ts:**
- Uses `competitor-alternatives` + `market-research` skills (baked into system prompt)
- Identifies: what competitors DO, what they DON'T DO, messaging gaps, audience gaps, emotional gaps
- Each finding source-attributed with URL

**market-research.service.ts:**
- Model: Haiku (cheap, single-turn)
- Calendar events + urgency scoring (days until event)
- Historical performance lookup on similar past dates

### Step 2.6 — Idea Pool (Debate Agent)

```
src/
├── pipeline/
│   ├── idea-pool/
│   │   └── idea-pool.service.ts
```

**Scoring formula:**

```typescript
const topicScore = company.learnings?.topicScores?.[brief.topic] ?? 5.0;
const historicalMultiplier = topicScore / 5.0;
const finalScore = confidenceWeight * urgencyWeight * historicalMultiplier;
```

**Auto-selection logic (in TypeScript, not prompt):**

```typescript
// Filter against requirements BEFORE selection
const validBriefs = rankedBriefs.filter(brief => {
  // Forbidden topics check
  if (requirements.forbiddenTopics.some(t =>
    brief.topic.toLowerCase().includes(t.toLowerCase())
  )) return false;

  // Format preferences check
  if (requirements.preferredFormats.length > 0 &&
    !requirements.preferredFormats.includes(brief.format)
  ) return false;

  return true;
});

// Select top brief
const selectedBrief = validBriefs[0];
```

### Step 2.7 — Digest Writer

```
src/
├── pipeline/
│   ├── digest/
│   │   └── digest.service.ts
```

- Model: Haiku (cheap, formatting only)
- Formats weekly intelligence report as structured JSON
- Includes: selected brief + reasoning, all scored briefs, key signals, competitor gaps, calendar events

### Step 2.8 — Pipeline Orchestrator

```
src/
├── pipeline/
│   ├── orchestrator/
│   │   └── orchestrator.service.ts
```

**DAG execution pattern (autonomous-loops skill):**

```typescript
async runPipeline(tenantId: string): Promise<PipelineRun> {
  const run = await this.createRun(tenantId);
  const company = await this.companyService.findByTenantId(tenantId);

  try {
    // PHASE A — 4 scouts in parallel
    await this.updatePhase(run, 'scouts_running');
    const scoutOutputs = await Promise.all([
      this.instagramScout.execute(company, run.runId),
      this.redditScout.execute(company, run.runId),
      this.twitterScout.execute(company, run.runId),
      this.youtubeScout.execute(company, run.runId),
    ]);

    // PHASE B — scouts enrich with cross-platform signals
    await this.updatePhase(run, 'scouts_enriching');
    const enrichedOutputs = await this.coordinator.enrich(scoutOutputs, company, run.runId);

    // INTELLIGENCE — competitor + market research in parallel
    await this.updatePhase(run, 'intelligence_running');
    const [competitorData, marketData] = await Promise.all([
      this.competitorResearch.execute(company, enrichedOutputs, run.runId),
      this.marketResearch.execute(company, run.runId),
    ]);

    // IDEA POOL — debate + score + auto-select
    await this.updatePhase(run, 'idea_pool_running');
    const ideaPoolResult = await this.ideaPool.execute(
      company, enrichedOutputs, competitorData, marketData, run.runId
    );

    // DIGEST — format report
    const digest = await this.digestWriter.execute(company, ideaPoolResult, run.runId);

    // Complete
    await this.completeRun(run, ideaPoolResult.selectedBriefId);

    return run;
  } catch (error) {
    await this.failRun(run, error.message);
    throw error;
  }
}
```

### Step 2.9 — Pipeline API Routes

```
GET    /api/v1/pipeline/:tenantId/runs              → list all runs + status
GET    /api/v1/pipeline/:tenantId/runs/:runId        → run detail + all agent outputs
POST   /api/v1/pipeline/:tenantId/run                → trigger pipeline manually
GET    /api/v1/pipeline/:tenantId/briefs             → latest scored briefs
```

### Step 2.10 — Scout Validation Sprint (Week 5)

> **THIS IS THE MOST IMPORTANT WEEK IN THE ENTIRE BUILD**

**Process:**

1. Run the intelligence pipeline for 91Astrology 20–30 times over the week
2. For each run, manually review all 4 scout outputs
3. Score each scout output on a 1–5 scale across 4 dimensions:
   - **Relevance** — are the topics actually relevant to this company?
   - **Freshness** — are signals from the last 7–30 days, not stale?
   - **Specificity** — are angles specific ("Sade Sati career impact stories") not generic ("astrology trends")?
   - **Actionability** — could a human marketer use this signal to create an ad?
4. Track scores in a spreadsheet
5. If avg score < 3.5/5 for any scout → tune prompts, data sources, scoring rubric
6. Re-run and re-evaluate until all scouts consistently score 3.5+/5

**Scout quality evaluation schema:**

```
| Run # | Date | Scout | Topic | Relevance | Freshness | Specificity | Actionability | Avg | Notes |
|-------|------|-------|-------|-----------|-----------|-------------|---------------|-----|-------|
| 1     | ...  | Reddit| ...   | 4         | 5         | 3           | 4             | 4.0 | Good  |
```

**DO NOT proceed to Phase 3 until scout quality is validated.**

---

## Phase 3 — Scheduling + Delivery (Week 6)

> **Goal:** BullMQ scheduling for daily/weekly pipeline runs + n8n delivery to Slack/WhatsApp/Email + tenant feedback collection.
>
> **Exit Criteria:** Pipeline runs automatically per tenant schedule. Report arrives in Slack. Tenant can approve/reject ideas via Slack reactions.

### Product Flow (agreed)

#### Cold Start (Week 1-2) — Daily mode
```
Every day:
  → 4 scouts research trending + viral signals
  → Coordinator synthesises cross-platform signals
  → Competitor Research + Market Research run in parallel
  → Idea Pool generates N ideas in 3 buckets (tenant-configured, default 5), rule-based winner selection
  → Digest sent to tenant via Slack/WhatsApp
  → Tenant reacts per idea: ✅ good / ❌ bad
  → Feedback stored in MongoDB
```

#### End of Cold Start — Learning checkpoint
```
Learning Agent runs:
  → Analyses all approvals + rejections
  → Extracts patterns: topics, angles, formats, sources tenant likes
  → Updates company.learnings
  → Confidence check:
      > 60% approval rate → switch to weekly (autoSwitch)
      40-60% → extend daily one more week
      < 40% → alert, human review needed
```

#### Steady State (Week 3+) — Weekly mode
```
Every Monday:
  → Same pipeline, informed by learnings
  → Tenant picks 1 winner from N ideas
  → Winner goes to creative production (Phase 4)
  → Campaign launches (Phase 5)
  → Performance tracked (Phase 6)
  → Learning agent updates monthly (Phase 7)
```

### Tenant Pipeline Configuration
Each tenant controls their own pipeline via `pipelineConfig` on the company document:
```json
{
  "mode": "daily | weekly",
  "ideasPerRun": 3,        // 1-10, how many ideas per run
  "autoSwitch": true,      // auto switch daily → weekly after cold start
  "coldStartDays": 14      // days to run daily before switching
}
```

### Idea Sources
Ideas can originate from any of these sources — tracked per idea:
- **Scout signals** — what's trending on each platform right now
- **Viral trends** — trend-jacking opportunities (IPL, Bollywood, memes)
- **Competitor gaps** — what competitors aren't doing
- **Market insights** — industry trends, consumer behaviour

The learning agent tracks which source produces the best-performing ideas for each tenant.

### Approval → Campaign Flow

#### Learning Period (Week 1-2) — Human in the loop
```
Tenant approves idea ✅ via Slack
    ↓
Creative auto-generated (ad copy + image)
    ↓
Sent to tenant: "Your ad is ready. Launch?"
    ↓
Tenant confirms → campaign launches
    ↓
Auditor monitors performance
```
Tenant stays in control. Builds trust in the system gradually.

#### Steady State (Week 3+) — Full automation
```
Idea auto-selected by system (highest score)
    ↓
Creative auto-generated
    ↓
Campaign auto-launched (no human step)
    ↓
Auditor monitors
    ↓
Tenant sees results only
```

#### Switch conditions (ALL 3 must be true)
1. Approval rate > 60% — system knows what tenant likes
2. Campaign ROAS > target for 2+ consecutive weeks — system proven to work
3. Tenant explicitly enables full auto in settings — they choose when ready

If any condition fails → stay in human-in-the-loop mode.

### Step 3.1 — BullMQ Scheduler ✅

```
src/
├── scheduler/
│   ├── scheduler.module.ts
│   ├── scheduler.service.ts     # Schedules per tenant on startup (daily/weekly)
│   ├── pipeline.processor.ts    # BullMQ worker — calls orchestrator.trigger()
│   └── queue.constants.ts       # Queue name constants
```

**Auto cold-start detection:** On `OnModuleInit`, `SchedulerService` loads all tenants and schedules each one based on `createdAt` age vs `coldStartDays`:
- Age < `coldStartDays` → daily at 9 AM IST (`0 9 * * *`)
- Age ≥ `coldStartDays` → weekly Monday 9 AM IST (`0 9 * * 1`)

No manual intervention needed when a tenant graduates from cold start — schedule updates automatically on next server restart.

### Step 3.2 — Direct Slack Delivery ✅

> **Decision:** n8n removed — unnecessary middleware. Digest posts directly to Slack via incoming webhook stored on `company.delivery.slackWebhook`.

```
src/
├── delivery/
│   ├── delivery.module.ts
│   └── slack.service.ts    # Posts digest blocks to Slack; splits >2900-char content
```

Delivery is triggered at the end of `DigestWriterService.run()`. On success, sets `digest.delivered = true` in MongoDB.

### Step 3.3 — Action Logger ✅

```
src/
├── common/
│   ├── common.module.ts
│   └── action-logger/
│       ├── action-log.schema.ts      # MongoDB collection: action_logs
│       └── action-logger.service.ts  # ActionLoggerService.log()
```

Every autonomous decision logs: `tenantId`, `runId`, `agent`, `action`, `reason`, `outcome`, `metadata`.

### Step 3.4 — Per-Idea Digest + Slack Delivery ✅

**Digest schema updated** — one MongoDB record per digest unit (type: `signals` | `idea` | `cta`), all sharing the same `runId`. Each idea record stores `briefId`, `ideaIndex`, and `recommended` flag.

**Slack delivery — one message per idea:**
- Message 1: market signals summary
- Messages 2–6: one full content brief per idea (⭐ RECOMMENDED on the system pick, with `selectionReason`)
- Message 7: CTA — "review the N ideas above and pick one"
- Dividers between each message for readability

**No scores shown in digest** — removed entirely. Human team picks the idea, system recommends but doesn't decide.

**`POST /api/v1/pipeline/:tenantId/runs/:runId/regenerate-digest`** — regenerates and re-delivers digest from existing MongoDB data without re-running scouts/coordinator/idea pool.

**Digest writer moved from Haiku → Sonnet** — per-idea briefs require brand voice + Hinglish copywriting quality that Haiku couldn't deliver reliably.

### Step 3.5 — Validation ✅

- [x] Pipeline auto-schedules on server start for all tenants
- [x] Slack delivers 7 messages per run (signals + 5 ideas + CTA)
- [x] Each idea stored separately in MongoDB with same `runId`
- [x] Recommended idea marked with ⭐ and `selectionReason`
- [x] `delivered: true` + `deliveredAt` set after Slack send
- [x] Digest regeneration endpoint works from existing run data
- [x] Action logger schema + service ready for use in Phase 4+

---

## Phase 4 — Creative Production (Week 7–8)

> **Goal:** Team approves any idea from the digest → system auto-generates ad copy (3 variants), image, and video for that idea.
>
> **Exit Criteria:** Given an approved brief, system produces a complete creative package (copy + image + video) stored in S3.

### Approval Flow

```
Digest delivered (5 ideas in Slack)
    ↓
Team picks any idea and calls:
POST /api/v1/creative/:tenantId/briefs/:briefId/approve
    ↓
Creative production triggered for that briefId only
    ↓
Copy + Image + Video generated in parallel
    ↓
CreativePackage saved to MongoDB
    ↓
Slack: "Creative ready. Review before launch."
```

> **Decision:** No auto-trigger after pipeline. Human approves which idea to produce. Up to 2 ideas can be approved per run (generates 2 full creative packages). Slack button approval deferred to Phase 5.

### Step 4.1 — Creative Module Structure

```
src/
├── creative/
│   ├── creative.module.ts
│   ├── creative.controller.ts           # POST /briefs/:briefId/approve
│   ├── schemas/
│   │   └── creative-package.schema.ts   # Stores prompts + URLs + copy variants
│   ├── copy-writer/
│   │   └── copy-writer.service.ts
│   ├── image-generator/
│   │   └── image-generator.service.ts   # Nano Banana (Google Gemini Image API)
│   ├── video-generator/
│   │   └── video-generator.service.ts   # Kling 3.0 via fal.ai
│   ├── creative-producer/
│   │   └── creative-producer.service.ts # Orchestrates all 3 in parallel
│   └── s3/
│       └── s3.service.ts                # Upload assets to S3
```

### Step 4.2 — Creative Package Schema

```typescript
creative_packages {
  tenantId: string;
  runId: string;
  briefId: string;
  status: 'pending' | 'completed' | 'failed';

  // Copy
  copyVariants: { primaryText: string; headline: string; cta: string; hookStyle: string; }[];
  selectedCopyIndex: number;
  copySelectionReason: string;

  // Image
  imagePrompt: string;    // Claude-generated prompt — stored for debugging + learning
  imageUrl: string;       // S3 URL

  // Video
  videoPrompt: string;    // Claude-generated prompt — stored for debugging + learning
  videoUrl: string;       // S3 URL

  approvedAt: Date;
  completedAt?: Date;
}
```

### Step 4.3 — Copy Writer

- Generates 3 ad copy variants using PAS + BAB frameworks
- Each variant: `primaryText` + `headline` + `cta` + `hookStyle` tag
- Auto-selects best variant based on `company.learnings.winningPatterns`

### Step 4.4 — Image Generator (Nano Banana — Google Gemini Image API)

- Claude writes a detailed image generation prompt from the brief + brand guidelines
- Calls Nano Banana API (Google AI Studio / Vertex AI)
- Uploads result to S3 at `{tenantId}/creatives/images/`
- Stores the Claude-generated prompt in `creative_packages.imagePrompt`

### Step 4.5 — Video Generator (Kling 3.0 via fal.ai) — deferred

> **Deferred:** fal.ai API key not yet available. Video generator will be added once key is obtained. `videoPrompt` will still be generated and stored by Claude so it's ready when the API is wired up.

### Step 4.6 — Validation

- [ ] `POST /creative/:tenantId/briefs/:briefId/approve` triggers creative production
- [ ] Copy Writer produces 3 variants with tagged hook styles
- [ ] Image Generator produces an ad image via Nano Banana + uploads to S3
- [ ] Video Generator produces a 15–20s Reel via Kling 3.0 + uploads to S3
- [ ] `imagePrompt` and `videoPrompt` stored in MongoDB
- [ ] Slack notification sent when creative package is complete
- [ ] Up to 2 briefs can be approved and produced per run

---

## Phase 5 — Campaign Execution (Week 9)

> **Goal:** Auto-launch Meta Ads campaigns from creative packages with all safety checks.
>
> **Exit Criteria:** Campaign created and launched on Meta Ads. Budget caps enforced. All safety checks pass.

### Step 5.1 — Campaign Module Structure

```
src/
├── campaigns/
│   ├── campaigns.module.ts
│   ├── campaigns.controller.ts
│   ├── campaigns.service.ts
│   ├── schemas/
│   │   └── campaign.schema.ts
│   ├── campaign-creator/
│   │   ├── campaign-creator.service.ts
│   │   └── safety-checks.ts          # ALL budget/content checks in TypeScript
│   └── campaign-auditor/              # placeholder — built in Phase 6
│       └── campaign-auditor.service.ts
```

### Step 5.2 — Safety Checks (Hardcoded in TypeScript)

**safety-checks.ts:**

```typescript
export class SafetyChecks {
  // Check 1: Weekly budget cap
  static async checkWeeklyBudget(
    tenantId: string,
    campaignBudget: number,
    requirements: MarketingRequirements,
    campaignsService: CampaignsService,
  ): Promise<void> {
    const currentWeeklySpend = await campaignsService.getWeeklySpend(tenantId);
    if (currentWeeklySpend + campaignBudget > requirements.weeklyBudgetCap) {
      throw new BudgetCapError(
        `Weekly budget cap reached: $${currentWeeklySpend} + $${campaignBudget} > $${requirements.weeklyBudgetCap}`
      );
    }
  }

  // Check 2: Per-campaign budget cap
  static checkCampaignBudget(
    campaignBudget: number,
    requirements: MarketingRequirements,
  ): void {
    if (campaignBudget > requirements.maxBudgetPerCampaign) {
      throw new BudgetCapError(
        `Campaign budget $${campaignBudget} exceeds max $${requirements.maxBudgetPerCampaign}`
      );
    }
  }

  // Check 3: Forbidden topics
  static checkForbiddenTopics(
    brief: CreativeBrief,
    requirements: MarketingRequirements,
  ): void {
    const forbidden = requirements.forbiddenTopics.find(t =>
      brief.topic.toLowerCase().includes(t.toLowerCase())
    );
    if (forbidden) {
      throw new ForbiddenTopicError(`Brief topic "${brief.topic}" matches forbidden topic "${forbidden}"`);
    }
  }

  // Check 4: Campaigns per run limit
  static async checkCampaignsPerRun(
    tenantId: string,
    runId: string,
    requirements: MarketingRequirements,
    campaignsService: CampaignsService,
  ): Promise<void> {
    const launchedThisRun = await campaignsService.countByRunId(tenantId, runId);
    if (launchedThisRun >= requirements.campaignsPerRun) {
      throw new CampaignLimitError(
        `Already launched ${launchedThisRun}/${requirements.campaignsPerRun} campaigns this run`
      );
    }
  }
}
```

### Step 5.3 — Campaign Creator Service

**campaign-creator.service.ts:**

```typescript
async create(
  brief: CreativeBrief,
  creativePackage: CreativePackage,
  company: CompanyDocument,
  runId: string,
): Promise<Campaign> {
  const requirements = company.requirements;

  // ALL SAFETY CHECKS — TypeScript level, Claude cannot override
  SafetyChecks.checkForbiddenTopics(brief, requirements);
  SafetyChecks.checkCampaignBudget(brief.suggestedBudget, requirements);
  await SafetyChecks.checkWeeklyBudget(company.tenantId, brief.suggestedBudget, requirements, this.campaignsService);
  await SafetyChecks.checkCampaignsPerRun(company.tenantId, runId, requirements, this.campaignsService);

  // Claude creates campaign structure via Meta Ads MCP
  const result = await this.claudeService.runAgent({
    tenantId: company.tenantId,
    agentType: AgentType.CAMPAIGN_CREATOR,
    systemPrompt: company.prompts.campaignCreator || CAMPAIGN_CREATOR_FALLBACK_PROMPT,
    liveContext: this.liveContextBuilder.build(company),
    userMessage: `Create and launch a Meta Ads campaign:
      Brief: ${JSON.stringify(brief)}
      Creative: ${JSON.stringify(creativePackage)}
      Budget: $${brief.suggestedBudget}
      Objective: ${requirements.primaryObjective}
      Use 70/30 split: 70% proven audience, 30% test audience.
      Naming: META_${requirements.primaryObjective.toUpperCase()}_${brief.audience}_${brief.topic}_${new Date().toISOString().split('T')[0]}`,
    maxTurns: 15, // Meta Ads MCP needs multiple turns
    runId,
  });

  // Save campaign record
  const campaign = await this.saveCampaign({
    tenantId: company.tenantId,
    runId,
    briefId: brief.briefId,
    creativePackageId: creativePackage._id,
    metaCampaignId: this.extractMetaCampaignId(result),
    status: 'active',
    budget: brief.suggestedBudget,
    objective: requirements.primaryObjective,
    launchedAt: new Date(),
  });

  // Log action
  await this.actionLogger.log({
    tenantId: company.tenantId,
    runId,
    agent: AgentType.CAMPAIGN_CREATOR,
    action: 'campaign_launched',
    reason: `Auto-launched campaign for brief "${brief.topic}" with budget $${brief.suggestedBudget}`,
    outcome: `Meta campaign ID: ${campaign.metaCampaignId}`,
  });

  return campaign;
}
```

### Step 5.4 — Campaign API Routes

```
GET    /api/v1/campaigns/:tenantId                          → all campaigns + metrics
GET    /api/v1/campaigns/:tenantId/:campaignId              → detail + audit log
POST   /api/v1/campaigns/:tenantId/:campaignId/pause        → manual override pause
```

### Step 5.5 — Validation

- [ ] Safety checks block campaigns that exceed budget caps
- [ ] Safety checks block campaigns with forbidden topics
- [ ] Campaign launches successfully on Meta Ads via MCP
- [ ] Campaign record saved in MongoDB with correct metaCampaignId
- [ ] Action log records the launch with full reasoning
- [ ] Manual pause endpoint works

---

## Phase 6 — Auditor + Optimizer (Week 10)

> **Goal:** Auto-monitor campaigns every 6 hours. Auto-pause underperformers. Auto-scale winners.
>
> **Exit Criteria:** Auditor runs every 6h, pauses/scales campaigns based on requirements thresholds, writes performance back to creative_briefs.

### Step 6.1 — Campaign Auditor Service

```
src/
├── campaigns/
│   ├── campaign-auditor/
│   │   ├── campaign-auditor.service.ts
│   │   └── campaign-optimizer.service.ts
```

**campaign-auditor.service.ts:**

```typescript
async audit(tenantId: string): Promise<AuditResult> {
  const company = await this.companyService.findByTenantId(tenantId);
  const activeCampaigns = await this.campaignsService.findActive(tenantId);
  const requirements = company.requirements;

  for (const campaign of activeCampaigns) {
    // Fetch live metrics via Meta Ads MCP
    const metrics = await this.fetchMetrics(campaign, company);

    // Update campaign metrics in MongoDB
    await this.campaignsService.updateMetrics(campaign._id, metrics);

    // Auto-pause checks (all in TypeScript — Claude cannot override)
    if (metrics.ctr < requirements.pauseIfCTRBelow && campaign.ageHours > 72) {
      await this.pauseCampaign(campaign, company, `CTR ${metrics.ctr}% below threshold ${requirements.pauseIfCTRBelow}% for 72h+`);
    }
    else if (metrics.frequency > requirements.pauseIfFrequencyAbove) {
      await this.pauseCampaign(campaign, company, `Frequency ${metrics.frequency} exceeds ${requirements.pauseIfFrequencyAbove} — audience fatigued`);
    }
    else if (metrics.roas < requirements.pauseIfROASBelow && campaign.ageDays > 5) {
      await this.pauseCampaign(campaign, company, `ROAS ${metrics.roas}x below ${requirements.pauseIfROASBelow}x after 5 days`);
    }
    else if (campaign.isInLearningPhase && campaign.learningPhaseDays > requirements.pauseAfterDaysInLearning) {
      await this.pauseCampaign(campaign, company, `Stuck in learning phase for ${campaign.learningPhaseDays} days`);
    }

    // Auto-scale check
    if (metrics.roas > requirements.scaleIfROASAbove) {
      await this.optimizer.scaleBudget(campaign, company, metrics);
    }

    // Write performance back to creative_brief at day 7/14/30
    await this.writePerformanceBack(campaign, metrics);
  }
}
```

### Step 6.2 — Campaign Optimizer

**campaign-optimizer.service.ts:**

```typescript
async scaleBudget(campaign: Campaign, company: CompanyDocument, metrics: CampaignMetrics): Promise<void> {
  const requirements = company.requirements;

  // HARDCODED SCALE LIMIT — Claude cannot override
  const maxIncrease = campaign.budget * (requirements.maxBudgetScalePercent / 100);
  const suggestedNewBudget = campaign.budget * 1.2; // 20% increase suggestion
  const newBudget = Math.min(suggestedNewBudget, campaign.budget + maxIncrease);

  // Also check weekly cap
  const currentWeeklySpend = await this.campaignsService.getWeeklySpend(company.tenantId);
  if (currentWeeklySpend + (newBudget - campaign.budget) > requirements.weeklyBudgetCap) {
    await this.actionLogger.log({
      tenantId: company.tenantId,
      agent: AgentType.CAMPAIGN_AUDITOR,
      action: 'scale_blocked',
      reason: `ROAS ${metrics.roas}x qualifies for scale but weekly cap would be exceeded`,
      outcome: 'No action taken',
    });
    return;
  }

  // Scale via Meta Ads MCP
  // ... (Claude agent call to update budget)

  await this.actionLogger.log({
    tenantId: company.tenantId,
    agent: AgentType.CAMPAIGN_AUDITOR,
    action: 'budget_scaled',
    reason: `ROAS ${metrics.roas}x exceeds ${requirements.scaleIfROASAbove}x threshold`,
    outcome: `Budget increased from $${campaign.budget} to $${newBudget}`,
  });
}
```

### Step 6.3 — Performance Attribution Writeback

```typescript
async writePerformanceBack(campaign: Campaign, metrics: CampaignMetrics): Promise<void> {
  const ageDays = campaign.ageDays;
  const briefId = campaign.briefId;

  if (ageDays >= 7 && !campaign.performanceWritten.day7) {
    await this.briefsService.updatePerformance(briefId, 'day7', {
      roas: metrics.roas, ctr: metrics.ctr, cpc: metrics.cpc, conversions: metrics.conversions,
    });
    campaign.performanceWritten.day7 = true;
  }
  // Same for day14 and day30...
}
```

### Step 6.4 — Audit BullMQ Job

```typescript
// In scheduler.service.ts — add for each tenant:
await this.auditQueue.add(
  `audit-${company.tenantId}`,
  { tenantId: company.tenantId },
  {
    repeat: { every: 6 * 60 * 60 * 1000 }, // every 6 hours
    jobId: `audit-${company.tenantId}`,
  }
);
```

### Step 6.5 — Validation

- [ ] Auditor fetches live metrics from Meta Ads MCP
- [ ] Auto-pause triggers correctly based on requirements thresholds
- [ ] Auto-scale respects maxBudgetScalePercent and weeklyBudgetCap
- [ ] Performance written back to creative_briefs at day 7/14/30
- [ ] All actions logged with full reasoning
- [ ] Audit API routes return action history

---

## Phase 7 — Learning System (Week 11)

> **Goal:** Monthly learning agent that extracts patterns from campaign performance and updates company-specific learnings.
>
> **Exit Criteria:** Learning Agent reads 30 days of briefs + outcomes, extracts instincts with confidence scores, updates company.learnings, triggers prompt regeneration.

### Architecture: Vectors + LLM (why both)

The learning system uses a two-layer architecture — vectors for retrieval, LLM for reasoning:

```
Past campaign performance (structured numbers: ROAS, CTR, conversions)
         +
Past briefs + signals (embedded as vectors → MongoDB Atlas Vector Search)
         ↓
Learning Agent queries: "find briefs similar to this week's winner"
Vector search returns semantically similar past campaigns (not just string match)
         ↓
LLM reasons over retrieved data + raw numbers
"IPL-tied content outperforms generic astrology 3x — confidence 0.87"
         ↓
Outputs human-readable learnings → stored in company.learnings (MongoDB)
         ↓
LiveContextBuilder injects learnings as plain text into every future agent prompt
         ↓
Prompts regenerated — all 9 agents now aware of what works
```

**Why vectors + text (not vectors alone):**
- Vectors are for *retrieval* — finding similar past campaigns fast
- LLM is for *reasoning* — understanding why something worked
- Storing learnings as human-readable text (not vectors) lets every agent use them directly in prompts
- LLMs cannot reason directly from vector space — they need text

**Signal deduplication upgrade (also in Phase 7):**
- Embed every scout signal on save
- Before each scout run, vector-query past signals
- Similarity > 0.85 = same idea, inject as "already covered" context
- Replaces the topic+angle string matching used in Phase 2

### Step 7.1 — Learning Module

```
src/
├── learning/
│   ├── learning.module.ts
│   ├── learning-agent.service.ts
│   ├── schemas/
│   │   └── learning-run.schema.ts
```

### Step 7.2 — Learning Agent Service

**learning-agent.service.ts:**

```typescript
async runLearning(tenantId: string): Promise<LearningRun> {
  const company = await this.companyService.findByTenantId(tenantId);

  // Fetch all briefs with performance data from last 30 days
  const briefs = await this.briefsService.findWithPerformance(tenantId, 30);

  if (briefs.length < 3) {
    // Not enough data to learn — skip
    return this.createSkippedRun(tenantId, 'Insufficient data (need 3+ campaigns with performance)');
  }

  // Claude extracts patterns using continuous-learning-v2 skill methodology
  const result = await this.claudeService.runAgent({
    tenantId,
    agentType: AgentType.LEARNING_AGENT,
    systemPrompt: LEARNING_AGENT_PROMPT, // uses continuous-learning-v2 pattern
    liveContext: this.liveContextBuilder.build(company),
    userMessage: `Analyze these campaign outcomes and extract learning patterns.
      MINIMUM 3 data points to confirm any pattern.
      Tag each instinct with a confidence score (0.0-1.0).

      Campaign data:
      ${JSON.stringify(briefs, null, 2)}

      Current learnings (previous version):
      ${JSON.stringify(company.learnings, null, 2)}

      Return JSON with: topicScores, winningPatterns, losingPatterns, audienceInsights`,
    model: 'claude-sonnet-4-6',
    maxTurns: 5,
  });

  const newLearnings = this.parseLearnings(result.content);

  // Update company.learnings in MongoDB
  await this.companyService.updateLearnings(tenantId, {
    ...newLearnings,
    version: (company.learnings?.version || 0) + 1,
    updatedAt: new Date(),
  });

  // Trigger prompt regeneration — new learnings should influence agent behavior
  await this.promptGenerator.generate(tenantId);

  // Log learning run
  const run = await this.saveLearningRun({
    tenantId,
    version: newLearnings.version,
    briefsAnalyzed: briefs.length,
    instinctsExtracted: this.countInstincts(newLearnings),
    promptsRegenerated: true,
    runAt: new Date(),
  });

  await this.actionLogger.log({
    tenantId,
    agent: AgentType.LEARNING_AGENT,
    action: 'learnings_updated',
    reason: `Analyzed ${briefs.length} campaigns. Extracted ${run.instinctsExtracted} instincts.`,
    outcome: `Learnings updated to v${newLearnings.version}. 9 agent prompts regenerated.`,
  });

  return run;
}
```

### Step 7.3 — Monthly BullMQ Job

```typescript
// In scheduler.service.ts:
await this.learningQueue.add(
  `learning-${company.tenantId}`,
  { tenantId: company.tenantId },
  {
    repeat: { pattern: '0 3 1 * *', tz: 'Asia/Kolkata' }, // 1st of month, 3 AM IST
    jobId: `learning-${company.tenantId}`,
  }
);
```

### Step 7.4 — Validation

- [ ] Learning Agent correctly identifies winning and losing patterns from test data
- [ ] Minimum 3 data points requirement enforced (no patterns from 1-2 campaigns)
- [ ] company.learnings updated with new version number
- [ ] Prompt Generator re-runs after learning update
- [ ] New prompts reflect updated learnings (manually verify)
- [ ] Learning run logged with instinct count

---

## Phase 8 — Production + Multi-Tenant (Week 12)

> **Goal:** Production-ready deployment with security, rate limiting, usage tracking, and Docker deployment.
>
> **Exit Criteria:** System runs on EC2 with Docker Compose. Multi-tenant isolation verified. API authenticated. Usage tracked for billing.

### Step 8.1 — Authentication Guard

```
src/
├── common/
│   ├── guards/
│   │   └── api-key.guard.ts
│   ├── interceptors/
│   │   ├── tenant.interceptor.ts    # Extracts tenantId, injects into request
│   │   └── usage-logging.interceptor.ts
│   └── decorators/
│       └── tenant.decorator.ts      # @Tenant() param decorator
```

**api-key.guard.ts:**
```typescript
@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'];

    if (!apiKey) throw new UnauthorizedException('API key required');

    const company = this.companyService.findByApiKey(apiKey);
    if (!company) throw new UnauthorizedException('Invalid API key');

    request.tenantId = company.tenantId;
    request.company = company;
    return true;
  }
}
```

### Step 8.2 — Rate Limiting

```typescript
// In app.module.ts:
ThrottlerModule.forRoot({
  throttlers: [
    { name: 'short', ttl: 1000, limit: 5 },    // 5 requests/second
    { name: 'long', ttl: 60000, limit: 100 },   // 100 requests/minute
  ],
}),
```

Per-tenant rate limiting via Redis-backed custom throttler (different limits per plan tier).

### Step 8.3 — Tenant Isolation Audit

Verify tenantId enforcement across every layer:

- [ ] Every MongoDB query includes tenantId filter
- [ ] Every BullMQ job carries tenantId
- [ ] Every Claude agent call includes tenantId
- [ ] Every S3 path includes tenantId prefix
- [ ] Every API route scoped to authenticated tenant
- [ ] No cross-tenant data leakage possible in:
  - [ ] scout_outputs
  - [ ] creative_briefs
  - [ ] campaigns
  - [ ] action_logs
  - [ ] usage_logs
  - [ ] learnings

### Step 8.4 — Usage Reporting API

```
GET    /api/v1/usage/:tenantId                → token usage + cost breakdown per agent
GET    /api/v1/usage/:tenantId/monthly        → monthly totals by agent + model
```

### Step 8.5 — Docker + Deployment

**Dockerfile:**
```dockerfile
# Multi-stage build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.claude ./.claude
COPY --from=builder /app/package.json ./
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

**docker-compose.yml:** (see Docker Compose section below)

**Deployment steps:**
1. SSH into EC2 (t3.medium minimum)
2. Install Docker + Docker Compose
3. Clone repo + copy .env
4. `docker compose up -d`
5. Configure Nginx reverse proxy:
   - `api.briefos.io` → `:3000`
   - `n8n.briefos.io` → `:5678`
6. SSL via Certbot
7. Verify all services healthy

### Step 8.6 — Final Security Review

Run the security-reviewer.md agent from `.claude/agents/` against the full codebase:

- [ ] No API keys hardcoded in code
- [ ] All external API calls use HTTPS
- [ ] MongoDB queries use parameterized inputs (no injection)
- [ ] Meta Ads token stored securely, not logged
- [ ] S3 bucket has proper access policies
- [ ] n8n webhook uses HMAC verification
- [ ] Rate limiting active on all public routes
- [ ] Error responses don't leak internal details

---

## Phase 9 — Agent Team Review System (Planned)

> **Goal:** Insert expert persona review gates at 3 checkpoints in the pipeline to catch weak output before money is spent, and extract actionable insights from performance data.
>
> **Build after:** Phase 8 (full pipeline running with real campaign data)

### Overview

A panel of AI expert personas debates pipeline output in structured 3-round discussions. Each persona brings a different professional lens. They read each other's feedback, challenge each other, and synthesize into consensus + ranked action items.

### The 3 Review Checkpoints

| Checkpoint | Trigger | Personas Used | Output |
|------------|---------|---------------|--------|
| **Idea Pool** | After ideas are scored | All 5 | Which ideas to pursue, which to drop + why. Summary sent to Slack |
| **Creative Package** | After copy/visuals generated | Copywriter + Psychologist + Skeptical Customer | Pass / auto-revise / block launch |
| **Campaign Performance** | After Day 7/14/30 data written | Media Buyer + Brand Strategist | Actionable advice in plain language → feeds learning loop |

### The 5 Default Personas

Global defaults, seeded automatically for every tenant on first run. No manual setup required.

| # | Persona | Domain | Evaluates |
|---|---------|--------|-----------|
| 1 | **Media Buyer** | performance_marketing | Budget efficiency, audience targeting, ROAS potential, platform fit |
| 2 | **Copywriter** | copywriting | Hook strength, headline clarity, CTA, tone, persuasion |
| 3 | **Consumer Psychologist** | consumer_behavior | Emotional triggers, cognitive biases, motivation, why someone clicks |
| 4 | **Brand Strategist** | brand_strategy | Positioning, consistency, differentiation from competitors |
| 5 | **Skeptical Customer** | end_user | "Would I actually stop scrolling for this?" |

Default personas are global (`tenantId: null`). Tenants can override system prompts or add custom personas.

### How a Discussion Works (3 Rounds)

```
Round 1 — Independent Review (parallel Claude calls)
  Each persona reviews the pipeline output independently
  Returns: score (1–10), strengths, weaknesses, suggestions

Round 2 — Discussion (parallel Claude calls)
  Each persona receives everyone else's Round 1 feedback
  They agree, disagree, challenge, and build on each other's points

Round 3 — Synthesis (single moderator call)
  Moderator reads full R1 + R2 discussion
  Returns: consensus points, dissenting views, ranked action items, final score
```

Total Claude calls per review: `(N personas × 2 rounds) + 1 moderator`
Example with 5 personas: 11 calls per gate.

### Score-Based Gate Logic

| Final Score | Action |
|-------------|--------|
| **>= 7** | Pipeline continues — output approved |
| **5–6** | Auto-revise — action items fed back, output regenerated once, then continues |
| **< 5** | Pipeline paused — Slack alert sent, flagged for human review |

### ReviewConfig (per tenant, stored in MongoDB)

Fully controllable per tenant — which personas, which checkpoints, thresholds:

```json
{
  "tenantId": "fittrack",
  "checkpoints": {
    "idea_pool": {
      "enabled": true,
      "personaIds": ["media_buyer", "copywriter", "psychologist", "brand_strategist", "skeptical_customer"],
      "minScore": 6,
      "autoRevise": true
    },
    "creative_package": {
      "enabled": true,
      "personaIds": ["copywriter", "psychologist", "skeptical_customer"],
      "minScore": 7,
      "autoRevise": true
    },
    "campaign_performance": {
      "enabled": true,
      "personaIds": ["media_buyer", "brand_strategist"],
      "minScore": null
    }
  }
}
```

### Persona Storage Model

```
personas collection
├── media_buyer         (isDefault: true,  tenantId: null)   ← shared globally
├── copywriter          (isDefault: true,  tenantId: null)
├── psychologist        (isDefault: true,  tenantId: null)
├── brand_strategist    (isDefault: true,  tenantId: null)
├── skeptical_customer  (isDefault: true,  tenantId: null)
│
└── fitness_expert      (isDefault: false, tenantId: "fittrack")  ← tenant-specific custom
```

### New Files to Create

```
src/review/
  schemas/
    persona.schema.ts           — Expert persona profiles
    discussion.schema.ts        — Full discussion records (rounds, messages, consensus)
    review-config.schema.ts     — Per-tenant checkpoint configuration
  dto/
    create-persona.dto.ts
    start-discussion.dto.ts
    update-review-config.dto.ts
  personas.defaults.ts          — Hardcoded default persona system prompts (5 experts)
  agent-team.service.ts         — 3-round discussion orchestration
  review.controller.ts          — CRUD for personas + config + trigger discussions
  review.module.ts
```

### Files to Update

| File | Change |
|------|--------|
| `claude/claude.types.ts` | Add `REVIEW_PERSONA`, `REVIEW_MODERATOR` to AgentType + NO_TOOL_AGENTS |
| `pipeline/idea-pool.service.ts` | Call `agentTeamService.discuss()` after scoring, append result to digest |
| `creative/creative-producer.service.ts` | Call `agentTeamService.discuss()` after generation, gate on score |
| `pipeline/campaign-auditor.service.ts` | Call `agentTeamService.discuss()` after writing performance data |
| `app.module.ts` | Register ReviewModule |

### Discussion Document Shape

```typescript
{
  tenantId: string
  targetType: 'idea_pool' | 'creative_package' | 'campaign_performance'
  targetId: string                          // briefId, packageId, or campaignId
  personaIds: string[]
  rounds: [
    {
      round: 1,
      messages: [{ personaId, personaName, score, strengths, weaknesses, suggestions }]
    },
    {
      round: 2,
      messages: [{ personaId, personaName, agreements, challenges, additions }]
    },
    {
      round: 3,
      messages: [{ role: 'moderator', consensus, dissentingViews, actionItems, finalScore }]
    }
  ]
  finalScore: number
  actionItems: string[]
  status: 'running' | 'completed' | 'failed'
  totalCostUSD: number
}
```

### Phase 9 Exit Criteria

- [ ] 5 default personas seeded for new tenants automatically
- [ ] 3-round discussion runs end-to-end for all 3 checkpoint types
- [ ] Score gate blocks creative launch when score < 5
- [ ] Auto-revise loop regenerates creative once when score 5–6
- [ ] Idea Pool review summary included in Slack digest
- [ ] Campaign performance review feeds into learning agent
- [ ] Custom persona CRUD working per tenant
- [ ] ReviewConfig CRUD working per tenant
- [ ] All discussion records stored in MongoDB with full round history
- [ ] Cost tracked per discussion in `usage_logs`

---

## Project Structure (Final)

```
briefos/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   │
│   ├── config/
│   │   ├── config.module.ts
│   │   └── configuration.ts
│   │
│   ├── database/
│   │   └── database.module.ts
│   │
│   ├── claude/
│   │   ├── claude.module.ts
│   │   ├── claude.service.ts
│   │   ├── claude.types.ts
│   │   └── schemas/
│   │       └── usage-log.schema.ts
│   │
│   ├── companies/
│   │   ├── companies.module.ts
│   │   ├── companies.controller.ts
│   │   ├── companies.service.ts
│   │   ├── schemas/
│   │   │   ├── company.schema.ts
│   │   │   └── company.types.ts
│   │   ├── dto/
│   │   │   ├── create-company.dto.ts
│   │   │   └── update-company.dto.ts
│   │   └── prompt-generator/
│   │       ├── prompt-generator.service.ts
│   │       └── live-context.builder.ts
│   │
│   ├── pipeline/
│   │   ├── pipeline.module.ts
│   │   ├── pipeline.controller.ts
│   │   ├── schemas/
│   │   │   ├── pipeline-run.schema.ts
│   │   │   ├── scout-output.schema.ts
│   │   │   ├── scout-signal.schema.ts
│   │   │   ├── intelligence-brief.schema.ts
│   │   │   └── creative-brief.schema.ts
│   │   ├── scouts/
│   │   │   ├── scout-base.service.ts
│   │   │   ├── instagram.scout.ts
│   │   │   ├── reddit.scout.ts
│   │   │   ├── twitter.scout.ts
│   │   │   └── youtube.scout.ts
│   │   ├── coordinator/
│   │   │   └── coordinator.service.ts
│   │   ├── intelligence/
│   │   │   ├── competitor-research.service.ts
│   │   │   └── market-research.service.ts
│   │   ├── idea-pool/
│   │   │   └── idea-pool.service.ts
│   │   ├── digest/
│   │   │   └── digest.service.ts
│   │   └── orchestrator/
│   │       └── orchestrator.service.ts
│   │
│   ├── creative/
│   │   ├── creative.module.ts
│   │   ├── schemas/
│   │   │   └── creative-package.schema.ts
│   │   ├── copy-writer/
│   │   │   └── copy-writer.service.ts
│   │   ├── image-generator/
│   │   │   └── image-generator.service.ts
│   │   ├── video-generator/
│   │   │   └── video-generator.service.ts
│   │   ├── creative-producer/
│   │   │   └── creative-producer.service.ts
│   │   └── s3/
│   │       └── s3.service.ts
│   │
│   ├── campaigns/
│   │   ├── campaigns.module.ts
│   │   ├── campaigns.controller.ts
│   │   ├── campaigns.service.ts
│   │   ├── schemas/
│   │   │   └── campaign.schema.ts
│   │   ├── campaign-creator/
│   │   │   ├── campaign-creator.service.ts
│   │   │   └── safety-checks.ts
│   │   └── campaign-auditor/
│   │       ├── campaign-auditor.service.ts
│   │       └── campaign-optimizer.service.ts
│   │
│   ├── learning/
│   │   ├── learning.module.ts
│   │   ├── learning-agent.service.ts
│   │   └── schemas/
│   │       └── learning-run.schema.ts
│   │
│   ├── scheduler/
│   │   ├── scheduler.module.ts
│   │   ├── scheduler.service.ts
│   │   └── processors/
│   │       ├── weekly-pipeline.processor.ts
│   │       ├── creative.processor.ts
│   │       ├── audit.processor.ts
│   │       └── learning.processor.ts
│   │
│   ├── delivery/
│   │   ├── delivery.module.ts
│   │   └── n8n.service.ts
│   │
│   └── common/
│       ├── guards/
│       │   └── api-key.guard.ts
│       ├── interceptors/
│       │   ├── tenant.interceptor.ts
│       │   └── usage-logging.interceptor.ts
│       ├── decorators/
│       │   └── tenant.decorator.ts
│       ├── action-logger/
│       │   ├── action-log.schema.ts
│       │   └── action-logger.service.ts
│       ├── exceptions/
│       │   ├── budget-cap.error.ts
│       │   ├── forbidden-topic.error.ts
│       │   └── campaign-limit.error.ts
│       └── filters/
│           └── all-exceptions.filter.ts
│
├── .claude/
│   ├── CLAUDE.md
│   ├── mcp.json
│   ├── agents/
│   │   ├── architect.md
│   │   ├── typescript-reviewer.md
│   │   ├── security-reviewer.md
│   │   └── loop-operator.md
│   ├── skills/
│   │   ├── paid-ads/
│   │   ├── ad-creative/
│   │   ├── product-marketing-context/
│   │   ├── marketing-psychology/
│   │   ├── competitor-alternatives/
│   │   ├── customer-research/
│   │   ├── copywriting/
│   │   ├── social-content/
│   │   ├── continuous-learning-v2/
│   │   ├── autonomous-loops/
│   │   ├── cost-aware-llm-pipeline/
│   │   ├── verification-loop/
│   │   ├── iterative-retrieval/
│   │   └── market-research/
│   └── commands/
│       ├── multi-plan.md
│       ├── orchestrate.md
│       └── learn-eval.md
│
├── .env
├── .env.example
├── package.json
├── tsconfig.json
├── nest-cli.json
├── Dockerfile
├── docker-compose.yml
└── BRIEFOS.md
```

---

## Environment Variables

```bash
# ──────────────────────────────────────
# App
# ──────────────────────────────────────
PORT=3000
NODE_ENV=production

# ──────────────────────────────────────
# Claude Code SDK
# ──────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...

# ──────────────────────────────────────
# MongoDB
# ──────────────────────────────────────
MONGO_URI=mongodb://localhost:27017/briefos

# ──────────────────────────────────────
# Redis (BullMQ)
# ──────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ──────────────────────────────────────
# n8n Delivery
# ──────────────────────────────────────
N8N_WEBHOOK_URL=https://n8n.yourdomain.com/webhook/briefos
N8N_WEBHOOK_SECRET=your-hmac-secret

# ──────────────────────────────────────
# Image Generation
# ──────────────────────────────────────
IDEOGRAM_API_KEY=...
FAL_API_KEY=...

# ──────────────────────────────────────
# Video Generation
# ──────────────────────────────────────
KLING_API_KEY=...

# ──────────────────────────────────────
# Meta Ads (used by MCP server in .claude/mcp.json)
# Status: Configured — credentials pending
# ──────────────────────────────────────
# How to get these:
# META_ADS_ACCESS_TOKEN — Meta for Developers → your app → Tools → Graph API Explorer
#   Generate User Access Token with: ads_management, ads_read, business_management
#   For production: use a System User token (doesn't expire)
# META_ADS_ACCOUNT_ID — Meta Business Manager → Accounts → Ad Accounts
#   Copy the Account ID (format: act_XXXXXXXXX)
# Test connection after filling in: npx @pipeboard/meta-ads-mcp
META_ADS_ACCESS_TOKEN=
META_ADS_ACCOUNT_ID=

# ──────────────────────────────────────
# AWS S3 (creative asset storage)
# ──────────────────────────────────────
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=briefos-creatives
AWS_REGION=ap-south-1

# ──────────────────────────────────────
# Platform APIs (for scouts)
# ──────────────────────────────────────
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
YOUTUBE_API_KEY=...
```

---

## Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  briefos:
    build: .
    ports:
      - "3000:3000"
    env_file: .env
    restart: always
    depends_on:
      - redis
      - mongo
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/v1/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  n8n:
    image: n8nio/n8n
    ports:
      - "5678:5678"
    environment:
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=admin
      - N8N_BASIC_AUTH_PASSWORD=${N8N_PASSWORD}
    volumes:
      - n8n_data:/home/node/.n8n
    restart: always

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    restart: always
    command: redis-server --appendonly yes
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3

  mongo:
    image: mongo:7
    volumes:
      - mongo_data:/data/db
    restart: always
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  n8n_data:
  redis_data:
  mongo_data:
```

---

## Database Collections Reference

| Collection | Purpose | Key Indexes |
|---|---|---|
| `companies` | Profile + requirements + prompts + learnings | `tenantId` (unique) |
| `pipeline_runs` | Weekly run state machine | `tenantId + runId`, `tenantId + status` |
| `scout_outputs` | Raw + enriched scout findings | `tenantId + runId + platform` |
| `scout_signals` | Signal freshness tracking | `tenantId + hash` (unique), `tenantId + topic` |
| `intelligence_briefs` | Coordinator + competitor + market output | `tenantId + runId` |
| `creative_briefs` | Ranked briefs + performance attribution | `tenantId + briefId`, `tenantId + runId` |
| `creative_packages` | Generated ad creatives | `tenantId + briefId` |
| `campaigns` | Meta campaign records + audit history | `tenantId + metaCampaignId`, `tenantId + status` |
| `action_logs` | Every autonomous decision with reasoning | `tenantId + timestamp`, `tenantId + agent` |
| `usage_logs` | Every Claude API call (billing ledger) | `tenantId + timestamp`, `tenantId + agent` |
| `learning_runs` | Monthly learning execution log | `tenantId + version` |
| `personas` | Expert reviewer profiles (defaults + custom) | `tenantId` (null for defaults), `domain` |
| `discussions` | Full agent team review records with all rounds | `tenantId + targetId`, `tenantId + targetType` |
| `review_configs` | Per-tenant checkpoint configuration | `tenantId` (unique) |

---

## API Routes Reference

| Method | Route | Phase | Description |
|---|---|---|---|
| `POST` | `/api/v1/companies` | 1 | Register company + auto-generate prompts |
| `GET` | `/api/v1/companies` | 1 | List all companies |
| `GET` | `/api/v1/companies/:tenantId` | 1 | Full company details |
| `PUT` | `/api/v1/companies/:tenantId` | 1 | Update profile/requirements |
| `POST` | `/api/v1/companies/:tenantId/regenerate` | 1 | Re-run prompt generation |
| `POST` | `/api/v1/pipeline/:tenantId/run` | 2 | Trigger intelligence pipeline |
| `GET` | `/api/v1/pipeline/:tenantId/runs` | 2 | List all runs + status |
| `GET` | `/api/v1/pipeline/:tenantId/runs/:runId` | 2 | Run detail + agent outputs |
| `GET` | `/api/v1/pipeline/:tenantId/briefs` | 2 | Latest scored briefs |
| `GET` | `/api/v1/campaigns/:tenantId` | 5 | All campaigns + metrics |
| `GET` | `/api/v1/campaigns/:tenantId/:campaignId` | 5 | Campaign detail + audit log |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/pause` | 5 | Manual override pause |
| `GET` | `/api/v1/reports/:tenantId/weekly` | 3 | Latest weekly digest |
| `GET` | `/api/v1/reports/:tenantId/performance` | 6 | Campaign performance summary |
| `GET` | `/api/v1/actions/:tenantId` | 3 | Full action log with reasoning |
| `GET` | `/api/v1/usage/:tenantId` | 8 | Token usage + cost per agent |
| `GET` | `/api/v1/usage/:tenantId/monthly` | 8 | Monthly totals by agent |
| `GET` | `/api/v1/health` | 8 | Health check endpoint |
| `POST` | `/api/v1/review/personas` | 9 | Create custom persona for tenant |
| `GET` | `/api/v1/review/personas/:tenantId` | 9 | List all personas (defaults + custom) for tenant |
| `PATCH` | `/api/v1/review/personas/:id` | 9 | Update persona system prompt or criteria |
| `DELETE` | `/api/v1/review/personas/:id` | 9 | Delete custom persona |
| `GET` | `/api/v1/review/config/:tenantId` | 9 | Get checkpoint config for tenant |
| `PATCH` | `/api/v1/review/config/:tenantId` | 9 | Update checkpoint config (enable/disable, personas, thresholds) |
| `POST` | `/api/v1/review/discuss` | 9 | Manually trigger a team discussion on any pipeline output |
| `GET` | `/api/v1/review/discussions/:tenantId` | 9 | List all discussions for tenant |
| `GET` | `/api/v1/review/discussions/detail/:id` | 9 | Full discussion with all rounds and action items |

---

## Skills Reference

### Marketing Skills (from coreyhaines31/marketingskills)

| Skill | Used By | Purpose |
|---|---|---|
| `paid-ads` | Campaign Creator prompt | Meta campaign structure, audience strategy, naming, 70/30 split, scaling rules |
| `ad-creative` | Copy Writer + Scout prompts | PAS + BAB copywriting frameworks, ad variation patterns |
| `product-marketing-context` | All agent prompts | 12-section company knowledge format |
| `marketing-psychology` | Idea Pool + Scout prompts | Psychological triggers for brief scoring and hook writing |
| `competitor-alternatives` | Competitor Research prompt | Structured gap identification |
| `customer-research` | Scout prompts | Signal quality criteria, audience insight patterns |
| `copywriting` | Copy Writer prompt | Headline + CTA frameworks |
| `social-content` | Scout prompts | Platform-specific format signals |

**How skills are used:**
Skills are NOT injected directly into agent calls at runtime. Instead, `PromptGeneratorService` reads all marketing skills and uses them — along with the company profile — to generate rich, company-specific system prompts. These are stored in `company.prompts.*` in MongoDB and used for every agent call. Running `/regenerate` rebuilds all prompts when skills or company data changes.

**Prompts generated (10 total):**
`instagramScout`, `redditScout`, `twitterScout`, `youtubeScout`, `coordinator`, `competitorResearch`, `marketResearch`, `ideaPool`, `digestWriter`, `campaignCreator`

### Execution Skills (from everything-claude-code)

| Skill | Used By | Purpose |
|---|---|---|
| `continuous-learning-v2` | Learning Agent | Instinct-based learning with confidence scoring |
| `autonomous-loops` | Orchestrator | DAG pipeline with parallel execution + barriers |
| `cost-aware-llm-pipeline` | Claude Client | Model routing + budget tracking |
| `verification-loop` | Every Agent | Output validation + auto-retry (max 3) |
| `iterative-retrieval` | Scouts | Multi-pass progressive search |
| `market-research` | Competitor + Market Research | Source-attributed findings |

---

## Key Decisions Log

| Decision | Choice | Reason |
|---|---|---|
| Runtime | Node.js (not Bun) | Bottleneck is AI API calls, not runtime speed. Node has better ecosystem stability |
| Framework | NestJS (not Hono/Fastify) | DI, modules, guards, interceptors — built for this complexity level |
| AI SDK | Claude Code SDK (not raw API) | query() handles full agentic loop — tools, search, MCP, retries |
| Prompt architecture | Hybrid (strategic + live injection) | Products/prices change — can't hardcode in prompts. Serves any company type |
| Scout data sources | Platform APIs + web search | Web search alone is unreliable for trending content. Real engagement data needed |
| Scout research pattern | gpt-researcher-inspired (native) | Multi-query + page fetch + synthesis. Implemented in Claude Code SDK, no extra dependency |
| Safety enforcement | TypeScript code (not prompts) | Claude cannot override code-level budget caps and content rules |
| RAG | Not now | All company knowledge fits in prompt. Add as optional layer when data outgrows context |
| Delivery | n8n (self-hosted) | Visual routing for Slack/WhatsApp/Email. Marketing team can change channels without code |
| Learning | Monthly with 3+ data point minimum | Prevents overfitting to small samples. Confidence scoring for each pattern |
| Cold start strategy | Daily research + tenant feedback loop (14 days) | System has no idea what tenant likes on day 1. Daily ideas + ✅/❌ reactions build preference data fast. Auto-switches to weekly after confidence threshold (>60% approval) |
| Campaign creator prompt | Generated by PromptGeneratorService using `paid-ads` skill | Campaign creator needs company-specific audience strategy, placement preferences, and naming conventions — not just generic Meta Ads knowledge. Generated once, reused on every campaign launch. |
| Ideas per run | Tenant-configurable (default 5, max 10) | Every tenant has different experimentation appetite. Startups may want 10/day, established brands want 1-3/week. Stored in company.pipelineConfig.ideasPerRun. Budget: (N-2) coordinator ideas + 1 competitor gap + 1 market insight |
| Idea sources | 4 types tracked per idea (scout/viral/competitor/market) | Learning agent uses source tracking to find which input type produces best-performing ideas for each tenant |
| Campaign automation | Human-in-loop during learning, full auto after | During cold start: creative auto-generated but tenant confirms before launch. After steady state: fully autonomous. Switch requires 3 conditions: >60% approval rate + ROAS target met 2 consecutive weeks + tenant explicitly enables auto |
| Signal deduplication (now) | Topic+angle TTL (14d industry, 7d viral) | Simple, effective for early stage. Prevents re-researching same topic+angle within 2 weeks |
| Signal deduplication (Phase 7 upgrade) | Vector embeddings + cosine similarity | Semantic dedup catches same idea with different wording. Use MongoDB Atlas Vector Search. Threshold: 0.85 similarity = skip. Implement after 6-8 weeks of data when string matching starts failing |
| Vector embedding storage | Single collection, filtered by tenantId | Each signal document gets an `embedding` field (1536 dims). Atlas Vector Search pre-filters by tenantId before similarity search. No separate index per tenant — overkill and expensive. Embedding model: OpenAI text-embedding-3-small or Claude. Query: find signals where tenantId=X AND createdAt > 8 weeks ago AND similarity > 0.85 |

---

## Known Optimisations Backlog

Issues identified during Phase 2 build and testing. To be addressed in priority order.

### Priority 1 — ✅ Implemented

**Stuck run detector** ✅
- Problem: If server crashes mid-agent, run stays stuck in `scouts_running` / `intelligence_running` forever.
- Fix: On server startup, find runs stuck in non-terminal state for >2 hours and auto-resume.
- Implemented: `PipelineOrchestratorService.recoverStuckRuns()` via `OnModuleInit`.

**Bucket-based idea pool with rule-based selection** ✅
- Problem: Idea Pool generated ideas then scored them with a second LLM call — self-scoring bias inflated all scores to 7-9/10, and the scoring step wasted a full agent call.
- Fix: Removed scoring entirely. Ideas are now generated in 3 explicit buckets: (N-2) from coordinator signals, 1 from competitor gap, 1 from market insight. Winner is selected by deterministic rules: urgent competitor gap → Signal 1 → urgent market insight → Signal 2 → highest `priorityScore`. Selection reason is always traceable.
- Tracks `ideaSource` per idea: `scout_signal` / `viral_trend` / `competitor_gap` / `market_insight`. Each coordinator idea tagged with `signalRank` and `urgent` flag.
- Default `ideasPerRun` changed from 3 to 5 (both schema and service).
- Implemented: `IdeaPoolService.buildGeneratePrompt()`, `selectWinner()`, `parseBriefs()`.

**Cost estimation from token counts** ✅
- Problem: `costUSD` always 0 — Claude Code subscription doesn't return billing data.
- Fix: Estimate from token counts using public pricing (Sonnet: $3/M input + $15/M output, Haiku: $0.8/M input + $4/M output).
- Implemented: `ClaudeService.estimateCost()`.

**Full data flow — no truncation** ✅
- Problem: Competitor research (23KB) and market research (19KB) were truncated to 2000 chars in idea pool prompt.
- Fix: All three inputs (coordinator content, competitor research, market research) pass in full — no slicing anywhere.
- Implemented: `IdeaPoolService.buildGeneratePrompt()`.

**Viral trend deduplication** ✅
- Problem: `saveSignals()` only saved industry topics to `scout_signals`. Viral trends were never saved, so TTL dedup never excluded repeated viral trends across runs.
- Fix: Viral trends now saved to `scout_signals` with `signalType: 'viral'`. TTL is 7d for viral, 14d for industry. `loadRecentSignals()` queries both types with correct TTL per type.
- Implemented: `ScoutBaseService.saveSignals()`, `loadRecentSignals()`, `ScoutSignal` schema.

**Scout failure now throws** ✅
- Problem: After 3 failed attempts, scout saved an empty output and continued. Orchestrator counted it as a valid scout (`existingScouts.length >= 4`), so coordinator ran on zero signals from that platform silently.
- Fix: Scout throws after 3 failures. Pipeline fails cleanly and can be resumed. No empty outputs saved.
- Implemented: `ScoutBaseService.execute()`.

**Coordinator output schema in prompt** ✅
- Problem: Coordinator prompt told agent to "return topSignals JSON" but never showed field names. Agent invented its own structure, parser silently returned `[]`.
- Fix: Explicit JSON schema with exact field names (`topic`, `platforms`, `compositeScore`, `rationale`) added to coordinator prompt. Parser now logs a warning when JSON block is missing or malformed.
- Implemented: `CoordinatorService.buildCoordinatorPrompt()`, `extractTopSignals()`.

**Phase D skip loads briefs from DB** ✅
- Problem: On pipeline resume, Phase D skip reconstructed `ideaPoolResult` with `briefs: []`. Digest writer had no runner-up ideas to include.
- Fix: Load all `intelligence_briefs` from DB when skipping Phase D so digest gets full runner-up list.
- Implemented: `PipelineOrchestratorService.executeDAG()`.

**Digest writer never asks questions** ✅
- Problem: Digest agent asked for clarification when topSignals was empty instead of writing with available data.
- Fix: Prompt explicitly says "Do NOT ask any questions. Write the digest immediately using the data provided." Runner-up ideas now included in prompt.
- Implemented: `DigestWriterService.buildDigestPrompt()`.

**Prompt generator improvements** ✅
- JSON parser now extracts ```json block anywhere in response (not just start) — same fix as scouts.
- Word count guidance split: scouts 600-900 words, non-scouts 300-500 words.
- Non-scout agents now get specific per-agent guidance in the meta-prompt.
- Reddit example subreddit generalised (was hardcoded to `r/astrology`).
- Errors now surface via NestJS Logger instead of `console.error`.
- Implemented: `PromptGeneratorService`, `CompaniesController`.

### Priority 2 — Implement in Phase 3-4

**Coordinator aware of past winning briefs**
- Problem: Coordinator ranks signals but doesn't know which topics historically converted into good campaigns.
- Fix: Inject top 5 past briefs with high ROAS into coordinator prompt. It will favour signals similar to past winners.
- Where: `CoordinatorService.run()` — load top performing `intelligence_briefs` and inject into prompt.

**Scout quality tracking**
- Problem: If a scout returns 2 signals instead of 10, we don't know if the platform was quiet or Claude searched poorly.
- Fix: Track signal count per scout per run. Flag runs where any scout returns <3 signals.
- Where: `ScoutBaseService.execute()` — store signal count in `pipeline_runs`.

**Platform failure flagging to coordinator**
- Problem: If a scout fails, coordinator just sees fewer signals and may draw wrong conclusions without knowing why.
- Fix: Pass platform failure flags to coordinator prompt so it can weight remaining platforms accordingly.
- Where: `PipelineOrchestratorService.executeDAG()`.

### Priority 3 — Implement in Phase 7

**Prompt quality validation after generation**
- Problem: If prompt generator produces a bad prompt, there's no quality check. Bad prompts silently degrade all agents.
- Fix: After generation, run a validation agent that scores each of the 9 prompts 1-10. Regenerate any below 7.
- Where: `PromptGeneratorService.generate()`.

**Digest actionability**
- Problem: Digest presents ideas but doesn't lead with a single clear next step.
- Fix: Add "THIS WEEK'S ACTION" section at the very top — one sentence, one next step.
- Where: `DigestWriterService` — update prompt.

---

## Weekly Checklist Template

Use this for each development week:

```
Week N — Phase X
═══════════════════════

Monday:
  [ ] Review phase goals and exit criteria
  [ ] Set up any new modules/schemas needed

Tues–Thursday:
  [ ] Build core services
  [ ] Write integration tests for critical paths
  [ ] Manual testing against real APIs

Friday:
  [ ] Code review (use typescript-reviewer.md agent)
  [ ] Verify exit criteria met
  [ ] Document any decisions or deviations
  [ ] Update BRIEFOS.md if architecture changed
```

---

*This document is the single source of truth for building BriefOS. Update it as decisions change.*