# Deployment

Two ways. Pick Docker first, it is the same on your Mac and on a server.

## What you need on the server
- A Linux VPS (2 GB RAM minimum for API + Postgres + Redis), Docker + Docker Compose, a domain pointing at it.
- The AI model. READ THIS: a 7B model on a small CPU-only VPS is very slow (minutes per file). Options:
  1. Run Ollama on the VPS only if it has enough RAM/GPU.
  2. Run Ollama on a machine with a GPU you control and set `OLLAMA_URL` to it (put it behind a private network or VPN, never open port 11434 to the internet).
  3. Write a second `LlmProvider` for a hosted API (one new class plus one line in `app.module.ts`). Not built yet.
  `docker-compose.prod.yml` lets the container reach Ollama running on the same server at `http://host.docker.internal:11434`.

## Steps (Docker)
```bash
git clone <your repo> /opt/prgate && cd /opt/prgate
mkdir -p api/secrets && cp /path/to/github-app.pem api/secrets/github-app.pem
cp api/.env.example api/.env.production      # then edit it
```
Set in `api/.env.production`: `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `OLLAMA_URL=http://host.docker.internal:11434`, `OLLAMA_MODEL`, `API_TOKEN` (long random string), `PUBLIC_URL=https://prgate.example.com`, `POSTGRES_PASSWORD`, `NODE_ENV=production`. (`DATABASE_URL`, `REDIS_*` and the key path are set by the compose file.)

```bash
docker compose -f docker-compose.prod.yml --env-file api/.env.production up -d --build
docker compose -f docker-compose.prod.yml logs -f api       # "Nest application successfully started"
curl localhost:3000/health
```
The container applies migrations (`prisma migrate deploy`) every time it starts.

## HTTPS with Nginx
Copy `deploy/nginx.conf` to `/etc/nginx/sites-available/prgate`, change the domain, enable it, then `sudo certbot --nginx -d prgate.example.com`.
Then set the GitHub App's webhook URL to `https://prgate.example.com/webhooks/github` and open the UI at `https://prgate.example.com` (it asks for `API_TOKEN` once, via the "API token" button).

## Without Docker (PM2)
See the comment at the top of `deploy/ecosystem.config.cjs`. You install Postgres and Redis yourself.

## Backups and updates
- Nightly backup: `deploy/backup-db.sh` (cron line inside).
- Update: `git pull && docker compose -f docker-compose.prod.yml --env-file api/.env.production up -d --build`.
- Roll back: `git checkout <old commit>` and the same command. Migrations only move forward, so take a backup before a release that changes the schema.

## CI
`deploy/ci.yml` (copy it: `mkdir -p .github/workflows && cp deploy/ci.yml .github/workflows/ci.yml`, my tools may not write there) builds and tests on every push and pull request. Add "build-and-test" as a required check in branch protection next to "PR Quality Gate" when you are ready. Automatic deployment (CD) is not set up on purpose: deploy by hand until you trust the flow.

## Security checklist
- `API_TOKEN` set, HTTPS on, `NODE_ENV=production` (switches off every `/dev` route).
- Port 3000 is bound to 127.0.0.1 only; Postgres and Redis publish no ports.
- `.env*` and `*.pem` are never committed.
- The webhook route trusts only requests with a valid HMAC signature.
