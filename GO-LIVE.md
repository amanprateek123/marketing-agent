# Going live — 91 Astro marketing automation

Written 2026-09-19. Everything here was verified against the live system, not assumed.

There are two tracks. **They do not block each other.** The Brain can run the company today without
the dashboard being deployed; the deploy is what gives *you* the controls instead of me.

---

## Where things actually stand

| | |
|---|---|
| Brain v2 | **2.10.1**, serving, 5 schedules live |
| Brain v1 | **retired** 2026-09-19 — all 5 triggers paused |
| Today's plan | written, zero-spend, `plan_missing: false` |
| Creative pipeline | working end to end (kiro → gpt-image-2 → dashboard) |
| `saathi_report` launch readiness | `ready: true` |
| Dashboard console | built, merged to `data-enrich`, **not deployed** |

---

## Track 1 — Deploy the dashboard

### What you are deploying

Two additive changes. Nothing existing changes behaviour.

- `marketing-agent` — one new NestJS module (`/api/v1/brain/*`, 15 routes)
- `Marketing-Agent-Dashboard` — one new page (`/dashboard/:tenantId/brain`)

Production is currently missing **two** modules, not one: `campaign-copilot` also 404s, so the live
commit predates it. A pull picks up both.

### Step 1 — the branch

**`data-enrich`.** That is what production runs, for both repos. `main` is identical to it (same
commits, pushed to both), so either pulls the same code. If the box already has `data-enrich`
checked out, a plain `git pull` is all it needs.

### Step 2 — environment

One file: **`marketing-agent/.env`**, in the same directory as `docker-compose.yml`. Append:

```bash
# --- Foundry RUN api (MCP over HTTP, not REST) ---------------------------------
# This token may only RUN the agents it was granted. It cannot create, edit or
# deploy anything. Grants are fixed when the token is minted.
FOUNDRY_RUN_MCP_URL=https://foundry-api.alignbridge.ai/mcp-run/
FOUNDRY_RUN_TOKEN=<the 7-agent token already minted>
FOUNDRY_RUN_TIMEOUT_MS=60000

# --- The 91astro brain -----------------------------------------------------------
# COPY these two from /home/creativebot/creativebot/.env on i-0a4488215f5d0263a.
# Do NOT regenerate: creativebot uses the same credential and you will break it.
BRAIN_MCP_URL=https://creative.91wheels.com/brain-mcp
BRAIN_MCP_BEARER_TOKEN=<copy, do not mint>
BRAIN_MCP_TIMEOUT_MS=30000

# --- Who a console gate decision is recorded as ----------------------------------
# NOT a token. The brain enforces APPROVAL_SLACK_IDS inside approval_record, in SQL,
# so a decision made in the dashboard must still carry an identity that allowlist
# knows. UNSET => gate decisions return 503 naming this variable.
BRAIN_APPROVAL_ACTOR_SLACK_ID=U0B8E8P4CVC

# --- Foundry BUILDER api — schedule read + pause/resume ONLY ----------------------
# THE ONLY THING YOU NEED TO MINT. Studio -> builder/API token, scope `agents:write`.
# This token can also rewrite prompts, edit graphs and deploy versions, so the bridge
# constructs its client with a hard allowlist (list_triggers, update_trigger) enforced
# at the transport: anything else throws before a request is built. Verified —
# edit_node, deploy_confirm, save_node_code, compile_and_publish and run_agent are all
# refused locally.
# UNSET => the trigger routes 503 and nothing else changes.
FOUNDRY_BUILDER_MCP_URL=https://foundry-api.alignbridge.ai/mcp/
FOUNDRY_BUILDER_TOKEN=<mint this one>
FOUNDRY_BUILDER_TIMEOUT_MS=30000
```

**Frontend: set nothing.** `NEXT_PUBLIC_BRAIN_MOCK` must stay unset. Only the literal string `true`
turns the console into a demo against fixtures; unset means real data. `docker-compose.yml` already
does not pass it — verified — so there is nothing to change, just do not add it.

Every variable above is optional in the sense that the app still boots without it. An unconfigured
bridge 503s only the `/brain/*` routes and leaves the other fifteen modules untouched. **You cannot
break the existing dashboard by deploying before the values are ready.**

### Step 3 — deploy

```bash
cd /path/to/marketing-agent            && git pull     # data-enrich
cd ../Marketing-Agent-Dashboard        && git pull     # data-enrich
cd ../marketing-agent && docker compose up -d --build
```

The dashboard repo must stay a **sibling directory** of `marketing-agent`, which owns the compose
file.

### Step 4 — prove it

```bash
curl -s https://marketing.91astrology.com/api/v1/brain/91astrology/state | head -c 200
```

| response | meaning |
|---|---|
| `{"generatedAt":…,"connected":true,…}` | Working. Done. |
| `404 Cannot GET` | The build did not include `data-enrich`. |
| `{"connected":false,…}` valid JSON | Bridge up, Foundry unreachable — check `FOUNDRY_RUN_TOKEN`. **The page still works** and shows an honest "Foundry unreachable" state. |
| `401` | Expected without a bearer token — the route sits behind the normal login. Not a fault. |
| `503` naming a variable | That variable is missing. The message says which. |

