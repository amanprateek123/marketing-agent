# Marketing Agent — Autonomous AI Marketing Platform

> **Stack:** NestJS + TypeScript · MongoDB · BullMQ + Redis · Claude Code SDK · Meta Graph API v21.0 · n8n
>
> **Runtime:** Node.js (bottleneck is AI API latency, not runtime speed)
>
> **Last Updated:** April 2026

---

## Overview

Autonomous AI Marketing Agent built for 91astrology. A company registers once, and the system autonomously runs weekly intelligence pipelines, generates ad creatives, auto-launches Meta Ads campaigns, monitors performance every 6 hours, and improves itself monthly by learning from past results.

Human involvement is optional — every decision surfaces for approval, but the system can operate end-to-end without it.

---

## Architecture

```
INTELLIGENCE PIPELINE (weekly + daily crons)
  Scout Agents (Haiku) → Coordinator → Brief Generator → Creative Team → Campaign Review

CAMPAIGN LIFECYCLE
  Meta Learning Import → Pattern Calculator → Campaign Sync → Auditor (6h) → Monthly Learning

API LAYER
  CompaniesController + CampaignsController → BullMQ queues → MongoDB (tenantId-scoped)
```

### Agent Model Routing

| Agent | Model |
|---|---|
| Instagram, Reddit, Twitter, YouTube scouts | `claude-haiku-4-5-20251001` |
| Market Research, Case Study Generator | `claude-haiku-4-5-20251001` |
| Coordinator, Brief Generator, Creative Team, Auditor | `claude-sonnet-4-6` |

All agent calls go through `ClaudeService.runAgent()` — never call `query()` directly.

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

### 4. Intelligence Pipeline

Runs weekly (and select steps daily) to generate fresh campaign briefs.

```
Scout Agents (parallel, Haiku)
  Instagram · Reddit · Twitter · YouTube · Market Research
       ↓
  Brief Generator (Sonnet)
       ↓
  Creative Team (Sonnet)
       ↓
  Campaign Review Team (Sonnet)
       ↓
  Campaign Auditor — 6h cron
       ↓
  Monthly Learning Aggregation — 1st of each month
```

---

### 5. Learnings Schema

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

### 6. Multi-Account Meta Support

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
