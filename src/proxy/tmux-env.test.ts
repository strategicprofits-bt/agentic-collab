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
  it('emits `-e KEY=` (set-empty) for credential vars present in the enumerated keys', () => {
    // tmux 3.4 `new-session` has NO `-u` flag — the only way to neutralize an
    // inherited server-global value on the initial pane is to OVERRIDE it via
    // `-e KEY=` (set to empty). A `-u KEY` arg is rejected: "unknown flag -u".
    const args = envScrubArgs(['DOPPLER_TOKEN', 'STRIPE_SECRET_KEY']);
    assert.deepEqual(args, ['-e', 'DOPPLER_TOKEN=', '-e', 'STRIPE_SECRET_KEY=']);
  });

  it('does NOT scrub allowlisted vars (PATH, HOME, COLLAB_AGENT, GH_TOKEN)', () => {
    const args = envScrubArgs(['PATH', 'HOME', 'COLLAB_AGENT', 'GH_TOKEN']);
    assert.deepEqual(args, [], 'allowlisted vars must not appear in scrub args');
  });

  it('scrubs ANTHROPIC_API_KEY (intentionally not allowlisted — claude uses OAuth)', () => {
    const args = envScrubArgs(['ANTHROPIC_API_KEY']);
    assert.deepEqual(args, ['-e', 'ANTHROPIC_API_KEY=']);
  });

  it('NEVER emits a `-u` flag (tmux 3.4 new-session rejects it → fleet-kill on spawn)', () => {
    // Regression backstop for the class that the canary caught: the scrub argv
    // must be composed only of tmux-new-session-valid flags. `-u` is fatal.
    const args = envScrubArgs([
      'DOPPLER_TOKEN', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'DB_PASSWORD',
      'CLOUDFLARE_API_TOKEN', 'SLACK_BOT_TOKEN', 'MAILGUN_API_KEY',
    ]);
    assert.ok(!args.includes('-u'), 'envScrubArgs must never emit the -u flag');
    // every flag position must be `-e`
    for (let i = 0; i < args.length; i += 2) {
      assert.equal(args[i], '-e', `scrub flag at ${i} must be -e, not ${args[i]}`);
    }
  });

  it('PRESERVES COLLAB_AGENT — the path-2 loader guard keys on it; scrubbing it fails-open', () => {
    // Brienne clause-3: path-1 must not scrub COLLAB_AGENT or the operator-side
    // loader guard `[ -n "$COLLAB_AGENT" ] && return 0` never fires → re-fetch returns.
    const args = envScrubArgs(['COLLAB_AGENT', 'DOPPLER_TOKEN']);
    assert.ok(!args.includes('COLLAB_AGENT') && !args.includes('COLLAB_AGENT='),
      'COLLAB_AGENT must never be scrubbed');
    assert.ok(args.includes('DOPPLER_TOKEN='), 'the cred is still scrubbed (set-empty)');
  });

  it('skips keys with unsafe/invalid names (never emits an unsafe token into argv)', () => {
    const args = envScrubArgs(['BAD;NAME', 'FOO BAR', '1LEADINGDIGIT', 'has-hyphen', 'SAFE_CRED']);
    assert.deepEqual(args, ['-e', 'SAFE_CRED=']);
  });

  it('output is well-formed -e/`KEY=` pairs (even length; keys match the safe pattern; none allowlisted)', () => {
    const args = envScrubArgs(['DOPPLER_TOKEN', 'DATABASE_URL', 'PATH', 'BAD;NAME']);
    assert.equal(args.length % 2, 0, 'output must be an even-length flag/value list');
    for (let i = 0; i < args.length; i += 2) {
      assert.equal(args[i], '-e', `index ${i} must be the -e flag`);
      const kv = args[i + 1]!;
      assert.match(kv, /^[A-Za-z_][A-Za-z0-9_]*=$/, `entry "${kv}" must be KEY= (empty value)`);
      const key = kv.slice(0, -1);
      assert.ok(!ALLOWED_SESSION_ENV.has(key), `key "${key}" must not be allowlisted`);
    }
  });
});

