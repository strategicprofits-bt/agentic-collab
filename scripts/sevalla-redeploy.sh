#!/usr/bin/env bash
set -euo pipefail

# Redeploy sp-marketing (go-strategicprofits) on Sevalla.
# Uses is_restart=true to redeploy the last successful build artifact
# without rebuilding — correct for deploy-queue stalls.
#
# Requires SEVALLA_API_KEY in environment (loaded via Doppler/direnv
# from the sp project).
#
# Usage:
#   ./scripts/sevalla-redeploy.sh            # restart last successful build
#   ./scripts/sevalla-redeploy.sh --rebuild   # full rebuild from master

APP_ID="515f8a57-8b1d-450e-8ba1-e719746620d3"
API_BASE="https://api.sevalla.com/v3"

if [[ -z "${SEVALLA_API_KEY:-}" ]]; then
  echo "ERROR: SEVALLA_API_KEY not set. Run from a direnv-enabled sp directory or set manually." >&2
  exit 1
fi

IS_RESTART=true
if [[ "${1:-}" == "--rebuild" ]]; then
  IS_RESTART=false
fi

if $IS_RESTART; then
  BODY='{"is_restart":true}'
  MODE="restart (last successful artifact)"
else
  BODY='{"branch":"master"}'
  MODE="full rebuild from master"
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Triggering Sevalla deploy: ${MODE}"

RESPONSE=$(curl -sf -X POST \
  "${API_BASE}/applications/${APP_ID}/deployments" \
  -H "Authorization: Bearer ${SEVALLA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${BODY}")

DEPLOY_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
STATUS=$(echo "$RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Deploy triggered — id: ${DEPLOY_ID}, status: ${STATUS}"
echo "chore: retrigger Sevalla auto-deploy [${MODE}]"
