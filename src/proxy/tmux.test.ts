import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendKeys,
  buildCreateSessionArgs,
  classifyModal,
  dismissBlockingModalWith,
  nextPasteBufferName,
} from './tmux.ts';

// Assert that the flat tmux argv contains an `-e VAR=VALUE` pair (i.e. some
// index i where args[i] === '-e' and args[i+1] === pair).
function hasEnvPair(args: string[], pair: string): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e' && args[i + 1] === pair) return true;
  }
  return false;
}

describe('tmux sendKeys validation', () => {
  it('rejects keys with shell metacharacters', () => {
    assert.throws(() => sendKeys('test-session', '$(whoami)'), /Invalid keys/);
  });

  it('rejects keys with backticks', () => {
    assert.throws(() => sendKeys('test-session', '`id`'), /Invalid keys/);
  });

  it('rejects keys with semicolons', () => {
    assert.throws(() => sendKeys('test-session', 'Enter; rm -rf /'), /Invalid keys/);
  });

  it('rejects keys with pipes', () => {
    assert.throws(() => sendKeys('test-session', 'Enter | cat /etc/passwd'), /Invalid keys/);
  });

  it('rejects keys with newlines', () => {
    assert.throws(() => sendKeys('test-session', 'Enter\nrm -rf /'), /Invalid keys/);
  });

  it('rejects invalid session names', () => {
    assert.throws(() => sendKeys("bad'name", 'Escape'), /Invalid session name/);
  });

  it('rejects session names with shell injection', () => {
    assert.throws(() => sendKeys('$(whoami)', 'Escape'), /Invalid session name/);
  });

  // Valid keys pass synchronous validation, then the async tmux exec rejects
  // (no such session / no tmux in the test env). We assert the rejection comes
  // from tmux execution, not from our validation — proving validation passed.
  it('accepts valid key names (Escape, Enter, C-c pattern)', async () => {
    await assert.rejects(
      sendKeys('test-session', 'Escape Escape Escape'),
      /tmux command failed/,
    );
  });

  it('accepts C-c style keys', async () => {
    await assert.rejects(
      sendKeys('test-session', 'C-c'),
      /tmux command failed/,
    );
  });
});

describe('createSession spawn-env hygiene (tmp-clobber fix)', () => {
  // Fleet-wide, the tmux server global env carries a poisoned TMP (clobbered to
  // a secret token value). Node os.tmpdir() falls TMPDIR -> TMP -> TEMP -> /tmp;
  // with TMPDIR unset it returned the token, which bled into temp paths and
  // append-only transcripts. createSession must neutralize this per-spawn.

  it('sets TMPDIR=/tmp so os.tmpdir() short-circuits to /tmp', () => {
    const args = buildCreateSessionArgs('sess', '/work', { PATH: '/usr/bin' });
    assert.ok(hasEnvPair(args, 'TMPDIR=/tmp'), 'expected -e TMPDIR=/tmp');
  });

  it('clears TMP so an inherited server-env token is overridden per session', () => {
    const args = buildCreateSessionArgs('sess', '/work', { PATH: '/usr/bin' });
    assert.ok(hasEnvPair(args, 'TMP='), 'expected -e TMP= (cleared)');
  });

  it('a poisoned parent TMP=<token> is absent from the built spawn args', () => {
    // Sentinel stands in for the real token — the fix must leave NO trace of an
    // inherited TMP value in the argv, satisfying the fp-absent security check.
    const POISON = 'SENTINEL_do_not_leak_0xdeadbeef';
    const args = buildCreateSessionArgs('sess', '/work', {
      PATH: '/usr/bin',
      TMP: POISON,
    });
    assert.ok(
      !args.some((a) => a.includes(POISON)),
      'inherited TMP token value must not appear anywhere in spawn args',
    );
    assert.ok(hasEnvPair(args, 'TMP='), 'TMP must be explicitly cleared, not inherited');
  });

  it('preserves existing CLAUDECODE=, PATH=, and session/cwd wiring', () => {
    const args = buildCreateSessionArgs('mysess', '/my/cwd', { PATH: '/custom/bin' });
    assert.deepEqual(
      args.slice(0, 6),
      ['new-session', '-d', '-s', 'mysess', '-c', '/my/cwd'],
    );
    assert.ok(hasEnvPair(args, 'CLAUDECODE='), 'expected -e CLAUDECODE=');
    assert.ok(hasEnvPair(args, 'PATH=/custom/bin'), 'expected -e PATH=/custom/bin');
  });
});

