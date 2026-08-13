# GAP-056 ADD-2 — Recovery blast-radius scale tracker

## What it is
A shadow-mode counter that measures the **scale** of context-lost reaps in a trailing
window, so a mass reap (the 2026-08-07 20-of-21 event) is visible in ~seconds instead of
reconstructed ~an hour late. PRIMARY (the tmux-server-death watcher) already tells you *a*
reap happened in ~15s; ADD-2 tells you *how many*.

## The signal (why session-id, not "recovered")
A context-lost reap = `recoverAgent` fresh-respawns an agent whose **prior sessionId was
non-null** and rotated to a **new** sessionId. Keyed **strictly on sid-continuity** — never a
"recovered" label or pane-alive, because a reaped agent re-orients from `STATE.md` and *reads
coherent*; only a rotated DB `sessionId` proves the context was actually lost.

- `priorSid = phase1.current.currentSessionId` — survives the `failed → spawning` transition
  (the failure path sets only `failedAt`/`failureReason`; the sole `currentSessionId = null`
  site is the *suspend* path, not recovery).
- `newSid = generatedSessionId` (the fresh session minted in recovery).
- `isFreshSid = priorSid !== null && newSid !== null && newSid !== priorSid`.

`prior-null` (a first spawn from no session) and resumes (`newSid === priorSid`) are **not**
counted — they aren't context loss.

## Shadow mode (default) — measure before paging
`RECOVERY_SCALE_PAGING_ENABLED = false`. Every fresh-sid reap emits a
`recovery_scale_fresh_sid` event (with `windowCount`, `activeAgents`) — the **events table
is the baseline-measurement substrate**. It does **not** page. During shadow, a real
08-07-class reap still fires PRIMARY (`tmux_server_died`), so nothing is exposed by waiting.

The threshold is a **hypothesis** until measured against real fresh-sid churn:
`hypothesisThreshold(active) = max(3, ceil(0.20 × active))`. The absolute floor 3 avoids
ratio false-alarms on a tiny active set + normal 1–2 reap churn; the 20% ratio scales to
fleet size and catches partial-fleet reaps.

**Enabling paging** = flip `RECOVERY_SCALE_PAGING_ENABLED = true` + set a measured
`RECOVERY_SCALE_THRESHOLD` (constant + flag, not a re-gate). When enabled, crossing the
threshold emits one `recovery_scale_alert` per mass-reap episode (deduped; resets when the
window drains).

## Wiring
- One stateful `RecoveryScaleTracker` instance (holds the trailing window) is created in
  `main.ts` and shared by **every** recovery path:
  - health-monitor auto-recover (`makeLifecycleCtx()`),
  - routes API recover (`lifecycleCtx`).
- `recoverAgent` calls `recordRecoveryScale(ctx, name, priorSid, newSid)` **only on a
  successful finalize**. It is wrapped so it can **never** throw into the lifecycle path —
  observability must not break recovery.
- Time + active-count are injected into `record()` (no clock read inside), so the tracker is
  deterministically unit-testable (11 tests).

## Design constraints honored
- **Deterministic**: no `Date.now()`/`Math.random()` inside the tracker — injected.
- **Aggregate-to-one**: one page per mass-reap episode, not one per reaped agent.
- **Fail-open observability**: absent tracker → recovery unchanged; record throws → caught + logged.
- **Measure-don't-reason**: paging gated OFF until the hypothesis threshold is validated
  against the shadow baseline.
