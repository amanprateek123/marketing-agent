# Autonomous Marketing Agent

> **Stack:** NestJS + TypeScript · MongoDB + Mongoose · BullMQ + Redis · Claude Code SDK · Meta Graph API v21.0 · Heygen V3 · Nano Banana (Gemini 3.1 Flash Image) · YouTube Data API v3 · Reddit JSON API · n8n
>
> **Runtime:** Node 20+

A company registers once. The system runs intelligence pipelines on a schedule, generates ad creatives, launches Meta Ads campaigns under human approval, audits performance every 6h, and improves itself by learning from past results. Every campaign launches under a human-in-the-loop gate; every safety/budget check is enforced in TypeScript so LLMs cannot override it.

---

## High-level Flow

```
INTELLIGENCE PIPELINE (weekly per tenant; daily during cold start)
  Phase A — Scouts (4 parallel)
  Phase B — Coordinator + Meta Ad Library (real ads_archive Graph API)
  Phase C — Competitor Research + Market Research
  Phase D — Strategy Team (2-agent debate) → IdeaPool fallback
  Phase E — Digest → Slack
  Phase F — Creative Team (2-agent debate) → copy + image + video
  Phase G — Campaign Review Team → human approval → Meta launch

CAMPAIGN LIFECYCLE
  pending_approval → /approve → Meta launch (PAUSED → ACTIVE)
  → 6h audit loop (4 layers, 11 actions) → pendingActions → human/auto-execute

LEARNING LOOP
  Day 7   — creative quick scan (Wilson + Bonferroni + composite CTR/CPA)
  Day 14  — performance writeback (per-ad-set breakdown)
  Day 30  — causal attribution (TS-pre-constructed matched pairs)
  On pause — single-campaign root cause analysis
  Monthly — prompt regeneration with versioning + history (rollback ready)
```

---

## Directory Structure

```
src/
├── app.module.ts                   # Root NestJS module
├── main.ts                         # Bootstrap
├── claude/                         # Claude SDK wrapper, model routing, usage logging
├── companies/                      # Tenant CRUD, prompt generator, live context builder
├── pipeline/                       # 4 scouts, coordinator, research, idea pool, digest, orchestrator
├── creative/                       # Copy writer, image generator, video generator, creative producer
├── campaigns/                      # Creator, auditor + optimizer + signal detector, Meta Ads, sync, learning import
├── learning/                       # Creative learning (Day 7), Campaign learning (Day 30), Shadow actions
├── teams/                          # Strategy / Creative / Campaign Review (2-agent debates)
├── scheduler/                      # BullMQ processors + queue config
├── common/
│   ├── action-logger/              # Audit trail
│   ├── benchmarks/                 # 12 verticals × CPA / CVR ranges
│   ├── calendar/                   # India holidays + festivals + events with CPM impact
│   ├── creative/                   # Canonical hookStyle taxonomy (DR + meme)
│   ├── safety/                     # Copy-safety regex gate (forbidden claims + special ad categories)
│   ├── statistics/                 # Bayesian shrinkage, Wilson LB, power calc, bandit allocator, inverseNormalCdf
│   └── storage/                    # S3 service
├── delivery/                       # Slack integration
├── config/                         # Environment loader
└── database/                       # Mongo connection
```

---

## The 7-Phase Pipeline

### Phase A — Scouts (4 parallel)

Instagram, Reddit, Twitter, YouTube each:
1. Loads tenant-specific system prompt from `company.prompts`
2. Receives live context (products + learnings + saturation map + calendar)
3. Receives recently-covered exclusion list (14d TTL industry, 7d TTL viral)
4. **YouTube + Reddit:** pre-fetches real engagement via Data API v3 / JSON API; injects view/upvote counts into prompt as ground truth
5. **Twitter + Instagram:** Claude WebSearch + WebFetch
6. Retries up to 3× on invalid JSON
7. **Platform-tiered virality floors:** YouTube ≥ 100k views, Reddit ≥ 200 upvotes — drops noise before it reaches the coordinator
8. Persists `ScoutOutput` (full JSON) + per-signal `ScoutSignal` (hash-deduped)

**Scout output:**
- `topSignals[]` — industry signals (trending topics, competitor moves, market shifts)
- `viralTrends[]` — separated from industry signals to prevent cross-contamination
- `format_insights[]`, `hook_examples[]`, `raw_summary`

### Phase B — Coordinator + Meta Ad Library (parallel)

**Coordinator** (Sonnet) synthesizes all scout signals into ranked `topSignals` (5-10, scored 0-10). Brand-relevance filter post-process: drops signals whose topic doesn't share keywords with `company.industry` or `product.trendKeywords` (closes the cross-vertical drift problem).

**Meta Ad Library** (Haiku, maxTurns: 2) — uses Meta's official `graph.facebook.com/v21.0/ads_archive` Graph API per competitor (region-scoped). Returns real `ad_creative_bodies` + `ad_delivery_start_time` + `publisher_platforms` instead of LLM-confabulated competitor ads. Falls back to honest empty insights when ads_archive returns nothing (most non-EU non-political ads — Meta restricts public access).

### Phase C — Research (parallel)

**Competitor Research** (Sonnet, 15 turns) — deep web research on competitor weaknesses, pricing, complaints, positioning shifts.

**Market Research** (Haiku, 12 turns) — purchase-intent signals, seasonal windows, urgency triggers.

