import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendKeys, buildCreateSessionArgs } from './tmux.ts';

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
