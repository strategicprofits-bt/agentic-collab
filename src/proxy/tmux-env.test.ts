import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  envScrubArgs,
  ALLOWED_SESSION_ENV,
  parseServerEnvKeys,
  buildCreateSessionArgs,
  readInheritedEnvKeys,
} from './tmux.ts';

describe('envScrubArgs — least-privilege session env scoping (deny-all path-1)', () => {
  it('emits `-u KEY` for credential vars present in the enumerated keys', () => {
    const args = envScrubArgs(['DOPPLER_TOKEN', 'STRIPE_SECRET_KEY']);
    assert.deepEqual(args, ['-u', 'DOPPLER_TOKEN', '-u', 'STRIPE_SECRET_KEY']);
  });

  it('does NOT scrub allowlisted vars (PATH, HOME, COLLAB_AGENT, GH_TOKEN)', () => {
    const args = envScrubArgs(['PATH', 'HOME', 'COLLAB_AGENT', 'GH_TOKEN']);
    assert.deepEqual(args, [], 'allowlisted vars must not appear in scrub args');
  });

  it('scrubs ANTHROPIC_API_KEY (intentionally not allowlisted — claude uses OAuth)', () => {
    const args = envScrubArgs(['ANTHROPIC_API_KEY']);
    assert.deepEqual(args, ['-u', 'ANTHROPIC_API_KEY']);
  });

  it('PRESERVES COLLAB_AGENT — the path-2 loader guard keys on it; scrubbing it fails-open', () => {
    // Brienne clause-3: path-1 must not scrub COLLAB_AGENT or the operator-side
    // loader guard `[ -n "$COLLAB_AGENT" ] && return 0` never fires → re-fetch returns.
    const args = envScrubArgs(['COLLAB_AGENT', 'DOPPLER_TOKEN']);
    assert.ok(!args.includes('COLLAB_AGENT'), 'COLLAB_AGENT must never be scrubbed');
    assert.ok(args.includes('DOPPLER_TOKEN'), 'the cred is still scrubbed');
  });

  it('skips keys with unsafe/invalid names (never emits an unsafe token into argv)', () => {
    const args = envScrubArgs(['BAD;NAME', 'FOO BAR', '1LEADINGDIGIT', 'has-hyphen', 'SAFE_CRED']);
    assert.deepEqual(args, ['-u', 'SAFE_CRED']);
  });

  it('output is well-formed -u/key pairs (even length; keys match the safe pattern; none allowlisted)', () => {
    const args = envScrubArgs(['DOPPLER_TOKEN', 'DATABASE_URL', 'PATH', 'BAD;NAME']);
    assert.equal(args.length % 2, 0, 'output must be an even-length flag/value list');
    for (let i = 0; i < args.length; i += 2) {
      assert.equal(args[i], '-u', `index ${i} must be the -u flag`);
      const key = args[i + 1]!;
      assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/, `key "${key}" must match the safe pattern`);
      assert.ok(!ALLOWED_SESSION_ENV.has(key), `key "${key}" must not be allowlisted`);
    }
  });
});

describe('envScrubArgs — COMPOSITION with the -e overrides (coherent-by-construction)', () => {
  // DrRobby point 2: the -e-override keys (TMPDIR, TMP, CLAUDECODE, PATH) must be
  // EXCLUDED from the -u emission so `-u TMPDIR` is never emitted to RACE
  // `-e TMPDIR=/tmp`. Ordering-independent: eliminate the race, don't win it.
  it('never emits -u for TMPDIR even though it is not in the allowlist (it is -e-overridden)', () => {
    const args = envScrubArgs(['TMPDIR']);
    assert.deepEqual(args, [], 'TMPDIR is authoritative via -e, never -u-scrubbed');
  });

  it('never emits -u for TMP even though it is not in the allowlist (it is -e-overridden)', () => {
    const args = envScrubArgs(['TMP']);
    assert.deepEqual(args, [], 'TMP is authoritative via -e (blank), never -u-scrubbed');
  });

  it('never emits -u for CLAUDECODE or PATH (both -e-set / authoritative)', () => {
    assert.deepEqual(envScrubArgs(['CLAUDECODE']), []);
    assert.deepEqual(envScrubArgs(['PATH']), []);
  });

  it('a poisoned server-env carrying TMP=<token> yields NO -u TMP and keeps -e TMP= authoritative', () => {
    // The regression path: TMP present in the enumerated server env. If the scrub
    // emitted `-u TMP`, tmux ordering could unset-after-set. Excluding it means
    // -e TMP= is the SOLE authority → TMP is blank by construction.
    const scrubKeys = ['TMP', 'TMPDIR', 'DOPPLER_TOKEN'];
    const argv = buildCreateSessionArgs('sess', '/work', { PATH: '/usr/bin' }, scrubKeys);
    // no -u for the -e-override keys
    assert.ok(!argvHasFlagKey(argv, '-u', 'TMP'), 'must NOT emit -u TMP');
    assert.ok(!argvHasFlagKey(argv, '-u', 'TMPDIR'), 'must NOT emit -u TMPDIR');
    // the cred IS scrubbed
    assert.ok(argvHasFlagKey(argv, '-u', 'DOPPLER_TOKEN'), 'must emit -u DOPPLER_TOKEN');
    // the -e overrides remain authoritative
    assert.ok(argvHasFlagKey(argv, '-e', 'TMPDIR=/tmp'), 'must keep -e TMPDIR=/tmp');
    assert.ok(argvHasFlagKey(argv, '-e', 'TMP='), 'must keep -e TMP=');
  });

  it('NEVER scrubs COLLAB_AGENT in the composed argv (path-2 guard fails-open if it is missing)', () => {
    // DrRobby + Brienne gate criterion: path-1 must preserve COLLAB_AGENT so the
    // operator-side loader guard `[ -n "$COLLAB_AGENT" ] && return 0` fires.
    const scrubKeys = ['COLLAB_AGENT', 'DOPPLER_TOKEN', 'STRIPE_SECRET_KEY'];
    const argv = buildCreateSessionArgs('sess', '/work', { PATH: '/usr/bin' }, scrubKeys);
    assert.ok(!argvHasFlagKey(argv, '-u', 'COLLAB_AGENT'), 'COLLAB_AGENT must NOT be -u-scrubbed');
    assert.ok(argvHasFlagKey(argv, '-u', 'DOPPLER_TOKEN'), 'creds are still scrubbed');
    assert.ok(argvHasFlagKey(argv, '-u', 'STRIPE_SECRET_KEY'), 'creds are still scrubbed');
  });
});

