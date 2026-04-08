# Autonomous Marketing Agent

> **Stack:** NestJS + TypeScript · MongoDB · BullMQ + Redis · Claude Code SDK · Meta Graph API v21.0 · Heygen · n8n
>
> **Runtime:** Node.js 20+
>
> **Branch:** agent_teams

---

## Overview

Autonomous AI Marketing Agent. A company registers once and the system autonomously runs intelligence pipelines, generates ad creatives, auto-launches Meta Ads campaigns, monitors performance every 6 hours, and improves itself monthly by learning from past results.

Human involvement is optional — every decision surfaces for approval via Slack, but the system can operate end-to-end without it.

---

## Architecture

```
INTELLIGENCE PIPELINE (daily during cold start → weekly after)
  Scout Agents (Haiku) → Coordinator → Strategy Team → Creative Team → Campaign Review Team

CAMPAIGN LIFECYCLE
  pending_approval → human approve → Meta launch → Audit (6h) → pendingActions → Learning

LEARNING LOOP
  Day 7/14/30 writebacks → Monthly Aggregation → company.learnings → feeds next campaign
```

### Agent Model Routing

| Agent | Model |
|---|---|
| Instagram, Reddit, Twitter, YouTube scouts | `claude-haiku-4-5-20251001` |
| Market Research, Case Study Generator, Coordinator, Digest Writer | `claude-haiku-4-5-20251001` |
| Campaign Auditor, Learning Agent, Prompt Generator | `claude-sonnet-4-6` |
| Strategy Team (Strategist + Contrarian) | `claude-sonnet-4-6` via `claude -p` CLI |
| Creative Team (Creative Director + Brand Compliance) | `claude-sonnet-4-6` via `claude -p` CLI |
| Campaign Review Team (Campaign Strategist + Performance Analyst) | `claude-sonnet-4-6` via `claude -p` CLI |

All agent calls go through `ClaudeService.runAgent()` — never call `query()` directly.

---

## What's Built

### 1. Intelligence Pipeline

Runs daily during cold start (<14 days), weekly (Monday 9 AM IST) after.

```
Scout Agents (parallel, Haiku)
  Instagram · Reddit · Twitter · YouTube · Market Research
       ↓
  Coordinator (Haiku) — signal scoring
       ↓
  Strategy Team (2-agent debate via CLI)
  Strategist proposes ideas → Contrarian stress-tests → consensus on winning idea
       ↓
  Creative Team (2-agent debate via CLI)
  Creative Director drafts copy variants + image/video prompts
  Brand Compliance reviews for Meta policy + brand tone
       ↓
  Campaign Review Team (2-agent debate via CLI)
  Campaign Strategist proposes full Meta config (budget, ad sets, audiences)
  Performance Analyst challenges on targeting, timing, risk
       ↓
  Campaign saved as pending_approval → Slack notification
```

---

### 2. Meta Learning Import

Fetches and enriches up to 1 year of historical campaign data from all Meta ad accounts.

**How it works:**
1. Fetches 1 year of campaigns from all accounts in `company.meta.accountIds[]`
2. Filters campaigns with spend > ₹500
3. Batches into groups of 50, queued via BullMQ with 10s stagger between batches
4. Each campaign enriched with: insights, ad sets (with `promoted_object` + budgets), ad-level insights, demographics, creatives
5. `detectProduct` maps `promoted_object.custom_conversion_id` → custom conversion name → fuzzy product match
6. Atomic finalize guard prevents duplicate BullMQ runs
7. Top 50 case studies by spend saved per batch — visible live as batches complete

**Query helpers used by agent teams:**
- `getRelevantCaseStudies(tenantId, { product?, limit? })` — top N case studies by spend
- `getAudiencePerformanceSummary(tenantId)` — avg CPA, CTR, conversions grouped by audience type

---

### 3. Campaign Creator

