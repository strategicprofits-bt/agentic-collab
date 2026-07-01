import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendKeys } from './tmux.ts';

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
