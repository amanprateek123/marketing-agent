# Autonomous Marketing Agent

> **Stack:** NestJS + TypeScript · MongoDB · BullMQ + Redis · Claude Code SDK · Meta Graph API v21.0 · Heygen · OpenAI DALL-E 3 · n8n
>
> **Runtime:** Node.js 20+

---

## Overview

Autonomous AI Marketing Agent. A company registers once and the system autonomously runs intelligence pipelines, generates ad creatives, launches Meta Ads campaigns, monitors performance every 6 hours, and improves itself by learning from past results.

Every campaign requires human approval before spending real money. Decisions surface via Slack with one-click approve/reject.

---

## Architecture

```
INTELLIGENCE PIPELINE (daily during cold start → weekly after)
  Scout Agents (4x parallel) → Coordinator → Research Agents → Strategy Team → Creative Team → Campaign Review Team

CAMPAIGN LIFECYCLE
  pending_approval → human /approve → Meta launch (PAUSED → ACTIVE) → Audit (6h) → pendingActions → Learning

LEARNING FEEDBACK LOOP
  Day 7:  creative quick scan → company.learnings.creative
  Day 14: performance writeback
  Day 30: causal attribution → company.learnings.campaign → prompt regeneration
  On pause: single-campaign root cause analysis → causalInsights

SAFETY LAYERS (all TypeScript — LLMs cannot override)
  Budget caps · Weekly spend limits · Forbidden topics · Campaign-per-run limits
  Re-validated after review team adjustments · NaN guards on all budget math
```

### Agent Model Routing

| Agent | Model | Tools | Notes |
|---|---|---|---|
| Instagram, Reddit, Twitter, YouTube scouts | Haiku | WebSearch, WebFetch, Bash | Data fetching + structured JSON output |
| Market Research | Haiku | WebSearch, WebFetch, Bash | maxTurns: 12 |
| Meta Ads Library | Haiku | WebSearch, WebFetch, Bash | Web scraping for competitor ads |
| Case Study Generator | Haiku | None | Structured summarization |
| Digest Writer | Haiku | None | Slack formatting |
| Coordinator | Sonnet | None | Cross-platform signal synthesis — needs reasoning |
| Competitor Research | Sonnet | WebSearch, WebFetch, Bash | Attack angle formulation |
| Idea Pool (fallback) | Sonnet | None | Rule-based winner selection |
| Creative Producer / Copy Writer | Sonnet | None | Ad copy creativity |
| Campaign Auditor | Sonnet | None | Multi-signal verdict synthesis (maxTurns: 1) |
| Creative Learning Agent | Sonnet | None | Pattern attribution (overridden from Haiku) |
| Campaign Learning Agent | Sonnet | None | Causal attribution |
| Prompt Generator | Sonnet | None | Meta-reasoning (writes prompts for other agents) |
| Strategy Team Lead | Sonnet | Team tools | 2-agent debate via CLI |
| Creative Team Lead | Sonnet | Team tools | 2-agent debate via CLI |
| Campaign Review Lead | Sonnet | Team tools | 2-agent debate via CLI |

All agent calls go through `ClaudeService.runAgent()` with:
- **3 retries** with exponential backoff on rate limit errors
- **5-minute timeout** via `Promise.race` (timer properly cleared)
- **Usage logging** to MongoDB per call

---

## Pipeline Flow (Phases A–G)

### Phase A: Scouts (parallel)

