# Marketing Agent — Autonomous AI Marketing Platform

> **Stack:** NestJS + TypeScript · MongoDB · BullMQ + Redis · Claude Code SDK · Meta Graph API v21.0 · n8n
>
> **Runtime:** Node.js (bottleneck is AI API latency, not runtime speed)
>
> **Last Updated:** April 2026 (agent_teams branch)

---

## Overview

Autonomous AI Marketing Agent built for 91astrology. A company registers once, and the system autonomously runs weekly intelligence pipelines, generates ad creatives, auto-launches Meta Ads campaigns, monitors performance every 6 hours, and improves itself monthly by learning from past results.

Human involvement is optional — every decision surfaces for approval, but the system can operate end-to-end without it.

---

## Architecture

```
INTELLIGENCE PIPELINE (weekly + daily crons)
  Scout Agents (Haiku) → Coordinator → Strategy Team → Creative Team → Campaign Review Team

CAMPAIGN LIFECYCLE
  Meta Learning Import → Pattern Calculator → Campaign Sync → Auditor (6h) → Monthly Learning

API LAYER
  CompaniesController + CampaignsController + CreativeController
    → BullMQ queues → MongoDB (tenantId-scoped)
```

### Agent Model Routing

| Agent | Model |
|---|---|
| Instagram, Reddit, Twitter, YouTube scouts | `claude-haiku-4-5-20251001` |
| Market Research, Case Study Generator | `claude-haiku-4-5-20251001` |
| Coordinator, Brief Generator, Auditor | `claude-sonnet-4-6` |
| Strategy Team (Strategist + Contrarian) | `claude-sonnet-4-6` via `claude -p` CLI |
| Creative Team (Creative Director + Brand Compliance) | `claude-sonnet-4-6` via `claude -p` CLI |
| Campaign Review Team (Strategist + Performance Analyst) | `claude-sonnet-4-6` via `claude -p` CLI |

All agent calls go through `ClaudeService.runAgent()` — never call `query()` directly.
Agent teams run via `runTeamViaCli()` which shells out to `claude -p`.

---

## What's Built

### 1. Meta Learning Import Pipeline

Fetches and enriches up to 1 year of historical campaign data from all Meta ad accounts.

**Endpoints:**
- `POST /api/v1/companies/:tenantId/import-learnings` — trigger full import
- `GET /api/v1/companies/:tenantId/import-status` — poll progress (`status`, `progress %`, `caseStudyCount`)
- `POST /api/v1/companies/:tenantId/finalize-import` — re-run finalize without re-enriching

**How it works:**
1. Fetches 1 year of campaigns from all accounts in `company.meta.accountIds[]`
2. Filters campaigns with spend > ₹500
3. Batches into groups of 50, queued via BullMQ with 10s stagger between batches
4. Each campaign is enriched with: insights, ad sets (with `promoted_object` + `lifetime_budget`), ad-level insights (with `adset_id`), demographics, and creatives
5. `fetchConversionData` discovers custom conversions (e.g. `Nadi_Report_Purchase`, `Parashari_Premium_Purchase`) and custom pixel events (e.g. `NADI_REPORT_PURCHASE_COMPLETED`)
6. `detectProduct` maps `promoted_object.custom_conversion_id` → custom conversion name → fuzzy product match
7. Atomic finalize guard (`findOneAndUpdate $nin`) prevents duplicate BullMQ runs
8. Top 50 case studies by spend are saved immediately per batch — frontend sees them live as batches complete

**Query helpers used by agent teams:**
- `getRelevantCaseStudies(tenantId, { product?, limit? })` — returns top N case studies by spend, optionally filtered by product name
- `getAudiencePerformanceSummary(tenantId)` — returns avg CPA, CTR, conversions, and total spend grouped by audience type across all historical ad sets

---

### 2. Pattern Calculator

Extracts structured performance patterns from enriched campaign data.

| Pattern Type | How Derived |
|---|---|
| **Hooks** | Inferred from ad name + copy body + copy title (Hindi + English), ranked by CTR |
| **Formats** | Creative object type (`video_data` / `link_data` / `child_attachments`) + adset-level conversions distributed by CTR share |
| **Audiences** | Adset-level ROAS by audience type: `lookalike`, `advantage_plus`, `retarget`, `interest`, `broad` |
| **Budget insights** | `daily_budget` → `lifetime_budget/30` → spend-as-proxy |
| **Seasonal peaks** | Monthly ROAS patterns |

Confidence levels: `high` (≥100 conversions), `medium` (≥30), `low`.

