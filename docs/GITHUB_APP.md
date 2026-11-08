# Chunk 2: create the GitHub App (click by click)

A GitHub App is how the tool receives webhooks and gets a short-lived token for ONE installation (your repos only). Prefer this over a personal access token: the permissions are narrow and the token expires in an hour.

Names of buttons can shift slightly. If something differs, send me a screenshot.

## A. A public URL for your laptop (local testing)

GitHub cannot reach `localhost`. Use smee.io, a free relay that forwards webhooks to your machine:

1. Open https://smee.io and click **Start a new channel**. Copy the channel URL (like `https://smee.io/AbCdEf123`).
2. In a new terminal: `npx smee-client --url https://smee.io/AbCdEf123 --target http://localhost:3000/webhooks/github`
   Leave it running while you test.

(On a real server you skip this and use your own https URL, see `DEPLOY.md`.)

## B. Create the App

GitHub -> your profile picture -> **Settings** -> bottom of the left menu **Developer settings** -> **GitHub Apps** -> **New GitHub App**.

| Field | Value |
|---|---|
| GitHub App name | `pr-quality-gate-<yourname>` (must be unique) |
| Homepage URL | any URL, for example your repo URL |
| Webhook -> Active | checked |
| Webhook URL | the smee channel URL (local) or `https://your-domain/webhooks/github` (server) |
| Webhook secret | a long random string. Put the SAME value in `api/.env` as `GITHUB_WEBHOOK_SECRET` |

**Repository permissions** (leave everything else on "No access"):

| Permission | Access | Why |
|---|---|---|
| Pull requests | Read-only | list the changed files and their diffs |
| Checks | Read-only | read your CI results for the report |
| Commit statuses | Read and write | post "PR Quality Gate" (Ready to merge or not) |
| Metadata | Read-only | added automatically |

**Subscribe to events:** tick **Pull request**.

**Where can this GitHub App be installed?** -> **Only on this account**.

Click **Create GitHub App**.

## C. Get the two secrets

1. On the App page, copy the **App ID** (a number).
2. Scroll to **Private keys** -> **Generate a private key**. A `.pem` file downloads.
3. Move it into the project: `api/secrets/github-app.pem` (create the folder). `*.pem` and `/secrets` are in `.gitignore`. Never commit this file or paste it into chat.
4. Add to `api/.env`:

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app.pem
GITHUB_WEBHOOK_SECRET=<the same string you typed in the webhook secret field>
```

Restart `npm run start:dev`.

## D. Install it on your repo

App page -> **Install App** (left menu) -> your account -> **Only select repositories** -> choose the repo -> **Install**.

## E. Test

1. Make sure Postgres, Redis, Ollama, the API and smee are running.
2. In the repo, create a branch, change a file, push, open a pull request.
3. On the App page -> **Advanced** tab you can see each webhook delivery and its response code (should be 200). "Redeliver" resends one.
4. In your terminal you should see the run start. In http://localhost:3000 the PR appears as "Reviewing...", then findings.
5. On the GitHub PR page, under the checks, you should see **PR Quality Gate** (pending, then success or failure).

If the delivery shows 401: the secret in `.env` differs from the one in GitHub.
If the run fails with "GITHUB_APP_ID" missing: `.env` was not reloaded, restart the server.
If the status never appears: check the App has **Commit statuses: Read and write**, and accept the new permission request GitHub sends you after you change permissions (Install App -> Configure).

## F. Make the gate count (branch protection)

Repo -> **Settings** -> **Branches** -> add a rule for `main` -> tick **Require status checks to pass before merging** -> search for **PR Quality Gate** (it only appears after the first status was posted) -> save.
Now the merge button stays blocked until you have triaged everything and all Accepted tickets are fixed. In v1 you are the only reviewer; later your RM/PM can approve in GitHub as usual (Option A).
