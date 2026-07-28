import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord } from '../shared/types.ts';
import { StrandedWatchdog, classifyStrand, extractComposerText, composerCorrespondsToMessage, MIN_CORRESPONDENCE_CHARS, WATCHDOG, type StrandedWatchdogDeps } from './stranded-watchdog.ts';

// Pane fixtures that trip each strand classifier (mirrors proxy/tmux.ts sigs).
const S1_PANE = [
  '⏵ some earlier output',
  '─────────────────────────',
  '❯ hey Gilfoyle can you look at this   ', // un-submitted composer text
].join('\n');
const S2_PANE = [
  ' Settings   Status   Config   Usage   Stats ',
  ' context: 42%   model: opus ',
].join('\n');
const CLEAN_PANE = ['⏵ working...', '─────────────', '❯ '].join('\n'); // empty composer, no modal

// REALISTIC Claude TUI panes — the composer is NOT the last line; an indented
// hint line renders below it. This is the live layout that exposed the
// leading-whitespace scan-bail bug (the bottom-up scan hit the hint line first).
const REAL_HINT = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents              /rc';
const REAL_S1_PANE = [
  '──────────────────────────────── Agent ──',
  '❯ please respond ok', // un-submitted composer text, ABOVE the hint line
  '──────────────────────────────────────────',
  REAL_HINT,
].join('\n');
const REAL_CLEAN_PANE = [
  '──────────────────────────────── Agent ──',
  '❯ ', // empty composer
  '──────────────────────────────────────────',
  REAL_HINT,
].join('\n');

// Real-captured MULTI-LINE composer (a long unsubmitted paste wraps: the "❯"
// prompt line + indented continuation lines with NO glyph). Captured verbatim
// from a live agent's composer while it genuinely held pending text. This is the
// actual stranding case (collab envelopes are long/multi-line) and must detect.
const REAL_MULTILINE_S1_PANE = [
  '──────────────────────────────────────────────────────────────────── Agent ──',
  '❯ this is a long unsubmitted draft that should wrap across multiple visual',
  '  lines inside the composer box without ever being submitted so that the',
  '  composer genuinely holds multi line pending text right now',
  '────────────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)                             /rc',
].join('\n');

// ── OVER-DETECTION (false-kill) regressions — Roz gate finding ──
// The composer is EMPTY, but blockquoted "> …" scrollback (routine in this fleet:
// persona/system-prompt text renders as indented markdown blockquotes) sits
// ABOVE it. trim() alone let the unbounded reverse scan climb past the empty
// composer into that scrollback and read "> …" as live input → false S1 → a
// healthy idle agent enters the kill-capable recovery ladder. The bounded scan
// must STOP at the composer box and return null. NBSP after "❯" matches the real
// capture (Roz's fixture-realism note) and exercises whitespace handling.
const EMPTY_COMPOSER = '❯ '; // real composer ends '❯' + U+00A0 (NBSP)
// Roz's exact adversarial pane — border between quote and composer.
const ADVERSARIAL_QUOTE_ABOVE = [
  '  > some quoted markdown text from assistant output',
  '──────────────────────────────── Agent ──',
  EMPTY_COMPOSER,
  '──────────────────────────────────────────',
  REAL_HINT,
].join('\n');
// Variant — quote immediately adjacent to the composer, no border between.
const ADVERSARIAL_QUOTE_ADJACENT = [
  '  > some quoted markdown text',
  EMPTY_COMPOSER,
  REAL_HINT,
].join('\n');
// Real-captured "> …" blockquote scrollback (verbatim from a live agent's
// persona history) above a real empty composer box.
const REAL_QUOTE_SCROLLBACK_EMPTY = [
  '> You are the ONLY agent authorized to spawn other agents. When the team needs a',
  ' > **How to spawn an agent:**',
  '> ```bash',
  '',
  '──────────────────────────────── Agent ──',
  EMPTY_COMPOSER,
  '──────────────────────────────────────────',
  REAL_HINT,
].join('\n');