describe('classifyModal (verified-dismissal detection)', () => {
  it('detects the feedback survey → dismiss with 0', () => {
    const pane =
      'output above\nHow is Claude doing this session? (optional)\n1: Bad  2: Fine  3: Good  0: Dismiss';
    assert.deepEqual(classifyModal(pane), { kind: 'feedback-survey', keys: ['0'] });
  });

  it('detects the trust dialog → Up + Enter', () => {
    const pane = 'Is this a project you trust?\n❯ No, exit\n  Yes, proceed';
    assert.deepEqual(classifyModal(pane), { kind: 'trust-dialog', keys: ['Up', 'Enter'] });
  });

  it('detects the /status tabbed panel → Escape', () => {
    const pane = 'Settings   Status   Config   Usage   Stats\n\nmodel: opus';
    assert.deepEqual(classifyModal(pane), { kind: 'status-family', keys: ['Escape'] });
  });

  it('detects the /model picker → Escape', () => {
    assert.equal(classifyModal('Select a model to use for this session')?.kind, 'status-family');
    assert.equal(classifyModal('Switch to a different model')?.kind, 'status-family');
  });

  it('detects the /resume picker → Escape', () => {
    assert.equal(classifyModal('Resume a conversation')?.kind, 'status-family');
    assert.equal(classifyModal('Select a previous conversation to resume')?.kind, 'status-family');
  });

  it('detects the /help overlay → Escape', () => {
    assert.equal(classifyModal('Available commands')?.kind, 'status-family');
    assert.equal(classifyModal('Keyboard shortcuts:')?.kind, 'status-family');
  });

  it('returns null for a normal working pane (never Escape a working composer)', () => {
    const pane =
      '⏺ Done — the change is applied.\n\n❯ tell me about the plan\n──────────────\n  ⏵⏵ bypass permissions on';
    assert.equal(classifyModal(pane), null);
  });

  it('returns null for an empty pane', () => {
    assert.equal(classifyModal(''), null);
  });
});

