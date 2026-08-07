# GAP-056: tmux Server-Death Observability — Scoped Design

**Owner:** Gilfoyle · **Status:** for Brienne+Roz gate · **Priority:** re-prioritized-important (not emergency) · **Date:** 2026-08-07

## Problem

On 2026-08-07 01:56Z the host's tmux server died and recreated, reaping **20 of 21 agents** (fresh-sid respawn, context lost; only CoachBeard retained continuity). Two failures made it worse than it had to be:

1. **Nobody knew for ~1 hour.** The death was reconstructed from DB/socket forensics long after the fact.
2. **The origin is unattributable** on this host — no coredumpctl, and auditd only instruments `systemctl` execve, so a `kill-server`/crash/OOM of the tmux server leaves no trace.

The self-heal also was NOT clean (a reaped agent re-orients from STATE.md and *reads* coherent, masking real context loss — see the pane-coherence≠continuity finding).

## Goal

Make the **next** tmux-server death **attributable in seconds, not an hour** — detected, context-snapshotted at death time, and actively alerted — without gold-plating.

## Non-goals

- Preventing server death (that's the A-origin root-cause, Chloe owns).
- Full "who sent the kill signal" attribution (needs the host `acct` COMPANION below).
- Any change to the tmux delivery/paste path.

## Architecture (corrected)

The tmux server is **host-side, local to the proxy**. The orchestrator health-monitor runs in **Docker** and cannot see the host tmux PID or `dmesg` the host. So the watcher lives **proxy-side**; the orchestrator handles logging + alerting.

### PRIMARY (in-repo, gated) — ships now

**Proxy (host):** piggyback on the existing 15s heartbeat (`src/proxy/main.ts` `heartbeat`, no new timer):
- Read tmux server identity: PID via `tmux display-message -p '#{pid}'` + socket inode via `stat` on the socket path.
- Track last-seen identity. On **change** (PID or inode differs from a non-null baseline) → a server death+recreate occurred.
- Run a **bounded, best-effort host forensic snapshot** (each probe timeout-bounded, size-capped, **failures swallowed** so it can never wedge the heartbeat).

**Forensic-field provisioning matrix — what works today vs what the COMPANION unlocks (for Ben):**

| Field | At proxy uid 1000 **today** | Needs COMPANION (Ben: sudo/`acct`) |
|---|---|---|
| tmux server PID (`display-message -p '#{pid}'`) + socket inode (`stat`) | ✅ detection works | — |
| death timestamp + old/new PID | ✅ | — |
| `free -m` (memory pressure → **OOM hint only**) | ✅ | — |
| `who` (active sessions at death) | ✅ | — |
| `last -n 20` (recent logins; wtmp usually world-readable) | ✅ | — |
| `dmesg \| tail` (kernel **OOM-killer** lines = definitive OOM evidence) | ⚠️ EPERM if `dmesg_restrict=1` (common default) | ✅ **needs sudo** |
| `lastcomm tmux` (`AXSIG` killed-by-signal / `ACORE` core-dump = **crash-vs-kill-vs-OOM discriminator**) | ❌ not available | ✅ **needs `acct`** |

Net for Ben: uid1000 gets **detection + timing + an OOM *hint* (free -m)**. His provisioning unlocks the two fields that turn a hint into an **answer** — `dmesg` (was it the kernel OOM-killer?) and `acct`/`lastcomm` (killed-by-signal vs crash vs clean). Without COMPANION, PRIMARY still detects+alerts in ≤15s; it just can't fully attribute *how* the server died.
- Report a `tmux_server_died` payload up to the orchestrator as an **additive optional field on the existing heartbeat** (old PID/inode, new PID/inode, detected-at ts, snapshot). No new endpoint; if the orchestrator ignores the field, behavior is unchanged.

**Orchestrator:** in the heartbeat handler, on a `tmux_server_died` payload:
- `db.logEvent('tmux_server_died', …)` with the full snapshot.
- **[ADD-1, folded in — trivial]** Real-time alert to **Chloe + Sydney** via the existing `enqueueMessage` path (same mechanism the circuit-breaker uses to page DrRobby). Dedupe on (proxyId, new-PID) so one death = one alert.

Detection latency: **≤15s** (heartbeat cadence), vs ~1hr tonight.

### FAST-FOLLOW (in-repo, gated) — ships right after PRIMARY

**[ADD-2 — more than trivial, so not a PRIMARY blocker per Robby]** Blast-radius signal: tag each recovery **fresh-sid (context-lost)** vs **resumed** at the `lifecycle.ts:1339` decision point; maintain a windowed counter; when fresh-sid recoveries in the recovery window cross a threshold, emit a **scale alert** ("N/M agents reaped in T"). Orchestrator-side, separable from the proxy watcher. Turns "know the reap scale in seconds" into reality.

### COMPANION (host-level, NEEDS BEN) — bundled into Robby's pending Ben ask

Install `acct` + enable `accton` + logrotate. Process-accounting `AC_FLAG` carries `AXSIG` (killed-by-signal) + `ACORE` (dumped-core), so `lastcomm tmux` discriminates **crash vs kill vs OOM** — the who/how the unprivileged watcher can't get. Not shippable through code gates alone.

### DEFERRED

auditd kill-syscall rule — victim/argv-blind, noisy. Only if PRIMARY+COMPANION prove insufficient.

## Safety (for Brienne)

- **Read-only** host probes (`display-message`, `stat`, `free`, `who`, `last`, `dmesg`). No writes, no new privileged ops (no sudo added; `dmesg` best-effort).
- Snapshot is **bounded + failure-swallowed** — cannot wedge or slow the heartbeat, cannot crash the proxy.
- Report is **additive** to the heartbeat payload — zero behavior change if unread.
- **No change** to the tmux delivery/paste/session-create paths. The watcher cannot kill or disrupt sessions.
- Worst-case misfire = a **spurious alert** (dedupe bounds it) — annoyance, not harm. It observes; it does not act.

## Testing (for Roz)

- Unit-test server-identity change detection via an injected exec seam (codebase already uses IO seams): baseline (no prior → no event), no-change, PID-change, inode-change, death→recreate.
- Unit-test orchestrator event handling: logEvent emitted, alert enqueued to Chloe+Sydney, **dedupe** (same PID → one alert).
- Snapshot failure paths: each probe failing → snapshot still returns, heartbeat unaffected.
- No live-fleet test — this is observation-only (and the race-repro-live-hazard rule forbids exercising failure against the live substrate).

## Rollout

Worktree + PR → `npx tsc --noEmit` + `node --test` → Brienne (safety) + Roz (QA) gates → DrRobby push approval → merge → orchestrator restart to deploy (running code needs restart). COMPANION tracked separately on Ben.
