import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord } from '../shared/types.ts';
import { StrandedWatchdog, classifyStrand, WATCHDOG, type StrandedWatchdogDeps } from './stranded-watchdog.ts';

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

  function makeWatchdog(): StrandedWatchdog {
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
      logEvent: () => {},
      sleep: async () => {}, // no real delays in tests
    });
  }

  /** Seed a message that reached 'delivered', back-dated by ageSeconds. */
  function seedDeliveredMessage(agent: string, source: string, ageSeconds: number): number {
    const pending = db.enqueueMessage({
      sourceAgent: source,
      targetAgent: agent,
      envelope: `[from: ${source}]: 'do the thing'`,
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
    scripts.set('s1agent', { pane: REAL_S1_PANE, frozenSecs: 300 }); // frozen 5min, stays stranded

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

  it('TEST 1b: S2 modal stranded → Escape+Enter nudges, then respawns', async () => {
    const agent = makeAgent('s2agent');
    seedDeliveredMessage('s2agent', 'CoachBeard', 300);
    scripts.set('s2agent', { pane: S2_PANE, frozenSecs: 300 });

    const wd = makeWatchdog();
    const [outcome] = await wd.sweep([agent]);
    assert.ok(outcome);

    assert.equal(outcome.result, 'respawned');
    assert.equal((outcome as { kind: string }).kind, 'S2');
    // S2: Escape sent to dismiss the modal before Enter.
    assert.ok(sentKeys.some((k) => k.keys === 'Escape'), 'Escape sent for modal');
    assert.ok(sentKeys.some((k) => k.keys === 'Enter'), 'Enter sent after dismiss');
  });

  it('TEST 1c: nudge clears the strand → recovered without respawn', async () => {
    const agent = makeAgent('nudged');
    seedDeliveredMessage('nudged', 'CoachBeard', 300);
    // First capture (candidacy) stranded; after the first nudge the pane clears.
    scripts.set('nudged', { pane: [S1_PANE, CLEAN_PANE], frozenSecs: 300 });

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
    scripts.set('busy', { pane: S1_PANE, frozenSecs: 0 });

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
    scripts.set('draining', { pane: S1_PANE, frozenSecs: 300 }); // pane frozen...
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
    scripts.set('ctxflip', { pane: S1_PANE, frozenSecs: 300 });
    // Write wildly different context_pct values — must not change the decision.
    db.rawDb.prepare('UPDATE agents SET last_context_pct = 1 WHERE name = ?').run('ctxflip');
    const wd = makeWatchdog();
    const [before] = await wd.sweep([agent]);
    assert.ok(before);
    db.rawDb.prepare('UPDATE agents SET last_context_pct = 99 WHERE name = ?').run('ctxflip');
    scripts.set('ctxflip', { pane: S1_PANE, frozenSecs: 300 });
    const [after] = await makeWatchdog().sweep([db.getAgent('ctxflip')!]);
    assert.ok(after);
    // Both decisions come from the two ground-truth legs, not ctx% → identical path.
    assert.equal(before.result, 'respawned');
    assert.equal(after.result, 'respawned');
  });

  // ── TEST 3: re-enqueue BEFORE kill (order invariant) ──
  it('TEST 3: unconsumed message is re-enqueued as pending BEFORE the kill', async () => {
    const agent = makeAgent('order');
    seedDeliveredMessage('order', 'CoachBeard', 300);
    scripts.set('order', { pane: S1_PANE, frozenSecs: 300 });
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
    scripts.set('capped', { pane: S1_PANE, frozenSecs: 300 });

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
    scripts.set('partial', { pane: S1_PANE, frozenSecs: 300 }); // currently frozen ≥120s
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
});
