/**
 * GAP-056: tmux server-death observability (proxy-side detector).
 *
 * The tmux server is host-local to the proxy; the orchestrator health-monitor
 * runs in Docker and cannot see the host tmux PID. So detection lives here,
 * piggybacked on the existing 15s heartbeat (no new timer). On each poll we
 * read the server identity — PID (`tmux display-message -p '#{pid}'`) + socket
 * inode (`stat` on the socket path). When the identity *changes* from a
 * non-null baseline, a server death+recreate occurred: we capture a bounded,
 * best-effort, failure-swallowed forensic snapshot and hand back a report the
 * heartbeat attaches as an additive optional field.
 *
 * Safety (Brienne): every probe is read-only, timeout-bounded, and its failure
 * is swallowed — the watcher can never wedge or slow the heartbeat, and worst
 * case is a spurious report (annoyance, not harm). It observes; it never acts.
 */

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { TmuxServerDeathReport, TmuxDeathSnapshot } from '../shared/types.ts';

/** Injectable seam: all host reads go through this so the watcher is unit-testable. */
export interface ServerProbe {
  /** tmux server PID, or null if unavailable (no sessions / tmux down / error). */
  tmuxServerPid(): Promise<string | null>;
  /** tmux socket inode as a string, or null if the socket can't be stat'd. */
  socketInode(): Promise<string | null>;
  /** `free -m` output, or null on failure. */
  free(): Promise<string | null>;
  /** `who` output, or null on failure. */
  who(): Promise<string | null>;
  /** `last -n 20` output, or null on failure. */
  last(): Promise<string | null>;
  /** `dmesg | tail` output, or null (commonly EPERM at uid1000). */
  dmesgTail(): Promise<string | null>;
}

export interface ServerIdentity {
  pid: string | null;
  inode: string | null;
}

/**
 * Detects tmux server-identity changes across polls. Stateful: holds the last
 * observed identity as a baseline. Fires ONLY on a change from a non-null
 * baseline to a different present identity — never on first observation, and
 * never when the server is transiently unreadable (baseline is held, not
 * clobbered with null, so a brief probe failure can't manufacture a death).
 */
export class ServerDeathWatcher {
  private baseline: ServerIdentity | null = null;
  private readonly probe: ServerProbe;

  constructor(probe: ServerProbe) {
    this.probe = probe;
  }

  /** For tests / introspection. */
  getBaseline(): ServerIdentity | null {
    return this.baseline;
  }

  /**
   * Read the current server identity and compare to the baseline.
   * @param nowIso ISO timestamp to stamp the report with (injected — no clock read here).
   * @returns a death report if the identity changed, else null.
   */
  async poll(nowIso: string): Promise<TmuxServerDeathReport | null> {
    const [pid, inode] = await Promise.all([
      this.probe.tmuxServerPid().catch(() => null),
      this.probe.socketInode().catch(() => null),
    ]);
    const current: ServerIdentity = { pid, inode };

    // Server not currently readable (pid null): can't attribute anything, and
    // we must NOT overwrite a good baseline with null — hold and wait for it to
    // come back so the recreate is detected as a change, not a null→value flip.
    if (current.pid === null) return null;

    // First-ever observation: establish baseline silently, no event.
    if (this.baseline === null || this.baseline.pid === null) {
      this.baseline = current;
      return null;
    }

    const changed = current.pid !== this.baseline.pid ||
      (current.inode !== null && this.baseline.inode !== null && current.inode !== this.baseline.inode);

    if (!changed) {
      // Refresh a previously-unknown inode without treating it as a death.
      if (this.baseline.inode === null && current.inode !== null) this.baseline = current;
      return null;
    }

    const old = this.baseline;
    this.baseline = current;
    const snapshot = await this.snapshot();
    return {
      oldPid: old.pid,
      oldInode: old.inode,
      newPid: current.pid,
      newInode: current.inode,
      detectedAt: nowIso,
      snapshot,
    };
  }

  /**
   * Bounded, best-effort forensic snapshot. Each probe's failure is mapped to
   * null via allSettled — the snapshot always resolves and never throws, so it
   * cannot wedge the heartbeat.
   */
  private async snapshot(): Promise<TmuxDeathSnapshot> {
    const [free, who, last, dmesg] = await Promise.all([
      this.probe.free().catch(() => null),
      this.probe.who().catch(() => null),
      this.probe.last().catch(() => null),
      this.probe.dmesgTail().catch(() => null),
    ]);
    return { free, who, last, dmesg };
  }
}

// ── Real host probe (production wiring) ──────────────────────────────────────

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_MAXBUF = 64 * 1024; // size-cap each probe's output

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAXBUF }, (err, stdout) => {
      if (err) return resolve(null); // swallow — best-effort only
      resolve(stdout.toString().trim());
    });
  });
}

/**
 * Default tmux socket path: `$TMUX_TMPDIR|/tmp` / `tmux-<uid>` / `default`.
 * Matches how the proxy invokes tmux (no `-S`, so the default socket).
 */
export function defaultTmuxSocketPath(): string {
  const tmp = process.env['TMUX_TMPDIR'] || '/tmp';
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `${tmp}/tmux-${uid}/default`;
}

/** Production probe: read-only host commands, all failure-swallowed. */
export const hostProbe: ServerProbe = {
  async tmuxServerPid() {
    const out = await run('tmux', ['display-message', '-p', '#{pid}']);
    if (!out) return null;
    const n = out.split('\n')[0]!.trim();
    return /^\d+$/.test(n) ? n : null;
  },
  async socketInode() {
    try {
      const s = await stat(defaultTmuxSocketPath());
      return String(s.ino);
    } catch {
      return null;
    }
  },
  free: () => run('free', ['-m']),
  who: () => run('who', []),
  last: () => run('last', ['-n', '20']),
  dmesgTail: async () => {
    const out = await run('dmesg', []);
    if (!out) return null; // EPERM at uid1000 when dmesg_restrict=1
    return out.split('\n').slice(-20).join('\n');
  },
};
