# GAP-026 Load-Spike Root-Cause & Remediation (T0)

Status: **reap permanently closed** (GAP-026 Stage 1–3 + fast-follows, deployed 2026-07-29). This
document covers the **residual**: fleet-wide **false** `proxy_disconnected` / `session_death_alert`
bursts under host-load spikes. Severity reframed **SEV1 context-loss → SEV3 false-alert/observability**.

## Why it is now SEV3, not SEV1

On 2026-08-03 00:04–00:10 UTC there was a fresh episode: **49 `proxy_disconnected` + 21 false
`session_death_alert_sent`**, but **14 `self_healed` and 0 `killed`**. The proxy process was alive
continuously (never restarted). So the cannot-reap guarantee held live under a real spike — nobody
was reaped, no context lost. The remaining harm is **alert noise + churn** — which still matters
because the false alerts are the trigger for agent-panic-paging (a 21-false-alert burst is what
paged the operator previously). Killing the noise (T1) removes that panic-page root.

## Mechanism

The orchestrator is a single Node process; **all `node:sqlite` DB access is synchronous on one
event loop**. The proxy heartbeats every 15s; `staleProxyTimer` (30s) marks a proxy dead when
`last_heartbeat > 45s` (`listStaleProxies(45)`), then flips **every** agent on it to `failed`,
logs `proxy_disconnected`, and fires `session_death_alert`. 45s = only 3 missed heartbeats, with
**no grace/debounce for late-vs-gone**. Under a host-load spike the synchronous stalls on the shared
loop get pathologically slow (disk-I/O wait), pushing heartbeat processing past 45s → fleet-wide
false-fail. The heartbeat handler itself is cheap (indexed UPDATE); it is starved by *other*
synchronous work on the same loop.

## The "second event-loop-blocking path" is a CLASS, not another execSync

The 2026-07-15 file-browse `execSync` fix is confirmed live (`proxy/main.ts` `exec` case is async).
The remaining blockers are synchronous DB + synchronous fs on the shared loop, amplified under load:

1. **Synchronous SQLite + `busy_timeout=5000`, no WAL-checkpoint tuning** (`database.ts:38-39`).
   Lock contention spin-blocks the loop up to 5s; auto-checkpoints run synchronously and scale with
   WAL/disk latency. Continuous write pressure from `recordTokenSnapshot` (every active-agent poll)
   + `logEvent` on every transition. Most directly load-correlated.
2. **`persona-watch` every 5s** (`main.ts` ~463): unconditional `readdirSync` + per-file `statSync`
   on a Docker **bind mount** — slow under host disk contention, competing with heartbeat every 5s.
3. **`getDashboardThreads()` / `searchMessages()`** (`database.ts:582/603`): unbounded full-table
   scan + `JSON.stringify` of all `dashboard_messages`, with `ORDER BY created_at` and **no index**
   on `created_at`. Dashboard-poll triggered.

## Compounding find: a 344 MB DB that is 91% dead events

The live `orchestrator.db` is **344 MB / ~1.5M `events` rows**, of which **1,361,693 (91%) are
`idle_timeout_exceeded`** — a firehose whose emitter has since been **removed from source** (0 rows
written in 30 days). There is **no events-retention job** (`archiveOldCompleted`/`pruneTokenSnapshots`
cover only projects + token snapshots). This dead-row bloat makes *every* synchronous DB op
(checkpoint, scan, backup) slower — it worsens all three culprits above. This is root-cause beyond
the symptom and is what makes T0 high-leverage.

Note: the three source event-**reads** (`database.ts:557/563/1383`) are all agent-scoped and covered
by `idx_events_agent(agent_name, created_at)` (~0.2 ms), so events reads are **not** a blocking path.
A bare-time `WHERE created_at > ?` scan measures **~2.7 s** (full scan + temp b-tree) but **no source
query uses that shape** — latent, not live. The events table is a **write/bloat** problem, not a
read-scan problem.

## Metric note — flagged, not asserted

The reported "65→161 climbing false-positive ceiling" is **not reproducible as a climbing count**:
`session_death_alert_sent` is **episodic**, not monotonic (~20–22 on incident days 07-14/25/28 and
08-03; 1–5 on quiet days); `proxy_disconnected` likewise (49 on 08-03; 379/272/170 back in late
April). If "65→161" referred to host **load-avg peaks** across incidents that is consistent with
load-triggered starvation, but there are no historical load samples in the DB to confirm a climbing
*ceiling*. Recorded as flagged-not-asserted so nobody inherits an unconfirmed trend.

## Remediation tiers (DrRobby-approved 2026-08-03)

- **T0 (this change + gated ops cleanup)** — cheap, high-leverage, shrinks the blast radius of all
  three culprits. Each Brienne+Roz gated → merge-auth.
- **T1** — proxy-disconnect **grace/debounce**: a late heartbeat triggers a re-check before
  fleet-failing. Directly kills the false-alert noise. Detection-side only; must not touch the
  cannot-reap guarantee. Gate criterion: adversarial **both directions** — live-but-slow proxy is
  NOT false-failed, AND a genuinely-dead proxy IS still detected after the grace window.
- **T2 (follow-up)** — make the amplifiers non-blocking: `persona-watch` → async/event-driven;
  bound + index the dashboard scans; WAL-checkpoint tuning; move token-snapshot writes off the hot
  loop.
- **T3 (deferred)** — shape the concurrent-activity burst that triggers the spike (health-poll
  capture concurrency cap under load, or host-load-awareness in `staleProxyTimer`).

## T0 — what this change ships

1. **Retention job** `Database.pruneChurnEvents(retentionDays=14)` — batched-by-construction DELETE
   of high-volume **churn** event types (`idle_detected`, `activity_detected`) older than the window.
   Each batch is its own small transaction, so a large backlog can never hold SQLite's single-writer
   lock long enough to stall heartbeat processing. Runs off a **6h maintenance tick** in `main.ts`,
   never the hot path. Audit classes (`spawned`, `killed`, `session_death_*`, `proxy_disconnected`,
   `suspended`, …) are **never** listed → kept indefinitely for incident forensics. `idle_timeout_exceeded`
   is intentionally excluded (dead emitter; owned by the one-time cleanup below).
2. **Index** `idx_dm_created ON dashboard_messages(created_at)` — supports the `ORDER BY created_at`
   in `getDashboardThreads`/`searchMessages`, removing the full-scan + temp-sort.
3. **One-time ops cleanup** (`scripts/gap026-t0-cleanup.cjs`, separately gated as a prod write) —
   clears the 1.36M dead `idle_timeout_exceeded` rows. **BACKUP-FIRST** (`VACUUM INTO` a dated
   backup), **scope-EXACT** (only `event='idle_timeout_exceeded'`; explicit inventory that no live
   class is in the predicate), **BATCHED** delete (never one giant write-lock), **COUNT-verified**
   before/after (idle_timeout_exceeded → 0; every other type unchanged; total drop == the deleted
   count), **reversible** via the backup. Dry-run by default; `--execute` only under gate + merge-auth.

### File-size reclamation (deferred)

The batched delete reclaims rows (query benefit) but not file bytes without `VACUUM`, which needs an
exclusive lock the live orchestrator holds. File-size reclamation is a **separate, explicitly-deferred**
maintenance-window op (stop orchestrator → `VACUUM`/backup-swap → restart), not bundled here.
