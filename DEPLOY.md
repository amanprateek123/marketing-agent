# Deploying behind the existing ALB

This repo (`marketing-agent`, the NestJS backend) holds the Docker orchestration
for both apps. It expects the frontend repo to be checked out as a **sibling
directory**:

```
/opt/apps/
├── marketing-agent/            <- this repo (docker-compose.yml lives here)
└── Marketing-Agent-Dashboard/  <- frontend repo
```

This instance has no public IP and sits behind an ALB (alongside the other
`91astro-*` apps on the same box, which follow the same pattern). There's no
in-stack reverse proxy — `backend` and `frontend` each publish their port
directly to the host, and the ALB does the path-based routing between them.

## 1. Wire up the ALB (one-time, in the AWS console/Terraform)

Two target groups, both pointing at this instance:

1. **Backend target group**: protocol HTTP, port `8082` (matches the
   `8082:8082` mapping in `docker-compose.yml`). Health check path e.g.
   `/api/v1/learning/91astrology/regret-summary` (or any known-good route —
   there's no dedicated `/health` endpoint).
2. **Frontend target group**: protocol HTTP, port `3002` (matches the
   `3002:3000` mapping). Health check path `/`.
3. **Register this instance** in both target groups on their respective ports.
4. **Listener rules** on the ALB's existing HTTPS:443 listener, both scoped
   to Host header `marketing.91astrology.com`:
   - path pattern `/api/*` → backend target group (higher priority / evaluated first)
   - default (no path condition, just the host) → frontend target group
5. **ACM certificate**: confirm the cert attached to that listener covers
   `marketing.91astrology.com` (already true if it's a `*.91astrology.com`
   wildcard cert; otherwise add this hostname as a SAN).
6. **Security group**: the instance's security group needs to allow inbound
   `8082` and `3002` from the ALB's security group (not from the internet —
   the whole point of no public IP is that only the ALB should reach it).

If either host port (`8082`/`3002`) is already taken on this box, change it
in `docker-compose.yml` and use the new port in the matching target group.

## 2. DNS

Point `marketing.91astrology.com` at the **ALB's DNS name** (CNAME, or an
ALIAS/A-record if using Route 53), the same way the other `91astro-*`
subdomains presumably already point at this ALB — not at the instance,
which has no public IP to point to.

## 3. Server prep

```bash
mkdir -p /opt/apps && cd /opt/apps
git clone <marketing-agent-repo-url> marketing-agent
git clone <dashboard-repo-url> Marketing-Agent-Dashboard
```

## 4. Configure secrets

```bash
cd /opt/apps/marketing-agent
cp .env.docker.example .env
$EDITOR .env   # fill in META_ADS_ACCESS_TOKEN, AWS keys, OPENAI_API_KEY, etc.
```

`MONGO_URI` and `REDIS_URL` must point at the **container service names**,
not `localhost`:
```
MONGO_URI=mongodb://mongo:27017/autonomous-marketing-agent
REDIS_URL=redis://redis:6379
```
(`.env.docker.example` already has these pre-filled — don't overwrite them
with values copied from a local/non-Docker `.env`, which uses `localhost`
and won't resolve inside the container.)

If the frontend's public API URL ever changes from
`https://marketing.91astrology.com/api/v1`, update the `NEXT_PUBLIC_API_URL`
build arg in `docker-compose.yml` — it's baked into the frontend's client
bundle at build time, so a rebuild (`docker compose build frontend`) is
required after any change.

## 4b. Higgsfield CLI credentials (video generation)

The backend shells out to the `higgsfield` CLI for all video generation
(single-shot and scene-chunk). It has **no API key / headless login** — auth
is a browser OAuth flow (`higgsfield auth login`) that writes
`~/.config/higgsfield/credentials.json` + `config.json` on whatever machine
ran it. This step gets those files onto the server without ever running that
login flow there (there's no browser on the server anyway).

On your local machine (where you've already run `higgsfield auth login`):
```bash
ls ~/.config/higgsfield/          # config.json, credentials.json, credentials.json.lock
scp ~/.config/higgsfield/config.json ~/.config/higgsfield/credentials.json \
  <server-user>@<server-host>:/opt/apps/marketing-agent/higgsfield-config/
```
(Skip `credentials.json.lock` — a 0-byte lock file the CLI recreates itself.)

On the server, before first `docker compose up`:
```bash
cd /opt/apps/marketing-agent
mkdir -p higgsfield-config
# files should already be here from the scp above
chown -R 1001:1001 higgsfield-config   # container runs as uid 1001 (nestjs)
```
`docker-compose.yml` bind-mounts this directory to `/home/nestjs/.config/higgsfield`
inside the container — read-write, not read-only, because the CLI rewrites
`credentials.json` in place when it refreshes the access token using the
refresh token. If that mount is ever read-only, video generation will keep
working until the token expires, then fail with an auth error.

**If the refresh token itself ever expires/gets revoked:** re-run
`higgsfield auth login` locally and re-copy both files to the server the same
way — there's no in-container remediation for that, since there's no browser
in the container.

## 5. Build and start

```bash
cd /opt/apps/marketing-agent
docker compose up -d --build
docker compose ps
docker compose logs -f backend frontend
```

`backend` listens on host port `8082`, `frontend` on host port `3002` — both
directly, no reverse proxy in between. The ALB is what stitches
`marketing.91astrology.com/api/*` and `marketing.91astrology.com/*` back
together into one hostname.

## 6. Verify

From the server itself first (bypasses the ALB/DNS entirely):

```bash
curl -I http://localhost:3002/
curl http://localhost:8082/api/v1/<some-known-route>
```

Once both ALB target groups are healthy and DNS has propagated:

```bash
curl -I https://marketing.91astrology.com
curl https://marketing.91astrology.com/api/v1/<some-known-route>
```

## Updating after a code change

```bash
cd /opt/apps/marketing-agent && git pull
cd /opt/apps/Marketing-Agent-Dashboard && git pull
cd /opt/apps/marketing-agent
docker compose up -d --build
```

## Notes

- `mongo_data` / `redis_data` are named Docker volumes — they survive
  `docker compose down` (but not `docker compose down -v`).
- The backend has no cron for `metric_timeseries`/`breakdown_snapshots`
  refresh yet — the manual `/deep-sync` endpoint is still the only way to
  refresh that data (see project memory `marketing-agent-system`).
