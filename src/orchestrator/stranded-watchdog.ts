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
import { extractComposerText, hasComposerText, composerCorrespondsToMessage, MIN_CORRESPONDENCE_CHARS } from '../shared/composer.ts';

// Re-export the shared composer primitives so existing importers (and tests)
// keep a single import site while the implementation lives in shared/.
export { extractComposerText, composerCorrespondsToMessage, MIN_CORRESPONDENCE_CHARS };

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
  /** Re-escalate an unresolved wedge at most once per this interval (seconds).
   *  30 min — clear of alarm-fatigue while never silently dropping a real one. */
  ESCALATE_REMINDER_SECONDS: 1800,
  /** Dwell before a SUSTAINED s1-no-correspondence strand pages the monitors
   *  (seconds). The s1-no-correspondence state is ambiguous on a single sweep (an
   *  agent's own draft / the TUI placeholder trips it transiently), so we only
   *  alert once a message has sat delivered-but-undrained this long AND the agent
   *  has done zero durable work since delivery. 30 min rules out transient blips
   *  while catching the silent-strand class (PepperPotts 36h) far below 36h. */
  SILENT_STRAND_ALERT_SECONDS: 1800,
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
 * S2 — an undismissed blocking modal is stealing keystrokes. Signatures are kept
 * in sync with proxy/tmux.ts matchModalSignature (same real v2.1.220 headers +
 * legacy OR-alternates) so the watchdog DETECTS the same modals the proxy
 * DISMISSES. NOTE — deliberate divergence: the proxy additionally applies a
 * composer-guard (structural check that the working footer is absent) to reject
 * a signature merely QUOTED in message content; this detector OMITS that guard.
 * Safe because a content-quote false-match is backstopped downstream — the strand
 * requires the two-signal AND (a delivered message pending) plus the pending-msg
 * gate, so a quoted signature on a healthy pane does not trigger action.
 * (Follow-up: extract ONE shared modal predicate both sides import — drift-proof.)
 */
export function classifyModal(pane: string): boolean {
  return (
    /How is Claude doing this session/.test(pane) ||
    /Is this a project you (created or one you )?trust/.test(pane) ||
    /Settings\s+Status\s+Config\s+Usage\s+Stats/.test(pane) || // /status, /usage
    /Help\s+General\s+Commands\s+Custom commands/.test(pane) || // /help (v2.1.220)
    /Available commands|Keyboard shortcuts:/.test(pane) || // /help (legacy)
    /Select model\b|Switch between Claude models/.test(pane) || // /model (v2.1.220)
    /Select (a|the) model|Switch to a different model/.test(pane) || // /model (legacy)
    /Resume session \(\d+ of \d+\)/.test(pane) || // /resume (v2.1.220)
    /Resume a conversation|Select a( previous)? conversation to resume/.test(pane) // /resume (legacy)
  );
}

