/**
 * GAP-056 ADD-2: blast-radius scale detection for context-lost reaps.
 *
 * PRIMARY (server-death watcher) tells you A reap happened in ~15s. ADD-2 tells
 * you the SCALE in ~seconds — the 20/21 mass reap on 2026-08-07 was reconstructed
 * ~an hour late, and that late reconstruction IS the gap this closes.
 *
 * The reap signal is keyed STRICTLY on session-id continuity (never a "recovered"
 * label or pane-alive — a reaped agent re-orients from STATE.md and READS coherent;
 * only a rotated DB sessionId proves context loss). A context-lost reap =
 * `recoverAgent` fresh-respawns an agent whose PRIOR sessionId was non-null
 * (prior-null = a first spawn from no session, not a reap).
 *
 * SHADOW MODE (default): emit the fresh-sid signal + windowed count for the
 * events table to become the baseline-measurement substrate — it does NOT page.
 * The threshold is a HYPOTHESIS until measured against real churn; paging is
 * gated OFF until a measured threshold is set (flip = flag + constant, not a
 * re-gate). During shadow, a full 08-07-class reap still fires PRIMARY
 * (tmux_server_died), so nothing is exposed.
 */

/** 120s — covers the observed 08-07 recreate spread (~84s) + margin. */
export const RECOVERY_SCALE_WINDOW_MS = 120_000;

/**
 * Paging gate. FALSE until a threshold is measured from real fresh-sid baseline
 * (Robby-steered: don't reason a threshold on an unmeasured signal → cry-wolf).
 * Flip to true WITH a measured `RECOVERY_SCALE_THRESHOLD`.
 */
export const RECOVERY_SCALE_PAGING_ENABLED = false;

/**
 * HYPOTHESIS threshold (unused while paging is disabled): fire when fresh-sid
 * recoveries in the window ≥ max(3, ceil(0.20 × activeAgents)). Absolute floor 3
 * avoids ratio false-alarms on a tiny active set + normal 1–2 reap churn; the 20%
 * ratio scales to fleet size and catches partial-fleet reaps. Validate against the
 * measured baseline before enabling paging.
 */
export function hypothesisThreshold(activeAgents: number): number {
  return Math.max(3, Math.ceil(0.2 * Math.max(activeAgents, 0)));
}

export interface RecordArgs {
  agentName: string;
  priorSid: string | null;
  newSid: string | null;
  activeAgents: number;
  nowMs: number;
}

export interface RecordResult {
  /** true iff this recovery rotated a non-null prior sid → a NEW sid = context-lost reap. */
  isFreshSid: boolean;
  /** count of fresh-sid reaps within the trailing window (this one included). */
  windowCount: number;
  /**
   * Present only when paging is enabled AND the window count crossed the threshold
   * AND this episode has not already alerted. One page per mass-reap episode.
   */
  alert?: { windowCount: number; activeAgents: number; windowSec: number };
}

/**
 * Stateful across calls (holds the trailing window of fresh-sid timestamps).
 * Instantiate once at orchestrator wiring, inject via LifecycleContext, call from
 * recoverAgent's finalize. Time + active-count are injected — no clock read here,
 * so it is deterministically unit-testable.
 */
export class RecoveryScaleTracker {
  private readonly windowMs: number;
  private readonly pagingEnabled: boolean;
  private readonly thresholdFn: (activeAgents: number) => number;
  /** trailing timestamps (ms) of fresh-sid reaps within the window. */
  private freshSidTimes: number[] = [];
  /** dedupe: true once this mass-reap episode has paged; reset when the window drains. */
  private alertedThisEpisode = false;

  constructor(opts?: {
    windowMs?: number;
    pagingEnabled?: boolean;
    thresholdFn?: (activeAgents: number) => number;
  }) {
    this.windowMs = opts?.windowMs ?? RECOVERY_SCALE_WINDOW_MS;
    this.pagingEnabled = opts?.pagingEnabled ?? RECOVERY_SCALE_PAGING_ENABLED;
    this.thresholdFn = opts?.thresholdFn ?? hypothesisThreshold;
  }

  /**
   * Record one recovery outcome. Returns the fresh-sid classification + windowed
   * count (always — that's the shadow signal the caller logs), and an `alert`
   * intent ONLY when paging is enabled and the threshold is crossed (deduped).
   */
  record(args: RecordArgs): RecordResult {
    // Prune the window first so both the drain-reset and the count are current.
    const cutoff = args.nowMs - this.windowMs;
    this.freshSidTimes = this.freshSidTimes.filter((t) => t > cutoff);
    if (this.freshSidTimes.length === 0) this.alertedThisEpisode = false;

    const isFreshSid = args.priorSid !== null && args.newSid !== null && args.newSid !== args.priorSid;
    if (!isFreshSid) {
      return { isFreshSid: false, windowCount: this.freshSidTimes.length };
    }

    this.freshSidTimes.push(args.nowMs);
    const windowCount = this.freshSidTimes.length;

    let alert: RecordResult['alert'];
    if (this.pagingEnabled && !this.alertedThisEpisode &&
        windowCount >= this.thresholdFn(args.activeAgents)) {
      this.alertedThisEpisode = true;
      alert = { windowCount, activeAgents: args.activeAgents, windowSec: Math.round(this.windowMs / 1000) };
    }

    return { isFreshSid: true, windowCount, ...(alert ? { alert } : {}) };
  }
}