**Step 1 — Create (pending_approval):**
1. Safety checks (TypeScript, cannot be overridden by Claude):
   - Weekly budget cap not exceeded
   - Per-campaign budget cap not exceeded
   - No forbidden topics in brief.topic / brief.hook / brief.keyMessage
   - Campaigns per run limit not reached
2. Campaign Review Team debate (2 attempts with fallback)
3. Save as `pending_approval` with full `campaignConfig` (ad sets, budget, audiences, creative formats)
4. Slack notification with approval endpoint

**Step 2 — Launch (human approval):**
```
POST /api/v1/campaigns/:tenantId/:campaignId/approve
Body: { "accountId": "act_123456789" }
```
1. Validates `accountId` against `company.meta.accountIds`
2. Uploads image to Meta (image hash)
3. Uploads video to Meta if any ad set needs it (async polling up to 3 min)
4. Creates Meta campaign → ad sets → ads via Graph API
5. Per ad set: `creativeFormat` decides video/image/both ads
6. Activates campaign only if all expected ads created
7. Saves all Meta IDs + `metaAccountId` to MongoDB

---

### 4. Creative Format per Ad Set

Campaign Review Team decides `creativeFormat: 'video' | 'image' | 'both'` per ad set based on:
- `company.learnings.creative.winningFormats` — historical winners
- Audience type defaults:
  - `lookalike` / `advantage_plus` (cold) → `video` (scroll-stop)
  - `interest` (warm) → `both` (test both)
  - `retarget` (hot) → `image` (faster, user knows brand)

Video generation via Heygen:
- Creative Team outputs Heygen-compatible JSON script: `{ title, scenes: [{ text, duration }] }`
- Heygen generates vertical (9:16) video
- Uploaded to Meta at launch time

---

### 5. Intelligent Campaign Auditor (4 Layers)

Runs every 6 hours per tenant. Only monitors `source: 'agent'` campaigns.

#### Layer 1 — Safety Rails (TypeScript, unoverridable)
- Campaign spend > `maxBudgetPerCampaign` → auto-pause
- Weekly spend across all campaigns > `weeklyBudgetCap` → auto-pause
- Frequency > `pauseIfFrequencyAbove * 1.5` → auto-pause (severe audience fatigue)
- Age > 2× `coldStartDays` with 0 conversions + >50% budget spent → auto-pause

#### Layer 2 — Signal Detection (pure TypeScript math)
Calculates from last 3 `AuditSnapshot` records:

| Signal | What it measures |
|---|---|
| `ctrTrend` | CTR improving/stable/declining vs last 3 audits (±10% threshold) |
| `roasTrend` | ROAS trend |
| `frequencyTrend` | Frequency rising/stable |
| `spendPace` | on_track/underspending/overspending vs budget |
| `expectedCTRRange` | Benchmark from `company.learnings.creative.winningHooks` |
| `highSpendZeroConversions` | Ad sets with spend >₹1,500 + 0 conversions |
| `creativeFatigue` | Ads with CTR drop >35% from 48h baseline |
| `audienceFatigue` | Ad sets with frequency > `pauseIfFrequencyAbove` |
| `stuckInLearning` | Age >coldStartDays with 0 total conversions |
| `budgetExhaustionRisk` | Spend >85% of budget |

#### Layer 3 — Audit Agent (Claude)
Receives full context: live metrics + signal packet + 10 audit snapshots + company.learnings + case studies.

Returns structured `AuditVerdict`:
```json
{
  "verdict": "watch | act | no_action",
  "urgency": "immediate | 48h | 7d | null",
  "contextInsight": "plain English explanation of the key finding",
  "watchSignals": ["signal to monitor next audit"],
  "recommendedActions": [
    {
      "type": "pause_ad | pause_adset | scale_adset | replace_creative",
      "targetId": "meta_id",
      "targetName": "human readable name",
      "reason": "specific reason",
      "priority": "high | medium | low"
    }
  ]
}
```

