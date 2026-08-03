# GAP-026 T1 — Proxy-Disconnect Bounded Heartbeat-Grace

The second GAP-026 residual fix (T0 closed the DB-load blast radius; T1 kills the recurring **false**
`proxy_disconnect` → `session_death_alert` noise, which is the panic-page + queue-flood trigger — not
cosmetic). DETECTION-only; the kill/reap interlock is untouched (cannot-reap stays).

## Problem

The old sweep (`main.ts` `staleProxyTimer`) failed **every** agent on a proxy the instant its
`last_heartbeat` aged past a single 45s threshold, with no grace. Under a host-load spike the
orchestrator's own event loop stalls (GAP-026 T0), delaying heartbeat *processing*, so a live-but-slow
proxy looks dead → `removeProxy` → its agents lose their proxy → captures fail → `health_check_failed`
→ marked `failed` → `session_death_alert`. On 2026-08-03 this fired fleet-wide 3× in ~6 min while the
proxy process never restarted (0 kills — cannot-reap held; the harm was pure false-alert noise).

## Design (bounded heartbeat-grace)

On staleness, a proxy enters a **grace** window instead of failing. Implemented as a pure,
dependency-injected sweep (`proxy-sweep.ts` `sweepStaleProxies`) called from the 30s `staleProxyTimer`:

- `PROXY_STALE_S = 45` (3 missed heartbeats) → **stale**, enters grace (no fail, no alert).
- `PROXY_GRACE_S = 45` (env `PROXY_GRACE_S`) → grace window.
- `PROXY_FAIL_S = 90` (= stale + grace, 6 missed heartbeats) → **disconnected** (existing fail path).

A proxy stale in `[45, 90)`s is held; a real push-heartbeat arriving in that window drops it out of
`stale` → **recovered**, no disconnect ever fired. A proxy still non-heartbeating past 90s → failed.

## Invariants (verify against `proxy-sweep.ts`)

1. **BOUNDED.** A genuinely non-heartbeating proxy is always failed once heartbeat age exceeds
   `PROXY_FAIL_S`; detection is never deferred indefinitely. (Timer granularity: the 30s sweep means
   the effective fail moment is within `[90, 120]`s — same granularity the old 45s threshold already had.)
2. **DEATH AUTHORITY = PUSH-HEARTBEAT PATH ONLY.** A proxy is failed **iff** `last_heartbeat` age >
   `PROXY_FAIL_S` (`listStaleProxies`, which reads only `last_heartbeat`). There is **no**
   reverse-direction orchestrator→proxy `GET /health` pull check anywhere in the decision. The earlier
   design considered a confirm-alive `/health` accelerator; it was **deleted** because it could neither
   safely declare alive-early (would extend life without a real heartbeat = keep a heartbeat-wedged
   proxy alive forever on the pull path) nor dead-early (pull-path false-death / path-asymmetry blind
   spot). With no pull path, only a real push-heartbeat resets the age clock; nothing here advances or
   resets it, so pull-path liveness cannot leak back in. The sweep's `ProxySweepDeps` has **no**
   health/ping/http dependency — asserted structurally in the test.

## Adversarial trio (hand to Brienne + Roz; covered by `proxy-sweep.test.ts`)

- **(a) live-but-slow** → heartbeat resumes within grace → drops out of `stale` → **recovered, never
  failed**, no agent marked failed during grace. (test: grace-then-recovery)
- **(b) genuinely-dead** → no heartbeat → age > `PROXY_FAIL_S` → **failed** (proxy removed + agents
  failed). (test: genuinely-dead; grace→fail transition)
- **(c) http-alive-but-non-heartbeating** → `last_heartbeat` stays old → age > `PROXY_FAIL_S` →
  **still failed** (the HTTP server answering plays no role — invariant 2 by construction). (test:
  asserts no pull/health dep exists + age>fail fails unconditionally)

## Scope boundary (gate to weigh — NOT silently assumed away)

The false-alert on 2026-08-03 cascaded from `removeProxy` → captures fail (no proxy) → mark-failed →
alert. T1 defers `removeProxy` during grace, breaking that cascade. There is a *second* path — the
health-monitor's per-agent `health_check_failed` (capturePaneOutput, `health-monitor.ts:~574`) can
mark an agent failed if its captures to a slow proxy time out **independently** of `removeProxy`.
Mitigating fact: `proxyDispatch` allows 15s per attempt + retries, so a typical event-loop stall
(seconds) succeeds late → no independent `health_check_failed`; the dominant path is the
`removeProxy` cascade this fixes. **Open item for the gate:** if a proxy stall exceeds ~15s per
capture, the health-monitor could still fire an agent-level alert during proxy grace. If observed,
the fast-follow (T1.1) is to make the health-monitor treat a capture failure as proxy-transient (not
agent-death) while the agent's proxy is in grace. Flagged, not bundled — T1 scopes to the
`staleProxyTimer` grace DrRobby framed.

## Config / tuning

`PROXY_GRACE_S` (default 45s) trades false-positive suppression vs dead-detection latency. 45s spares
stalls up to 90s total; genuine death detected in `[90, 120]`s. Cannot-reap is live, so a dead
proxy's agents are protected from reap throughout the interim regardless — the extra latency costs
only a delayed `failed` mark, no agent harm. Tune via env without a code change.
