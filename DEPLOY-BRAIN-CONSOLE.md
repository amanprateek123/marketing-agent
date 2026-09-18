# Deploying the Brain console

One-time notes for whoever has access to the box behind `marketing.91astrology.com`.

This is an **additive** deploy. It adds one NestJS module (`/api/v1/brain/*`) and one dashboard page
(`/dashboard/:tenantId/brain`). Nothing existing changes behaviour. Both apps deploy exactly as
`DEPLOY.md` already describes — `git pull` then `docker compose up -d --build` — so the only new
work is the environment below.

Production is currently missing **two** modules, not one: `campaign-copilot` also 404s, so whatever
commit is live predates it. A pull of `main` picks up both.

---

## 0. Which branch

**`data-enrich`** — that is what production runs, for both repos. `main` is now identical to it
(the same commits, pushed to both), so a pull of either gets the same code. If the box already has
`data-enrich` checked out, a plain `git pull` is all it needs.

## 1. Backend env — `marketing-agent/.env`

```bash
# Foundry's RUN api. MCP over HTTP, not REST. This token may only RUN the agents
# it was granted — it cannot create, edit or deploy anything.
FOUNDRY_RUN_MCP_URL=https://foundry-api.alignbridge.ai/mcp-run/
FOUNDRY_RUN_TOKEN=<ask Ujjwal — the widened run token>
FOUNDRY_RUN_TIMEOUT_MS=60000

# The 91astro brain's MCP server. Same URL and bearer token creativebot already
# uses on M2 — see /home/creativebot/creativebot/.env on i-0a4488215f5d0263a.
BRAIN_MCP_URL=https://creative.91wheels.com/brain-mcp
BRAIN_MCP_BEARER_TOKEN=<same value creativebot already uses>
BRAIN_MCP_TIMEOUT_MS=30000

# The Slack id a gate decision made in the dashboard is recorded under.
# The brain enforces APPROVAL_SLACK_IDS inside approval_record, in SQL — so a
# console decision must still arrive carrying an identity that allowlist knows.
# UNSET => gate decisions return 503 with a message naming this variable.
BRAIN_APPROVAL_ACTOR_SLACK_ID=<a Slack id already on the brain's APPROVAL_SLACK_IDS>

# Foundry BUILDER api — powers ONLY "show me this agent's schedules" and
# "pause/resume one". This token can also rewrite prompts, edit graphs and deploy
# versions, so the bridge constructs its client with a hard tool allowlist
# (list_triggers, update_trigger) enforced at the transport: anything else throws
# before a request is built. Verified — edit_node, deploy_confirm, save_node_code,
# compile_and_publish and run_agent are all refused locally.
# UNSET => the trigger routes 503 and nothing else changes.
FOUNDRY_BUILDER_MCP_URL=https://foundry-api.alignbridge.ai/mcp/
FOUNDRY_BUILDER_TOKEN=<ask Ujjwal — the Foundry builder token>
FOUNDRY_BUILDER_TIMEOUT_MS=30000
```

**Every one of these is optional in the sense that the app still boots without them.** That is
deliberate: an unconfigured bridge 503s the `/brain/*` routes and leaves the other fifteen modules
untouched. You will not break the dashboard by deploying before the values are ready.

## 2. Frontend — a BUILD arg, not a runtime var

`NEXT_PUBLIC_*` is baked into the client bundle when Next builds. Setting it at runtime does
nothing.

**Do not set `NEXT_PUBLIC_BRAIN_MOCK` at all.** Fixtures are now opt-in: only the literal string
`true` turns the console into a demo. Unset means real data.

**Verified: `docker-compose.yml` already does not pass it.** The `frontend` service's `build.args`
carries only `NEXT_PUBLIC_API_URL`, so there is nothing to change here — just do not add it.

## 3. Deploy

```bash
cd /path/to/marketing-agent && git pull            # data-enrich
cd ../Marketing-Agent-Dashboard && git pull        # data-enrich
cd ../marketing-agent && docker compose up -d --build
```

The dashboard must remain a **sibling directory** of `marketing-agent`, which owns the compose file.

## 4. Smoke test — paste the output back

```bash
curl -s https://marketing.91astrology.com/api/v1/brain/91astrology/state | head -c 200
```

| You get | It means |
|---|---|
| `{"generatedAt":…,"connected":true,…}` | Working. Done. |
| `404 Cannot GET` | The backend did not pick up the new module — the build did not include `data-enrich`. |
| `{"connected":false,…}` but valid JSON | Bridge is up, Foundry is not reachable — check `FOUNDRY_RUN_TOKEN`. **The page still works**; it shows an honest "Foundry unreachable" state and the brain-sourced tabs still render. |
| `401` | Expected without a bearer token — the route sits behind the normal dashboard login. Not a fault. |
| `503` with a message naming an env var | That variable is missing. The message says which. |

Then open `https://marketing.91astrology.com/dashboard/91astrology/brain` and confirm there is **no
amber "Sample data — bridge not connected" chip**. If that chip is present, `NEXT_PUBLIC_BRAIN_MOCK`
was set to `true` at build time.

---

## What this touches, and what it does not

- **Adds:** `src/foundry-bridge/` (13 routes), and the dashboard's `/brain` page.
- **Reads from:** the astro-brain's Postgres over MCP, and Foundry's run API. **No MongoDB.**
- **Writes:** only gate decisions (`approval_record`, `update_idea`) and conversation turns, both in
  the brain — and starting Foundry agent runs. It never touches Meta directly.
- **Does not change** any existing route, model or page.

One thing worth knowing for whoever supports this: the dashboard now has **two** approval surfaces.
`/approvals` is the existing flow over MongoDB `Campaign` documents. `/brain` → Approvals is the
brain's own `plan`/`build`/`launch`/`scale` gates, which are what actually gate the Foundry
pipeline. They are different tables and neither is a mirror of the other.