Agent guidelines:
- Tolerant during learning phase (first `coldStartDays` days)
- Only "act" on clear evidence of waste or scaling opportunity
- Creative fatigue >35% CTR drop → always act
- High spend + zero conversions → always act with immediate urgency
- ROAS > 2× with 3+ conversions → act with scale recommendation

#### Layer 4 — Human-in-the-Loop
- `no_action` → nothing
- `watch` → Slack notification (only if watchSignals present)
- `act` → creates `pendingActions` with grace period + Slack digest

**pendingAction lifecycle:**
```
recommendedAt + gracePeriodHours = executeAt
  → auto-executes pause_ad / pause_adset when expired
  → scale_adset ALWAYS requires manual approval (never auto-executes)

Human can:
  POST /actions/:actionId/approve  → executes immediately
  POST /actions/:actionId/override → skips, won't auto-execute
```

**Performance writebacks:**
- Day 7 → brief.day7Performance + triggers creative quick scan
- Day 14 → brief.day14Performance
- Day 30 → brief.day30Performance + triggers campaign deep run

---

### 6. Audit Snapshot History

Every audit run saves an `AuditSnapshot` to MongoDB (collection: `audit_snapshots`):
```
tenantId, campaignId, metaCampaignId, auditedAt
metrics: { spend, impressions, clicks, conversions, roas, ctr, cpc, cpa, frequency }
adSets: [{ metaAdSetId, name, audienceType, spend, conversions, ctr, cpa, roas, frequency }]
ads: [{ metaAdId, adSetId, spend, conversions, ctr, cpc }]
verdict: { verdict, urgency, contextInsight, watchSignals, recommendedActions[] }
```
Used for trend detection (last 3 snapshots) and audit history display.

---

### 7. Multi-Account Meta Support

- `company.meta.accountIds[]` — list of allowed Meta ad accounts per tenant
- Approval endpoint requires `accountId` in request body
- Validated against `company.meta.accountIds` before launch
- Stored as `campaign.metaAccountId` after launch
- Image/video uploads are account-scoped
- `company.meta.accessToken` — shared across accounts

---

### 8. Campaign Sync

Keeps MongoDB in sync with Meta.
- `syncActiveCampaigns` — 6h cron, syncs ACTIVE and PAUSED campaigns
- Saves full ad set + ad structure including `audienceType`, `dailyBudget`, `lifetimeBudget`, metrics
- `source: 'agent' | 'manual'` — auditor only monitors `agent` campaigns

---

### 9. Monthly Learning Aggregation

Runs 1st of every month at 3 AM IST. Aggregates patterns from historical + live data into `company.learnings`:

```json
{
  "creative": {
    "winningHooks": ["bold_claim (2.54% CTR)", "question (2.36% CTR)"],
    "losingHooks": ["personal_story (1.04% CTR)"],
    "winningFormats": ["video", "carousel"]
  },
  "campaign": {
    "audienceScores": { "lookalike": 1.88, "interest": 0.35 },
    "budgetInsights": ["Low budgets <₹3K/day have 66% lower CPA"],
    "timingInsights": ["Seasonal peaks: Jun"]
  }
}
```

---

## API Reference

### Companies

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/companies` | Create company — schedules all jobs automatically |
| `GET` | `/api/v1/companies` | List all companies |
| `GET` | `/api/v1/companies/:tenantId` | Get company (includes meta, learnings, signals) |
| `PUT` | `/api/v1/companies/:tenantId` | Update company (meta fields merged, not replaced) |
| `POST` | `/api/v1/companies/:tenantId/regenerate` | Regenerate AI prompts |
| `POST` | `/api/v1/companies/:tenantId/import-learnings` | Trigger Meta learning import |
| `GET` | `/api/v1/companies/:tenantId/import-status` | Poll import progress |
| `POST` | `/api/v1/companies/:tenantId/finalize-import` | Re-run finalize without re-enriching |
| `GET` | `/api/v1/companies/:tenantId/case-studies` | List top 50 case studies |

### Campaigns

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/campaigns/:tenantId` | List all campaigns |
| `GET` | `/api/v1/campaigns/:tenantId/:campaignId` | Get single campaign |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/approve` | Launch campaign on Meta — body: `{ accountId }` |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/pause` | Pause campaign — body: `{ reason }` |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/reject` | Reject pending campaign — body: `{ reason }` |
| `GET` | `/api/v1/campaigns/:tenantId/:campaignId/pending-actions` | List pending audit actions |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/approve` | Execute action immediately |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/override` | Veto action |

### Creative

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/creative/:tenantId/packages/:creativePackageId` | Get creative package (copy variants, imageUrl, videoUrl) |
| `POST` | `/api/v1/creative/:tenantId/briefs/:briefId/approve` | Approve idea → trigger creative production (fire-and-forget) |