---

### 3. Campaign Sync

Keeps MongoDB in sync with Meta campaign data.

- `source: 'agent' | 'manual'` on every campaign record
- `syncFromEnrichedData` — syncs all 248 historical campaigns after import
- `syncActiveCampaigns` — 6-hour cron, syncs `ACTIVE` and `PAUSED` campaigns only

**Campaign schema includes:**
- Campaign: `name`, `metaAdSets[]`
- Ad Set: `id`, `name`, `audienceType`, `spend`, `impressions`, `clicks`, `conversions`, `ctr`, `cpa`, `frequency`, `dailyBudget`, `lifetimeBudget`, `optimizationGoal`
- Ad: `id`, `name`, `hookStyle`, `format`, `spend`, `impressions`, `clicks`, `ctr`, `cpc`

---

### 4. Agent Teams System

Three peer-to-peer debate teams run via `claude -p` CLI (`runTeamViaCli`). Each team spawns sub-agents that communicate via `TeamCreate` / `SendMessage` / `TeamDelete`.

#### Strategy Team (`StrategyTeamService`)

**Agents:** Strategist + Contrarian
- Receives full coordinator signals, competitor research, market research, and company learnings
- Strategist proposes top N ideas; Contrarian stress-tests each with counter-evidence
- Debate continues up to 5 rounds until consensus on the winning idea + runner-ups
- Pulls product-specific case studies from `MetaLearningImporterService` to score ideas

**Output:** `IdeaPoolResult` — `recommendedIdea`, `runnerUpIdeas[]`, `winnerId`, `selectionReason`, `rejectedIdeas[]`

#### Creative Team (`CreativeTeamService`)

**Agents:** Creative Director + Brand Compliance Reviewer
- Creative Director drafts 3 copy variants + image prompt + video prompt (visuals, voiceover, captions, music in one prompt)
- Brand Compliance reviews for Meta ad policy, brand tone, and platform specs
- Debate continues until the package is both high-converting AND compliant
- Pulls winning/losing hooks and formats from `company.learnings.creative`

**Output:** `CreativeTeamOutput` — `variants[]`, `selectedIndex`, `imagePrompt`, `videoPrompt`, `complianceNotes`, `debateLog[]`

#### Campaign Review Team (`CampaignReviewTeamService`)

**Agents:** Campaign Strategist + Performance Analyst
- Strategist proposes the full Meta campaign config (budget, objective, ad sets, ads)
- Performance Analyst challenges on budget sizing, audience targeting, timing, and risk
- Debate resolves into a final `StructuredCampaignConfig`

**Key behaviors:**
- Minimum 2-3 ad sets per campaign; `budgetPercent` across all ad sets must sum to 100
- Uses real Meta audience IDs from `product.metaAudiences` — never invents IDs
- Past buyer audiences are excluded from prospecting ad sets
- Injects `getAudiencePerformanceSummary()` (CPA/CTR by audience type) and `getRelevantCaseStudies()` (top 7 by spend for the product)
- Injects causal insights from `company.learnings.causalInsights`
- Budget anchor rule: never exceeds `company.maxBudgetPerCampaign`; if proposed budget is ₹0, defaults to 25% of weekly cap

**Campaign strategy modes** (set via `company.pipelineConfig.campaignStrategy`):

| Mode | Behavior |
|---|---|
| `conservative` | Min viable budget, only proven audiences, tight pause rules, 10% max scale |
| `balanced` (default) | 50-70% proven audiences, 20-30% broad test, 20% scale after 48h if ROAS > 2x |
| `experimental` | 30-40% budget on new/broad audiences, looser pause rules, higher CPA tolerance |

**Output:** `CampaignReviewOutput` — `approved`, `campaign` (with `adSets[]`), `adjustments`, `debateRounds`, `debateLog[]`, `debateRationale`

---

### 5. Intelligence Pipeline

Runs weekly (and select steps daily) to generate fresh campaign briefs.

```
Scout Agents (parallel, Haiku)
  Instagram · Reddit · Twitter · YouTube · Market Research
       ↓
  Coordinator (Sonnet)
       ↓
  Strategy Team (2-agent debate via CLI)
       ↓
  Creative Team (2-agent debate via CLI)
       ↓
  Campaign Review Team (2-agent debate via CLI)
       ↓
  Campaign Auditor — 6h cron
       ↓
  Monthly Learning Aggregation — 1st of each month
```

---

### 6. Learnings Schema

Stored on `company.learnings`, updated after each monthly aggregation.