### Phase D — Strategy Team

**Primary path:** 2-agent debate (Strategist + Contrarian).

Prompt structure (Data → Rules → Steps):
1. Product catalog with audience segments, Meta audience IDs, performance data
2. All intelligence (signals, competitor, market, ads library) — equal-weight sources
3. Live context + case studies (12 most recent)
4. Rules (budget, product matching, no-source-quotas, empty-state handling)
5. Output schema with explicit `audienceStage` (cold/warm/hot) + `explorationArm` flag

**Closed-loop drift mitigation:** The Strategy Team flags 1-of-N briefs as `explorationArm: true` — picks a brief whose hookStyle is in NEITHER `winningHooks` nor `losingHooks`. Downstream Creative Team skips injecting winning exemplars for that brief, letting the LLM generate freely.

**Audience-stage propagation:** stage flows through IntelligenceBrief → CreativeBrief → BriefData → Creative Team and Campaign Review Team. Each phase branches its prompts per stage:
- `cold` → AP + LAL + interest, exclude past purchasers + recent visitors
- `warm` → Visitors_30d + LAL_1pct, exclude purchasers
- `hot` → cart-30d retarget only, max ₹2k/day, single ad set

**Fallback path:** IdeaPool — single-agent with rule-based winner selection. Throws on empty briefs (orchestrator catches).

### Phase E — Digest

Slack-formatted intelligence summary with per-idea briefs. Large messages auto-split into ≤2900-char chunks.

### Phase F — Creative Team

2-agent debate (Creative Director + Brand Compliance Reviewer).

**Output (per brief):**
- 4 copy variants — each with unique hookStyle, headline, primary text, CTA
- 4 image prompts — one per variant, visual centerpiece concept matched to that variant's hook
- 1 Heygen video prompt — cinematic 15s vertical 9:16; **opener / duration / b-roll vocabulary varies by hookStyle**
- `selectedIndex` — variant chosen by compliance reviewer

**Astro vertical depth (91astrology):** video prompts use Sade Sati, Mercury Retrograde, Rahu/Ketu, Manglik dosha vocabulary; b-roll references kundli paper, deity iconography, classical instruments (sitar, tabla, tanpura); off-screen Hindi/Hinglish voiceover.

**Brand compliance reviewer** has product name + price + landing URL + brand guidelines so it can verify accuracy, not just policy/tone.

**hookSaturation feedback:** for each (audienceType, hookStyle) above 60% saturation in last 14 days, the Creative Team is told to avoid that hookStyle on that audience. Decay filter + per-entry timestamps prevent the monotonic lockout problem.

**Winning exemplars:** verbatim top-N hook lines (extracted deterministically per ad set, see Learning section) injected as inspiration. Filtered by `audienceStage` so cold winners don't anchor warm briefs.

**Fallback:** single-agent CopyWriter + ImageGenerator + no video.

### Phase G — Campaign Review + Launch

2-agent debate (Campaign Strategist + Performance Analyst).

**Reviewer receives a context brief** with: product perf, weekly cap remaining, audience CPA history, case studies — not just the strategist's output. Without this, the analyst nitpicks instead of pushing back with data.

**Output:** structured `campaignConfig` with `adSets[]`, budget allocation, `creativeFormat` per ad set, `scaleRules`, `pauseRules`.

**Format options:**
- `image` — N image ads, one per variant
- `video` — single video ad (selected variant only)
- `both` — DEPRECATED for prospecting (duplicates the single video across all variants)
- `mixed` — split into 2 sibling ad sets at launch time: 1 video ad set (selected variant, 30% budget) + 1 image ad set (other variants, 70% budget). Skips splitting under ₹6k/day total — degrades to image-only.

**Why split (R3 fix):** Meta's intra-ad-set auction skews to lowest-CPM creative; 1 video + N image inside one ad set means video wins 90%+ impressions and the image variants get no signal. Splitting into siblings preserves clean per-format attribution.

**Safety re-validation after debate:** budget clamped to `maxBudgetPerCampaign`; `checkWeeklyBudget` re-run. Review team cannot override TypeScript limits.

**Launch flow:**
1. Saved as `pending_approval` → Slack notification (with approve/reject endpoint instructions)
2. Human calls `POST /approve` with `accountId`
3. Audience validation — strips expired Meta audience IDs, converts orphaned lookalikes to `advantage_plus`
4. `mixed` ad sets split into video + image siblings
5. Per-tenant Purchasers audience auto-injected into `excludeAudienceIds` of every prospecting ad set (advantage_plus / lookalike / broad / interest)
6. Campaign / ad set / ad creation via Graph API v21.0 — all start PAUSED
7. **`special_ad_categories`** sourced from `company.meta.specialAdCategories` (was hardcoded `[]`); regulated verticals declare correctly
8. **Default placements:** `publisher_platforms: ['facebook', 'instagram']` (skip Audience Network)
9. **Attribution:** `[7d-click + 1d-view]` (was 7d-click only — under-counted video performance)
10. Activated only if all expected ads created; rollback on partial failure (delete cascades)
11. Retry with exponential backoff on transient Meta errors

---

## Decision-Theory Foundation

Closed-form Bayesian + frequentist helpers in `src/common/statistics/` — no math library, no LLM.

