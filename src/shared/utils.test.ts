import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelFlag, validModelId, shellQuote, sleep } from './utils.ts';

describe('validModelId', () => {
  it('returns the trimmed id for a safe model token', () => {
    assert.equal(validModelId('claude-sonnet-5'), 'claude-sonnet-5');
    assert.equal(validModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
    assert.equal(validModelId('  opus '), 'opus');
  });

  it('returns null for empty/unpinned', () => {
    assert.equal(validModelId(undefined), null);
    assert.equal(validModelId(null), null);
    assert.equal(validModelId(''), null);
    assert.equal(validModelId('   '), null);
  });

  it('returns null for shell-unsafe values (reject, never quote)', () => {
    assert.equal(validModelId('sonnet; rm -rf /'), null);
    assert.equal(validModelId('$(whoami)'), null);
    assert.equal(validModelId('a b'), null);
    assert.equal(validModelId("x' --dangerously"), null);
  });

  it('buildModelFlag is validModelId + the flag prefix (single source of validity)', () => {
    assert.equal(buildModelFlag('claude-sonnet-5'), '--model claude-sonnet-5');
    assert.equal(buildModelFlag('sonnet; rm -rf /'), '');
    assert.equal(buildModelFlag(''), '');
  });
});

describe('buildModelFlag', () => {
  it('builds a --model flag for a valid model id', () => {
    assert.equal(buildModelFlag('claude-sonnet-5'), '--model claude-sonnet-5');
    assert.equal(buildModelFlag('claude-haiku-4-5-20251001'), '--model claude-haiku-4-5-20251001');
    assert.equal(buildModelFlag('opus'), '--model opus');
  });

  it('returns empty string for an unpinned model (negative control)', () => {
    // An unpinned agent MUST still resolve to its intended default — no flag injected.
    assert.equal(buildModelFlag(undefined), '');
    assert.equal(buildModelFlag(null), '');
    assert.equal(buildModelFlag(''), '');
    assert.equal(buildModelFlag('   '), '');
  });

  it('trims surrounding whitespace before building the flag', () => {
    assert.equal(buildModelFlag('  claude-sonnet-5 '), '--model claude-sonnet-5');
  });

  it('rejects shell-unsafe values rather than injecting them', () => {
    // Defends the shell-interpolation surface: anything outside [A-Za-z0-9._-] is
    // dropped (empty flag), so a hostile model value can never break out of the flag.
    assert.equal(buildModelFlag('sonnet; rm -rf /'), '');
    assert.equal(buildModelFlag('$(whoami)'), '');
    assert.equal(buildModelFlag('a b'), '');
    assert.equal(buildModelFlag("x' --dangerously"), '');
  });
});

describe('shellQuote', () => {
  it('wraps simple strings in single quotes', () => {
    assert.equal(shellQuote('hello'), "'hello'");
  });

  it('handles empty string', () => {
    assert.equal(shellQuote(''), "''");
  });

  it('escapes single quotes', () => {
    assert.equal(shellQuote("it's"), "'it'\\''s'");
  });

  it('handles multiple single quotes', () => {
    assert.equal(shellQuote("a'b'c"), "'a'\\''b'\\''c'");
  });

  it('preserves spaces and special chars inside quotes', () => {
    assert.equal(shellQuote('hello world $HOME'), "'hello world $HOME'");
  });

  it('handles semicolons and pipes safely', () => {
    const quoted = shellQuote('foo; rm -rf /');
    assert.equal(quoted, "'foo; rm -rf /'");
  });
});

describe('sleep', () => {
  it('resolves after delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Expected >=40ms, got ${elapsed}ms`);
  });
});
