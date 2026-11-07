import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from './claude.ts';
import { CodexAdapter } from './codex.ts';
import { OpenCodeAdapter } from './opencode.ts';
import { getAdapter } from './index.ts';

describe('Engine Adapters', () => {
  describe('getAdapter', () => {
    it('returns ClaudeAdapter for claude', () => {
      const adapter = getAdapter('claude');
      assert.equal(adapter.engine, 'claude');
    });

    it('returns CodexAdapter for codex', () => {
      const adapter = getAdapter('codex');
      assert.equal(adapter.engine, 'codex');
    });

    it('returns OpenCodeAdapter for opencode', () => {
      const adapter = getAdapter('opencode');
      assert.equal(adapter.engine, 'opencode');
    });

    it('throws for unknown engine', () => {
      assert.throws(() => getAdapter('unknown' as 'claude'), /Unknown engine/);
    });
  });

  describe('ClaudeAdapter', () => {
    const adapter = new ClaudeAdapter();

    it('builds spawn command with all options', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
        model: 'opus',
        thinking: 'high',
        task: 'fix the bug',
        appendSystemPrompt: 'You are helpful',
        dangerouslySkipPermissions: true,
      });
      assert.ok(cmd.includes('claude'));
      assert.ok(cmd.includes('--dangerously-skip-permissions'));
      assert.ok(cmd.includes('--model opus'));
      assert.ok(cmd.includes('--effort high'));
      assert.ok(cmd.includes('--append-system-prompt'));
      assert.ok(cmd.includes('fix the bug'));
    });

    it('builds spawn command with minimal options (no skip-permissions by default)', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
      });
      assert.ok(cmd.includes('claude'));
      assert.ok(!cmd.includes('--model'));
      assert.ok(!cmd.includes('--effort'));
      assert.ok(!cmd.includes('--dangerously-skip-permissions'));
      assert.ok(!cmd.includes('-p'));
    });

    it('builds spawn command with skip-permissions when explicitly enabled', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
        dangerouslySkipPermissions: true,
      });
      assert.ok(cmd.includes('--dangerously-skip-permissions'));
    });

    it('omits optional flags when undefined', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
        model: undefined,
        thinking: undefined,
        task: undefined,
        appendSystemPrompt: undefined,
      });
      assert.equal(cmd, 'claude');
    });

    it('builds spawn command with pre-set session ID', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });
      assert.ok(cmd.includes('--session-id'));
      assert.ok(cmd.includes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    });

    it('omits --session-id when not provided', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'test-agent',
        cwd: '/tmp/test',
      });
      assert.ok(!cmd.includes('--session-id'));
    });

    it('builds resume command with session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'test-agent',
        sessionId: 'abc-123',
        cwd: '/tmp/test',
      });
      assert.ok(cmd.includes('--resume'));
      assert.ok(cmd.includes('abc-123'));
    });

    it('builds resume command with --dangerously-skip-permissions', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'test-agent',
        sessionId: 'abc-123',
        cwd: '/tmp/test',
        dangerouslySkipPermissions: true,
      });
      assert.ok(cmd.includes('--dangerously-skip-permissions'));
      assert.ok(cmd.includes('--resume'));
      assert.ok(cmd.includes('abc-123'));
    });

    it('resume command omits --dangerously-skip-permissions when false', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'test-agent',
        sessionId: 'abc-123',
        cwd: '/tmp/test',
        dangerouslySkipPermissions: false,
      });
      assert.ok(!cmd.includes('--dangerously-skip-permissions'));
    });

    it('resume command pins --model when a model is configured', () => {
      // Without an explicit --model, `claude --resume` inherits the model persisted
      // in the session transcript (which can be a poisoned CLI-default). The pin
      // makes the resumed model deterministic == configured.
      const cmd = adapter.buildResumeCommand({
        name: 'test-agent',
        sessionId: 'abc-123',
        cwd: '/tmp/test',
        model: 'claude-sonnet-5',
      });
      assert.ok(cmd.includes('--model claude-sonnet-5'));
      assert.ok(cmd.includes('--resume'));
    });

    it('resume command omits --model when no model configured (negative control)', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'test-agent',
        sessionId: 'abc-123',
        cwd: '/tmp/test',
      });
      assert.ok(!cmd.includes('--model'));
    });

    it('REJECTS a shell-unsafe model token rather than pushing it raw (spawn + resume)', () => {
      const evil = 'x; rm -rf / #';
      const spawn = adapter.buildSpawnCommand({ name: 'a', cwd: '/tmp', model: evil, sessionId: 'sid' });
      const resume = adapter.buildResumeCommand({ name: 'a', cwd: '/tmp', model: evil, sessionId: 'sid' });
      assert.ok(!spawn.includes('--model'), 'malformed model must not reach the spawn argv');
      assert.ok(!resume.includes('--model'), 'malformed model must not reach the resume argv');
      assert.ok(!spawn.includes('rm -rf'), 'no injection payload in the command');
    });

    it('builds exit command', () => {
      assert.equal(adapter.buildExitCommand(), '/exit');
    });

    it('builds compact command', () => {
      assert.equal(adapter.buildCompactCommand(), '/compact');
    });

    it('builds rename command', () => {
      const cmd = adapter.buildRenameCommand('my-agent');
      assert.equal(cmd, '/rename my-agent');
    });

    it('returns interrupt keys', () => {
      const keys = adapter.interruptKeys();
      assert.ok(keys.length > 0);
      assert.ok(keys.every(k => k === 'Escape'));
    });

    it('buildSubmitCommand returns task text', () => {
      assert.equal(adapter.buildSubmitCommand('do the thing'), 'do the thing');
    });

    it('extractSessionId returns null (Claude uses --session-id at spawn)', () => {
      assert.equal(adapter.extractSessionId('any pane output'), null);
    });

    it('buildDetectSessionCommand returns null (Claude pre-generates UUIDs)', () => {
      assert.equal(adapter.buildDetectSessionCommand('/some/cwd'), null);
    });

    it('detects idle state from ASCII > prompt', () => {
      assert.equal(adapter.detectIdleState('some output\n> '), 'waiting_for_input');
    });

    it('detects idle state from Unicode ❯ prompt', () => {
      assert.equal(adapter.detectIdleState('some output\n❯ '), 'waiting_for_input');
      assert.equal(adapter.detectIdleState('some output\n❯'), 'waiting_for_input');
    });

    it('detects idle state from prompt with placeholder hints (v2.1.139+)', () => {
      const pane = [
        '  What would you like to work on?',
        '',
        '──────────── ▪▪▪ ─',
        '❯ Try "how do I log an error?"',
        '────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)              ◉',
      ].join('\n');
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects idle state skipping context-left and Remote Control status bar', () => {
      const pane = [
        '  Standing by for new tasks.',
        '',
        '──────────── ▪▪▪ ─',
        '❯ ',
        '────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cyc…      155377 tokens Remote Control reconnecting',
        '                                                       Context left until auto-compact: 7%',
        '                                                          current: 2.1.70 · latest: 2.1.71',
      ].join('\n');
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects idle state skipping status bar lines', () => {
      // Real Claude Code v2.x output: status bar at bottom, prompt above it
      const pane = [
        '  What would you like to work on?',
        '',
        '──────────────────────────── ▪▪▪ ─',
        '❯ ',
        '────────────────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cyc…      /ide for Visual Studio Code',
        '                                                                  15048 tokens',
        '                                               current: 2.1.70 · latest: 2.1.…',
      ].join('\n');
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects running state from spinner', () => {
      assert.equal(adapter.detectIdleState('some output\n⠋ Running task...'), 'running_tool');
    });

    it('detects running state from tool name', () => {
      assert.equal(adapter.detectIdleState('some output\n  Bash git status'), 'running_tool');
    });

    it('returns unknown for ambiguous output', () => {
      assert.equal(adapter.detectIdleState('some random text'), 'unknown');
    });

    it('parses context percent from percentage format', () => {
      const result = adapter.parseContextPercent('some output\n45% context remaining\nmore text');
      assert.equal(result.contextPct, 45);
      assert.equal(result.confident, true);
    });

    // GAP-122: the Claude TUI occupancy line drifted ~2026-10-13 (under a steady .296 binary =
    // a server/Statsig render change) from "Context left until auto-compact: N%" (% AFTER the
    // phrase) to "N% until auto-compact" (% BEFORE, still % REMAINING → occupancy = 100 - N).
    // The old regex missed the new format → context_pct went null fleet-wide for ~3 weeks.
    it('GAP-122: parses the drifted "N% until auto-compact" occupancy format (% remaining → 100-N)', () => {
      // live sample (PepperPotts): "1% until auto-compact" = 1% headroom left = 99% occupied
      assert.equal(adapter.parseContextPercent('        1% until auto-compact').contextPct, 99);
      assert.equal(adapter.parseContextPercent('  15% until auto-compact').contextPct, 85);
      // tolerant of an optional word between the % and the phrase ("left"/"remaining")
      assert.equal(adapter.parseContextPercent('  8% left until auto-compact').contextPct, 92);
    });

    it('GAP-122: still parses the OLD "Context left until auto-compact: N%" format (kept)', () => {
      assert.equal(
        adapter.parseContextPercent('   Context left until auto-compact: 7%').contextPct,
        93,
      );
    });

    // GAP-122 HARDENING (the FP that bit prod): the first fix was UNANCHORED and false-captured
    // the occupancy phrase out of PROSE — a literal "1% until auto-compact" quoted MID-SENTENCE in
    // a collab message rendered in an agent's pane parsed as context_pct=99 (3 agents, + a false
    // GAP-118 alert). Anchor the match to the WHOLE trimmed line (standalone status-bar indicator).
    it('GAP-122 harden: DIGIT prose mid-sentence ("1% until auto-compact" in a message) MUST null', () => {
      // the exact shape that bit us — our own collab-message text in a pane
      assert.equal(adapter.parseContextPercent('  written 1% until auto-compact repeatedly').contextPct, null);
      assert.equal(adapter.parseContextPercent('PepperPotts at 1% until auto-compact now, 99% occupied').contextPct, null);
      assert.equal(adapter.parseContextPercent('showing "1% until auto-compact" as the drifted format').contextPct, null);
      // literal-N% prose also null (no digit)
      assert.equal(adapter.parseContextPercent('the "N% until auto-compact" format drifted').contextPct, null);
      // OLD-format prose embedded in a sentence also must null now (anchored)
      assert.equal(adapter.parseContextPercent('the Context left until auto-compact: 7% line moved').contextPct, null);
    });

    it('GAP-122 harden: a REAL standalone right-aligned status-bar line still captures', () => {
      // genuine PepperPotts shape: right-aligned, the indicator is the whole (trimmed) line
      assert.equal(adapter.parseContextPercent('                                   1% until auto-compact').contextPct, 99);
      assert.equal(adapter.parseContextPercent('        15% until auto-compact').contextPct, 85);
      assert.equal(adapter.parseContextPercent('   Context left until auto-compact: 7%').contextPct, 93);
    });

    // GAP-012/097: a CUMULATIVE "tokens" figure is recorded as totalTokens (never
    // divided by 200k to fabricate a context %; contextPct stays null). GAP-097: the
    // cumulative figure is the "new task? /clear to save NNN[kKmM] tokens" line ONLY —
    // a bare "N tokens" is the TRANSIENT per-turn streaming counter (resets each turn)
    // and must NOT be captured as cumulative. (The pre-GAP-097 "↓ Nk tokens"/bare
    // Gusting/Working fixtures were an older Claude-CLI status-bar format — GAP-006 —
    // no longer emitted; the live v2.x cumulative line is "/clear to save".)
    it('records the /clear-to-save cumulative count as totalTokens, contextPct null', () => {
      const result = adapter.parseContextPercent('some output\n            new task? /clear to save 15048 tokens');
      assert.equal(result.contextPct, null);
      assert.equal(result.totalTokens, 15048);
      assert.equal(result.confident, true);
    });

    it('does not derive a context % from a large cumulative token count', () => {
      const result = adapter.parseContextPercent('  new task? /clear to save 160000 tokens');
      assert.equal(result.contextPct, null);
      assert.equal(result.totalTokens, 160000);
      assert.equal(result.confident, true);
    });

    it('parses k-suffix cumulative count (24.9k → 24900)', () => {
      const result = adapter.parseContextPercent('  new task? /clear to save 24.9k tokens');
      assert.equal(result.contextPct, null);
      assert.equal(result.totalTokens, 24900);
    });

    it('parses K-suffix cumulative count (150K → 150000)', () => {
      const result = adapter.parseContextPercent('  new task? /clear to save 150K tokens');
      assert.equal(result.totalTokens, 150000);
    });

    it('parses decimal k-suffix cumulative count (88.5k → 88500)', () => {
      const result = adapter.parseContextPercent('  new task? /clear to save 88.5k tokens');
      assert.equal(result.totalTokens, 88500);
    });

    // GAP-125: a pending-update NAG ("✔ Update installed · Restart to update") shares the
    // status-bar line and steals its width, TRUNCATING "/clear to save 124.6k tokens" to
    // "/clear to save 124.6k to…" (the word "tokens" is cut off). The old regex required a
    // literal "tokens" suffix → no match → totalTokens went null fleet-wide from ~2026-11-03,
    // killing the token snapshots AND the 700k auto-compact backstop. The number+unit is the
    // signal; the trailing "tokens" word is redundant and now unreliable.
    it('GAP-125: parses the NAG-truncated "/clear to save N.Nk to…" line (tokens word cut off)', () => {
      const real = '  new task? /clear to save 124.6k to… · ✔ Update installed · Restart to update';
      assert.equal(adapter.parseContextPercent(real).totalTokens, 124600);
      assert.equal(adapter.parseContextPercent(real).contextPct, null);
      // truncation with no trailing chrome at all
      assert.equal(adapter.parseContextPercent('  new task? /clear to save 127.2k to…').totalTokens, 127200);
      // whole-number truncated form
      assert.equal(adapter.parseContextPercent('new task? /clear to save 718k to…').totalTokens, 718000);
    });

    // GAP-125 false-MATCH guard (the GAP-122 leg-2 lesson: this branch feeds the 700k ACTION
    // gate, so a WIDENING must be checked for false MATCHES, not just no-match fail-safe). The
    // truncation-tolerant match is anchored to the status-bar chrome at the START of the trimmed
    // line, so "/clear to save N…" quoted MID-SENTENCE in a collab message does NOT capture.
    it('GAP-125 guard: "/clear to save Nk" embedded in prose MUST NOT capture', () => {
      assert.equal(adapter.parseContextPercent('I told them to run /clear to save 5k to free space').totalTokens, undefined);
      assert.equal(adapter.parseContextPercent('the "/clear to save 718k to…" line is truncated').totalTokens, undefined);
    });

    // GAP-097: the TRANSIENT per-turn streaming counter (bare "N tokens", no
    // "/clear to save" anchor) must NOT be captured as cumulative — it resets each
    // turn and sawtooths, which broke the auto-compact gate + the GAP-012 floor.
    it('GAP-097: does NOT capture a transient streaming "N tokens" counter', () => {
      const result = adapter.parseContextPercent('✻ Cooked for 2s · esc to interrupt · 16800 tokens');
      assert.equal(result.totalTokens, undefined, 'bare transient counter must not be captured as cumulative');
    });

    // GAP-012 live-defect regression: the v2.x idle status bar shows
    // "new task? /clear to save 202k tokens" — a CUMULATIVE figure that exceeds
    // the window and pinned ctx% to a false 100. Must be totalTokens only.
    it('does not fabricate 100% from the "/clear to save Nk tokens" idle hint', () => {
      const result = adapter.parseContextPercent('                          new task? /clear to save 202k tokens');
      assert.equal(result.contextPct, null);
      assert.equal(result.totalTokens, 202000);
      assert.equal(result.confident, true);
    });

    // GAP-012: the ONE genuine current-window occupancy signal Claude exposes.
    // "Context left until auto-compact: N%" reports REMAINING headroom, so
    // occupancy used = 100 - N (a near-full "7%" must read as 93, not 7).
    it('parses genuine occupancy from "Context left until auto-compact: N%" as 100 - N', () => {
      const result = adapter.parseContextPercent('  ⏵⏵ bypass permissions on\n                       Context left until auto-compact: 7%');
      assert.equal(result.contextPct, 93);
      assert.equal(result.confident, true);
    });

    // Decoupling: when both a cumulative token line and a genuine occupancy line
    // are present, contextPct comes from the occupancy line, totalTokens from the
    // token line — the two quantities are recorded independently.
    it('decouples occupancy % (from the auto-compact line) from cumulative totalTokens', () => {
      const pane = [
        '  new task? /clear to save 202k tokens',
        '                       Context left until auto-compact: 10%',
      ].join('\n');
      const result = adapter.parseContextPercent(pane);
      assert.equal(result.contextPct, 90);
      assert.equal(result.totalTokens, 202000);
      assert.equal(result.confident, true);
    });

    it('returns null context for no match', () => {
      const result = adapter.parseContextPercent('no context info here');
      assert.equal(result.contextPct, null);
      assert.equal(result.confident, false);
    });
  });

  describe('CodexAdapter', () => {
    const adapter = new CodexAdapter();

    it('builds spawn command with model and task', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        model: 'gpt-4',
        task: 'hello world',
      });
      assert.ok(cmd.includes('codex'));
      assert.ok(cmd.includes('--model gpt-4'));
      assert.ok(cmd.includes('hello world'));
    });

    it('always includes --dangerously-bypass-approvals-and-sandbox', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
      });
      assert.ok(cmd.includes('--dangerously-bypass-approvals-and-sandbox'), 'should include bypass flag');
      assert.ok(cmd.includes('--no-alt-screen'), 'should include --no-alt-screen');
      assert.ok(!cmd.includes('-a never'), 'should not use old -a flag');
      assert.ok(!cmd.includes('-s danger-full-access'), 'should not use old -s flag');
    });

    it('supports resume prompt', () => {
      assert.equal(adapter.supportsResumePrompt, true);
    });

    it('resume command pins --model before the resume subcommand (class-closure)', () => {
      const cmd = adapter.buildResumeCommand({ name: 'codex-agent', cwd: '/tmp', sessionId: 'sess-1', model: 'gpt-4' });
      assert.ok(cmd.includes('--model gpt-4'), 'codex resume should carry --model');
      // --model is a top-level flag, before the `resume` subcommand.
      assert.ok(cmd.indexOf('--model') < cmd.indexOf('resume'), '--model precedes the resume subcommand');
      assert.ok(cmd.includes('sess-1'));
    });

    it('resume command omits --model when unset or malformed', () => {
      const none = adapter.buildResumeCommand({ name: 'codex-agent', cwd: '/tmp', sessionId: 'sess-1' });
      const evil = adapter.buildResumeCommand({ name: 'codex-agent', cwd: '/tmp', sessionId: 'sess-1', model: 'x; rm -rf /' });
      assert.ok(!none.includes('--model'));
      assert.ok(!evil.includes('--model'));
    });

    it('builds spawn command with -p profile when appendSystemPrompt is set', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        appendSystemPrompt: 'You are a helpful assistant',
      });
      // Profile-based injection: -p <agent-name>, NOT -c developer_instructions
      assert.ok(cmd.includes('-p codex-agent'));
      assert.ok(!cmd.includes('-c'));
      assert.ok(!cmd.includes('developer_instructions'));
    });

    it('omits -p flag when appendSystemPrompt is undefined', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
      });
      assert.ok(!cmd.includes('-p'));
      assert.ok(!cmd.includes('-c'));
    });

    it('has usesConfigProfile set to true', () => {
      assert.equal(adapter.usesConfigProfile, true);
    });

    it('omits optional flags when undefined', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        model: undefined,
        task: undefined,
        thinking: undefined,
      });
      assert.equal(cmd, 'codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen');
    });

    it('ignores thinking (codex has no reasoning effort flag)', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'codex-agent',
        cwd: '/tmp',
        thinking: 'high',
      });
      assert.ok(!cmd.includes('thinking'));
      assert.ok(!cmd.includes('effort'));
      assert.ok(!cmd.includes('variant'));
      assert.ok(!cmd.includes('high'));
    });

    it('builds resume with session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        sessionId: 'xyz-123',
        cwd: '/tmp',
        task: 'continue',
      });
      assert.ok(cmd.includes('codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen resume'));
      assert.ok(cmd.includes('xyz-123'));
    });

    it('builds resume with --last when no session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        cwd: '/tmp',
      });
      assert.ok(cmd.includes('--last'));
    });

    it('builds resume command with -p profile when appendSystemPrompt is set', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        sessionId: 'xyz-123',
        cwd: '/tmp',
        appendSystemPrompt: 'You are a code reviewer',
      });
      assert.ok(cmd.includes('codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen resume'));
      assert.ok(cmd.includes('xyz-123'));
      assert.ok(cmd.includes('-p codex-agent'));
      assert.ok(!cmd.includes('-c'));
    });

    it('omits -p flag on resume when appendSystemPrompt is undefined', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'codex-agent',
        sessionId: 'xyz-123',
        cwd: '/tmp',
      });
      assert.ok(!cmd.includes('-p'));
      assert.ok(!cmd.includes('-c'));
    });

    it('returns null for rename', () => {
      assert.equal(adapter.buildRenameCommand('test'), null);
    });

    it('builds exit command', () => {
      assert.equal(adapter.buildExitCommand(), '/exit');
    });

    it('returns null for compact (Codex has no compaction support)', () => {
      assert.equal(adapter.buildCompactCommand(), null);
    });

    it('returns interrupt keys', () => {
      const keys = adapter.interruptKeys();
      assert.ok(keys.length > 0);
      assert.ok(keys.every(k => k === 'Escape'));
    });

    it('detects idle state from ASCII > prompt', () => {
      assert.equal(adapter.detectIdleState('output\n> '), 'waiting_for_input');
    });

    it('detects idle state from Unicode › prompt', () => {
      assert.equal(adapter.detectIdleState('output\n› Implement {feature}'), 'waiting_for_input');
      assert.equal(adapter.detectIdleState('output\n› '), 'waiting_for_input');
      assert.equal(adapter.detectIdleState('output\n›'), 'waiting_for_input');
    });

    it('detects idle from prompt with status bar below', () => {
      const pane = '› Implement {feature}\n\n  gpt-5.4 xhigh · 81% left · ~/Desktop';
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects idle from prompt with "context left" status bar', () => {
      const pane = '› \n\n  tab to queue message                                                  83% context left';
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects running from Working indicator above prompt', () => {
      const pane = [
        '◦ Working (32s • esc to interrupt)',
        '',
        '› [Pasted Content]',
        '',
        '  tab to queue message                                                  79% context left',
      ].join('\n');
      assert.equal(adapter.detectIdleState(pane), 'running_tool');
    });

    it('detects running from bullet Working indicator', () => {
      const pane = '• Working (1m 14s • esc to interrupt)\n› queued msg\n  83% context left';
      assert.equal(adapter.detectIdleState(pane), 'running_tool');
    });

    it('detects running state from spinner', () => {
      assert.equal(adapter.detectIdleState('output\n⠋ Running...'), 'running_tool');
    });

    it('returns unknown for ambiguous output', () => {
      assert.equal(adapter.detectIdleState('random text'), 'unknown');
    });

    it('parses context percent from status bar', () => {
      const result = adapter.parseContextPercent('gpt-5.4 xhigh · 81% left · ~/Desktop');
      assert.equal(result.contextPct, 19); // 100 - 81 = 19% used
      assert.equal(result.confident, true);
    });

    it('parses context percent from low remaining', () => {
      const result = adapter.parseContextPercent('gpt-5.4 · 15% left · ~/path');
      assert.equal(result.contextPct, 85);
      assert.equal(result.confident, true);
    });

    it('parses context percent from "context left" variant', () => {
      const result = adapter.parseContextPercent('tab to queue message                                                  83% context left');
      assert.equal(result.contextPct, 17);
      assert.equal(result.confident, true);
    });

    it('returns null context when no match', () => {
      const result = adapter.parseContextPercent('no context info');
      assert.equal(result.contextPct, null);
      assert.equal(result.confident, false);
    });

    it('detects idle state from Unicode ❯ prompt', () => {
      assert.equal(adapter.detectIdleState('output\n❯ '), 'waiting_for_input');
      assert.equal(adapter.detectIdleState('output\n❯'), 'waiting_for_input');
    });

    it('detects idle from ❯ prompt with tokens/version status bar', () => {
      const pane = [
        '● Status sent to dashboard. Standing by.',
        '',
        '────────────────────────────────────────────────────────────────────────── ▪▪▪ ─',
        '❯ ',
        '────────────────────────────────────────────────────────────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cyc…                     44091 tokens',
        '                                               current: 2.1.71 · latest: 2.1.…',
      ].join('\n');
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('buildSubmitCommand returns task text', () => {
      assert.equal(adapter.buildSubmitCommand('implement feature X'), 'implement feature X');
    });

    it('extractSessionId returns null (Codex falls back to --last)', () => {
      assert.equal(adapter.extractSessionId('any codex output'), null);
    });

    it('buildDetectSessionCommand returns ls command for codex sessions', () => {
      const cmd = adapter.buildDetectSessionCommand('/home/user/project');
      assert.ok(cmd, 'should return a command');
      assert.ok(cmd!.includes('.codex/sessions'), 'should reference codex sessions directory');
      assert.ok(cmd!.includes('basename'), 'should strip path to get UUID');
    });
  });

  describe('OpenCodeAdapter', () => {
    const adapter = new OpenCodeAdapter();

    it('builds spawn command for TUI mode (no run subcommand)', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'oc-agent',
        cwd: '/tmp',
        model: 'claude-3.5',
      });
      assert.equal(cmd, 'opencode -m claude-3.5');
      assert.ok(!cmd.includes('run'));
    });

    it('builds spawn command without task (TUI launches empty)', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'oc-agent',
        cwd: '/tmp',
      });
      assert.equal(cmd, 'opencode');
    });

    it('builds spawn command with variant for thinking', () => {
      const cmd = adapter.buildSpawnCommand({
        name: 'oc-agent',
        cwd: '/tmp',
        thinking: 'high',
      });
      assert.equal(cmd, 'opencode --variant high');
    });

    it('REJECTS a shell-unsafe model token on spawn rather than pushing -m raw', () => {
      const cmd = adapter.buildSpawnCommand({ name: 'oc', cwd: '/tmp', model: 'x; rm -rf /' });
      assert.ok(!cmd.includes('-m'), 'malformed model must not reach the -m argv');
      assert.ok(!cmd.includes('rm -rf'), 'no injection payload in the command');
    });

    it('pins the model with -m on resume (class-closure) and rejects malformed', () => {
      const ok = adapter.buildResumeCommand({ name: 'oc', cwd: '/tmp', sessionId: 'ses_1', model: 'claude-3.5' });
      const evil = adapter.buildResumeCommand({ name: 'oc', cwd: '/tmp', sessionId: 'ses_1', model: 'x; rm -rf /' });
      assert.ok(ok.includes('-m claude-3.5'), 'resume should carry -m for a valid model');
      assert.ok(ok.includes('-s ses_1'));
      assert.ok(!evil.includes('-m'), 'malformed model must not reach the resume argv');
    });

    it('builds resume with -s for session ID', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'oc-agent',
        sessionId: 'ses_abc123',
        cwd: '/tmp',
      });
      assert.equal(cmd, 'opencode -s ses_abc123');
    });

    it('falls back to plain opencode when no session ID (no -c in TUI mode)', () => {
      const cmd = adapter.buildResumeCommand({
        name: 'oc-agent',
        cwd: '/tmp',
      });
      assert.equal(cmd, 'opencode');
      assert.ok(!cmd.includes('-c'));
    });

    it('returns null for rename', () => {
      assert.equal(adapter.buildRenameCommand('test'), null);
    });

    it('provides exit keys (Ctrl-C)', () => {
      const keys = adapter.exitKeys!();
      assert.deepStrictEqual(keys, ['C-c']);
    });

    it('provides compact keys (Ctrl-X C)', () => {
      const keys = adapter.compactKeys!();
      assert.deepStrictEqual(keys, ['C-x', 'c']);
    });

    it('returns interrupt keys (single Escape)', () => {
      const keys = adapter.interruptKeys();
      assert.deepStrictEqual(keys, ['Escape']);
    });

    it('detects idle from TUI status bar', () => {
      const pane = 'some output\n  ctrl+t variants  tab agents  ctrl+p commands';
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects idle from Ask anything placeholder', () => {
      const pane = 'output\n  Ask anything... "Fix a TODO in the codebase"';
      assert.equal(adapter.detectIdleState(pane), 'waiting_for_input');
    });

    it('detects running from esc interrupt indicator', () => {
      const pane = 'output\n  esc interrupt                    ctrl+t variants';
      assert.equal(adapter.detectIdleState(pane), 'running_tool');
    });

    it('detects running state from spinner', () => {
      assert.equal(adapter.detectIdleState('output\n⠋ Running...'), 'running_tool');
    });

    it('returns unknown for ambiguous output', () => {
      assert.equal(adapter.detectIdleState('random text'), 'unknown');
    });

    it('parses context percent from TUI sidebar', () => {
      const pane = 'Context\n  11,371 tokens\n  6% used\n  $0.00 spent';
      const result = adapter.parseContextPercent(pane);
      assert.equal(result.contextPct, 6);
      assert.equal(result.confident, true);
    });

    it('returns null context when no percentage visible', () => {
      const result = adapter.parseContextPercent('anything');
      assert.equal(result.contextPct, null);
    });

    it('buildSubmitCommand returns task text', () => {
      assert.equal(adapter.buildSubmitCommand('fix the bug'), 'fix the bug');
    });

    it('extracts session ID from exit output', () => {
      const pane = 'Session   TUICHECK\n  Continue  opencode -s ses_32f35bf21ffeHDy7IvecACDwDY\nsammons@host:~$';
      assert.equal(adapter.extractSessionId(pane), 'ses_32f35bf21ffeHDy7IvecACDwDY');
    });

    it('returns null session ID when not present', () => {
      assert.equal(adapter.extractSessionId('any opencode output'), null);
    });

    it('buildDetectSessionCommand returns null (OpenCode uses pane parsing)', () => {
      assert.equal(adapter.buildDetectSessionCommand('/some/cwd'), null);
    });
  });
});