// ── Correspondence-guard fixtures ──
// A genuine stranded paste: the composer holds the delivered message ENVELOPE
// (what the dispatcher pasted). Candidacy tests seed this exact envelope so the
// composer CORRESPONDS and the ladder can run.
const STRANDED_ENVELOPE = "[from: CoachBeard, reply with collab send CoachBeard --topic ops]: 'please handle the queued task now and report back'";
const CORRESPONDING_S1_PANE = [
  '──────────────────────────────── Agent ──',
  '❯ ' + STRANDED_ENVELOPE, // composer holds the pasted envelope → corresponds
  '──────────────────────────────────────────',
  REAL_HINT,
].join('\n');
// An agent's OWN draft in the composer — a REAL strand-looking pane that must NOT
// act because the text does not correspond to the delivered message (Chloe class).
const OWN_DRAFT_S1_PANE = [
  '──────────────────────────────── Agent ──',
  '❯ check the queue for anything else pending', // agent's own note, not the message
  '──────────────────────────────────────────',
  REAL_HINT,
].join('\n');
// The Claude composer PLACEHOLDER on a fresh/empty composer (verbatim from
// adapters.test.ts) — classifies S1 but must NOT act (probe #1 false-positive).
const PLACEHOLDER_S1_PANE = [
  '──────────────────────────────── Agent ──',
  '❯ Try "how do I log an error?"',
  '──────────────────────────────────────────',
  REAL_HINT,
].join('\n');
// Contextual GHOST-TEXT (a TUI-suggested next-action, NOT a delivered message) —
// the exact ChloeOBrian #396 class DrRobby flagged. Classifies S1 (composer holds
// text) but must NOT act: it is not a [from:] envelope, so it does not correspond.
const GHOST_TEXT_S1_PANE = [
  '──────────────────────────────── Agent ──',
  "❯ keep watching Brienne's ctx number",
  '──────────────────────────────────────────',
  REAL_HINT,
].join('\n');

/** ISO in the DB's strftime format (no millis). */
function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

describe('classifyStrand', () => {
  it('detects S1 (un-submitted composer text)', () => {
    assert.equal(classifyStrand(S1_PANE), 'S1');
  });
  it('detects S2 (blocking modal), preferring modal over composer', () => {
    assert.equal(classifyStrand(S2_PANE), 'S2');
    assert.equal(classifyStrand(S2_PANE + '\n❯ pasted text'), 'S2');
  });
  it('returns null for a clean pane (empty composer, no modal)', () => {
    assert.equal(classifyStrand(CLEAN_PANE), null);
  });
  // Regression (live-verify finding): the real TUI renders an INDENTED hint line
  // below the composer, so "❯ <text>" is not the last line. A trailing-only
  // strip made the bottom-up scan bail on the hint's leading spaces and miss the
  // strand. trim() on both ends fixes it.
  it('detects S1 with a trailing indented hint line below the composer', () => {
    assert.equal(classifyStrand(REAL_S1_PANE), 'S1');
  });
  it('returns null for a real empty composer with a trailing hint line', () => {
    assert.equal(classifyStrand(REAL_CLEAN_PANE), null);
  });
  // POSITIVE — must still detect the real multi-line stranding case (the fix
  // must not over-correct into under-detection; DrRobby's two-sided constraint).
  it('detects S1 for a real multi-line wrapped unsubmitted paste', () => {
    assert.equal(classifyStrand(REAL_MULTILINE_S1_PANE), 'S1');
  });
  // NEGATIVE (false-kill regression) — empty composer with "> …" scrollback ABOVE
  // must be null. These are RED on the trim-only fix (0193593) and GREEN on the
  // bounded scan. The whole point of the bound: never climb into scrollback.
  it('returns null: empty composer, quoted scrollback above a border (Roz repro)', () => {
    assert.equal(classifyStrand(ADVERSARIAL_QUOTE_ABOVE), null);
  });
  it('returns null: empty composer, quoted scrollback adjacent (no border)', () => {
    assert.equal(classifyStrand(ADVERSARIAL_QUOTE_ADJACENT), null);
  });
  it('returns null: empty composer with REAL "> …" persona scrollback above', () => {
    assert.equal(classifyStrand(REAL_QUOTE_SCROLLBACK_EMPTY), null);
  });
});