```json
{
  "creative": {
    "winningHooks": ["bold_claim (2.54% CTR)", "question (2.36% CTR)"],
    "losingHooks": ["personal_story (1.04% CTR)"],
    "winningFormats": ["video", "carousel"],
    "losingFormats": ["story", "reel"]
  },
  "campaign": {
    "audienceScores": { "lookalike": 1.88, "interest": 0.35 },
    "budgetInsights": ["Low budgets < ₹3K/day have 66% lower CPA"],
    "timingInsights": ["Seasonal peaks: Jun"]
  }
}
```

---

### 7. Multi-Account Meta Support

- `company.meta.accountIds[]` — parallel fetch from all accounts
- `company.meta.accessToken` — shared across accounts
- `company.meta.pixelId`, `company.meta.pageId`
- Custom conversions discovered per account
- `act_` prefix normalization handled automatically
- Meta field updates always **merge** (never replace) to prevent wiping `accessToken`

---

## API Reference

### Companies

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/companies` | Create company |
| `GET` | `/api/v1/companies` | List all companies |
| `GET` | `/api/v1/companies/:tenantId` | Get company (includes meta, learnings) |
| `PATCH` | `/api/v1/companies/:tenantId` | Update company (meta fields merged, not replaced) |
| `POST` | `/api/v1/companies/:tenantId/regenerate` | Regenerate AI prompts |
| `POST` | `/api/v1/companies/:tenantId/import-learnings` | Trigger Meta learning import |
| `GET` | `/api/v1/companies/:tenantId/import-status` | Poll import progress |
| `GET` | `/api/v1/companies/:tenantId/case-studies` | List case studies |
| `POST` | `/api/v1/companies/:tenantId/finalize-import` | Re-run finalize without re-enriching |

### Campaigns

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/campaigns/:tenantId` | List campaigns (with metaAdSets) |
| `GET` | `/api/v1/campaigns/:tenantId/:campaignId` | Get single campaign |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/approve` | Launch campaign on Meta |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/pause` | Pause campaign |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/reject` | Reject campaign |
| `GET` | `/api/v1/campaigns/:tenantId/:campaignId/pending-actions` | Get pending actions |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/approve` | Approve a pending action |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/override` | Override a pending action |

### Creative

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/creative/:tenantId/packages/:creativePackageId` | Get creative package by ID |
| `POST` | `/api/v1/creative/:tenantId/briefs/:briefId/approve` | Approve any idea and trigger creative production (fire-and-forget) |

---

## Queue System (BullMQ)

| Queue | Trigger | Purpose |
|---|---|---|
| `pipeline` | Weekly cron (Monday 9 AM IST) | Full intelligence pipeline |
| `campaign-audit` | 6h cron | Audit active campaigns, propose actions |
| `monthly-learning` | 1st of each month | Aggregate patterns → `company.learnings` |
| `meta-learning-import` | On-demand (import endpoint) | Batch enrichment + finalize |
| `campaign-sync` | 6h cron | Sync ACTIVE/PAUSED campaigns from Meta |

---

## Setup

### Prerequisites

- Node.js 20+
- MongoDB
- Redis

### Environment Variables

```env
# MongoDB
MONGODB_URI=mongodb://localhost:27017/marketing-agent

# Redis (BullMQ)
REDIS_HOST=localhost
REDIS_PORT=6379

# Anthropic (Claude Code SDK)
ANTHROPIC_API_KEY=sk-ant-...

# Meta Graph API
META_APP_ID=...
META_APP_SECRET=...

# n8n (optional — for Slack/WhatsApp/Email/Notion delivery)
N8N_WEBHOOK_URL=...
```

### Run

```bash
npm install
npm run start:dev
```

---

## Key Rules

1. **Never hardcode** product names, prices, or dates in agent system prompts — live data is injected at runtime via `LiveContextBuilder`
2. **All budget/safety checks** are enforced in TypeScript — Claude agents cannot override them
3. **Every database query** must include a `tenantId` filter
4. **Every agent call** must go through `ClaudeService.runAgent()` — never call `query()` directly
5. **Meta field updates** always merge (not replace) to prevent wiping `accessToken` or other fields

---

## Agent System Prompt Architecture

- Strategic prompts stored in MongoDB per company (`company.prompts.*`)
- Live data (products, prices, promotions) injected at runtime via `LiveContextBuilder`
- Prompts are regenerated by `PromptGeneratorService` when brand-relevant fields change (`POST /api/v1/companies/:tenantId/regenerate`)
