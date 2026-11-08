# PR Quality Gate

An AI code reviewer that runs as a **GitHub App**. When a pull request is opened or updated, it reads the diff with an LLM, turns the real problems into **triageable tickets**, re-checks them automatically on every new push, and reports a **merge-readiness status** back to GitHub.

The model can be a local one (Ollama, private by default) or a hosted one (Groq). A built-in **evaluation harness** measures how many planted bugs the review finds and how much noise it makes, with a regression gate so a prompt change cannot silently make it worse.

## Features

- **Webhook to review pipeline.** HMAC-verified GitHub webhooks, a BullMQ queue with per-commit dedupe, superseding of stale runs, and retries.
- **Noise control.** Lockfiles, generated and minified files are skipped with a stated reason. Every finding must quote text that really exists in the diff, an optional second pass verifies it, and a content fingerprint stops the same finding from reappearing on later pushes.
- **Tickets, not comments.** Findings become tickets you accept, hold or reject, edit like a Jira ticket, or create by hand. Every step is kept in an activity history.
- **Automatic re-check.** On a new push, tickets whose flagged code is gone close themselves. Only the ambiguous cases go back to the LLM. Merging or closing the PR closes its tickets.
- **Merge readiness.** Readiness is computed from the ticket state and posted to the PR as a commit status ("PR Quality Gate").
- **Dashboard.** React UI for pull requests, a single-PR report and a ticket board.
- **Evaluation harness** (`api/eval`). Planted-bug cases, tune/holdout splits, detection rate, false-positive share and a CI-style regression gate.

## Architecture

```
GitHub ──webhook──▶ NestJS API ──▶ BullMQ (Redis) ──▶ Review worker
                      │                                   │ fetch diff (GitHub App token)
                      │                                   │ filter files ─▶ LLM (Ollama / Groq)
                      ▼                                   │ evidence check ─▶ verify ─▶ fingerprint
                  PostgreSQL ◀── findings, tickets, runs ◀┘
                      ▲
React dashboard ──────┘            readiness ──▶ GitHub commit status
```

| Part | Stack |
|---|---|
| `api/` | NestJS 12, TypeScript, Prisma 7 + PostgreSQL, BullMQ + Redis, Octokit (GitHub App auth), Vitest |
| `web/` | React 19, TypeScript, Vite |
| `deploy/` | Docker, Nginx, PM2, database backup script |
| `docs/` | Setup walkthrough, GitHub App guide, deployment guide |

## Quick start

Requires Node 24, Docker, and either [Ollama](https://ollama.com) or a Groq API key.

```bash
docker compose up -d                 # PostgreSQL + Redis
cd api
cp .env.example .env                 # then edit it
npm ci
npx prisma migrate dev
npm run start:dev                    # http://localhost:3000
```

Try it without GitHub: set `ENABLE_DEV_ROUTES=true` in `.env`, then `curl -X POST localhost:3000/dev/seed` and open the dashboard. The full guide, including the real GitHub flow, is in [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md) and [docs/GITHUB_APP.md](docs/GITHUB_APP.md).

Web development: `cd web && npm ci && npm run dev` (the build output goes to `api/public`).

## Tests and evaluation

```bash
cd api
npm test            # unit tests: re-check rules, readiness, fingerprints, diff filtering, evaluation logic
npm run lint
npm run eval        # runs the review against planted-bug files (needs Ollama or Groq)
npm run eval:gate   # fails if the newest run is worse than eval/baseline.json
```

See [api/eval/README.md](api/eval/README.md) for the metrics and how matches are scored.

## Deployment

See [docs/DEPLOY.md](docs/DEPLOY.md) (Docker Compose, Nginx + HTTPS, GitHub App webhook URL).

## Security notes

Webhook signatures are verified on the raw request body. Secrets (`.env`, the GitHub App private key) are git-ignored. Set `API_TOKEN` on any server reachable from the internet, and never enable the `/dev/*` routes there. The UI renders finding text as text, never as HTML.