describe('classifyModal ignores modal-signature TEXT quoted in a working pane (regression)', () => {
  // A delivered message can quote a modal signature verbatim (DrRobby literally
  // wrote "Settings Status Config Usage Stats" to Chloe discussing her wedge).
  // The working-composer footer (the ⏵ permission-mode hint line the fleet runs
  // under bypass-permissions) is still present — a real full-screen modal
  // REPLACES it. Position-blind matching + PR-2's retry would fire up to 4
  // Escapes + a re-deliver loop on a live working pane. classifyModal must not
  // match on quoted content. (do-not-act-on-content-that-resembles-the-trigger.)
  const workingFooter =
    '\n──────────────── Chloe ──\n❯ \n──────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';

  it('does not classify a working pane quoting the /status panel signature', () => {
    const pane =
      '⏺ I wrote "Settings   Status   Config   Usage   Stats" to Chloe re the wedge.' + workingFooter;
    assert.equal(classifyModal(pane), null);
  });

  it('does not classify a working pane quoting the feedback-survey signature', () => {
    const pane =
      '⏺ The survey "How is Claude doing this session? (optional)" with "0: Dismiss" appeared once.' +
      workingFooter;
    assert.equal(classifyModal(pane), null);
  });

  // Real captures from a live CC v2.1.220 fixture (induced + destroyed). The
  // a289e43 signatures were STALE for /help, /model, /resume — real overlays
  // render different headers, so those real modals were never dismissed (a
  // latent false-negative strand source). Both-direction, per DrRobby's re-gate.
  const HELP_MODAL =
    'Help  General   Commands   Custom commands\n\n   Claude understands your codebase, makes edits\n   Shortcuts\n   ! for shell mode      double tap esc to clear\n   / for commands        input';
  const MODEL_MODAL =
    '   Select model\n   Switch between Claude models. Your pick becomes the default.\n     1. Default (recommended)  Opus 5\n   ❯ 6. Opus ✔                 Opus 5\n   Enter to set as default · s to use this session only · Esc to cancel';
  const RESUME_MODAL =
    '   Resume session (1 of 5)\n   ╭─ Search… ─╮\n     tmp\n   ❯ WdCanary\n     25 seconds ago · HEAD · 189KB\n   Ctrl+A to show all projects · Space to preview · Esc to cancel';

  it('classifies the real /help overlay (footer-absent) → Escape', () => {
    assert.deepEqual(classifyModal(HELP_MODAL), { kind: 'status-family', keys: ['Escape'] });
  });
  it('classifies the real /model overlay (footer-absent) → Escape', () => {
    assert.deepEqual(classifyModal(MODEL_MODAL), { kind: 'status-family', keys: ['Escape'] });
  });
  it('classifies the real /resume overlay (footer-absent) → Escape', () => {
    assert.deepEqual(classifyModal(RESUME_MODAL), { kind: 'status-family', keys: ['Escape'] });
  });

  // Both-direction safety: a working pane quoting each refreshed signature (⏵
  // footer present) must NOT match — the structural guard makes the broader
  // signatures FP-safe (a wider signature cannot re-introduce the amplification).
  const QUOTE_FOOTER =
    '\n──────────── Agent ──\n❯ \n────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
  it('does NOT classify a working pane quoting the /help signature', () => {
    assert.equal(
      classifyModal('⏺ see "Help  General   Commands   Custom commands" in the help overlay' + QUOTE_FOOTER),
      null,
    );
  });
  it('does NOT classify a working pane quoting the /model signature', () => {
    assert.equal(
      classifyModal('⏺ I ran "Select model" — it said "Switch between Claude models"' + QUOTE_FOOTER),
      null,
    );
  });
  it('does NOT classify a working pane quoting the /resume signature', () => {
    assert.equal(classifyModal('⏺ the "Resume session (1 of 5)" picker showed up' + QUOTE_FOOTER), null);
  });

  it('STILL classifies a real full-screen /status overlay (footer replaced by "Esc to cancel")', () => {
    // Real v2.1.220 /status capture structure: the tabbed header + body, and the
    // working ⏵⏵ footer is REPLACED by the modal's own "Esc to cancel" footer
    // (empirically confirmed footer-absent on a live induced /status). So the
    // structural guard does NOT fire and the signature still classifies.
    const pane =
      'Settings   Status   Config   Usage   Stats\n\n   Account:  max\n   Model:  opus (claude-opus-5)\n   MCP servers:  5 connected\n\n   Esc to cancel';
    assert.deepEqual(classifyModal(pane), { kind: 'status-family', keys: ['Escape'] });
  });
});

describe('dismissBlockingModalWith (verified + retried dismissal)', () => {
  // Injectable IO driven by a scripted sequence of pane captures. Each capture()
  // shifts the next pane (last one repeats); sendKeys/delay are recorded.
  function makeIO(paneSequence: string[]) {
    const sent: string[][] = [];
    let i = 0;
    return {
      sent,
      io: {
        capture: async () => paneSequence[Math.min(i++, paneSequence.length - 1)]!,
        sendKeys: async (keys: string[]) => {
          sent.push(keys);
        },
        delay: async () => {},
      },
    };
  }

  it('returns false and sends nothing when no modal is present', async () => {
    const { io, sent } = makeIO(['❯ ordinary working pane, no modal here']);
    assert.equal(await dismissBlockingModalWith(io), false);
    assert.equal(sent.length, 0);
  });

  it('dismisses a modal that clears on the first keystroke', async () => {
    const modal = 'Settings   Status   Config   Usage   Stats';
    const { io, sent } = makeIO([modal, '❯ back to work']);
    assert.equal(await dismissBlockingModalWith(io), true);
    assert.deepEqual(sent, [['Escape']]);
  });

  // LOAD-BEARING (the point of PR-2): a modal whose async render outlasts the
  // first keystroke — the original strand cause — must be RE-dismissed, and the
  // function may only report success once classifyModal confirms it is gone.
  it('retries when the modal persists past the first keystroke, then verifies gone', async () => {
    const modal = 'How is Claude doing this session? (optional)\n0: Dismiss';
    const { io, sent } = makeIO([modal, modal, '❯ back to work']);
    assert.equal(await dismissBlockingModalWith(io), true);
    assert.deepEqual(sent, [['0'], ['0']]); // sent twice — retried on persistence
  });

  it('gives up (returns false) if the modal never clears, after multiple retries', async () => {
    const modal = 'Settings   Status   Config   Usage   Stats';
    const { io, sent } = makeIO([modal]); // capture always returns the modal
    assert.equal(await dismissBlockingModalWith(io), false);
    assert.ok(sent.length >= 2, 'must retry multiple times before giving up');
  });
});