| Helper | Purpose | Used by |
|---|---|---|
| `shrinkTowardPrior` | Pull lucky early CVR/CTR/CPA toward vertical prior; smooth cliff thresholds | Audit loop, signal detector |
| `wilsonLowerBound` | 95% CI lower bound on a proportion (better than normal approx at small N) | Day-7 winning exemplars, signal detector |
| `inverseNormalCdf` | Acklam approximation of probit; Bonferroni z-score for k candidates | Day-7 multiple-testing correction |
| `adSetWinnerPosterior` | Composite winner check: `shrunkenROAS > threshold AND lowerROAS > 1.0` | Audit signal detector |
| `requiredSampleForProportionDrop` | Sample size for a CTR drop to be statistically meaningful | Power-calc-derived audit floors |
| `requiredClicksForZeroConvSignal` | Clicks needed before "zero conversions" is real signal vs noise | Audit pause-on-no-conversion |
| `deriveFloorsFromVertical` | Vertical-aware audit thresholds (12 verticals shipped) | Audit signal detector |
| `thompsonAllocate` | Marsaglia-Tsang Gamma sampling for Beta-distribution Thompson Sampling | Bandit allocator (computed; not yet enforced — advisory in audit prompt) |

**Difference-in-differences** — ad-level CTR drop compared to ad-set-level CTR drop over the same window. Isolates creative fatigue from audience fatigue.

**Power-calc-derived audit floors** — `MIN_IMPRESSIONS_FOR_SIGNAL` is no longer hardcoded; computed from vertical CPA + target detection power.

**Shadow action log** — every action the LLM proposed but a TS guard blocked or downgraded gets logged with `(proposedAction, blockedReason, metricsAtT)`. The shadow-eval cron joins each record to campaign metrics at +24h and +72h to label `correct_block` vs `missed_signal` vs `inconclusive`. After ~2 weeks, regret rate per `(action_type, blocked_reason)` answers "are our guardrails correctly tuned?" — first quantitative answer instead of intuition. Pure logging today; behavior changes only after ground-truth data exists.

---

## Agent Model Routing

| Agent | Model | Tools | Notes |
|---|---|---|---|
| Instagram / Reddit / Twitter / YouTube scouts | Haiku | WebSearch, WebFetch, Bash | Pre-fetched API data + structured JSON |
| Market Research | Haiku | WebSearch, WebFetch, Bash | maxTurns: 12 |
| Meta Ads Library | Haiku | None | maxTurns: 2 — pure synthesis over real Graph API data |
| Case Study Generator | Haiku | None | Structured summarization |
| Digest Writer | Haiku | None | Slack formatting |
| Coordinator | Sonnet | None | Cross-platform synthesis + brand-relevance filter |
| Competitor Research | Sonnet | WebSearch, WebFetch, Bash | 15 turns |
| Idea Pool (fallback) | Sonnet | None | Rule-based winner selection |
| Creative Producer / Copy Writer | Sonnet | None | Ad copy creativity |
| Campaign Creator | Sonnet | None | Campaign config generation |
| Campaign Auditor | Sonnet | None | Multi-signal verdict (maxTurns: 1) |
| Creative Learning Agent | Sonnet | None | Pattern attribution |
| Campaign Learning Agent | Sonnet | None | Causal attribution |
| Prompt Generator | Sonnet | None | Meta-reasoning over brand profile + skills |
| Strategy Team Lead | Sonnet | Team tools | 2-agent debate (Strategist + Contrarian) |
| Creative Team Lead | Sonnet | Team tools | 2-agent debate (Director + Compliance) |
| Campaign Review Lead | Sonnet | Team tools | 2-agent debate (Strategist + Analyst) |

**ClaudeService.runAgent()** — single entry point for all 25 agent types:
- 3 retries with exponential backoff on rate-limit
- 8-min timeout via `Promise.race`
- Per-call usage logging (tokens, cost, model, duration) → `usage_logs` MongoDB collection
- Per-model cost calculation (Haiku $0.80/$4 vs Sonnet $3/$15 per Mtok)

---

## Agent Team Debates (Strategy / Creative / Campaign Review)

Two execution modes per tenant via `pipelineConfig.teamMode`:
- `cli` — `claude -p` with tmux for persistent debate sessions (5 round max). Real adversary, more reliable for hard decisions.
- `sequential` (default) — 2 separate `runAgent()` calls. Call 1 produces output; Call 2 critiques and finalises.

**Context briefs:** each reviewer agent gets a tailored brief with relevant data, not just the lead's raw output, so it pushes back with evidence rather than generic critique.

**Debate logging:** `debateRounds`, `debateLog[]`, `debateRationale` persisted on every brief / campaign for audit and learning attribution.

---

## Safety Architecture (TS-Enforced)

All safety/budget checks live in TypeScript and are enforced before every LLM call. LLMs cannot override them.

### Pre-launch budget gates
- `checkCampaignBudget` — daily budget ≤ `maxBudgetPerCampaign`
- `checkWeeklyBudget` — projected 7-day spend + current weekly spend ≤ `weeklyBudgetCap`
- `checkCampaignsPerRun` — runs per pipeline cap
- `checkForbiddenTopics` — scans brief.topic / hook / keyMessage against `company.forbiddenTopics`
- **Re-validation after Campaign Review Team** — review team's `campaign.budget` is clamped, `checkWeeklyBudget` runs again

