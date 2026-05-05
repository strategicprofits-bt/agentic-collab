#!/usr/bin/env bash
# Daily audit: every persona in persistent-agents/ must have a current backup
# in personas-backup/. Stale = source mtime > backup mtime. Missing = no backup.
# Alerts ChloeOBrian via `collab send` when gaps are found.
#
# Origin: 2026-05-04 outage post-mortem — DrRobby request after Goldratt was
# nearly lost to a missing backup. See agentic-collab CLAUDE.md memory.
set -euo pipefail

SOURCE_DIR="/Users/benthole/Development/sp/agentic-collab/persistent-agents"
BACKUP_DIR="/Users/benthole/Development/agent-team/personas-backup"
COLLAB="/Users/benthole/Development/sp/agentic-collab/bin/collab"
LOG="/tmp/persona-backup-audit.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

if [ ! -d "$SOURCE_DIR" ]; then
  log "ERROR: source dir missing: $SOURCE_DIR"
  exit 1
fi
if [ ! -d "$BACKUP_DIR" ]; then
  log "ERROR: backup dir missing: $BACKUP_DIR"
  exit 1
fi

missing=()
stale=()

for src in "$SOURCE_DIR"/*.md; do
  [ -e "$src" ] || continue
  name=$(basename "$src")
  bak="$BACKUP_DIR/$name"
  if [ ! -e "$bak" ]; then
    missing+=("$name")
  elif [ "$src" -nt "$bak" ]; then
    src_mtime=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$src")
    bak_mtime=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$bak")
    stale+=("$name (source $src_mtime > backup $bak_mtime)")
  fi
done

if [ ${#missing[@]} -eq 0 ] && [ ${#stale[@]} -eq 0 ]; then
  log "OK — all personas have current backups"
  exit 0
fi

msg="Persona backup audit — gaps detected ($(date '+%Y-%m-%d')).

"
if [ ${#missing[@]} -gt 0 ]; then
  msg+="MISSING backups (${#missing[@]}):
"
  for m in "${missing[@]}"; do msg+="  - $m
"; done
  msg+="
"
fi
if [ ${#stale[@]} -gt 0 ]; then
  msg+="STALE backups — source newer than backup (${#stale[@]}):
"
  for s in "${stale[@]}"; do msg+="  - $s
"; done
  msg+="
"
fi
msg+="Source: $SOURCE_DIR
Backup: $BACKUP_DIR
Fix: cp <source>.md $BACKUP_DIR/ for each gap, then verify."

log "ALERT: ${#missing[@]} missing, ${#stale[@]} stale — sending to ChloeOBrian"
"$COLLAB" send ChloeOBrian --topic persona-backup-audit "$msg" >> "$LOG" 2>&1
