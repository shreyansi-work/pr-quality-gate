# Run guide: everything, in order

Written by Claude. Only the pure logic (re-check rules, readiness) was run, by Claude, and the UI was opened in a browser with fake data. The rest has NOT been run against your database, Redis, Ollama or GitHub. Expect a few errors, paste them to me.
Your rule: run it, read the code in the order in section 7, and explain it back (section 8) before you trust it.

All commands run from `api/` unless they say otherwise. Run `pwd` first.

## 1. Setup (once)

```bash
npm install                      # nothing new was added since chunk 5
rm src/app.controller.ts src/app.service.ts src/app.controller.spec.ts test/app.e2e-spec.ts   # leftovers from the Nest template
```

Add to `api/.env` (compare with `.env.example`; never commit `.env`):

```
GITHUB_WEBHOOK_SECRET=change-me-local-webhook-secret
REDIS_HOST=localhost
REDIS_PORT=6379
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:7b
REVIEW_VERIFY=true
```

Start the services and update the database (new columns for tickets):

```bash
cd .. && docker compose up -d && docker compose ps     # postgres and redis must both say "running"
cd api
ollama list                                            # make sure the model in OLLAMA_MODEL exists
npx prisma migrate dev --name triage_and_tickets
npx prisma generate
npm run start:dev
```

Success looks like: "Found 0 errors", routes mapped (`/api/pulls`, `/api/tickets`, `/dev/seed` ...) and NO more "ECONNREFUSED" lines.
Open http://localhost:3000 : you should see the page "Pull requests" (empty).

## 2. Webhook smoke tests (chunk 1)

```bash
curl -s localhost:3000/health                                   # {"status":"ok","db":"up"}
./scripts/send-webhook.sh                                       # HTTP 200
./scripts/send-webhook.sh                                       # HTTP 200 again
BADSIG=sha256=0000 ./scripts/send-webhook.sh                    # HTTP 401
docker compose exec postgres psql -U prgate -d prgate -c 'select id, number, "headSha" from "PullRequest";'
docker compose exec postgres psql -U prgate -d prgate -c 'select id, "headSha", status, error from "PrRun";'
```

Expected: one PullRequest row (not two) and one PrRun row with status FAILED and error "No GitHub App installation id ..." (there is no GitHub App yet, that is correct). Change the sha: `./scripts/send-webhook.sh bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` gives a second PrRun row.
(If `docker compose exec` is run from `api/`, use `cd ..` first.)

## 3. THE QUALITY GATE: score the AI (no GitHub needed)

Take your auth project, make a copy of the code on a branch, plant 5 realistic bugs (a missing null check, a missing `await`, a hard-coded secret, an unhandled error, missing input validation), then:

```bash
git diff main > /tmp/bugs.diff
curl -s -X POST localhost:3000/dev/review -H "Content-Type: text/plain" --data-binary @/tmp/bugs.diff | python3 -m json.tool
```

Mark each kept finding useful / not useful. Your bar: at least 5 of 10 findings useful and at least 3 of 5 planted bugs found. Run it with `REVIEW_VERIFY=false` and `true` (restart between) and compare. Send me the numbers.
This decides whether the AI review is good enough. Everything else in the project works the same either way.

## 4. Demo: triage, tickets and readiness (no GitHub, no AI needed for these steps)

```bash
curl -s -X POST localhost:3000/dev/seed
```

Open http://localhost:3000/#/ and click "Add login". You get 4 findings (2 HIGH, 1 MEDIUM, 1 LOW), status "Needs triage".

1. **Triage.** Accept the two HIGH ones, Hold the MEDIUM one, Reject the LOW one with a reason. After each click the next untriaged finding opens. Watch the banner: "Needs triage" -> "Not ready. 2 accepted ticket(s) still open".
2. **Board.** Open the Tickets page. Accepted has 2, On hold has 1. Try the PR and severity filters.
3. **Confirm fixed by hand.** On one accepted ticket click "Fixed". It moves to the Fixed column and the banner count drops.
4. **Simulate a new push where you fixed things** (this re-runs only the re-check, and asks Ollama about lines that changed inside a function):

```bash
# 1 is the pull request id the seed printed
curl -s -X POST localhost:3000/dev/recheck/1 -H "Content-Type: text/plain" --data-binary @scripts/samples/after.diff | python3 -m json.tool
```

   Expected: the hard-coded secret ticket closes by itself ("The flagged line is gone"). The two tickets inside `login()` are decided by the AI: "gone" closes them, "present" keeps them, an unclear answer moves them to "Needs a look". The "no tests" rule is still there because no test file was added.
5. **Add a test and re-check:** same command with `scripts/samples/after-with-test.diff`. The rule closes by itself. If every Accepted ticket is closed and nothing is untriaged the banner turns green: "Ready to merge".
6. Run `/dev/seed` again at any time to reset the demo.