---

## Queue System (BullMQ)

| Queue | Trigger | Schedule |
|---|---|---|
| `pipeline` | Weekly cron (Monday 9 AM IST) or daily during cold start | Per tenant |
| `campaign-audit` | Every 6 hours | Per tenant |
| `monthly-learning` | 1st of every month, 3 AM IST | Per tenant |
| `meta-learning-import` | On-demand via import endpoint | On-demand |
| `campaign-sync` | Every 6 hours | Per tenant |

All jobs are scheduled automatically when a new company is created.

---

## Company Config Reference

Key fields that control campaign and audit behaviour:

```typescript
// Budget controls
weeklyBudgetCap: number            // hard cap on total spend per week
maxBudgetPerCampaign: number       // hard cap per campaign
maxBudgetScalePercent: number      // max % to scale budget per action (default 20)

// Pause triggers
pauseIfFrequencyAbove?: number     // safety pause at 1.5x this value
pauseIfROASBelow?: number
pauseIfCTRBelow?: number
pauseAfterDaysInLearning?: number

// Scale triggers
scaleIfROASAbove?: number

// Pipeline config
pipelineConfig: {
  mode: 'daily' | 'weekly'
  coldStartDays: number              // learning phase duration (default 14)
  autoSwitch: boolean
  campaignStrategy: 'conservative' | 'balanced' | 'experimental'
  pauseGracePeriodHours: number      // audit action grace period (default 12)
  scaleRequiresApproval: boolean
}

// Meta
meta: {
  accessToken: string
  accountIds: string[]               // all allowed ad accounts
  pageId: string
  pixelId: string
}

// Forbidden content
forbiddenTopics: string[]            // checked against topic, hook, keyMessage
```

---

## Setup

### Prerequisites

- Node.js 20+
- MongoDB
- Redis

### Environment Variables

```env
# App
APP_PORT=3000
APP_ENV=development

# MongoDB
MONGO_URI=mongodb://localhost:27017/autonomous-marketing-agent

# Redis (BullMQ)
REDIS_URL=redis://localhost:6379

# Anthropic (Claude Code SDK)
ANTHROPIC_API_KEY=sk-ant-...

# Meta Graph API (global fallback — per-tenant overrides stored in DB)
META_ADS_ACCESS_TOKEN=...
META_ADS_ACCOUNT_ID=act_...

# Heygen (text-to-video)
HEYGEN_API_KEY=...

# YouTube Data API (scout agent)
YOUTUBE_API_KEY=...

# AWS S3 (asset storage)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=...
AWS_REGION=ap-south-1

# n8n (Slack/WhatsApp/Email delivery)
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

1. **Never hardcode** product names, prices, or dates in agent system prompts — live data injected at runtime via `LiveContextBuilder`
2. **All budget/safety checks** are enforced in TypeScript — Claude agents cannot override them
3. **Every database query** must include a `tenantId` filter
4. **Every agent call** must go through `ClaudeService.runAgent()` — never call `query()` directly
5. **Meta field updates** always merge (never replace) to prevent wiping `accessToken`
6. **Campaign monitoring** only covers `source: 'agent'` campaigns — manual Meta campaigns are synced but not audited
