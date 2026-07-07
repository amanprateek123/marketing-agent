# Deploying to a VPS

This repo (`marketing-agent`, the NestJS backend) holds the Docker orchestration
for both apps. It expects the frontend repo to be checked out as a **sibling
directory**:

```
/opt/apps/
├── marketing-agent/            <- this repo (docker-compose.yml lives here)
└── Marketing-Agent-Dashboard/  <- frontend repo
```

## 1. DNS

Point an A record for `marketing.91astrology.com` at the VPS's public IP.
Caddy (below) handles TLS automatically via Let's Encrypt once that resolves.

## 2. Server prep

```bash
# Docker + Compose plugin (Ubuntu/Debian example)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out/in after this

mkdir -p /opt/apps && cd /opt/apps
git clone <marketing-agent-repo-url> marketing-agent
git clone <dashboard-repo-url> Marketing-Agent-Dashboard
```

## 3. Configure secrets

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

## 4. Build and start

```bash
cd /opt/apps/marketing-agent
docker compose up -d --build
docker compose ps
docker compose logs -f backend frontend caddy
```

Caddy listens on 80/443, requests its own Let's Encrypt cert for
`marketing.91astrology.com` on first boot, and reverse-proxies:
- `/api/*` → `backend:8082` (NestJS, prefix `/api/v1` already included in the path)
- everything else → `frontend:3000` (Next.js)

## 5. Verify

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

- `mongo_data` / `redis_data` / `caddy_data` are named Docker volumes — they
  survive `docker compose down` (but not `docker compose down -v`).
- The backend has no cron for `metric_timeseries`/`breakdown_snapshots`
  refresh yet — the manual `/deep-sync` endpoint is still the only way to
  refresh that data (see project memory `marketing-agent-system`).
