# Fix A — Kill-path liveness interlock (GAP-026 reap fix)

**Approved by DrRobby (top priority, expedited). Gates: same-SHA Brienne + Roz, merge-auth DrRobby.**

## Problem
2026-07-28 burst: a transient proxy restart → orchestrator correctly self-healed 21 alive
agents, but the host `stuck_input_watchdog.py` daemon force-freshed (`/kill`+`/spawn`, NO
liveness check) **10 always-on agents that were alive**, costing conversation context on 10
incl 4 core-team + the fix-builder. The reap path had no gate: a caller that *believes* an
agent is dead can kill a live session on a false signal.

## Fix
A liveness interlock at the **recovery/force-fresh kill primitives**: before killing, re-check
`has_session`; if the session is **alive**, refuse the kill (self-heal instead) unless the caller
passes an explicit `force: true`. This makes reaping a live agent impossible for **every** caller
(the Python daemon via `/kill`, `batch-force-fresh.sh`, the orchestrator stranded-watchdog and
the auto-recover breaker via `recoverAgent`) without needing to change any caller.

### Shared helper (lifecycle.ts)
```
async function killSessionGuarded(ctx, proxyId, sessionName, opts?: {force?: boolean}):
    Promise<{killed: boolean; alive: boolean}>
  - if !force: dispatch has_session; if ok && data===true → return {killed:false, alive:true}
  - else dispatch kill_session (best-effort) → return {killed:true, alive:false}
```

### Guarded sites (recovery/force-fresh ONLY)
| line | fn | change |
|------|----|--------|
| 1333 | `killAgent` | use guarded kill; if alive && !force → do NOT suspend, do NOT log `killed`; log `kill_skipped_alive`, ensure state=active (self-heal), return unchanged agent |
| 1172 | `recoverAgent` | use guarded kill; if alive && !force → ABORT recover, self-heal (state→active), log `recover_skipped_alive`, return (no respawn) |

### Wiring
- `POST /api/agents/:name/kill` (routes.ts:1396) reads `force` from body → passes to `killAgent`.
  Currently routed via `lifecycleRoute(killAgent,...)`; adjust to read+thread `force`.
- `killAgent(ctx, name, opts?: {force?: boolean})` signature extended (default force=false).
- `recoverAgent`: force=false by default (recovery should self-heal a live session, not reap it).

### NOT guarded (deliberate kills — leave as-is)
- `suspendAgent`-family / `destroyAgent` (894) / `reloadAgent` (1018) / `startWatchdog` cleanup (463):
  these kill a session ON PURPOSE (suspend, destroy, reload, timed-out-spawn cleanup). Not reaps.

## Tests (Roz-gated — write first, TDD)
1. killAgent on a LIVE session (has_session=true), no force → NOT killed, state stays active, `kill_skipped_alive` logged, no `killed` event.
2. killAgent on a DEAD session (has_session=false) → killed, state=suspended, `killed` logged (unchanged behavior).
3. killAgent force:true on a LIVE session → killed (override works).
4. recoverAgent when has_session=true → self-heals, no respawn, `recover_skipped_alive`.
5. recoverAgent when has_session=false → normal kill+respawn (unchanged).
6. POST /kill threads force from body.
7. Regression: suspend/destroy/reload still kill unconditionally.

## Verify
- `npx tsc --noEmit`
- `node --test --test-timeout=90000 'src/orchestrator/lifecycle.test.ts' 'src/orchestrator/routes.test.ts'`
- then full suite.

## Sequencing
A (this) → 1b-guard (stranded-watchdog.ts, same repo, adjacent) → B (proxy-disconnect debounce).
Host `stuck_input_watchdog.py` daemon stays STOPPED until A is deployed.
