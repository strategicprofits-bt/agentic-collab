#!/usr/bin/env bash
# Wrapper for launchd — waits for Docker Desktop, then runs start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="/tmp/agentic-collab-launchd.log"

log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

log "Waiting for Docker Desktop..."
MAX=120
WAITED=0
while [ $WAITED -lt $MAX ]; do
  if docker info &>/dev/null; then
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done

if [ $WAITED -ge $MAX ]; then
  log "Docker not ready after ${MAX}s — aborting"
  exit 1
fi

log "Docker ready, running start.sh"
cd "$SCRIPT_DIR"
bash start.sh >> "$LOG" 2>&1
log "start.sh finished (exit $?)"

# Start Telegram bridge if not already running
AGENT_TEAM_DIR="/Users/benthole/Development/agent-team"
if [ -f "$AGENT_TEAM_DIR/lib/telegram_bridge.py" ]; then
  if ! tmux has-session -t telegram-bridge 2>/dev/null; then
    tmux new-session -d -s telegram-bridge -c "$AGENT_TEAM_DIR" \
      "direnv exec $AGENT_TEAM_DIR python3 lib/telegram_bridge.py"
    log "Telegram bridge started in tmux session"
  else
    log "Telegram bridge already running"
  fi
fi
