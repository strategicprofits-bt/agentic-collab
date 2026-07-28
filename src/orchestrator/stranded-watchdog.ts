// ── Stranded-input watchdog ──
//
// The automated catch-net for the inbound-parking family: an agent that is
// ALIVE but wedged holding a message it never consumed. Root causes (fixed at
// source in 1a/Part A) were the /status-family modal-swallow and the TUI
// submit-wedge; Part A makes a wedged paste THROW (kept 'pending') instead of
// false-'delivered'. This watchdog is the recovery path of last resort for the
// residue: a message that DID reach 'delivered' but whose agent is now sitting
// on a stranded prompt (S1) or an undismissed modal (S2), doing nothing.
//
// Division of labor: Part A answers "did THIS message land"; the watchdog
// answers "is the agent alive AND draining" (per-turn, not per-message).
//
// SAFETY INVARIANTS (gate-blocking — do not relax):
//   • "no-activity" is a MANDATORY TWO-SIGNAL AND, never collapsed to one:
//       (1) db.hasRecentTokenActivity(agent, N) === false   AND
//       (2) tmux pane_activity frozen for ≥ N seconds.
//     The pane leg covers agent_token_snapshots' %-only-status-bar blind spot
//     (a busy agent whose status shows "XX% context" writes no snapshot row —
//     the Pepper false-kill trap). Requiring BOTH means a healthy agent whose
//     pane is advancing is NEVER touched, even with zero snapshots.
//   • NEVER read last_context_pct / context_pct (GAP-012 unreliable) or
//     agents.last_activity (poll heartbeat, not real work).
//   • PARTIAL consume (any durable activity AFTER delivery) ⇒ escalate only,
//     NEVER re-enqueue or respawn: re-running a side-effecting message that the
//     agent already started could double-fire it.
//   • Re-enqueue the unconsumed message as 'pending' BEFORE the kill, so a
//     respawn can never lose it.
//   • The respawn cap is DURABLE (countRecentWatchdogRespawns, DB-backed) so it
//     survives an orchestrator restart — a crash-loop can't reset the counter.
//
// v1 limitation (documented, accepted safe-direction): candidacy REQUIRES a
// delivered-not-consumed message. A pane stranded for some other reason (agent
// opened a picker itself, no message pending) is out of scope — we under-
// recover rather than risk killing a healthy agent. Part A preserves the
// message and Chloe's monitor is the human backstop.

import type { Database } from './database.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord } from '../shared/types.ts';
import { sessionName, canSuspend } from '../shared/agent-entity.ts';

export const WATCHDOG = {
  /** N — no-activity threshold (seconds). Both signal legs must exceed this. */
  NO_ACTIVITY_SECONDS: 120,
  /** M — dismiss/re-Enter nudge attempts before escalating to respawn. */
  MAX_NUDGE_ATTEMPTS: 3,
  /** Durable respawn cap within the rolling window. */
  RESPAWN_CAP: 2,
  /** Rolling window for the respawn cap (seconds). 30 minutes. */
  RESPAWN_WINDOW_SECONDS: 1800,
  /** Delay between nudge attempts (ms). Injectable via deps.sleep for tests. */
  NUDGE_DELAY_MS: 2000,
  /** Escalation targets (Telegram-reaching monitors). */
  ESCALATE_TARGETS: ['DrRobby', 'SydneyAdamu'] as const,
} as const;