describe('envScrubArgs — COMPOSITION with the -e overrides (coherent-by-construction)', () => {
  // DrRobby point 2: the -e-override keys (TMPDIR, TMP, CLAUDECODE, PATH) must be
  // EXCLUDED from the scrub emission so the scrub never emits a SECOND `-e TMP=`
  // (or worse, `-e PATH=` blanking the path). buildCreateSessionArgs is the sole
  // authority for those keys. Ordering-independent: eliminate the double-set.
  it('never scrubs TMPDIR even though it is not in the allowlist (it is -e-overridden)', () => {
    const args = envScrubArgs(['TMPDIR']);
    assert.deepEqual(args, [], 'TMPDIR is authoritative via -e TMPDIR=/tmp, never scrub-emitted');
  });

  it('never scrubs TMP even though it is not in the allowlist (it is -e-overridden)', () => {
    const args = envScrubArgs(['TMP']);
    assert.deepEqual(args, [], 'TMP is authoritative via -e TMP= (blank), never scrub-emitted');
  });

  it('never scrubs CLAUDECODE or PATH (both -e-set / authoritative)', () => {
    assert.deepEqual(envScrubArgs(['CLAUDECODE']), []);
    assert.deepEqual(envScrubArgs(['PATH']), []);
  });

  it('a poisoned server-env carrying TMP=<token> yields NO scrub for TMP and keeps -e TMP= authoritative', () => {
    // The regression path: TMP present in the enumerated server env. The scrub must
    // NOT emit anything for TMP (E_OVERRIDE exclusion) so the single authoritative
    // `-e TMP=` from buildCreateSessionArgs blanks it — TMP is empty by construction.
    const scrubKeys = ['TMP', 'TMPDIR', 'DOPPLER_TOKEN'];
    assert.deepEqual(envScrubArgs(scrubKeys), ['-e', 'DOPPLER_TOKEN='],
      'only the real cred is scrubbed; TMP/TMPDIR are left to the -e overrides');
    const argv = buildCreateSessionArgs('sess', '/work', { PATH: '/usr/bin' }, scrubKeys);
    // the cred IS scrubbed (set-empty)
    assert.ok(argvHasFlagKey(argv, '-e', 'DOPPLER_TOKEN='), 'must emit -e DOPPLER_TOKEN=');
    // exactly one authoritative -e TMP= and -e TMPDIR=/tmp (no scrub duplicate)
    assert.equal(countFlagKey(argv, '-e', 'TMP='), 1, 'exactly one -e TMP=');
    assert.equal(countFlagKey(argv, '-e', 'TMPDIR=/tmp'), 1, 'exactly one -e TMPDIR=/tmp');
    // never a -u anywhere in the composed argv
    assert.ok(!argv.includes('-u'), 'composed argv must contain no -u flag');
  });

  it('NEVER scrubs COLLAB_AGENT in the composed argv (path-2 guard fails-open if it is missing)', () => {
    const scrubKeys = ['COLLAB_AGENT', 'DOPPLER_TOKEN', 'STRIPE_SECRET_KEY'];
    const argv = buildCreateSessionArgs('sess', '/work', { PATH: '/usr/bin' }, scrubKeys);
    assert.ok(!argvHasFlagKey(argv, '-e', 'COLLAB_AGENT='), 'COLLAB_AGENT must NOT be scrubbed');
    assert.ok(argvHasFlagKey(argv, '-e', 'DOPPLER_TOKEN='), 'creds are still scrubbed');
    assert.ok(argvHasFlagKey(argv, '-e', 'STRIPE_SECRET_KEY='), 'creds are still scrubbed');
  });

  it('the full composed argv uses ONLY tmux-3.4-valid new-session flags (no -u)', () => {
    // End-to-end guard: the exact argv shape that reaches `tmux new-session`.
    const argv = buildCreateSessionArgs('sess', '/work', { PATH: '/usr/bin' },
      ['DOPPLER_TOKEN', 'STRIPE_SECRET_KEY', 'TMP', 'TMPDIR']);
    assert.ok(!argv.includes('-u'), 'no -u');
    // flags present are a subset of the ones new-session accepts here
    const allowedFlags = new Set(['new-session', '-d', '-s', '-c', '-e']);
    for (const tok of argv) {
      if (tok.startsWith('-') && tok.length === 2) {
        assert.ok(allowedFlags.has(tok), `flag ${tok} must be a valid new-session flag`);
      }
    }
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

// helper: count adjacent [flag, key] pairs in argv
function countFlagKey(argv: string[], flag: string, key: string): number {
  let n = 0;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && argv[i + 1] === key) n++;
  }
  return n;
}