### Pre-launch copy gates
- `checkCopySafety` — regex check before EVERY copy variant ships to Meta:
  - **Forbidden-claim patterns:** guaranteed-outcome / 100%-effective / miracle / cure / weight-loss-time-frame / personal-attribute-callout
  - **Special-ad-category triggers:** credit / loan / EMI / employment / housing / political / election content. If detected and not declared in `company.meta.specialAdCategories`, refuses to launch.

### Per-tenant + per-run isolation
- `tenantId` filter on every Mongo query (CLAUDE.md rule)
- `tenantId/` prefix on every S3 path
- Concurrent-run lock at `pipeline-orchestrator.trigger()` — manual /trigger + scheduled BullMQ + `recoverStuckRuns` no longer race
- `pipelineRun.promptsVersion` + `campaign.promptsVersion` stamped at creation — performance correlatable with prompt drift

---

## Audit Loop (4 Layers, Every 6h)

Per tenant, only monitors `source: 'agent'` campaigns.

### Layer 1 — TS-enforced safety rails (unoverridable)
- Campaign spend > `maxBudgetPerCampaign` → auto-pause
- Weekly spend > `weeklyBudgetCap` → auto-pause
- Frequency > `pauseIfFrequencyAbove × 1.5` → auto-pause
- Age > 2× `coldStartDays` + 0 conversions + >50% budget spent → auto-pause

### Layer 2 — Signal detection (TypeScript math, no LLM)
- CTR/ROAS/CPA trends from last 3 audit snapshots (±10% threshold)
- CTR benchmarks from historical snapshot data (not LLM-parsed text)
- Creative fatigue: ads with >35% CTR drop from 48h baseline (Wilson lower bound + DiD vs ad-set baseline)
- Audience fatigue: ad sets with frequency > threshold
- Spend pace vs expected `daily × days_elapsed`
- **Hook saturation map** — per (audienceType, hookStyle) accumulator, written each audit pass with timestamp; readers filter by 14-day decay

### Layer 3 — Audit Agent (Sonnet, maxTurns: 1)
Receives full signal packet + metrics + snapshots + learnings + vertical benchmarks + India calendar context. Returns structured verdict (`act` / `watch` / `no_action`) with recommended actions and urgency.

**hookStyle preserved on every snapshot** — learning system attributes performance to specific creative approaches.

**All-green skip:** when all signals are healthy, skip the Claude call entirely (saves ~70-80% audit cost).

**Cooldown:** recently-actioned items have a per-action cooldown to prevent ping-pong actions.

### Layer 4 — Human-in-the-loop
- `act` → creates `pendingActions` with grace period + Slack digest
- Pause actions auto-execute after grace period (default 12h)
- Scale + add_adset actions require explicit human approval (never auto-execute)
- Scale executes via `MetaAdsService.updateAdSetBudget()`

### 11 Supported Actions

| Action | Description | Execution |
|---|---|---|
| `pause_ad` | Individual ad with zero conversions | Auto after grace |
| `pause_adset` | Ad set burning with no returns | Auto after grace |
| `replace_creative` | Swap fatigued creative; preserves video prompt + queues regen with `forcedHookStyle` + `avoidHookStyles` (canonical 7-style taxonomy) | Auto after grace |
| `add_creative` | Fresh ad to winning set with early fatigue | Auto after grace |
| `scale_adset` | Increase budget on winner (Bayesian shrunken ROAS + Wilson LB > 1.0) | Human approval |
| `add_adset` | Retargeting or narrowed audience | Human approval |
| `shift_budget_between_adsets` | Donor-floor + recipient-cap + recipient-thin-evidence guard | Auto after grace |
| `reduce_total_budget` | Lower campaign daily budget | Auto after grace |
| `narrow_placement` | Drop underperforming placement | Auto after grace |
| `dayparting` | Schedule specific hours (TZ-guarded for IST) | Auto after grace |
| `refresh_audience` | Duplicate ad set with fresh audience, keep creative | Auto after grace |

### Performance writeback (Day 7 / 14 / 30)
- Day 7: campaign-level metrics + per-hookStyle aggregation + **per-ad-set breakdown** (`adSetPerformance[]`) → triggers `creativeLearning.runQuickScan`
- Day 14: same writeback, no scan
- Day 30: same writeback → triggers `campaignLearning.runDeepRun` → triggers `promptGenerator.generate`

**Flag-flip ordering:** `performanceWritten.day7 = true` flips AFTER `runQuickScan` completes successfully. If the scan throws, the flag stays false and next audit retries — was previously flipped first, so a process death between flag and scan caused briefs to silently never contribute to learnings.

**Per-ad-set breakdown** = `{ adSetId, name, audienceType, hookStyles[], formats[], spend, conversions, roas, cpa, capturedAtDay }` per ad set. Causal layer reads this instead of blended ROAS, which previously mixed 1 winning ad set with 3 losers into a single mediocre brief-level number.

---

## Learning Loop

### Day 7 — Creative Quick Scan

Runs after Day-7 writeback completes. Statistically guarded:

