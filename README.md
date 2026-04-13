# Autonomous Marketing Agent

> **Stack:** NestJS + TypeScript · MongoDB · BullMQ + Redis · Claude Code SDK · Meta Graph API v21.0 · Heygen · OpenAI DALL-E 3 · n8n
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

**Campaign naming:**
```
Format: TOPIC_SLUG_DATE
Examples: SUMMER_SALE_2026-04-13, NADI_REPORT_OFFER_2026-04-13
```
- Topic from brief is upper-cased, non-alphanumeric chars replaced with `_`, capped at 30 chars
- Date is the UTC date at launch time
- No `META_` prefix, no objective suffix

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

Campaign Review Team decides `creativeFormat: 'video' | 'image' | 'both'` per ad set using data-driven logic:

```
DECISION LOGIC (applied in order):
1. NO DATA → default by audience type:
   - lookalike / advantage_plus (cold) → video
   - interest (warm) → both
   - retarget (hot) → image

2. ONE FORMAT WINNING → winner on largest ad set, loser on smallest (never fully abandon a format)

3. BOTH FORMATS WINNING → split proportionally across ad sets

4. NO CLEAR WINNER → use "both" on all ad sets

BUDGET CONSTRAINT: If <₹1,500/day, do not split formats (not enough signal)
```

Data source: `company.learnings.creative.winningFormats` (populated by monthly learning aggregation from imported Meta campaigns).

**Video generation via Heygen:**
- Creative Team writes a pure visual scene description — no avatar/voiceover directions, just what the viewer sees on screen
- Format: `"15-second vertical Meta ad for [product] targeting [audience]. Opens with [scroll-stopping visual]. Quick cut to [product being shown]. Bold text overlay '[hook]' at top. Closes with product hero shot, '₹[price]' in large bold text, 'Order Now' CTA at bottom. Color palette: [warm/vibrant]. Music: [upbeat Indian]. Indian faces and locations throughout."`
- Saved as `creativePackage.videoPrompt`
- Heygen Video Agent API (`POST /v1/video_agent/generate`) converts the scene description to a vertical (9:16) video
- Polls `/v1/video_status.get` up to 15 minutes for completion
- Final video URL stored in `creativePackage.videoUrl`

**Image generation via OpenAI DALL-E 3:**
- Claude (Creative Producer agent) writes a detailed image prompt from the brief
- Saved as `creativePackage.imagePrompt`
- DALL-E 3 API (`POST /v1/images/generations`, size `1024x1792` for 9:16, **quality: `hd`**) generates the image
- Hosted URL returned (valid 1 hour from generation) — upload to S3 or use immediately at launch
- Final image URL stored in `creativePackage.imageUrl`

---

### 5. Conversion Tracking (3 Modes)

Per product, set exactly one of these in `company.products[]`:

| Mode | Fields to set | When to use |
|---|---|---|
| Standard Event | `conversionEvent: 'Purchase'` | Standard Meta pixel events (Purchase, Lead, etc.) |
| Custom Event | `conversionEvent: 'CustomEvent'`, `customEventName: 'MyEvent'` | Custom pixel events via `fbq('trackCustom', ...)` |
| Custom Conversion | `customConversionId: '123456'` | Named conversions with conditional logic (e.g. Nadi_Purchase) |

**How Meta `promoted_object` is set:**
```
customConversionId set → { pixel_id, custom_conversion_id }
conversionEvent = standard → { pixel_id, custom_event_type: 'PURCHASE' }
conversionEvent = non-standard → { pixel_id, custom_event_type: 'OTHER', custom_event_str: 'MyEvent' }
```

Custom conversions take priority over `conversionEvent`. Get `customConversionId` from:
```
GET https://graph.facebook.com/v21.0/act_{account_id}/customconversions?fields=id,name&access_token=...
```

---

### 6. Intelligent Campaign Auditor (4 Layers)

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

### 7. Audit Snapshot History

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

### 8. Multi-Account Meta Support

- `company.meta.accountIds[]` — list of allowed Meta ad accounts per tenant
- Approval endpoint requires `accountId` in request body
- Validated against `company.meta.accountIds` before launch
- Stored as `campaign.metaAccountId` after launch
- Image/video uploads are account-scoped
- `company.meta.accessToken` — shared across accounts

---

### 9. Campaign Sync

Keeps MongoDB in sync with Meta.
- `syncActiveCampaigns` — 6h cron, syncs ACTIVE and PAUSED campaigns
- Saves full ad set + ad structure including `audienceType`, `dailyBudget`, `lifetimeBudget`, metrics
- `source: 'agent' | 'manual'` — auditor only monitors `agent` campaigns

---

### 10. Monthly Learning Aggregation

Runs 1st of every month at 3 AM IST. Aggregates patterns from historical + live data into `company.learnings`:

```json
{
  "creative": {
    "winningHooks": ["bold_claim (2.54% CTR)", "question (2.36% CTR)"],
    "losingHooks": ["personal_story (1.04% CTR)"],
    "winningFormats": ["video", "carousel"],
    "losingFormats": ["static_image"],
    "ctaInsights": [
      "Direct CTAs ('Book Now', 'Order Now') outperform benefit CTAs by 2.1x",
      "Urgency CTAs ('Limited Offer') perform best in retargeting"
    ],
    "copyToneInsights": [
      "Conversational Hinglish drives 1.6x higher CTR than formal Hindi",
      "Emotional + proof-backed copy outperforms aspirational alone"
    ],
    "visualInsights": [
      "Indian faces in real-world settings increase CTR by 1.4x vs stock imagery",
      "Price shown on creative increases conversion rate by 1.8x"
    ]
  },
  "campaign": {
    "audienceScores": { "lookalike": 1.88, "interest": 0.35 },
    "budgetInsights": ["Low budgets <₹3K/day have 66% lower CPA"],
    "timingInsights": ["Seasonal peaks: Jun"]
  }
}
```

**How each creative field is populated:**

| Field | Populated by |
|---|---|
| `winningHooks`, `losingHooks` | Monthly learning aggregation — clusters ad hooks by CTR percentile |
| `winningFormats`, `losingFormats` | Monthly learning aggregation — compares video vs image ROAS |
| `ctaInsights` | `POST /import-creative-learnings` — Claude analysis of ad copy CTAs |
| `copyToneInsights` | `POST /import-creative-learnings` — Claude analysis of copy tone patterns |
| `visualInsights` | `POST /import-creative-learnings` — Claude analysis of creative descriptions |

**Populate creative copy insights manually:**
```bash
POST /api/v1/companies/:tenantId/import-creative-learnings
```
- Fetches all ads (with copy and performance data) directly from Meta API
- No dependency on having run `import-learnings` first
- Claude CREATIVE_LEARNING_AGENT analyzes CTA patterns, tone, visual descriptions from top vs bottom performers
- Saves only `ctaInsights`, `copyToneInsights`, `visualInsights` — does NOT overwrite hooks or formats
- Safe to re-run anytime; each run fetches fresh data from Meta

---

## API Reference

### Companies

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/companies` | Create company — schedules all jobs automatically |
| `GET` | `/api/v1/companies` | List all companies |
| `GET` | `/api/v1/companies/:tenantId` | Get company (includes meta, learnings, signals) |
| `PUT` | `/api/v1/companies/:tenantId` | Update company fields (meta fields merged, not replaced) |
| `POST` | `/api/v1/companies/:tenantId/regenerate` | Regenerate AI prompts |
| `POST` | `/api/v1/companies/:tenantId/import-learnings` | Trigger Meta learning import |
| `GET` | `/api/v1/companies/:tenantId/import-status` | Poll import progress |
| `POST` | `/api/v1/companies/:tenantId/finalize-import` | Re-run finalize without re-enriching |
| `GET` | `/api/v1/companies/:tenantId/case-studies` | List top 50 case studies |
| `POST` | `/api/v1/companies/:tenantId/import-creative-learnings` | Fetch ad copy from Meta + run Claude analysis → updates ctaInsights, copyToneInsights, visualInsights |

**Update company — product fields:**
```json
PUT /api/v1/companies/:tenantId
{
  "products": [
    {
      "name": "Nadi Report",
      "price": 499,
      "conversionValue": 499,
      "landingUrl": "https://example.com/nadi",
      "conversionEvent": "Purchase",
      "customConversionId": "1234567890",
      "customEventName": "Nadi_Purchase",
      "pixelId": "123456789",
      "customConversionId": "987654321"
    }
  ]
}
```
Note: `products` uses Mongoose Mixed type — always send the full array when updating.

### Campaigns

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/campaigns/:tenantId` | List all campaigns |
| `GET` | `/api/v1/campaigns/:tenantId/:campaignId` | Get single campaign |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/approve` | Launch campaign on Meta — body: `{ accountId }` |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/pause` | Pause campaign in MongoDB **and on Meta API** — body: `{ reason }` |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/reject` | Reject pending campaign — body: `{ reason }` |
| `GET` | `/api/v1/campaigns/:tenantId/:campaignId/pending-actions` | List pending audit actions |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/approve` | Execute action immediately |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/override` | Veto action |

### Creative

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/creative/:tenantId/packages/:creativePackageId` | Get creative package (copyVariants, imageUrl, videoUrl, imagePrompt, videoPrompt) |
| `POST` | `/api/v1/creative/:tenantId/packages/:creativePackageId/regenerate-image` | Retry image generation (uses saved imagePrompt → DALL-E 3). Fire-and-forget — poll GET for result |
| `POST` | `/api/v1/creative/:tenantId/packages/:creativePackageId/regenerate-video` | Retry video generation (uses saved videoPrompt → Heygen). Fire-and-forget — poll GET for result |
| `POST` | `/api/v1/creative/:tenantId/briefs/:briefId/approve` | Approve idea → trigger creative production (fire-and-forget) |

