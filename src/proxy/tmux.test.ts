import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendKeys, buildCreateSessionArgs, classifyModal, dismissBlockingModalWith } from './tmux.ts';

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