- **Per-ad extraction** — one row per launched ad with `audienceType` from the ACTUAL ad set it ran in (was: dominant-spend-per-package heuristic that mis-tagged warm wins as cold).
- **Pause-state contamination filter** — skips campaigns where `status === 'paused' AND liveDays < 5`. Frontloaded learning-phase data no longer pollutes 7-day signal.
- **Hard floors** — ≥10 conversions per ad, ≥1500 impressions.
- **Wilson 95% lower bound on CTR** with **Bonferroni-corrected z** (`z = inverseNormalCdf(1 - α/(2k))` where k scales with candidate count) — eliminates the "50 ads × α=0.05 → ~2.5 false-positive winners every scan" problem.
- **Lower-bound CTR must beat cohort median** (not just be > 0).
- **Composite ranking** — `0.4·CTR-z + 0.6·CPA⁻¹-z`. Drops clickbait that has high CTR but zero conversions.
- Top-10 emitted as `winningExemplars[]` with `hookLine` (verbatim first line of primaryText), `hookStyle`, `audienceSegment`, `ctr`, `sampleSize`, `extractedAt`.

LLM (Sonnet, separate pass) summarizes patterns into `winningHooks[]` / `losingHooks[]` / `winningFormats[]` / `losingFormats[]` / `ctaInsights[]` / `copyToneInsights[]` / `visualInsights[]` for human-readable rendering.

### Day 30 — Causal Deep Run

Needs ≥3 campaigns with Day-30 data.

- **Matched pairs pre-constructed in TypeScript** before LLM call — groups by `(product, audienceType, monthBucket)`; emits only pairs differing in exactly one of `{format, hookStyle, budget_band}`. Capped at 20 pairs. LLM now describes a controlled comparison instead of confabulating one. Was: raw rows dumped to LLM with prompt asking for "2+ campaigns where ONLY one variable changed" — LLMs are bad at confound detection.
- Outputs `causalInsights[]` with `{finding, isolatedVariable, controlledFor[], rootCause, confidence, dataPoints}`.
- Bumps `learnings.version`; triggers `promptGenerator.generate`.

### On Pause — Single-campaign Root Cause
Dedicated single-data-point system prompt (not the multi-campaign one). Confidence capped at 0.50. Appends to `causalInsights` via race-safe `$push` with `$slice: -25`.

### Race-safe Writes
All `learnings.*` writes are per-leaf-field dot-paths via:
- `setCreativeLearningSlice(tenantId, slice)` — only sets the keys passed
- `setCampaignLearningSlice(tenantId, slice)` — same
- `appendCausalInsight(tenantId, insight, cap=25)` — `$push` with `$slice`
- `setTopicScores(tenantId, scores)` — single-leaf
- `replaceCausalInsights(tenantId, list)` — wholesale (deep run only)

Was: every writer read the whole `learnings` tree, spliced its slice, wrote whole tree back → concurrent writers (Day 7 + Day 30 + Meta importer + root-cause analysis) clobbered each other; `version` could go backwards.

### Exploration Arm
Strategy Team flags 1-of-N briefs as `explorationArm: true` — picks a brief whose hookStyle is NOT in `winningHooks` AND NOT in `losingHooks`. Creative Team skips injecting `winningHooks` / `winningExemplars` for that brief. Persisted on `IntelligenceBrief` + `CreativeBrief` + `BriefData`. Closes the autoregressive loop where round-N winners drive round-N+1 generation drives round-N+1 winners → monoculture.

### Prompt Versioning + Rollback
- `company.promptsVersion` (default 1) — bumped on every successful regen
- `company.promptsHistory[]` — last 5 entries with `{version, prompts, generatedAt, learningVersion}`
- `pipelineRun.promptsVersion` + `campaign.promptsVersion` stamped at creation
- `rollbackPromptsToVersion(tenantId, targetVersion)` — copies a history entry forward as a new version (audit-friendly: every change is a forward step)

Foundation for measurement-driven rollback. Eval set / champion-challenger infrastructure not yet built.

---

## Creative Production

### Copy Writer
4 copy variants per brief, each with a unique hookStyle from the **canonical taxonomy**:
- DR: `pain_point` · `bold_claim` · `price_shock` · `social_proof` · `curiosity_gap` · `before_after` · `urgency`
- Meme: `meme_relatable` · `meme_punchline` · `meme_self_aware`

Variants follow `audienceStage` rules: cold = problem-first 5-line + brand intro; warm = offer-recall 2-3 line + no brand intro + no "Kya aap bhi…" hooks; hot = 1-2 line urgency referencing the abandoned action.

### Image Generator
4 image prompts per package — one per copy variant, visual centerpiece concept matched to that variant's hook. Generated via Nano Banana (Gemini 3.1 Flash Image), uploaded to S3 with hash-based dedup, then to Meta as ad creatives.

### Video Generator (Heygen V3)
- 15-second vertical 9:16
- 4-scene structure: Hook → Pain/Desire → Product Reveal → CTA
- Variable opener / duration / b-roll vocabulary by hookStyle
- For spirituality vertical (91astrology): astro-specific b-roll (kundli paper, deity iconography, transit visuals); off-screen Hindi/Hinglish voiceover; Indian classical instruments (sitar, tabla, tanpura)
- Polled until ready, S3 stored
- `referenceVideoPrompt` preserved during creative replacements for style continuity

---

## Meta Ads Integration

Full Meta Graph API v21.0 integration:

- **Multi-account:** `company.meta.accountIds[]` — all operations support multiple ad accounts per tenant
- **`special_ad_categories`** — typed `MetaSpecialAdCategory` (`CREDIT|EMPLOYMENT|HOUSING|ISSUES_ELECTIONS_POLITICS`) on `MetaAdsConfig`, plumbed through to `createCampaign` (was hardcoded `[]`)
- **`ads_archive` Graph endpoint** — real competitor ad fetching (per-competitor, region-scoped) replacing the LLM-confabulated scrape
- **Audience auto-creation** — `ensurePixelAudiences` creates `${brand}_Purchasers_180d`, `_Visitors_30d`, `_Lookalike_1pct` if missing
- **Auto-exclusion of Purchasers** from prospecting ad sets (advantage_plus / lookalike / broad / interest)
- **Audience expiry retry** — when Meta returns subcode 1359207 / 3858504, falls back to `advantage_plus`
- **Default placements** — `publisher_platforms: ['facebook','instagram']` (skip Audience Network)
- **Attribution spec** — `7d-click + 1d-view`
- **Campaign / Ad Set / Ad creation** — proper hierarchy, all start PAUSED, activated only after all expected ads created
- **Rollback** — campaign delete cascades on partial failure
- **Retry** — exponential backoff on transient errors (codes 2, 17, 341, 368)

### Ad-name Convention
`{adSetName} — Variant {N} ({hookStyle})` plus `(video)` suffix for video ads in mixed format. Downstream `meta-learning-importer` parses by name for per-variant attribution.

### `format` field on every saved ad
`campaign.adSets[].ads[].format: 'video' | 'image'` populated at launch from `MetaLaunchResult`. Required to measure mixed-format campaigns from MongoDB without re-querying Meta.

### Campaign Sync Service
Syncs active campaigns every 6h, pulls live metrics from Meta, extracts conversion counts per the configured conversion event per product, supports multiple Meta accounts per tenant.

---

## Meta Learning Import

Fetches and enriches up to 1 year of historical campaign data from all Meta ad accounts.

1. Fetches campaigns from all `company.meta.accountIds[]`
2. Filters campaigns with spend > ₹500
3. Batches into groups of 50, queued via BullMQ with 10s stagger
4. Each campaign enriched with insights, ad sets, ad-level metrics, demographics, creatives
5. Product detection via `promoted_object.custom_conversion_id` → fuzzy product match
6. Top 50 case studies by spend saved per batch

**Query helpers** (consumed by team agents):
- `getRelevantCaseStudies(tenantId, { product?, limit? })`
- `getAudiencePerformanceSummary(tenantId)` — avg CPA / CTR / conversions by audience type

**Pattern calculator** writes per-product `productPatterns` with hookPerformance / formatPerformance / audiencePerformance / budgetInsights / seasonalPeaks. Best-pattern winning/losing hooks + formats persisted via race-safe slice writers.

---

## Live Context Builder

Injects real-time data into every agent prompt:

- Active products with prices, landing URLs, audience segments, Meta audience IDs, performance data
- Creative learnings (winningHooks / losingHooks / winningFormats / winningExemplars filtered by audienceStage)
- Campaign learnings (audienceScores / topicScores / budgetInsights / timingInsights)
- Causal insights (latest 5 — confidence-ranked)
- Hook saturation map (filtered to last 14 days, threshold ≥60%)
- Active promotions (expired auto-filtered)
- India holidays + festivals + events for next 21 days (with `cpmImpact` + `buyingMode` tags)

This is why the system never hardcodes product info — everything flows at runtime.

---

## Prompt Generator

Multi-batch system that generates company-specific prompts for all agents:

- **Batch 1 — Observation agents:** Instagram / Reddit / Twitter / YouTube scouts
- **Batch 2 — Decision agents:** Coordinator, Competitor Research, Market Research, Meta Ads Library, Idea Pool, Campaign Auditor, Strategy / Creative / Campaign Review team leads

Each prompt is deeply specific to the tenant's industry, tone, and audience, but generic enough that price / product changes don't require regeneration.

**Skills from `.claude/skills/`** injected per batch (paid-ads, ad-creative, copywriting, marketing-psychology, customer-research, competitor-alternatives, social-content, continuous-learning-v2, autonomous-loops, cost-aware-llm-pipeline, verification-loop, iterative-retrieval, market-research, product-marketing-context).

**Timeout:** 8 minutes per batch.

**Versioning + rollback:** every successful regen bumps `promptsVersion` and pushes a snapshot to `promptsHistory[]` (capped 5).

**Trigger:** brand-relevant field changes via `companies.update`, after Day 30 deep run, or manually via `POST /companies/:tenantId/regenerate`.

---

## Schedules + Queues

| Queue | Schedule | Notes |
|---|---|---|
| `pipeline` | Daily 9 AM IST (cold start) → Weekly Mon 9 AM IST | Per tenant; `attempts: 2`, exponential backoff 30s |
| `pipeline-switch` | One-shot delayed | Fires at `coldStartDays` end; switches daily → weekly |
| `campaign-audit` | Every 6h | Per tenant |
| `campaign-sync` | Every 6h | Per tenant, multi-account |
| `monthly-learning` | 1st of month, 3 AM IST | Per tenant |
| `creative-replacement` | On-demand | Triggered by audit `replace_creative` |
| `meta-learning-import` | On-demand | Historical batch import |
| `shadow-eval` | Daily 4 AM IST | Joins shadow actions with +24h / +72h metrics, labels regret |