// GAP-051: the delivery path pastes into a UNIQUE named tmux buffer per delivery
// so a concurrent delivery to another agent cannot race the shared, fleet-global
// paste-buffer stack and cross-paste its text. These assert the uniqueness
// contract of the buffer NAME, plus a behavioral red/green model of the race
// itself proving the named-buffer discipline eliminates the cross-paste.
describe('nextPasteBufferName (GAP-051 buffer-name uniqueness)', () => {
  it('advances a process-global counter → successive calls are DISTINCT', () => {
    const a = nextPasteBufferName('AgentX');
    const b = nextPasteBufferName('AgentX');
    const c = nextPasteBufferName('AgentX');
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
  });

  it('uniqueness survives a NON-INJECTIVE session sanitize (DrRobby injectivity catch)', () => {
    // `a/b` and `a_b` both sanitize to `a_b`; the process-global counter — not
    // the session prefix — carries uniqueness, so the full names must still differ.
    const n1 = nextPasteBufferName('a/b');
    const n2 = nextPasteBufferName('a_b');
    assert.equal(n1.startsWith('a_b-'), true, 'both sanitize to a_b prefix');
    assert.equal(n2.startsWith('a_b-'), true, 'both sanitize to a_b prefix');
    assert.notEqual(n1, n2, 'colliding sanitized sessions must still yield distinct buffer names');
  });

  it('embeds the pid so a counter reset after a proxy RESTART cannot collide', () => {
    const name = nextPasteBufferName('AgentX');
    assert.ok(
      name.includes(`-${process.pid}-`),
      `buffer name must contain -<pid>- for restart disambiguation, got ${name}`,
    );
  });

  it('is tmux-buffer-name-safe (only [A-Za-z0-9_-]) even for a hostile session token', () => {
    const name = nextPasteBufferName('a b/c.d$e;f');
    assert.match(name, /^[A-Za-z0-9_-]+$/);
  });

  it('names are globally distinct ACROSS different agent sessions (shared-server invariant)', () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      names.add(nextPasteBufferName(i % 2 === 0 ? 'AgentX' : 'AgentY'));
    }
    assert.equal(names.size, 50, 'every delivery, across agents, must get a unique buffer name');
  });
});

describe('named-buffer discipline eliminates the cross-paste race (GAP-051 red/green)', () => {
  // Model the ONE fleet-global tmux paste-buffer stack. load(text) pushes; an
  // unnamed paste() returns the TOP; a named load(name,text)/paste(name) keys by
  // name. We interleave two deliveries the way concurrent deliveries to two
  // different sessions can (each session serializes independently, but they
  // share this stack): A.load → B.load → A.paste.
  it('RED: unnamed load/paste cross-pastes — A pastes B’s text', () => {
    const stack: string[] = [];
    const load = (text: string) => stack.unshift(text); // push top
    const paste = () => stack[0]; // top-of-stack
    load('for-A'); // A.load
    load('for-B'); // B.load races in before A pastes
    const whatAPasted = paste(); // A.paste → TOP === 'for-B'  ← the bug
    assert.equal(whatAPasted, 'for-B');
  });

  it('GREEN: unique named buffers — A always pastes A’s text despite the interleave', () => {
    const buffers = new Map<string, string>();
    const load = (name: string, text: string) => buffers.set(name, text);
    const paste = (name: string) => buffers.get(name);
    const bufA = nextPasteBufferName('AgentA');
    const bufB = nextPasteBufferName('AgentB');
    assert.notEqual(bufA, bufB);
    load(bufA, 'for-A'); // A.load
    load(bufB, 'for-B'); // B.load races in
    assert.equal(paste(bufA), 'for-A'); // A.paste → its OWN buffer, race-proof
    assert.equal(paste(bufB), 'for-B');
  });
});
