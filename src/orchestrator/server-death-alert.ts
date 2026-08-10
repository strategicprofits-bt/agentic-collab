/**
 * GAP-056: orchestrator-side handling of a proxy's tmux server-death report.
 *
 * The proxy attaches a `tmuxServerDied` payload to the heartbeat on the one
 * cycle after it detects a server identity change. Here we (1) log a durable
 * `tmux_server_died` event with the full snapshot, and (2) page the monitor
 * agents (Chloe + Sydney) via the same enqueue+notify path the circuit-breaker
 * uses. Deduped on (proxyId, newPid) so one death = one alert even if the
 * report arrives on more than one heartbeat.
 */

import type { TmuxServerDeathReport } from '../shared/types.ts';

/** Agents paged on a server death. Chloe owns the A-origin root-cause; Sydney sev3. */
export const SERVER_DEATH_ALERT_TARGETS = ['ChloeOBrian', 'SydneyAdamu'] as const;

/** Injected side-effects — real DB/dispatcher in prod, spies in tests. */
export interface ServerDeathAlertDeps {
  logEvent: (agentName: string, event: string, meta: Record<string, unknown>) => void;
  enqueue: (targetAgent: string, envelope: string) => void;
  notify: (targetAgent: string) => void;
}

export interface ServerDeathOutcome {
  handled: boolean; // false = deduped (already seen this proxy+newPid)
  targets: string[]; // agents paged (empty when deduped)
}

function summarizeSnapshot(r: TmuxServerDeathReport): string {
  const s = r.snapshot;
  const oom = s.dmesg && /killed process|Out of memory|oom-kill/i.test(s.dmesg)
    ? 'dmesg shows OOM-killer lines'
    : s.dmesg
      ? 'dmesg captured (no OOM lines)'
      : 'dmesg unavailable (EPERM/uid1000)';
  const mem = s.free ? 'free -m captured' : 'free -m unavailable';
  return `${oom}; ${mem}`;
}

/**
 * Process one server-death report. `dedupe` is owned by the caller (module-level
 * in the route) so this function stays pure and test-isolated.
 */
export function reportServerDeath(
  deps: ServerDeathAlertDeps,
  dedupe: Set<string>,
  proxyId: string,
  report: TmuxServerDeathReport,
): ServerDeathOutcome {
  const key = `${proxyId}|${report.newPid ?? '?'}`;
  if (dedupe.has(key)) return { handled: false, targets: [] };
  dedupe.add(key);

  deps.logEvent('system', 'tmux_server_died', {
    proxyId,
    oldPid: report.oldPid,
    oldInode: report.oldInode,
    newPid: report.newPid,
    newInode: report.newInode,
    detectedAt: report.detectedAt,
    snapshot: report.snapshot,
  });

  const body =
    `🔴 tmux server DIED on proxy ${proxyId}: server PID ${report.oldPid ?? '?'}→${report.newPid ?? '?'} ` +
    `at ${report.detectedAt}. Agents on this host were reaped and respawned with fresh session IDs ` +
    `(context loss — panes may READ coherent but continuity is gone). ${summarizeSnapshot(report)}. ` +
    `Chloe: this is the A-origin root-cause surface. Investigate now.`;

  const targets: string[] = [];
  for (const target of SERVER_DEATH_ALERT_TARGETS) {
    const envelope =
      `[from: system, reply with collab send system --topic tmux-server-death]: '${body.replace(/'/g, "\\'")}'`;
    deps.enqueue(target, envelope);
    deps.notify(target);
    targets.push(target);
  }
  return { handled: true, targets };
}