### Tickets like Jira
- Click a ticket on the Tickets page (or "Open ticket" in the report) to open it: change the title, description, severity and status, then Save.
- "+ New ticket" creates a ticket by hand. It is never closed automatically.
- Delete: a manual ticket is removed for good. A ticket the review found is marked rejected ("Deleted by you"), so it does not come back on the next push.
- After pulling this update, run `npx prisma migrate dev --name ticket_editing` (if you have not yet) and then `npx prisma migrate dev --name ticket_events`, then `npx prisma generate` and restart.

### Automation you can watch
- **History:** open any ticket. The "Activity" list shows every step: found on commit, your decisions, automatic closes with the commit, reopens.
- **Closed with the PR:** with the demo data and a ticket accepted, simulate GitHub saying the PR was merged:
  ```bash
  REPO_ID=1 FULL_NAME=demo/auth-app NUMBER=1 ACTION=closed MERGED=true bash scripts/send-webhook.sh
  ```
  Every open ticket of that PR moves to Done with "The pull request was merged" (use `MERGED=false` for "closed without merging"). Send `ACTION=reopened` to bring them back (a reopened PR also queues a new review, which fails without a GitHub App; that is expected locally).
- **Closed by a new push:** `/dev/recheck/1` with `scripts/samples/after.diff`, then open the ticket to read the "Closed automatically ... (commit ...)" line. The dev route has no commit id, so the real push on GitHub shows the commit.

## 5. The real GitHub flow

Follow `docs/GITHUB_APP.md` (click by click). After the first real PR you should see "PR Quality Gate" on the PR page: pending while reviewing, then pending/failure/success depending on your triage.

## 6. Tests

```bash
npm test      # includes src/gate/recheck.spec.ts (re-check and readiness rules)
npm run build
```

## 7. Read the code in this order

| # | File | Concept |
|---|------|---------|
| 1 | `src/webhooks.controller.ts`, `github-signature.guard.ts`, `webhooks.service.ts` | Signature check on raw bytes, upsert, enqueue |
| 2 | `review/review-queue.service.ts` | Queue, jobId dedupe, superseding old runs, retries |
| 3 | `review/review.worker.ts` | Worker, concurrency 1, stale checks, the full flow of one run |
| 4 | `github/github.service.ts`, `github/diff-filter.ts` | App token, REST calls, skipped files with reasons |
| 5 | `llm/*`, `review/prompts.ts`, `review/parse-findings.ts` | Provider interface, narrow prompts, JSON validation |
| 6 | `review/review.service.ts`, `review/fingerprint.ts` | Evidence check, second pass, rules, upsert by fingerprint |
| 7 | `gate/recheck.ts` + `gate/recheck.spec.ts` | The re-check decision (pure function, read the tests first) |
| 8 | `gate/recheck.service.ts` | Applying the decision, asking the AI only for the hard case |
| 9 | `gate/readiness.ts`, `gate/gate.service.ts` | Readiness is computed, then posted to GitHub as a status |
| 10 | `gate/triage.service.ts`, `gate/api.controller.ts`, `gate/api-token.guard.ts` | Triage transitions, JSON API, token guard |
| 11 | `public/app.js` | UI: only `textContent`, never HTML from the server |

## 8. Explain-back (write short answers, then send them to me)

Queue and review
1. Two quick pushes on the same PR: what happens to the first run, step by step?
2. What does `jobId: run-<id>` protect against, and what does the unique index on `(pullRequestId, headSha)` protect against?
3. Why `concurrency: 1`? Why does the worker check `isStale` more than once?
4. Why must a finding's quote exist in the diff, and what does the second pass add?
5. Why is the fingerprint built from the quote and not the line number?

Tickets and re-check
6. A ticket's line was reworded but the bug is still there. Which branch of `judge` catches it, and what happens if Ollama is down at that moment?
7. Why does `lineStillThere` compare whole lines and not use `includes`? (Hint: `await foo()` versus `foo()`.)
8. Why is readiness computed every time and not stored in a column?
9. Why does a failed status call to GitHub only log a warning and not throw?
10. Why does the UI never use `innerHTML` for finding text?

## 9. Honest limits

- Not run by Claude: anything touching Postgres, Redis, Ollama or GitHub, the Docker build, the CI file.
- A 7B local model gives uneven answers. The rest of the pipeline is built to cope (evidence check, second pass, "Needs a look") but it cannot make a weak model strong.
- The re-check treats "the flagged line is gone" as fixed unless the function around it is still in the diff (then the AI decides). A fix that moves the problem to another line would be missed. That is the price of no extra AI calls.
- v1 has one user. No login screen: set `API_TOKEN` on any server that is reachable from the internet.