Then open `/dashboard/91astrology/brain` and confirm there is **no amber "Sample data" chip**. If
there is, `NEXT_PUBLIC_BRAIN_MOCK` was set to `true` at build time.

---

## Track 2 — Tokens: what to mint, and what not to

**Mint exactly one: `FOUNDRY_BUILDER_TOKEN`.** Everything else already exists.

Foundry token grants are fixed at mint — you cannot edit them afterwards — which is why the system
already uses **two separate run tokens**, deliberately:

| token | lives in | grants | why |
|---|---|---|---|
| **Brain's dispatch token** | `/etc/astro-brain/brain.env` → `FOUNDRY_RUN_TOKEN` | producer, curator, builder, **launcher**, monitor, report — **not the Brain** | the Brain starts the pipeline chain |
| **Dashboard run token** | `marketing-agent/.env` → `FOUNDRY_RUN_TOKEN` | Brain + 6 | the dashboard starts on-demand agents and reads run history |

The Brain is excluded from its own dispatch token on purpose: *"letting it start itself invites a
recursive loop with an ad account behind it."*

**You do not need to add Campaign Launcher to the dashboard token.** Verified by dispatching it:
`dispatched: true`, `run_01a0b4560420…`. The launch path is brain → dispatch token → Launcher, and
it works. Adding it to the dashboard token only makes its runs *visible* in the Runs tab. Cosmetic.

---

## Track 3 — Launch a campaign through the Brain

The chain, and what gates each hop:

```
1. Brain allocates            →  needs headroom it trusts        ✅ fixed
2. Plan gate opens            →  automatic when a plan spends
3. A human approves the gate  →  Slack today, Approvals tab once deployed
4. pipeline_run released      →  the queue requires an APPROVED plan gate for that plan_date
5. Producer → Curator → Builder  →  webhook + 2-min sweeper      ✅ working
6. Builder leaves everything PAUSED
7. Launch gate opens          →  a human approves
8. Launcher activates in Meta →  brain dispatch token            ✅ verified
```

**Step 4 is the one that has silently stopped everything.** `pipeline_run_read` hands out a run only
when its day's plan gate is approved:

```sql
AND ( r.campaign_type = 'scale'
      OR EXISTS (SELECT 1 FROM approvals plan_gate
                  WHERE plan_gate.gate='plan' AND plan_gate.plan_date=r.plan_date
                    AND plan_gate.status='approved') )
```

Plan gates for 13, 14, 16 and 17 September all **expired unanswered**. That is why the pipeline
shows 88 abandoned runs against 4 done. It was never broken — nobody answered the gate. **The
Approvals tab exists to fix exactly this.**

### Launch readiness per product

A product can only be launched when its tracking is verified:

```
pixel_id             \  both must be non-stale for the offering
custom_conversion_id /
```

`saathi_report` is **ready** (verified 2026-09-19 — pixel last fired 2026-09-17T23:58, conversion
`Saathi_Purchase` matches `content_ids ~ saathi-report`, not archived).

For any other product, check with `ad_account_config_read {offering_slug}` and verify against
`list_pixels` / `list_custom_conversions` on the Meta connector. The IDs are usually already correct
and merely unverified.

---

## What was broken, and what fixed it

Five bugs, each hiding the next. Recorded because the pattern matters more than the fixes.

| version | bug | consequence |
|---|---|---|
| **2.7.0** | `select_mode` treated "no inputs" as an unattended wake, but a Foundry cron **does** pass `{event, foundry_trigger}` | Every scheduled run exited in 15s for $0.0003 **reporting success**. The daily review had never once run. |
| **2.8.1** | `except Exception:` recorded a hardcoded `'call failed'`, discarding the tool's own message | The day's plan of record contradicted the day's decisions and nothing in the run could say why. |
| **2.9.0** | A decision about a campaign with no registered offering could not satisfy the `offering_slug` rule | One missing field discarded three whole overnight runs, validated allocation included. |
| **2.10.0** | `valid: false` refused everything, including an allocation that passed its own arithmetic | The company had no plan while three successful runs had each computed one. |
| **2.10.1** | Foundry's code-node layer **drops empty arrays** from tool arguments | A zero-spend plan — whose lists are all empty — was the one plan shape the Brain could never write. |

The through-line: **a green run that quietly does nothing is worse than a red one.** Four of these
five reported success.

---

## Still open

| item | owner |
|---|---|
| Mint `FOUNDRY_BUILDER_TOKEN`, send this file + values to whoever has the box | you |
| Reject my fabricated wiki card `know_01a0b2c778b471a39190ce1b1f90e923` | you |
| VLM chain is down — Gemini billing disabled (`brilliant-era-505511-q5`), GLM 401, Kimi quota. Authoring is fine on kiro; this is the vision/routing chain | you |
| Rotate the Claude OAuth token and the run token (both pasted in chat) | you |
| `orders_daily` is empty — no revenue truth, so every ROAS is pixel-only and the brain distrusts it | needs a decision |
| 24 open `sync_gaps`, none ever resolved; 19 are the brain refusing Meta revenue as implausible | needs a decision |
| Brain v2 does not read `plan_directives_pending`, so "launch X for ₹Y" is not yet authoritative | ~30 min |
| Competitor Research has never run and has no scraper connector | scoped, not started |