/** S1 — the composer holds any un-submitted text (boolean view of extract). */
export function classifyUnsubmittedInput(pane: string): boolean {
  return hasComposerText(pane);
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
  /** Active escalation episodes: agent → {firstAt, lastAt} (epoch ms). Escalate
   *  ONCE per episode, then remind at most every ESCALATE_REMINDER_SECONDS;
   *  cleared when the agent next reads healthy (re-arm) so a NEW wedge fires fresh.
   *  Without this, a persistent wedge re-escalates every ~30s sweep → alarm
   *  fatigue (the ChloeOBrian #396 prod fire). */
  private readonly escalations = new Map<string, { firstAt: number; lastAt: number }>();
  /** Agents whose s1-no-correspondence was already logged this episode — log the
   *  event once, not every sweep (Chloe accrued 310 rows in one episode). */
  private readonly noCorrLogged = new Set<string>();
  /** Agents already paged for a SUSTAINED silent strand this episode — page once,
   *  not every sweep (mirrors noCorrLogged/escalations dedup); cleared on state-exit. */
  private readonly strandAlerted = new Set<string>();

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
      let outcome: SweepOutcome;
      try {
        outcome = await this.sweepAgent(agent);
      } catch (err) {
        outcome = { agent: agent.name, result: 'skip', reason: `error: ${(err as Error).message}` };
      }
      out.push(outcome);
      // Re-arm the escalation episode once the agent reads healthy/recovered — any
      // outcome that is neither an escalation nor a transient skip means the wedge
      // is over, so a FUTURE wedge escalates fresh (not as a stale reminder).
      if (
        outcome.result !== 'partial-consume-escalated' &&
        outcome.result !== 'cap-escalated' &&
        outcome.result !== 'skip'
      ) {
        this.escalations.delete(agent.name);
      }
      // The s1-no-correspondence log-once flag clears whenever the agent leaves
      // that state, so a later re-entry logs once again (not silence forever).
      if (outcome.result !== 's1-no-correspondence') {
        this.noCorrLogged.delete(agent.name);
        this.strandAlerted.delete(agent.name);
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
        // Log once per episode — a persistent own-draft would otherwise emit an
        // event every sweep (~30s), flooding the event log (Chloe: 310 rows).
        if (!this.noCorrLogged.has(name)) {
          this.logEvent(name, 'stranded_s1_no_correspondence', {
            deliveredAt: msg.deliveredAt,
            composerPreview: (composerText ?? '').slice(0, 80),
          });
          this.noCorrLogged.add(name);
        }
        // Logged-but-never-alerted is the gap this closes: a SUSTAINED silent
        // strand (message delivered ≥ DWELL ago with ZERO durable activity since
        // delivery) must page the Telegram-reaching monitors. hasActivitySince()
        // is the blessed ground-truth primitive (a token snapshot / activity event
        // after the timestamp) — it reads NO context_pct, so this detector never
        // depends on the GAP-012 telemetry it would otherwise be undermined by.
        // deliveredAt anchors BOTH legs (a real DB timestamp → no injected-now()/
        // DB-clock skew) and IS the episode anchor: the strand began when the
        // message landed undrained. Once per episode (strandAlerted, re-armed on
        // state-exit) mirrors the escalation dedup — never re-page every ~30s.
        // In-memory checks (arithmetic, Set) gate the DB query for cheap short-circuit.
        const deliveredMs = Date.parse(msg.deliveredAt);
        const ageSecs = Math.floor((this.now() - deliveredMs) / 1000);
        if (
          ageSecs >= WATCHDOG.SILENT_STRAND_ALERT_SECONDS &&
          !this.strandAlerted.has(name) &&
          !this.db.hasActivitySince(name, msg.deliveredAt)
        ) {
          const mins = Math.floor(ageSecs / 60);
          const body =
            `⚠️ ${name} has been silently stranded for ${mins}min holding an undrained ` +
            `message it never consumed (S1: composer shows its own draft/the TUI ` +
            `placeholder, not the delivered message). ZERO durable activity since ` +
            `delivery — NOT auto-recovering (the ambiguous s1-no-correspondence case). ` +
            `Needs operator: check the pane, then unwedge or /clear.`;
          for (const target of WATCHDOG.ESCALATE_TARGETS) {
            this.alert(target, 'stranded-silent-alert', body);
          }
          this.strandAlerted.add(name);
          this.logEvent(name, 'stranded_s1_alerted', { deliveredAt: msg.deliveredAt, ageSecs });
        }
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
      const fired = this.escalate(
        name,
        `⚠️ ${name} wedged (${kind}) AFTER partially processing a delivered message. NOT auto-recovering (avoid double-firing a side-effecting message). Needs operator: unwedge or /clear manually.`,
      );
      // Log the detection only when the escalation actually fired (first + each
      // 30-min reminder), not every suppressed sweep — same anti-spam as the alert.
      if (fired) this.logEvent(name, 'stranded_partial_consume', { kind, deliveredAt: msg.deliveredAt });
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
    let pane = firstPane;

    // S2 gate: a modal HID the composer, so the correspondence guard (gate 2b)
    // couldn't run before now. To keep the kill-capable ladder off a healthy
    // agent that opened a modal itself (e.g. /status) while its message was
    // already consumed, DISMISS the modal first (Escape — safe, recoverable),
    // then require the SAME correspondence on the revealed composer BEFORE any
    // respawn. A self-opened modal reveals an own-draft or empty composer → no
    // correspondence → STOP, never respawn (worst case we closed a self-opened
    // modal). Only a genuine stranded message revealed behind the modal proceeds.
    if (kind === 'S2') {
      await this.sendKeys(agent, 'Escape');
      await this.sleep(WATCHDOG.NUDGE_DELAY_MS);
      const revealed = await this.capture(agent);
      if (revealed !== null) pane = revealed;
      const composerText = revealed === null ? null : extractComposerText(revealed);
      if (composerText === null || !composerCorrespondsToMessage(composerText, msg.envelope)) {
        this.logEvent(name, 'stranded_s2_dismissed_no_correspondence', {
          deliveredAt: msg.deliveredAt,
          composerPreview: (composerText ?? '').slice(0, 80),
        });
        return { agent: name, result: 's1-no-correspondence' }; // dismissed, no genuine strand → no respawn
      }
      // A real stranded message is behind the modal — recover it like S1 below.
    }

    // (a) Gentle nudge: submit the pending (correspondence-verified) text. The
    //     modal, if any, was already dismissed above; Enter submits the composer.
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
      const fired = this.escalate(
        name,
        `🔴 ${name} stranded (${kind}) and hit the watchdog respawn cap (${respawns}/${WATCHDOG.RESPAWN_CAP} in ${WATCHDOG.RESPAWN_WINDOW_SECONDS / 60}min). Auto-recovery STOPPED — needs operator intervention.`,
      );
      if (fired) this.logEvent(name, 'stranded_respawn_cap_reached', { kind, respawns });
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

  /**
   * Escalate a wedge to the operator monitors ONCE per episode, then at most once
   * per ESCALATE_REMINDER_SECONDS as a REMINDER continuation (episode age + first-
   * escalation time, so the operator distinguishes an ongoing wedge from a new one).
   * The episode clears on recovery (see sweep) so a fresh wedge escalates fresh.
   * Returns true iff an alert was actually sent (first escalation or a due reminder).
   */
  private escalate(agentName: string, body: string): boolean {
    const now = this.now();
    const ep = this.escalations.get(agentName);
    if (ep === undefined) {
      this.escalations.set(agentName, { firstAt: now, lastAt: now });
      this.fanOut(body);
      return true;
    }
    // Ongoing episode — suppress unless the reminder interval has elapsed.
    if (now - ep.lastAt < WATCHDOG.ESCALATE_REMINDER_SECONDS * 1000) return false;
    ep.lastAt = now;
    const unresolvedMin = Math.floor((now - ep.firstAt) / 60000);
    const firstClock = new Date(ep.firstAt).toISOString().slice(11, 16); // HH:MM UTC
    this.fanOut(`⏳ REMINDER — still unresolved after ${unresolvedMin}min (first escalated ${firstClock}Z). ${body}`);
    return true;
  }

  private fanOut(body: string): void {
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