**Pipeline await:** `pipeline.processor` awaits `orchestrator.runForJob(tenantId)` synchronously. Was previously fire-and-forget, which marked the BullMQ job complete the moment runId was created → retries impossible, worker crashes left orphan runs.

**Concurrent-run guard** (`pipeline-orchestrator.trigger`): in-flight check rejects concurrent triggers; stale runs (> 2h) bypass to allow recovery.

**Pipeline recovery:** stuck runs (> 2h old) get reclaimed on `OnModuleInit`. Currently boot-only — periodic cron pending.

---

## Storage (S3)

- Images uploaded from Nano Banana → S3 → Meta (hash-deduped)
- Videos uploaded from Heygen → S3 → Meta
- All paths prefixed with `tenantId/`
- Signed URLs generated for Meta upload

---

## Action Logger

Audit trail for all system actions:
- Audit actions (pause / scale / add_creative / replace_creative / dayparting / refresh_audience / shift_budget / etc.)
- Campaign lifecycle events
- Stores `tenantId` / `runId` / `agent` / `action` / `reason` / `outcome` / `metadata`
- Used for learning attribution and compliance tracking

---

## Conversion Tracking (3 Modes)

Per product in `company.products[]`:

| Mode | Fields | When |
|---|---|---|
| Standard Event | `conversionEvent: 'Purchase'` | Standard Meta pixel events |
| Custom Event | `conversionEvent: 'CustomEvent'`, `customEventName: 'NadiPurchase'` | Custom pixel events |
| Custom Conversion | `customConversionId: '123456'` | Named conversions with rules |

Custom Conversion takes priority. All metrics, ROAS, safety checks, and learning analysis respect the configured event type.

---

## API Reference

### Companies
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/companies` | Create company — schedules all jobs |
| `GET` | `/api/v1/companies` | List all |
| `GET` | `/api/v1/companies/:tenantId` | Get company |
| `PUT` | `/api/v1/companies/:tenantId` | Update (meta + pipelineConfig fields merged) |
| `PUT` | `/api/v1/companies/:tenantId/budget` | Update budget settings |
| `PUT` | `/api/v1/companies/:tenantId/products` | Replace products array |
| `POST` | `/api/v1/companies/:tenantId/regenerate` | Regenerate AI prompts (bumps version) |
| `POST` | `/api/v1/companies/:tenantId/import-learnings` | Start Meta learning import |
| `GET` | `/api/v1/companies/:tenantId/import-status` | Poll import progress |
| `POST` | `/api/v1/companies/:tenantId/finalize-import` | Re-run finalize |
| `GET` | `/api/v1/companies/:tenantId/case-studies` | List case studies |

### Campaigns
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/campaigns/:tenantId` | List all |
| `GET` | `/api/v1/campaigns/:tenantId/:campaignId` | Get detail |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/approve` | Launch on Meta — `{ accountId }` |
| `POST` | `/api/v1/campaigns/:tenantId/:campaignId/pause` | Pause (Mongo + Meta) — `{ reason }` |
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
| `GET` | `/api/v1/pipeline/:tenantId/runs/:runId/full` | Full run data |

---

## Company Config Reference

```typescript
// Identity
tenantId: string
apiKey: string                       // auto-generated UUID
name: string
industry: string

// Brand & Audience
targetAudience: string
audiencePersonas: string[]
customerLanguage: string[]
tone: string
avoid: string[]                      // brand voice exclusions
uniqueValue: string
brandGuidelines: string

// Competitive
competitors: string[]
competitorNotes: string
calendarContext: string

// Platforms & Geography
platforms: string[]
geography: string                    // default 'India'
language: string

// Budget controls
weeklyBudgetCap: number
maxBudgetPerCampaign: number
maxBudgetScalePercent: number        // default 20

// Pause / scale triggers
pauseIfFrequencyAbove?: number       // safety pause at 1.5×
pauseIfROASBelow?: number
pauseIfCTRBelow?: number
pauseAfterDaysInLearning?: number
scaleIfROASAbove?: number

// Content safety
forbiddenTopics: string[]
preferredFormats: string[]
campaignsPerRun: number              // default 1
runFrequency: 'weekly' | 'biweekly'
primaryObjective: 'conversions' | 'awareness' | 'traffic' | 'leads'
targetROAS?: number
targetCPA?: number

// Pipeline
pipelineConfig: {
  mode: 'daily' | 'weekly'
  ideasPerRun: number
  autoSwitch: boolean                // default true — daily→weekly after cold start
  coldStartDays: number              // default 14
  campaignStrategy: 'conservative' | 'balanced' | 'experimental'
  pauseGracePeriodHours: number      // default 12
  scaleRequiresApproval: boolean     // default true
  teamMode: 'cli' | 'sequential'     // default 'sequential'
  heygenAvatarId?: string
  heygenVoiceId?: string
  heygenBackgroundUrl?: string
}

// Meta
meta: {
  accessToken: string
  accountId: string                  // primary
  accountIds: string[]               // all accounts
  pixelId?: string
  pageId?: string
  specialAdCategories?: ('CREDIT'|'EMPLOYMENT'|'HOUSING'|'ISSUES_ELECTIONS_POLITICS')[]
}