**Regenerate endpoints — response:**
```json
{
  "status": "started",
  "creativePackageId": "...",
  "message": "Image generation started. Poll GET /packages/:id for result."
}
```
Poll `GET /packages/:id` until `imageUrl` / `videoUrl` is populated (image ~30s, video up to 15 min).

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

// Products
products: [
  {
    name: string                     // product/service name
    price: number                    // price in INR
    conversionValue: number          // value to report to Meta per conversion
    landingUrl: string               // destination URL for ads
    pixelId?: string                 // product-specific pixel (falls back to meta.pixelId)
    conversionEvent?: string         // 'Purchase' | 'Lead' | 'CompleteRegistration' | 'CustomEvent'
    customEventName?: string         // used when conversionEvent = 'CustomEvent'
    customConversionId?: string      // Meta Custom Conversion ID — takes priority over conversionEvent
  }
]

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

# Heygen (text-to-video, up to 15 min per video)
HEYGEN_API_KEY=...

# OpenAI (DALL-E 3 image generation)
OPENAI_API_KEY=sk-...

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

---

## Frontend Integration Notes

### Campaign response shape

Campaigns returned from `GET /api/v1/campaigns/:tenantId/:campaignId` include:

```json
{
  "metaAdSets": [
    {
      "metaAdSetId": "...",
      "name": "Lookalike 1-3% | Video",
      "audienceType": "lookalike",
      "dailyBudget": 500,
      "lifetimeBudget": null,
      "spend": 1240,
      "conversions": 3,
      "ctr": 2.1,
      "roas": 2.4,
      "frequency": 1.8,
      "ads": [{ "metaAdId": "...", "name": "...", "ctr": 2.1, "spend": 620 }]
    }
  ]
}
```

- Ad sets and ads are in a **single merged `metaAdSets` array** — there is no separate `adSets` key.
- `metaAdSets` is populated by `CampaignSyncService` (runs every 6h) — it will be empty for newly approved campaigns until the first sync runs.

### Creative package

`GET /api/v1/creative/:tenantId/packages/:creativePackageId` returns:

```json
{
  "copyVariants": [
    { "headline": "...", "body": "...", "cta": "..." }
  ],
  "imageUrl": "https://...",
  "videoUrl": "https://...",
  "imagePrompt": "...",
  "videoPrompt": "...",
  "adLibrary": {
    "adCopy": "...",
    "headline": "...",
    "description": "..."
  }
}
```

- `imageUrl` / `videoUrl` — populated asynchronously. Poll `GET /packages/:id` after triggering regenerate.
- `adLibrary` — assembled from the winning copy variant + brief, used as fallback when Meta requires a single ad copy string.

### New endpoints (added this sprint)

| Endpoint | What it does |
|---|---|
| `POST /companies/:tenantId/import-creative-learnings` | Pulls 1225+ ads from Meta, runs Claude analysis, populates `ctaInsights` / `copyToneInsights` / `visualInsights` — takes ~30s |
| `POST /campaigns/:tenantId/:campaignId/pause` | Now also pauses the campaign on Meta API (not just MongoDB) |
| `POST /companies/:tenantId/finalize-import` | Re-runs finalize step for the latest import without re-enriching all campaigns |

### Campaign name format change

Campaign names on Meta Ads are now: `TOPIC_SLUG_DATE`
- Example: `NADI_REPORT_OFFER_2026-04-13`
- Previously had `META_` prefix and objective suffix — those are removed
- Useful to know when cross-referencing campaigns in Meta Ads Manager

---

## Key Rules

1. **Never hardcode** product names, prices, or dates in agent system prompts — live data injected at runtime via `LiveContextBuilder`
2. **All budget/safety checks** are enforced in TypeScript — Claude agents cannot override them
3. **Every database query** must include a `tenantId` filter
4. **Every agent call** must go through `ClaudeService.runAgent()` — never call `query()` directly
5. **Meta field updates** always merge (never replace) to prevent wiping `accessToken`
6. **Campaign monitoring** only covers `source: 'agent'` campaigns — manual Meta campaigns are synced but not audited
7. **Mongoose Mixed type fields** (`products`, `services`, `meta`) require `markModified()` before `save()` or changes are silently dropped
8. **Creative format decisions** are learning-driven — Campaign Review Team decides based on `company.learnings.creative.winningFormats`, not hardcoded rules