export interface StrandedWatchdogDeps {
  db: Database;
  proxyDispatch: (proxyId: string, cmd: ProxyCommand) => Promise<ProxyResponse>;
  /**
   * Kill the wedged session and fresh-respawn the agent. Implemented by the
   * health-monitor as: mark 'failed' → recoverAgent (which kills + re-spawns).
   * Called only AFTER the unconsumed message has been re-enqueued as pending.
   */
  respawn: (agentName: string, reason: string) => Promise<void>;
  /** Enqueue an alert to a target agent on a topic (fire-and-forget). */
  alert: (target: string, topic: string, body: string) => void;
  /** Log a structured event against the agent. */
  logEvent: (agentName: string, event: string, meta?: Record<string, unknown>) => void;
  /** Injectable clock (ms since epoch). Defaults to Date.now. */
  now?: () => number;
  /** Injectable sleep (ms). Defaults to real setTimeout; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export type StrandKind = 'S1' | 'S2';

export type SweepOutcome =
  | { agent: string; result: 'skip'; reason: string }
  | { agent: string; result: 'not-stranded' }
  | { agent: string; result: 's1-no-correspondence' } // composer text ≠ the delivered message (own-draft / placeholder)
  | { agent: string; result: 'recovered'; kind: StrandKind; attempts: number }
  | { agent: string; result: 'partial-consume-escalated'; kind: StrandKind }
  | { agent: string; result: 'respawned'; kind: StrandKind }
  | { agent: string; result: 'cap-escalated'; kind: StrandKind };

// ── Pane classification (pure, operates on captured text) ──

/**
 * S2 — an undismissed blocking modal is stealing keystrokes. Signatures mirror
 * proxy/tmux.ts dismissBlockingModal so classification and dismissal agree.
 */
export function classifyModal(pane: string): boolean {
  return (
    /How is Claude doing this session/.test(pane) ||
    /Is this a project you (created or one you )?trust/.test(pane) ||
    /Settings\s+Status\s+Config\s+Usage\s+Stats/.test(pane) || // /status, /usage
    /Select (a|the) model|Switch to a different model/.test(pane) || // /model
    /Resume a conversation|Select a( previous)? conversation to resume/.test(pane) || // /resume
    /Available commands|Keyboard shortcuts:/.test(pane) // /help
  );
}

/**
 * S1 — the composer holds un-submitted text, i.e. a paste that was never sent.
 * Mirrors proxy/tmux.ts inputStillHasUnsubmittedText, but reads the pane text the
 * orchestrator already captured (no extra proxy round-trip).
 *
 * The composer is a small, fixed-height BOX at the very bottom of the pane,
 * bounded by two border lines, with an indented hint line below it:
 *
 *     ──────────── AgentName ──     ← top border (has the title)
 *     ❯ first line of the message   ← composer prompt line
 *       wrapped continuation …      ← continuation lines (indented, NO glyph)
 *     ──────────────────────────    ← bottom border
 *       ⏵⏵ bypass permissions …     ← hint line (indented)
 *
 * Two hazards this threads on ONE pass (both are un-mergeable if traded):
 *  - UNDER-detect: trim() BOTH ends per line so the INDENTED hint/continuation
 *    lines don't defeat the walk (the original hint-line miss).
 *  - OVER-detect (false-kill): the walk is BOUNDED to the composer box — it stops
 *    at the top border and never climbs into scrollback, where blockquoted "> …"
 *    system-prompt text would otherwise be misread as live composer input
 *    (Roz gate finding). MAX_SCAN is a hard backstop if the borders are ever
 *    absent/malformed, so a run of blank/decoration lines can't chain up either.
 *
 * Returns the composer's unsubmitted text (visual order, prompt glyph stripped,
 * lines space-joined) or null if the composer is empty. classifyUnsubmittedInput
 * is the boolean view; the watchdog also needs the TEXT for the correspondence
 * guard (does it match the delivered message, or is it an own-draft/placeholder?).
 */
export function extractComposerText(pane: string): string | null {
  const lines = pane.split('\n');
  const MAX_SCAN = 16; // composer box is tiny; generous cap, still finite
  let scanned = 0;
  let insideBox = false; // seen the bottom border → now within the composer box
  const collected: string[] = []; // box content lines, collected bottom-up
  for (let i = lines.length - 1; i >= 0 && scanned < MAX_SCAN; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    scanned++;
    if (line.startsWith('⏵')) continue; // hint line, rendered BELOW the box
    if (line.startsWith('─')) {
      if (!insideBox) { insideBox = true; continue; } // bottom border → enter box
      break; // top border → everything above is scrollback: STOP
    }
    if (insideBox) {
      // Any non-empty text inside the box = live unsubmitted input. Strip an
      // optional prompt glyph so a bare "❯"/"> " empty prompt reads as empty
      // while wrapped continuation lines (no glyph) still count.
      const content = line.replace(/^[❯>]\s*/, '').trim();
      if (content.length > 0) collected.push(content);
    } else {
      // A non-decoration line reached BEFORE any bottom border = a compact pane
      // with no rendered box. Only a composer prompt WITH text counts, and only
      // the "❯" composer glyph (NOT ">") — so a bare scrollback "> …" line that
      // happens to be last can never false-positive. Decide here and STOP.
      const m = line.match(/^❯\s+(.+)$/);
      if (m !== null && m[1] !== undefined && m[1].trim().length > 0) collected.push(m[1].trim());
      break;
    }
  }
  if (collected.length === 0) return null;
  return collected.reverse().join(' '); // bottom-up → visual order
}

export function classifyUnsubmittedInput(pane: string): boolean {
  return extractComposerText(pane) !== null;
}

/** Minimum shared run (chars) for the composer to "correspond" to a message. */
export const MIN_CORRESPONDENCE_CHARS = 30;

/** Longest common substring length (DP, rolling row — inputs are small panes). */
function longestCommonSubstringLen(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const row = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    let diag = 0; // row[j-1] from the previous i (i.e. [i-1][j-1])
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      if (a[i - 1] === b[j - 1]) {
        row[j] = diag + 1;
        if (row[j]! > best) best = row[j]!;
      } else {
        row[j] = 0;
      }
      diag = tmp;
    }
  }
  return best;
}