// Products (each)
products: [{
  name: string
  price: number
  currency: string
  description: string
  active: boolean
  landingUrl?: string
  languages?: string[]
  trendKeywords?: string[]           // brand-relevance filter at coordinator
  differentiators?: string[]
  conversionEvent?: string
  conversionValue?: number
  customEventName?: string
  customConversionId?: string
  pixelId?: string
  audienceSegments?: AudienceSegment[]
  metaAudiences?: MetaAudience[]
  performance?: ProductPerformance   // populated by learning system
}]

// Delivery
delivery: {
  slackWebhook?: string
  whatsappNumber?: string
  email?: string
  notionDatabaseId?: string
}

// Generated by Prompt Generator
prompts: CompanyPrompts | null
promptsVersion: number               // default 1, bumped on regen
promptsHistory: Array<{ version, prompts, generatedAt, learningVersion }>  // capped 5

// Generated by Learning system
learnings: CompanyLearnings | null   // creative + campaign + topicScores + causalInsights + hookSaturation
signals: CompanySignals | null       // weekly observations from auditor
```

---

## Setup

### Prerequisites
- Node 20+
- MongoDB
- Redis

### Environment

```env
APP_PORT=3000
MONGO_URI=mongodb://localhost:27017/autonomous-marketing-agent
REDIS_URL=redis://localhost:6379
ANTHROPIC_API_KEY=sk-ant-...
META_ADS_ACCESS_TOKEN=...
META_ADS_ACCOUNT_ID=act_...
HEYGEN_API_KEY=...
GOOGLE_AI_API_KEY=...                 # Nano Banana / Gemini 3.1 Flash Image
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

## Critical Rules

1. **Never hardcode** product names, prices, or dates in agent prompts — live data injected via `LiveContextBuilder`
2. **All budget / safety checks in TypeScript** — re-validated after review team adjustments; LLMs cannot override
3. **Every database query** must include `tenantId` filter
4. **Every S3 path** must be prefixed with `tenantId/`
5. **Every agent call** through `ClaudeService.runAgent()` — never `query()` directly
6. **Meta field updates** always merge (never replace) — prevents wiping `accessToken` when only updating `pixelId`
7. **Mongoose Mixed fields** (`products`, `services`, `meta`, `pipelineConfig`) require `markModified()` before `save()`
8. **Campaign monitoring** only covers `source: 'agent'` campaigns
9. **Expired promotions** filtered from live context automatically
10. **Conversion tracking** respects per-product event type across metrics, safety checks, and learning analysis
11. **Scale + add_adset actions** always require human approval — never auto-execute
12. **Audit all-green skip** — skip Claude call when all signals healthy
13. **Learning writes** must use granular slice setters (`setCreativeLearningSlice` / `setCampaignLearningSlice` / `appendCausalInsight`) — never `updateLearnings()` whole-tree write (race-prone)
14. **`schemaVersion`** — old documents missing newer fields (`audienceStage`, `format`, `adSetPerformance`, `promptsVersion`, `explorationArm`) silently fall through to `undefined` defaults; migrations are not yet automated

---

## Known Gaps / Roadmap

The following are documented in `.claude/projects/.../memory/` and tracked as deferred work:

**Production safety (Round 2 deferred):**
- Atomic `/approve` claim — concurrent calls can duplicate Meta campaigns
- Per-tenant Redis lock around `create()` — covers weekly-budget / per-run / audience-create races
- Budget over-cap → reject + `actionLogger` (currently silent clamp)
- Forbidden topics scan against full brief + rendered copy variants
- Snapshot `creativePackage` + deep-clone `campaignConfig` (avoid Mongoose subdoc mutation)
- Approver attribution (`X-Approver` header)

**Approval UX (Round 4 deferred):**
- Slack creative preview (top hooks + image URLs + video link)
- Reject button + auto-expire pending after 72h
- Launch success / failure Slack confirmation
- Historical CPA + confidence panel in approval message

**Image text-rendering refactor (C1 deferred):**
- Stop asking Nano Banana to render text in images (mangles Devanagari, single 9:16 only)
- Code-side Sharp compositor with bundled Hindi fonts (Mukta, Hind Devanagari)
- Multi-aspect-ratio output (9:16 Stories/Reels, 4:5 Feed, 1:1 Marketplace) per variant
- Brand identity schema (palette, fonts, logo)

**Measurement infrastructure:**
- Eval harness — golden fixtures + per-prompt regression tests + champion/challenger
- Cost cap per run / per tenant per day (lower priority on Claude Code SDK CLI subscription)
- Structured logging with `runId` / `tenantId` / `phase` baggage
- Health endpoint per tenant
- Periodic recovery cron (currently OnModuleInit only)
- Schema migration framework (currently silent-default reads)

**Vertical depth (founder review priority):**
- Panchang / transit-calendar API ingestion as first-class scout signal source — astrology buyers buy on transit windows, not generic trending topics
- WhatsApp delivery with one-tap pause/scale (Indian DTC operators live in WhatsApp, not Slack)

**Architectural lift:**
- Sequential mode is single-pass review, not real debate — Strategy / Creative / Campaign Review prompts assume CLI tmux but default `'sequential'` runs 2 sequential calls without true adversary
- Hook saturation written by audit but never read by Strategy Team prompt
- Campaign Review Team has no fallback (2 attempts then throw)
- `enrichedCampaignModel.deleteMany` in Meta importer omits `tenantId` — bounded by ObjectId uniqueness today