4 platform scouts run in parallel via `Promise.allSettled` (one failing doesn't kill the pipeline).

Each scout:
1. Gets company-specific system prompt from `company.prompts`
2. Gets live context (products, prices, promotions, summarized learnings)
3. Receives exclusion list of recently covered topics (14-day TTL for industry, 7-day for viral)
4. Retries up to 3 times on invalid JSON
5. Saves `ScoutOutput` (full JSON) + individual `ScoutSignal` records (for dedup)

### Phase B: Coordinator + Meta Ads Library (parallel)

**Coordinator** synthesizes all scout signals into ranked `topSignals` (5-10, scored 0-10).
- Reads industry signals only (viral trends come from `ScoutOutput` separately — no double-counting)
- Produces structured JSON with fallback text extraction if JSON parsing fails

**Meta Ads Library** (optional, degrades gracefully) scrapes competitor ads and identifies market gaps.

### Phase C: Research Agents (parallel)

**Competitor Research** (Sonnet, 15 turns): Deep web research on competitor weaknesses, pricing changes, customer complaints. Finds what the Ads Library can't — reviews, positioning shifts, promotions.

**Market Research** (Haiku, 12 turns): Purchase-intent signals, seasonal windows, urgency triggers.

Both produce structured `{ insights[], rawSummary }` with score/urgency per insight.

### Phase D: Strategy Team / Idea Pool

**Primary: Strategy Team** — 2-agent debate (Strategist + Contrarian) via `claude -p` CLI.

Prompt structure (Data → Rules → Steps):
1. Product catalog with audience segments, Meta audiences, performance data
2. All intelligence (coordinator signals, competitor insights, market insights, ads library gaps) — presented as equal-weight sources
3. Live context + case studies
4. Rules (budget, product matching, source equality)
5. Steps (team setup, generate ~N ideas, send with context brief to Contrarian, debate, output JSON)

Key design decisions:
- **Contrarian receives a context brief** (top signals, competitor/market insights, product performance) so it can challenge with real data
- **Dynamic pool size:** `Math.max(20, ideasPerRun * 3)` raw ideas
- **Dynamic cut target:** Contrarian cuts `Math.floor(poolSize * 0.4)` in Round 1
- **No source quotas** — best ideas win regardless of origin
- **Empty state handling** — each intelligence section shows "No actionable X this run" when empty
- **No hardcoded product names** in the output schema

**Fallback: IdeaPool** — single-agent with rule-based winner selection. Throws on empty briefs (caught by orchestrator).

### Phase E: Digest

Writes Slack-formatted intelligence summary + per-idea briefs. Sends via webhook.

### Phase F: Creative Team

**Primary: Creative Team** — 2-agent debate (Creative Director + Brand Compliance Reviewer).

Prompt structure (Data → Specs → Rules → Steps):
1. Brief (topic, angle, platform, product with price/URL)
2. Live context + case studies
3. Creative specs: 3 copy variants (each with different hookStyle), DALL-E 3 image prompt, Heygen video prompt
4. Rules (direct response, no generic phrases, product name + price required)
5. Steps (team setup, create package, send to Compliance with product data for accuracy checks, debate, output)

**Compliance Reviewer** has product name + price data to verify accuracy (not just policy/tone).

**Fallback:** Single-agent CopyWriter + ImageGenerator + no video.

### Phase G: Campaign Review + Launch

**Campaign Review Team** — 2-agent debate (Campaign Strategist + Performance Analyst).

Prompt structure (Data → Rules → Steps):
1. Campaign brief + product data + audience segments + Meta audience IDs
2. Audience performance data + case studies + live context
3. Budget rules, ad set rules, creative format logic (conditional — full decision tree only when no data)
4. Steps (team setup, send with context brief to Analyst, debate, output structured config)

**Performance Analyst** receives context brief with product performance, budget caps, and audience data.

**Safety re-validation:** After review team adjustments, budget is clamped to `maxBudgetPerCampaign` and `checkWeeklyBudget` re-runs. Review team cannot override TypeScript limits.

**Launch flow:**
1. Campaign saved as `pending_approval` → Slack notification
2. Human calls `POST /approve` with `accountId`
3. Image uploaded to Meta (hash), video uploaded + polled (up to 3 min)
4. Campaign → Ad Sets → Ads created via Graph API (all start PAUSED)
5. Activated only if all expected ads created
6. Rollback on partial failure (delete campaign cascades)

---

## Campaign Auditor (4 Layers)

Runs every 6 hours per tenant. Only monitors `source: 'agent'` campaigns.

### Layer 1 — Safety Rails (TypeScript, unoverridable)
- Campaign spend > `maxBudgetPerCampaign` → auto-pause
- Weekly spend > `weeklyBudgetCap` → auto-pause
- Frequency > `pauseIfFrequencyAbove × 1.5` → auto-pause
- Age > 2× `coldStartDays` + 0 conversions + >50% budget spent → auto-pause

### Layer 2 — Signal Detection (TypeScript math)
- **CTR/ROAS trends** from last 3 audit snapshots (±10% threshold)
- **CTR benchmarks** from historical audit snapshot data (not parsed from text)
- **Creative fatigue:** ads with >35% CTR drop from 48h baseline
- **Audience fatigue:** ad sets with frequency > threshold
- **Weekly cap status:** actual weekly spend passed from auditor (no longer hardcoded false)
- **Spend pace:** actual vs expected based on daily budget × days elapsed

### Layer 3 — Audit Agent (Claude Sonnet, maxTurns: 1)
Receives full signal packet + metrics + snapshots + learnings. Returns structured verdict (act/watch/no_action) with recommended actions and urgency.

### Layer 4 — Human-in-the-Loop
- `act` → creates `pendingActions` with grace period + Slack digest
- Pause actions auto-execute after grace period
- **Scale actions require explicit human approval** (never auto-execute)
- Scale executes via `MetaAdsService.updateAdSetBudget()` → actually hits Meta Graph API
- Human can approve (immediate execute) or override (skip)

### Conversion Tracking

`extractConversions` respects the company's actual conversion event (Purchase, Lead, CompleteRegistration, Subscribe, custom events). All ROAS calculations, safety checks, and learning analysis use the correct event type.

### Metrics Time Windows

All metrics (campaign, ad set, ad level) use `date_preset: 'maximum'` (lifetime) for consistent cross-level comparisons.

---

## Learning System

### Creative Learning (Day 7 trigger)
- Needs 3+ completed creative packages
- Single batch query for campaigns (no N+1)
- Analyzes CTR patterns across hook styles/formats
- Model: Sonnet (forced override — pattern attribution needs reasoning)

### Campaign Learning (Day 30 trigger)
- Needs 3+ campaigns with Day 30 data
- Single batch queries for campaigns + creatives (no N+1)
- Causal attribution with variable isolation
- Regenerates company prompts after deep run

### Root Cause Analysis (on pause trigger)
- Dedicated single-campaign system prompt (not the multi-campaign prompt)
- Confidence capped at 0.50 for single data point
- Appends to `company.learnings.causalInsights`

---

## Scheduling

| Queue | Schedule | Notes |
|---|---|---|
| `pipeline` | Daily 9 AM IST (cold start) or Weekly Monday 9 AM IST | Per tenant |
| `pipeline-switch` | One-shot delayed job | Fires when cold start ends, switches daily → weekly |
| `campaign-audit` | Every 6 hours | Per tenant |
| `monthly-learning` | 1st of every month, 3 AM IST | Per tenant |
| `campaign-sync` | Every 6 hours | Per tenant |
| `meta-learning-import` | On-demand | Batch import of historical data |

### Schedule Logic

```
autoSwitch: false + mode: 'daily'  → always daily (manual override)
autoSwitch: false + mode: 'weekly' → always weekly (manual override)
autoSwitch: true  (default)        → daily during cold start, weekly after
```

When `autoSwitch` is on and tenant is in cold start, a one-shot delayed BullMQ job is scheduled to fire exactly when `coldStartDays` elapses. No dependency on server restarts for the switch.

### Pipeline Recovery

On server startup, stuck runs (>2 hours old) are recovered with **30-second stagger** between each to prevent thundering herd.

---

## Meta Learning Import

Fetches and enriches up to 1 year of historical campaign data from all Meta ad accounts.

1. Fetches campaigns from all accounts in `company.meta.accountIds[]`
2. Filters campaigns with spend > ₹500
3. Batches into groups of 50, queued via BullMQ with 10s stagger
4. Each campaign enriched with: insights, ad sets, ad-level insights, demographics, creatives
5. Product detection via `promoted_object.custom_conversion_id` → fuzzy product match
6. Top 50 case studies by spend saved per batch

**Query helpers used by agent teams:**
- `getRelevantCaseStudies(tenantId, { product?, limit? })` — most recent case studies
- `getAudiencePerformanceSummary(tenantId)` — avg CPA, CTR, conversions by audience type

---

## API Reference

### Companies

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/companies` | Create company — schedules all jobs |
| `GET` | `/api/v1/companies` | List all |
| `GET` | `/api/v1/companies/:tenantId` | Get company |
| `PUT` | `/api/v1/companies/:tenantId` | Update (meta fields merged) |
| `PUT` | `/api/v1/companies/:tenantId/budget` | Update budget settings |
| `PUT` | `/api/v1/companies/:tenantId/products` | Replace products array |
| `POST` | `/api/v1/companies/:tenantId/regenerate` | Regenerate AI prompts |
| `POST` | `/api/v1/companies/:tenantId/import-learnings` | Start Meta learning import |
| `GET` | `/api/v1/companies/:tenantId/import-status` | Poll import progress |
| `POST` | `/api/v1/companies/:tenantId/finalize-import` | Re-run finalize |
| `GET` | `/api/v1/companies/:tenantId/case-studies` | List case studies |
| `POST` | `/api/v1/companies/:tenantId/import-creative-learnings` | Claude analysis of Meta ad copy |

### Campaigns

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/campaigns/:tenantId` | List all campaigns |
| `GET` | `/api/v1/campaigns/:tenantId/:campaignId` | Get campaign detail |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/approve` | Launch on Meta — `{ accountId }` |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/pause` | Pause (MongoDB + Meta) — `{ reason }` |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/reject` | Reject pending — `{ reason }` |
| `GET` | `/api/v1/campaigns/:tenantId/:campaignId/pending-actions` | List pending audit actions |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/approve` | Execute action now |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/override` | Skip action |
| `GET` | `/api/v1/campaigns/:tenantId/:campaignId/audit-snapshots` | Audit history (last 30) |

### Pipeline

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/pipeline/:tenantId/trigger` | Trigger pipeline run |
| `GET` | `/api/v1/pipeline/:tenantId/runs/:runId` | Get run status |

---

## Conversion Tracking (3 Modes)

Per product in `company.products[]`:

| Mode | Fields | When to use |
|---|---|---|
| Standard Event | `conversionEvent: 'Purchase'` | Standard Meta pixel events |
| Custom Event | `conversionEvent: 'CustomEvent'`, `customEventName: 'MyEvent'` | Custom pixel events |
| Custom Conversion | `customConversionId: '123456'` | Named conversions with rules |

Custom conversions take priority. All metrics, ROAS calculations, safety checks, and learning analysis respect the configured conversion event type.

---

## Company Config Reference

```typescript
// Budget controls
weeklyBudgetCap: number            // hard cap on total spend per week
maxBudgetPerCampaign: number       // hard cap per campaign per day
maxBudgetScalePercent: number      // max % to scale (default 20, NaN-guarded)

// Pause triggers
pauseIfFrequencyAbove?: number     // safety pause at 1.5x this value
pauseIfROASBelow?: number
pauseIfCTRBelow?: number

// Scale triggers
scaleIfROASAbove?: number

// Pipeline config
pipelineConfig: {
  mode: 'daily' | 'weekly'          // manual override (when autoSwitch: false)
  coldStartDays: number              // default 14
  autoSwitch: boolean                // default true — daily→weekly after cold start
  ideasPerRun: number                // how many ideas to produce (default 10)
  campaignStrategy: 'conservative' | 'balanced' | 'experimental'
  pauseGracePeriodHours: number      // audit action grace period (default 12)
  scaleRequiresApproval: boolean     // scale always needs human OK (default true)
}

// Meta
meta: {
  accessToken: string
  accountId: string                  // primary account
  accountIds: string[]               // all allowed accounts
  pageId: string                     // Facebook Page ID
  pixelId: string                    // shared pixel
}

// Products
products: [{
  name: string
  price: number
  conversionValue: number
  landingUrl: string
  conversionEvent?: string           // Purchase | Lead | CompleteRegistration | CustomEvent
  customEventName?: string
  customConversionId?: string
  pixelId?: string                   // product-specific pixel
  audienceSegments?: AudienceSegment[]
  metaAudiences?: MetaAudience[]
  performance?: ProductPerformance   // populated by learning system
}]

// Content safety
forbiddenTopics: string[]            // checked against topic, hook, keyMessage
avoid: string[]                      // brand voice exclusions
```

---

## Setup

### Prerequisites

- Node.js 20+
- MongoDB
- Redis

### Environment Variables

```env
APP_PORT=3000
MONGO_URI=mongodb://localhost:27017/autonomous-marketing-agent
REDIS_URL=redis://localhost:6379
ANTHROPIC_API_KEY=sk-ant-...
META_ADS_ACCESS_TOKEN=...
META_ADS_ACCOUNT_ID=act_...
HEYGEN_API_KEY=...
OPENAI_API_KEY=sk-...
YOUTUBE_API_KEY=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=...
AWS_REGION=ap-south-1
N8N_WEBHOOK_URL=...
N8N_WEBHOOK_SECRET=...
```

### Run

```bash
npm install
npm run start:dev
```

---

## Key Rules

1. **Never hardcode** product names, prices, or dates in agent prompts — live data injected via `LiveContextBuilder`
2. **All budget/safety checks** in TypeScript — re-validated after review team adjustments
3. **Every database query** must include `tenantId` filter
4. **Every agent call** through `ClaudeService.runAgent()` — never `query()` directly
5. **Meta field updates** always merge (never replace)
6. **Campaign monitoring** only covers `source: 'agent'` campaigns
7. **Mongoose Mixed fields** (`products`, `services`, `meta`) require `markModified()` before `save()`
8. **Expired promotions** filtered from live context automatically
9. **Conversion tracking** respects per-product event type across all metrics and safety checks
10. **Scale actions** always require human approval — never auto-execute