/**
 * Does the unsubmitted composer text CORRESPOND to the delivered message?
 *
 * A genuine stranded paste renders the message envelope into the composer
 * (possibly wrapped / truncated / reformatted by the TUI) → the two share a long
 * common run. An agent's OWN draft, or the TUI placeholder ("❯ Try \"…\""), shares
 * only incidental short words. This is the guard that keeps the kill-capable
 * action path from firing on a healthy agent whose composer holds its own text
 * (Chloe class) or a fresh-composer placeholder (probe #1). TIGHT enough to
 * exclude those, LOOSE enough (substring, not equality) to still match a real
 * paste as it actually renders. Residual (accepted): an own-draft that quotes the
 * message verbatim still matches — a pane-based consumed signal closes that later.
 */
export function composerCorrespondsToMessage(composerText: string, envelope: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const c = norm(composerText);
  const e = norm(envelope);
  if (c.length < MIN_CORRESPONDENCE_CHARS) return false; // too short to be a real paste
  return longestCommonSubstringLen(c, e) >= MIN_CORRESPONDENCE_CHARS;
}

/** Classify the strand kind, preferring the modal signal (it gates keystrokes). */
export function classifyStrand(pane: string): StrandKind | null {
  if (classifyModal(pane)) return 'S2';
  if (classifyUnsubmittedInput(pane)) return 'S1';
  return null;
}

export class StrandedWatchdog {
  private readonly db: Database;
  private readonly proxyDispatch: StrandedWatchdogDeps['proxyDispatch'];
  private readonly respawn: StrandedWatchdogDeps['respawn'];
  private readonly alert: StrandedWatchdogDeps['alert'];
  private readonly logEvent: StrandedWatchdogDeps['logEvent'];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Agents with an in-flight sweep — prevents overlapping recovery ladders. */
  private readonly inFlight = new Set<string>();