describe('parseServerEnvKeys — key names from `tmux show-environment -g` (value-free)', () => {
  it('extracts key names from KEY=value lines', () => {
    const out = 'PATH=/usr/bin\nDOPPLER_TOKEN=abc123\nHOME=/home/agent';
    assert.deepEqual(parseServerEnvKeys(out), ['PATH', 'DOPPLER_TOKEN', 'HOME']);
  });

  it('handles values that themselves contain `=` (splits on the FIRST =)', () => {
    const out = 'DATABASE_URL=postgres://u:p@h/db?a=b\nFOO=bar';
    assert.deepEqual(parseServerEnvKeys(out), ['DATABASE_URL', 'FOO']);
  });

  it('skips `-NAME` removal lines (already-unset globals)', () => {
    const out = 'PATH=/usr/bin\n-STALE_VAR\nDOPPLER_TOKEN=x';
    assert.deepEqual(parseServerEnvKeys(out), ['PATH', 'DOPPLER_TOKEN']);
  });

  it('skips blank lines and malformed (no `=`) lines defensively', () => {
    const out = 'PATH=/usr/bin\n\nGARBAGE_NO_EQUALS\nHOME=/home/agent';
    assert.deepEqual(parseServerEnvKeys(out), ['PATH', 'HOME']);
  });

  it('returns [] for empty output', () => {
    assert.deepEqual(parseServerEnvKeys(''), []);
  });
});

describe('readInheritedEnvKeys — fail-SAFE enumeration source (deny-by-default)', () => {
  it('returns parsed server-global keys when `show-environment -g` succeeds', async () => {
    const exec = async () => 'PATH=/usr/bin\nDOPPLER_TOKEN=x\nHOME=/home/agent';
    assert.deepEqual(await readInheritedEnvKeys(exec), ['PATH', 'DOPPLER_TOKEN', 'HOME']);
  });

  it('falls back to process.env keys when NO tmux server is running (fresh server inherits proxy env)', async () => {
    const exec = async (): Promise<string> => {
      throw new Error('tmux command failed: tmux show-environment -g\nno server running on /tmp/tmux-1000/default');
    };
    const keys = await readInheritedEnvKeys(exec);
    assert.ok(keys.includes('PATH'), 'process.env fallback must include PATH');
    assert.ok(keys.length > 0, 'fallback must be non-empty');
  });

  it('FAILS CLOSED (throws) when the server is UP but the enumeration read errors — never spawn unscrubbed', async () => {
    // The dangerous case: silently falling back to process.env could MISS a
    // server-global key (server survives proxy restarts → not guaranteed ⊆).
    // Deny-by-default must hold even when the read fails → refuse the spawn.
    const exec = async (): Promise<string> => {
      throw new Error('tmux command failed: tmux show-environment -g\nsome transient read error');
    };
    await assert.rejects(() => readInheritedEnvKeys(exec), /unscrubbed|enumerat/i);
  });
});

// helper: does argv contain the [flag, key] adjacent pair?
function argvHasFlagKey(argv: string[], flag: string, key: string): boolean {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && argv[i + 1] === key) return true;
  }
  return false;
}
