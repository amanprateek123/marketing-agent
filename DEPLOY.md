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
`91astro-*` apps on the same box). The ALB terminates TLS — Caddy here is
**not** doing automatic HTTPS/Let's Encrypt; it's a plain internal HTTP
reverse proxy on port 8090 that splits `/api/*` (backend) from everything
else (frontend), the same role the ALB's path rules would otherwise play.

## 1. Wire up the ALB (one-time, in the AWS console/Terraform)

1. **Target group**: new target group, protocol HTTP, port `8090` (matches
   the `8090:80` mapping in `docker-compose.yml` — change both if 8090 is
   taken on this box), target type matching the other `91astro-*` target
   groups (likely "instance"). Health check path `/`.
2. **Register this instance** to that target group on port 8090.
3. **Listener rule**: on the ALB's existing HTTPS:443 listener, add a rule
   — if Host header is `marketing.91astrology.com`, forward to the new
   target group. Give it a priority that doesn't conflict with the
   existing per-app rules.
4. **ACM certificate**: confirm the cert attached to that listener covers
   `marketing.91astrology.com` (already true if it's a `*.91astrology.com`
   wildcard cert; otherwise add this hostname as a SAN).
5. **Security group**: the instance's security group needs to allow inbound
   `8090` from the ALB's security group (not from the internet — the whole
   point of no public IP is that only the ALB should reach it).

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

Leave `MONGO_URI` / `REDIS_URL` as the defaults — those point at the `mongo`
and `redis` containers defined in `docker-compose.yml`.

If the frontend's public API URL ever changes from
`https://marketing.91astrology.com/api/v1`, update the `NEXT_PUBLIC_API_URL`
build arg in `docker-compose.yml` — it's baked into the frontend's client
bundle at build time, so a rebuild (`docker compose build frontend`) is
required after any change.

## 5. Build and start

```bash
cd /opt/apps/marketing-agent
docker compose up -d --build
docker compose ps
docker compose logs -f backend frontend caddy
```

Caddy listens only on `8090` (plain HTTP, internal to the box) and
reverse-proxies:
- `/api/*` → `backend:8082` (NestJS, prefix `/api/v1` already included in the path)
- everything else → `frontend:3000` (Next.js)

## 6. Verify

From the server itself first (bypasses the ALB/DNS entirely):

```bash
curl -I http://localhost:8090/
curl http://localhost:8090/api/v1/<some-known-route>
```

Once the ALB target group is healthy and DNS has propagated:

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