  constructor(deps: StrandedWatchdogDeps) {
    this.db = deps.db;
    this.proxyDispatch = deps.proxyDispatch;
    this.respawn = deps.respawn;
    this.alert = deps.alert;
    this.logEvent = deps.logEvent;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Sweep every live agent. Errors are isolated per agent. */
  async sweep(agents: AgentRecord[]): Promise<SweepOutcome[]> {
    const out: SweepOutcome[] = [];
    for (const agent of agents) {
      try {
        out.push(await this.sweepAgent(agent));
      } catch (err) {
        out.push({ agent: agent.name, result: 'skip', reason: `error: ${(err as Error).message}` });
      }
    }
    return out;
  }

  async sweepAgent(agent: AgentRecord): Promise<SweepOutcome> {
    const name = agent.name;
    if (!agent.proxyId || !canSuspend(agent)) {
      return { agent: name, result: 'skip', reason: 'not a live agent' };
    }
    if (this.inFlight.has(name)) {
      return { agent: name, result: 'skip', reason: 'sweep already in flight' };
    }

    // Candidacy gate 1: there must be a delivered-not-yet-drained message to protect.
    const msg = this.db.getMostRecentDeliveredMessage(name);
    if (!msg || !msg.deliveredAt) {
      return { agent: name, result: 'skip', reason: 'no delivered message' };
    }

    // Candidacy gate 2: the pane is showing a stranded prompt (S1) or modal (S2).
    const pane = await this.capture(agent);
    if (pane === null) return { agent: name, result: 'skip', reason: 'capture failed' };
    const kind = classifyStrand(pane);
    if (!kind) return { agent: name, result: 'not-stranded' };

    // Candidacy gate 2b (S1 only): the unsubmitted composer text must CORRESPOND
    // to the delivered message. A genuine stranded paste renders the message
    // envelope; an agent's OWN draft or the TUI placeholder ("❯ Try \"…\"") does
    // not — so this excludes the false-action cases (Chloe's own-draft; the
    // fresh-composer placeholder / probe #1) BEFORE any nudge/kill. This guard is
    // safety-sufficient regardless of hasActivitySince blind spots: a healthy
    // agent's own text simply won't match the message. S2 modals hide the
    // composer, so correspondence can't be read there — S1 only (see report note).
    if (kind === 'S1') {
      const composerText = extractComposerText(pane);
      if (composerText === null || !composerCorrespondsToMessage(composerText, msg.envelope)) {
        this.logEvent(name, 'stranded_s1_no_correspondence', {
          deliveredAt: msg.deliveredAt,
          composerPreview: (composerText ?? '').slice(0, 80),
        });
        return { agent: name, result: 's1-no-correspondence' };
      }
    }

    // Candidacy gate 3: no-activity — MANDATORY TWO-SIGNAL AND. If either leg
    // shows life, the agent is alive/draining — never touch it.
    const N = WATCHDOG.NO_ACTIVITY_SECONDS;
    if (this.db.hasRecentTokenActivity(name, N)) {
      return { agent: name, result: 'not-stranded' }; // token snapshot within N — alive
    }
    const epoch = await this.paneActivityEpoch(agent);
    const frozenSecs = Math.floor(this.now() / 1000) - epoch;
    if (!(epoch > 0 && frozenSecs >= N)) {
      // Pane advanced within N (or unreadable) — treat as alive. Under-recover, never false-kill.
      return { agent: name, result: 'not-stranded' };
    }

    // Confirmed candidate: S1/S2 + both no-activity legs ≥ N. Distinguish a FULL
    // strand from a PARTIAL consume before choosing a recovery path.
    if (this.db.hasActivitySince(name, msg.deliveredAt)) {
      // The agent DID process after delivery, then wedged. Re-running could
      // double-fire a side-effecting message → escalate only, never respawn.
      this.logEvent(name, 'stranded_partial_consume', { kind, deliveredAt: msg.deliveredAt });
      this.escalate(
        name,
        `⚠️ ${name} wedged (${kind}) AFTER partially processing a delivered message. NOT auto-recovering (avoid double-firing a side-effecting message). Needs operator: unwedge or /clear manually.`,
      );
      return { agent: name, result: 'partial-consume-escalated', kind };
    }

    return this.inFlightGuard(name, () => this.recover(agent, msg, kind, pane));
  }

  private async inFlightGuard(name: string, fn: () => Promise<SweepOutcome>): Promise<SweepOutcome> {
    this.inFlight.add(name);
    try {
      return await fn();
    } finally {
      this.inFlight.delete(name);
    }
  }

  /** Full-strand recovery ladder: nudge → (re-enqueue before kill) → capped respawn → escalate+STOP. */
  private async recover(
    agent: AgentRecord,
    msg: NonNullable<ReturnType<Database['getMostRecentDeliveredMessage']>>,
    kind: StrandKind,
    firstPane: string,
  ): Promise<SweepOutcome> {
    const name = agent.name;

    // (a) Gentle nudge: dismiss the modal (S2) then submit the pending text.
    //     Escape closes /status-family pickers; Enter submits the composer.
    let pane = firstPane;
    for (let attempt = 1; attempt <= WATCHDOG.MAX_NUDGE_ATTEMPTS; attempt++) {
      if (classifyStrand(pane) === 'S2') {
        await this.sendKeys(agent, 'Escape');
        await this.sleep(300);
      }
      await this.sendKeys(agent, 'Enter');
      await this.sleep(WATCHDOG.NUDGE_DELAY_MS);

      // Recovered if the strand cleared OR real work resumed (short window).
      const after = await this.capture(agent);
      if (after !== null && classifyStrand(after) === null) {
        this.logEvent(name, 'stranded_recovered_by_nudge', { kind, attempt });
        return { agent: name, result: 'recovered', kind, attempts: attempt };
      }
      if (this.db.hasRecentTokenActivity(name, 10)) {
        this.logEvent(name, 'stranded_recovered_by_nudge', { kind, attempt, via: 'token-activity' });
        return { agent: name, result: 'recovered', kind, attempts: attempt };
      }
      pane = after ?? pane;
    }

    // (b) Still stranded after M nudges. Durable cap check FIRST — at cap we hand
    //     off to a human and STOP (do not re-enqueue or kill).
    const respawns = this.db.countRecentWatchdogRespawns(name, WATCHDOG.RESPAWN_WINDOW_SECONDS);
    if (respawns >= WATCHDOG.RESPAWN_CAP) {
      this.logEvent(name, 'stranded_respawn_cap_reached', { kind, respawns });
      this.escalate(
        name,
        `🔴 ${name} stranded (${kind}) and hit the watchdog respawn cap (${respawns}/${WATCHDOG.RESPAWN_CAP} in ${WATCHDOG.RESPAWN_WINDOW_SECONDS / 60}min). Auto-recovery STOPPED — needs operator intervention.`,
      );
      return { agent: name, result: 'cap-escalated', kind };
    }

    // Re-enqueue the unconsumed message as pending BEFORE the kill — a respawn
    // must never lose it. (Part A's throw keeps it out of a wedged session; the
    // fresh session will drain it cleanly.)
    this.db.enqueueMessage({
      sourceAgent: msg.sourceAgent,
      targetAgent: name,
      envelope: msg.envelope,
    });

    // Record the respawn in the DURABLE counter, then kill + fresh-spawn.
    this.db.recordWatchdogRespawn(name, `stranded-input:${kind}`);
    this.logEvent(name, 'stranded_respawn', { kind, respawns: respawns + 1 });
    await this.respawn(name, `stranded-input watchdog: ${kind} + ≥${WATCHDOG.NO_ACTIVITY_SECONDS}s no-activity`);

    // Always alert on an action taken.
    this.alert(
      'SydneyAdamu',
      'stranded-input-recovered',
      `${name} was stranded (${kind}, ≥${WATCHDOG.NO_ACTIVITY_SECONDS}s no-activity) holding an unconsumed message. Re-enqueued the message and respawned (${respawns + 1}/${WATCHDOG.RESPAWN_CAP}).`,
    );
    return { agent: name, result: 'respawned', kind };
  }

  private escalate(agentName: string, body: string): void {
    for (const target of WATCHDOG.ESCALATE_TARGETS) {
      this.alert(target, 'stranded-input-escalation', body);
    }
  }

  // ── Proxy helpers ──

  private async capture(agent: AgentRecord): Promise<string | null> {
    const res = await this.proxyDispatch(agent.proxyId!, {
      action: 'capture',
      sessionName: sessionName(agent),
      lines: 30,
    });
    return res.ok && typeof res.data === 'string' ? res.data : null;
  }

  private async paneActivityEpoch(agent: AgentRecord): Promise<number> {
    const res = await this.proxyDispatch(agent.proxyId!, {
      action: 'pane_activity',
      sessionName: sessionName(agent),
    });
    return res.ok && typeof res.data === 'number' ? res.data : 0;
  }

  private async sendKeys(agent: AgentRecord, keys: string): Promise<void> {
    await this.proxyDispatch(agent.proxyId!, {
      action: 'send_keys',
      sessionName: sessionName(agent),
      keys,
    });
  }
}
