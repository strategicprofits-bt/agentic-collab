#!/usr/bin/env bash
set -euo pipefail

# Canonical agentic-collab deploy — the sanctioned way to ship orchestrator +
# proxy code, encoding the "deployed==merged, verified not assumed" discipline
# (GAP-056 deploy, 2026-08-10). It exists because the systemd unit's plain
# `docker compose up -d` reuses the baked image: without an explicit `build`
# first, current LOCAL src does NOT reach the running orchestrator (merge≠image
# ≠running). This script ALWAYS builds, recreates, and VERIFIES freshness.
#
# The unit now also carries `ExecStartPre=-docker compose build`, so a plain
# `systemctl restart agentic-orchestrator` is no longer a stale-ship footgun —
# but THIS script is still the sanctioned deploy path: it fails loud on a broken
# build (the unit's `-` prefix intentionally does not) and verifies end-to-end.
#
# Usage:
#   scripts/deploy.sh                 # deploy current checkout (orchestrator + proxy)
#   scripts/deploy.sh --ref <sha>     # refuse unless HEAD == <sha> (deploy-the-right-commit guard)
#   scripts/deploy.sh --no-proxy      # orchestrator only (skip proxy restart)
#   scripts/deploy.sh --dry-run       # print what it would do, touch nothing

REPO_DIR="/home/agent/agentic-collab"
ORCH_CONTAINER="agentic-collab-orchestrator-1"
STATUS_URL="http://localhost:3000/api/orchestrator/status"
HEALTH_TIMEOUT=120

REQUIRE_REF=""
DO_PROXY=1
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REQUIRE_REF="${2:-}"; shift 2 ;;
    --no-proxy) DO_PROXY=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

log() { echo "[deploy $(date -u +%H:%M:%SZ)] $*"; }
die() { echo "[deploy ERROR] $*" >&2; exit 1; }

cd "$REPO_DIR" || die "repo dir $REPO_DIR not found"

HEAD_SHA="$(git rev-parse HEAD)"
HEAD_SHORT="$(git rev-parse --short HEAD)"
log "repo=$REPO_DIR HEAD=$HEAD_SHORT branch=$(git rev-parse --abbrev-ref HEAD)"

# Deploy-the-right-commit guard.
if [[ -n "$REQUIRE_REF" ]]; then
  REQ_FULL="$(git rev-parse "$REQUIRE_REF" 2>/dev/null || true)"
  [[ "$REQ_FULL" == "$HEAD_SHA" ]] || die "HEAD ($HEAD_SHORT) != required ref $REQUIRE_REF ($REQ_FULL). Sync the checkout first."
  log "HEAD matches required ref $REQUIRE_REF ✓"
fi

if [[ "$DRY_RUN" == 1 ]]; then
  log "DRY-RUN: would 'docker compose build' → 'up -d' → wait-healthy → assert-recreated → $([[ $DO_PROXY == 1 ]] && echo 'restart proxy + verify' || echo 'skip proxy')"
  exit 0
fi

START_EPOCH="$(date +%s)"

# 1. Build from current src — FAIL LOUD (unlike the unit's tolerant `-` prefix).
log "building orchestrator image from current src…"
docker compose build || die "docker compose build FAILED — not deploying stale. Fix the build."

# 2. Recreate the container on the freshly built image.
log "recreating orchestrator container…"
docker compose up -d || die "docker compose up -d FAILED"

# 3. Wait for healthy.
log "waiting for orchestrator healthy (≤${HEALTH_TIMEOUT}s)…"
deadline=$(( START_EPOCH + HEALTH_TIMEOUT ))
until curl -sf "$STATUS_URL" >/dev/null 2>&1; do
  [[ "$(date +%s)" -lt "$deadline" ]] || die "orchestrator did NOT become healthy within ${HEALTH_TIMEOUT}s"
  sleep 2
done
log "orchestrator healthy: $(curl -sf "$STATUS_URL" 2>/dev/null)"

# 4. Freshness assertion — the container must have been RECREATED during this run
#    (guards the stale-image footgun: a no-op 'up -d' would leave StartedAt old).
STARTED_AT="$(docker inspect --format '{{.State.StartedAt}}' "$ORCH_CONTAINER")"
STARTED_EPOCH="$(date -u -d "$STARTED_AT" +%s 2>/dev/null || echo 0)"
IMG_ID="$(docker inspect --format '{{.Image}}' "$ORCH_CONTAINER")"
IMG_CREATED="$(docker image inspect "$IMG_ID" --format '{{.Created}}' 2>/dev/null || echo '?')"
if [[ "$STARTED_EPOCH" -ge "$START_EPOCH" ]]; then
  log "FRESH ✓ container recreated this run (StartedAt=$STARTED_AT, image $IMG_ID created=$IMG_CREATED)"
else
  die "STALE: container StartedAt=$STARTED_AT predates this deploy — 'up -d' did not recreate. Image likely unchanged/stale."
fi

# 5. Proxy (host-side; watcher/proxy src is run directly by systemd, so a restart
#    reloads it). KillMode=process → tmux server is NOT touched, agents not reaped.
if [[ "$DO_PROXY" == 1 ]]; then
  PROXY_RESTART_AT="$(date -u +%Y-%m-%d\ %H:%M:%S)"
  log "restarting proxy (KillMode=process, tmux-safe)…"
  sudo systemctl restart agentic-proxy.service || die "proxy restart failed"
  # Verify proxy came back + (best-effort) that the GAP-056 watcher armed.
  for _ in $(seq 1 20); do
    sleep 2
    if systemctl is-active --quiet agentic-proxy.service; then
      ARMED="$(journalctl -u agentic-proxy.service --since "$PROXY_RESTART_AT" --no-pager 2>/dev/null | grep -m1 'server-death watcher armed' || true)"
      [[ -n "$ARMED" ]] && { log "proxy active; watcher armed: ${ARMED##*: }"; break; }
    fi
  done
  systemctl is-active --quiet agentic-proxy.service || die "proxy not active after restart"
  log "proxy active ✓"
else
  log "skipping proxy restart (--no-proxy)"
fi

log "DEPLOY OK — HEAD=$HEAD_SHORT image=$IMG_ID (created $IMG_CREATED). deployed==current-src, verified."