describe('extractComposerText', () => {
  it('returns the composer text (single line)', () => {
    assert.equal(extractComposerText(REAL_S1_PANE), 'please respond ok');
  });
  it('joins multi-line wrapped composer text in visual order', () => {
    assert.equal(
      extractComposerText(REAL_MULTILINE_S1_PANE),
      'this is a long unsubmitted draft that should wrap across multiple visual lines inside the composer box without ever being submitted so that the composer genuinely holds multi line pending text right now',
    );
  });
  it('returns null for an empty composer (incl. scrollback above)', () => {
    assert.equal(extractComposerText(REAL_CLEAN_PANE), null);
    assert.equal(extractComposerText(ADVERSARIAL_QUOTE_ABOVE), null);
  });
  it('extracts the placeholder text (classifier is imprecise; guard excludes it)', () => {
    assert.equal(extractComposerText(PLACEHOLDER_S1_PANE), 'Try "how do I log an error?"');
  });
});

describe('composerCorrespondsToMessage', () => {
  it('matches a real pasted envelope (even wrapped/truncated)', () => {
    // full envelope in composer
    assert.equal(composerCorrespondsToMessage(STRANDED_ENVELOPE, STRANDED_ENVELOPE), true);
    // truncated (composer cut off at capture width) still shares a long run
    assert.equal(composerCorrespondsToMessage(STRANDED_ENVELOPE.slice(0, 80), STRANDED_ENVELOPE), true);
    // reformatted whitespace (wrap inserts spaces) still corresponds
    assert.equal(
      composerCorrespondsToMessage(STRANDED_ENVELOPE.replace(/ /g, '  '), STRANDED_ENVELOPE),
      true,
    );
  });
  it('EXCLUDES an agent own-draft (Chloe class)', () => {
    assert.equal(
      composerCorrespondsToMessage('check the queue for anything else pending', STRANDED_ENVELOPE),
      false,
    );
  });
  it('EXCLUDES the TUI placeholder (probe #1)', () => {
    assert.equal(composerCorrespondsToMessage('Try "how do I log an error?"', STRANDED_ENVELOPE), false);
  });
  it('EXCLUDES text shorter than the correspondence threshold', () => {
    assert.equal(composerCorrespondsToMessage('ok', STRANDED_ENVELOPE), false);
    assert.equal('ok'.length < MIN_CORRESPONDENCE_CHARS, true);
  });
});

