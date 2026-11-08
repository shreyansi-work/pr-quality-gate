#!/usr/bin/env bash
# Sends a signed fake "pull_request" webhook to your local server.
# Usage:  ./scripts/send-webhook.sh [sha] [secret]      (secret defaults to GITHUB_WEBHOOK_SECRET in .env, then "dev-secret")
set -euo pipefail
cd "$(dirname "$0")/.."
SHA="${1:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
SECRET="${2:-}"
if [ -z "$SECRET" ] && [ -f .env ]; then SECRET="$(grep -E '^GITHUB_WEBHOOK_SECRET=' .env | cut -d= -f2- || true)"; fi
SECRET="${SECRET:-change-me-local-webhook-secret}"
URL="${URL:-http://localhost:3000/webhooks/github}"
ACTION="${ACTION:-synchronize}"   # opened | synchronize | reopened | closed
MERGED="${MERGED:-false}"         # for ACTION=closed: true = merged, false = closed without merging
REPO_ID="${REPO_ID:-999}"
FULL_NAME="${FULL_NAME:-tester/fake-repo}"
NUMBER="${NUMBER:-42}"
if [ "$ACTION" = "closed" ]; then STATE="closed"; else STATE="open"; fi

BODY=$(cat <<JSON
{"action":"$ACTION","pull_request":{"number":$NUMBER,"title":"Fake PR","state":"$STATE","merged":$MERGED,"user":{"login":"tester"},"head":{"ref":"feat/x","sha":"$SHA"}},"repository":{"id":$REPO_ID,"full_name":"$FULL_NAME"}}
JSON
)
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: ${BADSIG:-$SIG}" \
  --data "$BODY"
