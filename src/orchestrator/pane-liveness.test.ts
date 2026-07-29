import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaneCommand } from './pane-liveness.ts';

describe('classifyPaneCommand — GAP-026 Stage 1 process-liveness signal', () => {
  it('claude / node → "claude" (alive)', () => {
    assert.equal(classifyPaneCommand('claude'), 'claude');
    assert.equal(classifyPaneCommand('node'), 'claude');
    assert.equal(classifyPaneCommand('Claude'), 'claude'); // case-insensitive
    assert.equal(classifyPaneCommand('  claude  '), 'claude'); // trimmed
  });

  // The make-or-break OVERSHOOT case: an idle-but-ALIVE agent produces no new pane output,
  // but the Node TUI still OWNS the pane, so pane_current_command is 'claude' → alive → refused.
  // (Verified empirically: live agents report 'claude' across rapid samples, incl. idle + tool-calls.)
  it('idle-but-alive agent still reports "claude" → alive (never false-killed)', () => {
    assert.equal(classifyPaneCommand('claude'), 'claude');
    // process-based: identical to an active agent — there is no idle/active distinction to trip on.
  });

  it('interactive shells → "shell" (dead-CLI: the exit-to-shell death)', () => {
    for (const sh of ['bash', 'sh', 'zsh', 'dash', 'fish', 'ash', 'ksh', 'tcsh', 'csh']) {
      assert.equal(classifyPaneCommand(sh), 'shell', `${sh} should be shell`);
    }
  });

  it('login shells (leading "-") → "shell"', () => {
    assert.equal(classifyPaneCommand('-bash'), 'shell');
    assert.equal(classifyPaneCommand('-zsh'), 'shell');
  });

  it('anything else (editor/pager/unknown) → "other" (treated as alive — never reap on unknown)', () => {
    assert.equal(classifyPaneCommand('vim'), 'other');
    assert.equal(classifyPaneCommand('less'), 'other');
    assert.equal(classifyPaneCommand('python'), 'other');
  });

  it('empty / null / undefined → "other" (do not reap on missing data)', () => {
    assert.equal(classifyPaneCommand(''), 'other');
    assert.equal(classifyPaneCommand('   '), 'other');
    assert.equal(classifyPaneCommand(null), 'other');
    assert.equal(classifyPaneCommand(undefined), 'other');
  });

  it('substring safety: a shell name inside another word is NOT a shell', () => {
    assert.equal(classifyPaneCommand('bashful'), 'other'); // anchored regex, not substring
    assert.equal(classifyPaneCommand('nodemon'), 'other'); // not 'node'
  });
});
