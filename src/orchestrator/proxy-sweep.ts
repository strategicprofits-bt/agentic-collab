import type { ProxyRegistration, AgentRecord } from '../shared/types.ts';

/**
 * GAP-026 T1 — proxy-disconnect bounded heartbeat-grace.
 *
 * Problem: the old sweep failed every agent on a proxy the instant its heartbeat aged past a single
 * threshold (45s = 3 missed heartbeats), with NO grace. Under a host-load spike the orchestrator's
 * own event loop stalls (GAP-026 T0), delaying heartbeat PROCESSING, so a live-but-slow proxy looks
 * dead → fleet-wide false proxy_disconnect + session_death_alert (the panic-page / queue-flood noise).
 *
 * Fix (DETECTION-only, zero touch to the kill/reap interlock): on staleness, enter a GRACE window
 * instead of failing. INVARIANTS:
 *   (1) BOUNDED — a genuinely non-heartbeating proxy is always failed once its heartbeat age exceeds
 *       failSeconds (= staleSeconds + grace); detection can never be deferred indefinitely.
 *   (2) DEATH AUTHORITY IS THE PUSH-HEARTBEAT PATH ONLY — a proxy is failed iff `last_heartbeat` age
 *       exceeds failSeconds. There is NO reverse-direction (orchestrator→proxy GET /health) pull
 *       check anywhere in this decision, so a proxy whose HTTP still answers but whose heartbeat-push
 *       is wedged STILL dies at failSeconds. Only a real push-heartbeat resets the age clock / clears
 *       death — nothing here advances or resets it, so pull-path liveness cannot leak back in.
 *
 * Adversarial trio the gate checks against this code:
 *   (a) live-but-slow  → heartbeat resumes within grace → drops out of `stale` → RECOVERED, not failed.
 *   (b) genuinely-dead → no heartbeat → age > failSeconds → FAILED.
 *   (c) http-alive-but-non-heartbeating → last_heartbeat stays old → age > failSeconds → FAILED
 *       (the HTTP server answering plays no role — invariant (2) by construction).
 */

export interface ProxySweepDeps {
  /** proxies whose `last_heartbeat` age exceeds the given threshold (seconds). */
  listStaleProxies: (thresholdSeconds: number) => ProxyRegistration[];
  removeProxy: (proxyId: string) => void;
  listAgents: () => AgentRecord[];
  isRunning: (agent: AgentRecord) => boolean;
  /** mark an agent failed + log proxy_disconnected. Owns the state/event types (kept out of this module). */
  failAgent: (agent: AgentRecord, proxyId: string) => void;
  log: (msg: string) => void;
}

export interface ProxySweepConfig {
  /** heartbeat age (s) at which a proxy is "stale" and ENTERS grace (does not fail). */
  staleSeconds: number;
  /** heartbeat age (s) at which a stale proxy is declared disconnected (= staleSeconds + grace). */
  failSeconds: number;
}

export interface ProxySweepResult {
  graced: string[];    // proxyIds newly entered grace this sweep (no fail, no alert)
  recovered: string[]; // proxyIds that resumed heartbeating within grace (no disconnect fired)
  failed: string[];    // proxyIds declared disconnected (heartbeat age past failSeconds)
}

/**
 * Run ONE proxy-liveness sweep. `graceState` is the caller-owned Set of proxyIds currently in grace;
 * it persists across sweeps so grace entry is logged once and recovery can be detected.
 */
export function sweepStaleProxies(
  deps: ProxySweepDeps,
  cfg: ProxySweepConfig,
  graceState: Set<string>,
): ProxySweepResult {
  const failing = deps.listStaleProxies(cfg.failSeconds);   // age > fail window → disconnected
  const failingIds = new Set(failing.map((p) => p.proxyId));
  const stale = deps.listStaleProxies(cfg.staleSeconds);    // age > stale window (superset of failing)
  const staleIds = new Set(stale.map((p) => p.proxyId));

  const result: ProxySweepResult = { graced: [], recovered: [], failed: [] };

  // GRACE: stale but not yet past the fail window. Do NOT remove/fail/alert — a live-but-slow proxy's
  // delayed heartbeat (the SAME push path) will land and drop it out of `stale` before it reaches fail.
  for (const proxy of stale) {
    if (failingIds.has(proxy.proxyId)) continue;
    if (!graceState.has(proxy.proxyId)) {
      graceState.add(proxy.proxyId);
      result.graced.push(proxy.proxyId);
      deps.log(`[proxy] Grace: ${proxy.proxyId} stale >${cfg.staleSeconds}s — holding for a heartbeat before failing (last: ${proxy.lastHeartbeat})`);
    }
  }

  // RECOVERY: previously graced but no longer stale → heartbeat resumed → clear, NO disconnect fired.
  for (const id of [...graceState]) {
    if (!staleIds.has(id) && !failingIds.has(id)) {
      graceState.delete(id);
      result.recovered.push(id);
      deps.log(`[proxy] Grace recovered: ${id} resumed heartbeating within grace — no disconnect fired`);
    }
  }

  // FAIL: age beyond the full grace window → genuinely non-heartbeating. Death authority is
  // heartbeat-absence over failSeconds (invariant 2) — no pull/HTTP check involved.
  for (const proxy of failing) {
    graceState.delete(proxy.proxyId);
    result.failed.push(proxy.proxyId);
    deps.log(`[proxy] Removing stale proxy: ${proxy.proxyId} (last heartbeat: ${proxy.lastHeartbeat}, exceeded ${cfg.failSeconds}s)`);
    deps.removeProxy(proxy.proxyId);
    for (const agent of deps.listAgents().filter((a) => a.proxyId === proxy.proxyId)) {
      if (deps.isRunning(agent)) deps.failAgent(agent, proxy.proxyId);
    }
  }

  return result;
}