describe('StrandedWatchdog', () => {
  let db: Database;
  let tmpDir: string;

  // Per-agent scripted proxy responses.
  type Script = { pane: string | string[]; frozenSecs: number };
  let scripts: Map<string, Script>;
  let sentKeys: Array<{ agent: string; keys: string }>;
  let respawned: Array<{ agent: string; pendingExistedAtCall: boolean }>;
  let alerts: Array<{ target: string; topic: string; body: string }>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'strand-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    scripts = new Map();
    sentKeys = [];
    respawned = [];
    alerts = [];
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeAgent(name: string): AgentRecord {
    db.createAgent({ name, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(name)!;
    db.updateAgentState(name, 'active', a.version, {
      proxyId: 'p1',
      tmuxSession: `agent-${name}`,
    });
    return db.getAgent(name)!;
  }

  function agentNameFromSession(cmd: ProxyCommand): string {
    const sn = (cmd as { sessionName?: string }).sessionName ?? '';
    return sn.replace(/^agent-/, '');
  }

  function makeDispatch(): StrandedWatchdogDeps['proxyDispatch'] {
    return async (_proxyId: string, cmd: ProxyCommand): Promise<ProxyResponse> => {
      const name = agentNameFromSession(cmd);
      const script = scripts.get(name);
      if (cmd.action === 'capture') {
        let pane = script?.pane ?? CLEAN_PANE;
        if (Array.isArray(pane)) {
          // Pop through the sequence; last entry sticks.
          pane = pane.length > 1 ? (pane.shift() as string) : pane[0]!;
        }
        return { ok: true, data: pane };
      }
      if (cmd.action === 'pane_activity') {
        const epoch = Math.floor(Date.now() / 1000) - (script?.frozenSecs ?? 0);
        return { ok: true, data: epoch };
      }
      if (cmd.action === 'send_keys') {
        sentKeys.push({ agent: name, keys: (cmd as { keys: string }).keys });
        return { ok: true };
      }
      return { ok: true };
    };
  }

  function makeWatchdog(opts?: { now?: () => number; logEvent?: StrandedWatchdogDeps['logEvent'] }): StrandedWatchdog {
    return new StrandedWatchdog({
      db,
      proxyDispatch: makeDispatch(),
      respawn: async (agentName) => {
        // Capture whether the unconsumed message was already re-enqueued as
        // 'pending' at the exact moment respawn (the kill) is invoked.
        const pendingExisted = db.hasPendingMessages(agentName);
        respawned.push({ agent: agentName, pendingExistedAtCall: pendingExisted });
      },
      alert: (target, topic, body) => alerts.push({ target, topic, body }),
      logEvent: opts?.logEvent ?? (() => {}),
      sleep: async () => {}, // no real delays in tests
      ...(opts?.now ? { now: opts.now } : {}),
    });
  }

  /** Seed a message that reached 'delivered', back-dated by ageSeconds. */
  function seedDeliveredMessage(agent: string, source: string, ageSeconds: number): number {
    const pending = db.enqueueMessage({
      sourceAgent: source,
      targetAgent: agent,
      envelope: STRANDED_ENVELOPE,
    });
    db.rawDb
      .prepare("UPDATE pending_messages SET status = 'delivered', delivered_at = ? WHERE id = ?")
      .run(iso(Date.now() - ageSeconds * 1000), pending.id);
    return pending.id;
  }

  /** Raw-insert a token snapshot with an explicit age (bypasses default now()). */
  function seedSnapshot(agent: string, ageSeconds: number): void {
    db.rawDb
      .prepare('INSERT INTO agent_token_snapshots (agent_name, total_tokens, context_pct, captured_at) VALUES (?, ?, ?, ?)')
      .run(agent, 1234, 42, iso(Date.now() - ageSeconds * 1000));
  }

  // ── TEST 1: POSITIVE — S1 and S2 each detected + recovered ──
  it('TEST 1a: S1 stranded + no activity → nudges, re-enqueues, respawns', async () => {
    const agent = makeAgent('s1agent');
    seedDeliveredMessage('s1agent', 'CoachBeard', 300); // delivered 5min ago
    // Use the REALISTIC pane (composer above a trailing hint line) so the full
    // detect→respawn ladder is proven on the live TUI layout, not just a fixture
    // where "❯ text" is conveniently the last line.
    scripts.set('s1agent', { pane: CORRESPONDING_S1_PANE, frozenSecs: 300 }); // frozen 5min, stays stranded

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 'respawned');
    assert.equal((outcome as { kind: string }).kind, 'S1');
    assert.equal(respawned.length, 1, 'respawn called once');
    assert.equal(respawned[0]!.agent, 's1agent');
    // S1: Enter sent to submit the composer (M attempts).
    assert.ok(sentKeys.some((k) => k.keys === 'Enter'), 'Enter nudge sent');
    // Durable respawn recorded.
    assert.equal(db.countRecentWatchdogRespawns('s1agent', 1800), 1);
  });

  it('TEST 1b: S2 modal hiding a REAL stranded message → Escape reveals it, corresponds → respawns', async () => {
    const agent = makeAgent('s2agent');
    seedDeliveredMessage('s2agent', 'CoachBeard', 300);
    // Candidacy capture sees the modal (S2); after the Escape-dismiss the pane
    // reveals the corresponding stranded message → genuine S2 recovery proceeds.
    scripts.set('s2agent', { pane: [S2_PANE, CORRESPONDING_S1_PANE], frozenSecs: 300 });

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 'respawned');
    assert.equal((outcome as { kind: string }).kind, 'S2');
    // S2: Escape sent to dismiss the modal, then Enter to submit the revealed message.
    assert.ok(sentKeys.some((k) => k.keys === 'Escape'), 'Escape sent for modal');
    assert.ok(sentKeys.some((k) => k.keys === 'Enter'), 'Enter sent after dismiss');
  });

  it('TEST 1b2: S2 self-opened modal (Escape reveals OWN-DRAFT) → dismissed, NO respawn', async () => {
    const agent = makeAgent('s2self');
    seedDeliveredMessage('s2self', 'CoachBeard', 300);
    // Modal at candidacy; after Escape the composer is the agent's OWN draft, not
    // the delivered message → correspondence fails → STOP, never respawn.
    scripts.set('s2self', { pane: [S2_PANE, OWN_DRAFT_S1_PANE], frozenSecs: 300 });

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 's1-no-correspondence');
    assert.equal(respawned.length, 0, 'never respawn a self-opened modal on a healthy agent');
    // Escape WAS sent (safe modal-dismiss), but NO respawn and no Enter-submit of the own-draft.
    assert.ok(sentKeys.some((k) => k.keys === 'Escape'), 'Escape dismissed the modal');
    assert.ok(!sentKeys.some((k) => k.keys === 'Enter'), 'no Enter — own-draft not submitted');
    assert.equal(db.countRecentWatchdogRespawns('s2self', 1800), 0);
  });

  it('TEST 1c: nudge clears the strand → recovered without respawn', async () => {
    const agent = makeAgent('nudged');
    seedDeliveredMessage('nudged', 'CoachBeard', 300);
    // First capture (candidacy) stranded; after the first nudge the pane clears.
    scripts.set('nudged', { pane: [CORRESPONDING_S1_PANE, CLEAN_PANE], frozenSecs: 300 });

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 'recovered');
    assert.equal(respawned.length, 0, 'no respawn when a nudge fixes it');
    assert.equal(db.countRecentWatchdogRespawns('nudged', 1800), 0);
  });

  // ── TEST 2: NEGATIVE load-bearing — both legs required, ground-truth ──
  it('TEST 2a: %-only zero-snapshots but pane ADVANCING → ZERO action', async () => {
    const agent = makeAgent('busy');
    seedDeliveredMessage('busy', 'CoachBeard', 300);
    // Stranded-LOOKING pane text, NO token snapshots (the %-status blind spot),
    // BUT pane_activity advancing (frozenSecs 0). The pane leg proves it's alive.
    scripts.set('busy', { pane: CORRESPONDING_S1_PANE, frozenSecs: 0 });

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 'not-stranded');
    assert.equal(respawned.length, 0, 'a live agent is NEVER respawned');
    assert.equal(alerts.length, 0);
    assert.equal(db.countRecentWatchdogRespawns('busy', 1800), 0);
  });

  it('TEST 2b: token snapshot recent (pane frozen) → alive, ZERO action', async () => {
    const agent = makeAgent('draining');
    seedDeliveredMessage('draining', 'CoachBeard', 300);
    scripts.set('draining', { pane: CORRESPONDING_S1_PANE, frozenSecs: 300 }); // pane frozen...
    seedSnapshot('draining', 5); // ...but a token snapshot 5s ago → real work

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 'not-stranded', 'token leg alone keeps it alive');
    assert.equal(respawned.length, 0);
  });

  it('TEST 2c: GAP-012 ctx% has ZERO effect (watchdog never reads it)', async () => {
    const agent = makeAgent('ctxflip');
    seedDeliveredMessage('ctxflip', 'CoachBeard', 300);
    scripts.set('ctxflip', { pane: CORRESPONDING_S1_PANE, frozenSecs: 300 });
    // Write wildly different context_pct values — must not change the decision.
    db.rawDb.prepare('UPDATE agents SET last_context_pct = 1 WHERE name = ?').run('ctxflip');
    const wd = makeWatchdog();
    const [before] = await wd.sweep([agent]);
    assert.ok(before);
    db.rawDb.prepare('UPDATE agents SET last_context_pct = 99 WHERE name = ?').run('ctxflip');
    scripts.set('ctxflip', { pane: CORRESPONDING_S1_PANE, frozenSecs: 300 });
    const [after] = await makeWatchdog().sweep([db.getAgent('ctxflip')!]);
    assert.ok(after);
    // Both decisions come from the two ground-truth legs, not ctx% → identical path.
    assert.equal(before.result, 'respawned');
    assert.equal(after.result, 'respawned');
  });

  // ── TEST 2d/2e: CORRESPONDENCE GUARD — the false-ACTION cases (Roz + live sweep) ──
  // Both panes classify S1 and satisfy every no-activity leg + a delivered msg,
  // so pre-guard they would be nudged/respawned. The guard must exclude them
  // because the composer text does not correspond to the delivered message.
  it('TEST 2d: OWN-DRAFT in composer (Chloe class) → s1-no-correspondence, ZERO action', async () => {
    const agent = makeAgent('owndraft');
    seedDeliveredMessage('owndraft', 'CoachBeard', 300); // delivered msg exists
    seedSnapshot('owndraft', 300); // old snapshot only → hasRecentTokenActivity=false
    // frozen 300s + no recent token = both no-activity legs; composer holds the
    // agent's OWN note, NOT the delivered message.
    scripts.set('owndraft', { pane: OWN_DRAFT_S1_PANE, frozenSecs: 300 });

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 's1-no-correspondence');
    assert.equal(respawned.length, 0, 'a healthy agent with its own draft is NEVER acted on');
    assert.equal(alerts.length, 0);
    assert.equal(sentKeys.length, 0, 'no nudge keys sent');
    assert.equal(db.countRecentWatchdogRespawns('owndraft', 1800), 0);
  });

  it('TEST 2e: TUI PLACEHOLDER in composer (probe #1) → s1-no-correspondence, ZERO action', async () => {
    const agent = makeAgent('placeholder');
    seedDeliveredMessage('placeholder', 'CoachBeard', 300);
    scripts.set('placeholder', { pane: PLACEHOLDER_S1_PANE, frozenSecs: 300 });

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 's1-no-correspondence');
    assert.equal(respawned.length, 0, 'a fresh-composer placeholder is NEVER acted on');
    assert.equal(sentKeys.length, 0);
  });

  it('TEST 2f: CONTEXTUAL GHOST-TEXT in composer (Chloe #396 class) → s1-no-correspondence, ZERO escalation', async () => {
    const agent = makeAgent('ghost');
    seedDeliveredMessage('ghost', 'CoachBeard', 300);
    // Snapshot AFTER delivery → this WOULD be partial-consume (escalate) if the
    // guard let it through; the test proves the guard excludes it FIRST.
    seedSnapshot('ghost', 200);
    scripts.set('ghost', { pane: GHOST_TEXT_S1_PANE, frozenSecs: 300 });

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    // TUI-suggested ghost-text is not a [from:] envelope → no correspondence →
    // excluded BEFORE the partial-consume escalation. The message-grounded guard
    // (not the episode-dedup) is what keeps a recovered/active agent silent.
    assert.equal(outcome.result, 's1-no-correspondence');
    assert.equal(alerts.length, 0, 'contextual ghost-text NEVER escalates');
    assert.equal(respawned.length, 0);
    assert.equal(sentKeys.length, 0);
  });

  // ── TEST 3: re-enqueue BEFORE kill (order invariant) ──
  it('TEST 3: unconsumed message is re-enqueued as pending BEFORE the kill', async () => {
    const agent = makeAgent('order');
    seedDeliveredMessage('order', 'CoachBeard', 300);
    scripts.set('order', { pane: CORRESPONDING_S1_PANE, frozenSecs: 300 });
    assert.equal(db.hasPendingMessages('order'), false, 'no pending before sweep');

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 'respawned');
    assert.equal(respawned.length, 1);
    assert.equal(respawned[0]!.pendingExistedAtCall, true, 'message pending BEFORE kill');
  });

  // ── TEST 4: bounded across restart (durable cap) ──
  it('TEST 4: respawn cap survives restart — 3rd attempt blocked + escalates + STOPS', async () => {
    const agent = makeAgent('capped');
    seedDeliveredMessage('capped', 'CoachBeard', 300);
    scripts.set('capped', { pane: CORRESPONDING_S1_PANE, frozenSecs: 300 });

    // Simulate two prior respawns persisted BEFORE a restart.
    db.recordWatchdogRespawn('capped', 'stranded-input:S1');
    db.recordWatchdogRespawn('capped', 'stranded-input:S1');
    assert.equal(db.countRecentWatchdogRespawns('capped', 1800), 2, 'cap reached in DB');

    // A FRESH watchdog instance (post-restart) reads the DB-backed counter.
    const freshWatchdog = makeWatchdog();
    const [outcome] = await freshWatchdog.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 'cap-escalated');
    assert.equal(respawned.length, 0, 'no respawn past the cap');
    // Counter unchanged — cap did not record a 3rd.
    assert.equal(db.countRecentWatchdogRespawns('capped', 1800), 2);
    // Escalated to both operators.
    const targets = alerts.map((a) => a.target).sort();
    assert.deepEqual(targets, ['DrRobby', 'SydneyAdamu']);
    assert.ok(alerts.every((a) => a.topic === 'stranded-input-escalation'));
  });

  // ── TEST 5: partial-consume → escalate, never re-run ──
  it('TEST 5: activity AFTER delivery (then wedged) → escalate, never re-enqueue/respawn', async () => {
    const agent = makeAgent('partial');
    seedDeliveredMessage('partial', 'CoachBeard', 300); // delivered 300s ago
    scripts.set('partial', { pane: CORRESPONDING_S1_PANE, frozenSecs: 300 }); // currently frozen ≥120s
    // A snapshot 200s ago: AFTER delivery (300s ago) but OLDER than the 120s
    // no-activity window → agent processed, then went silent (wedged).
    seedSnapshot('partial', 200);

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 'partial-consume-escalated');
    assert.equal(respawned.length, 0, 'NEVER respawn a partially-consumed message');
    assert.equal(db.hasPendingMessages('partial'), false, 'NEVER re-enqueue it');
    assert.equal(db.countRecentWatchdogRespawns('partial', 1800), 0);
    // Escalated to operators.
    assert.deepEqual(alerts.map((a) => a.target).sort(), ['DrRobby', 'SydneyAdamu']);
  });

  // ── TEST 6: escalation episode-dedup + reminder + re-arm (alarm-fatigue fix) ──
  // A persistent wedge must escalate ONCE per episode, then re-escalate only as a
  // 30-min REMINDER — not afresh every ~30s sweep (the ChloeOBrian #396 prod fire).
  function seedPartialConsume(name: string): AgentRecord {
    const agent = makeAgent(name);
    seedDeliveredMessage(name, 'CoachBeard', 300); // delivered 300s ago
    scripts.set(name, { pane: CORRESPONDING_S1_PANE, frozenSecs: 300 });
    seedSnapshot(name, 200); // AFTER delivery, older than the 120s window → partial-consume
    return agent;
  }

  it('TEST 6a: partial-consume escalation fires ONCE, then dedups within the reminder window', async () => {
    const agent = seedPartialConsume('dedup');
    let clock = Date.now();
    const wd = makeWatchdog({ now: () => clock });

    const [o1] = await wd.sweep([agent]);
    assert.equal(o1!.result, 'partial-consume-escalated');
    assert.equal(alerts.length, 2, 'first escalation fans to both targets');

    const [o2] = await wd.sweep([agent]); // immediate re-sweep, same clock
    assert.equal(o2!.result, 'partial-consume-escalated');
    assert.equal(alerts.length, 2, 'no NEW alert within the reminder window (dedup)');

    clock += (WATCHDOG.ESCALATE_REMINDER_SECONDS - 1) * 1000; // just under the interval
    await wd.sweep([agent]);
    assert.equal(alerts.length, 2, 'still deduped just before the reminder interval');
  });

  it('TEST 6b: a still-unresolved wedge re-escalates as a REMINDER continuation after the interval', async () => {
    const agent = seedPartialConsume('remind');
    let clock = Date.now();
    const wd = makeWatchdog({ now: () => clock });

    await wd.sweep([agent]);
    assert.equal(alerts.length, 2);

    clock += WATCHDOG.ESCALATE_REMINDER_SECONDS * 1000; // exactly the interval
    await wd.sweep([agent]);
    assert.equal(alerts.length, 4, 'reminder re-escalates once the interval elapses');
    const reminder = alerts[alerts.length - 1]!.body;
    assert.match(reminder, /REMINDER/i, 'framed as a continuation, not a fresh alert');
    assert.match(reminder, /unresolved/i, 'names elapsed-since-first so it reads as ongoing');
  });

  it('TEST 6c: re-arms on recovery — after not-stranded, a NEW wedge escalates FRESH (not a reminder)', async () => {
    const agent = seedPartialConsume('rearm');
    const clock = Date.now();
    const wd = makeWatchdog({ now: () => clock }); // clock never advances a full interval

    await wd.sweep([agent]);
    assert.equal(alerts.length, 2, 'first escalation');

    // Recovery: composer clears → not-stranded → episode re-arms.
    scripts.set('rearm', { pane: CLEAN_PANE, frozenSecs: 0 });
    const [rec] = await wd.sweep([agent]);
    assert.equal(rec!.result, 'not-stranded');
    assert.equal(alerts.length, 2, 'no alert on recovery');

    // Re-wedge: a FRESH episode escalates fresh, even though no full interval has
    // elapsed — proving the episode cleared (else it would dedup-suppress).
    scripts.set('rearm', { pane: CORRESPONDING_S1_PANE, frozenSecs: 300 });
    const [o] = await wd.sweep([agent]);
    assert.equal(o!.result, 'partial-consume-escalated');
    assert.equal(alerts.length, 4, 'a new episode escalates fresh after re-arm');
    assert.doesNotMatch(alerts[alerts.length - 1]!.body, /REMINDER/i, 'fresh episode is NOT a reminder');
  });

  it('TEST 6d: s1-no-correspondence logs the event ONCE per episode, not every sweep', async () => {
    const agent = makeAgent('noisy');
    seedDeliveredMessage('noisy', 'CoachBeard', 300);
    seedSnapshot('noisy', 300);
    scripts.set('noisy', { pane: OWN_DRAFT_S1_PANE, frozenSecs: 300 });
    const events: Array<{ agent: string; event: string }> = [];
    const wd = makeWatchdog({ logEvent: (a, e) => events.push({ agent: a, event: e }) });

    await wd.sweep([agent]);
    await wd.sweep([agent]);
    await wd.sweep([agent]);
    assert.equal(
      events.filter((e) => e.event === 'stranded_s1_no_correspondence').length,
      1,
      'logged once across three identical sweeps, not 3x',
    );

    // Recovery clears the once-flag → a fresh episode logs again.
    scripts.set('noisy', { pane: CLEAN_PANE, frozenSecs: 0 });
    await wd.sweep([agent]);
    scripts.set('noisy', { pane: OWN_DRAFT_S1_PANE, frozenSecs: 300 });
    await wd.sweep([agent]);
    assert.equal(
      events.filter((e) => e.event === 'stranded_s1_no_correspondence').length,
      2,
      're-logs after leaving and re-entering the s1-no-correspondence state',
    );
  });
});
