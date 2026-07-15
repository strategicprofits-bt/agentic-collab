import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';
import { HealthMonitor } from './health-monitor.ts';
import { MessageDispatcher } from './message-dispatcher.ts';

describe('HealthMonitor', () => {
  let db: Database;
  let tmpDir: string;
  let proxyCommands: ProxyCommand[];
  let captureOutput: string;
  const monitors: HealthMonitor[] = [];

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'health-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    proxyCommands = [];
    captureOutput = '> \n';
  });

  afterEach(() => {
    for (const m of monitors) m.stop();
    monitors.length = 0;
  });

  function makeMonitor(overrides?: Partial<ConstructorParameters<typeof HealthMonitor>[0]>): HealthMonitor {
    const dispatch = overrides?.proxyDispatch ?? (async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      proxyCommands.push(command);
      if (command.action === 'capture') {
        return { ok: true, data: captureOutput };
      }
      if (command.action === 'has_session') {
        return { ok: true, data: true };
      }
      return { ok: true };
    });

    const locks = new LockManager(db.rawDb);

    const monitor = new HealthMonitor({
      db,
      locks,
      proxyDispatch: dispatch,
      orchestratorHost: 'http://localhost:3000',
      pollIntervalMs: 100,
      ...overrides,
    });
    monitors.push(monitor);
    return monitor;
  }

  /** Ensure an agent is in active state for testing. */
  function ensureActive(name: string): void {
    const a = db.getAgent(name);
    if (a && a.state !== 'active') {
      db.updateAgentState(name, 'active', a.version, {
        proxyId: 'p1',
        tmuxSession: `agent-${name}`,
      });
    }
  }

  it('starts and stops without error', () => {
    const monitor = makeMonitor();
    monitor.start();
    monitor.start(); // idempotent
    monitor.stop();
    monitor.stop(); // idempotent
  });

  it('polls active agents and captures pane output', async () => {
    db.createAgent({ name: 'health-a1', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-a1')!;
    db.updateAgentState('health-a1', 'active', a.version, {
      tmuxSession: 'agent-health-a1',
      proxyId: 'p1',
    });

    const monitor = makeMonitor();
    await monitor.pollAll();

    assert.ok(proxyCommands.some(c => c.action === 'capture'));
  });

  it('skips void/suspended agents', async () => {
    db.createAgent({ name: 'health-void', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });

    const monitor = makeMonitor();
    proxyCommands = [];
    await monitor.pollAll();

    // Only health-a1 (active) should be polled, not health-void (void)
    const captureForVoid = proxyCommands.filter(
      c => c.action === 'capture' && 'sessionName' in c && c.sessionName.includes('health-void'),
    );
    assert.equal(captureForVoid.length, 0);
  });

  it('detects idle via screen-diff (unchanged output across polls)', async () => {
    ensureActive('health-a1');
    captureOutput = 'some output\n> '; // static output

    // Same monitor instance for both polls — screen-diff state is per-instance
    const monitor = makeMonitor();

    // First poll — establishes baseline, no transition yet
    await monitor.pollAll();
    assert.equal(db.getAgent('health-a1')?.state, 'active', 'still active after first poll (baseline)');

    // Second poll — same output → not yet at IDLE_THRESHOLD
    await monitor.pollAll();
    assert.equal(db.getAgent('health-a1')?.state, 'active', 'still active after 2 polls (threshold=2)');

    // Third poll — same output → IDLE_THRESHOLD reached → idle
    await monitor.pollAll();
    assert.equal(db.getAgent('health-a1')?.state, 'idle', 'idle after 3 consecutive unchanged polls');
  });

  it('detects active transition when screen changes', async () => {
    // Agent should be idle from previous test
    const a = db.getAgent('health-a1')!;
    assert.equal(a.state, 'idle', 'precondition: agent should be idle');

    // Start with same output to establish baseline, then change it
    captureOutput = 'some output\n> '; // same as last test
    const monitor = makeMonitor();
    await monitor.pollAll(); // baseline with current output

    // Now change the output — this should trigger active transition
    captureOutput = 'new output\n⠋ Processing...';
    await monitor.pollAll();

    const agent = db.getAgent('health-a1');
    assert.equal(agent?.state, 'active');
  });

  it('marks agent failed when capture fails', async () => {
    db.createAgent({ name: 'health-fail', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-fail')!;
    db.updateAgentState('health-fail', 'active', a.version, {
      tmuxSession: 'agent-health-fail',
      proxyId: 'p1',
    });

    const failDispatch = async () => ({ ok: false as const, error: 'Session not found' });
    const failMonitor = makeMonitor({ proxyDispatch: failDispatch });

    // Requires 3 consecutive failures before marking as failed
    await failMonitor.pollAll();
    assert.equal(db.getAgent('health-fail')?.state, 'active', 'still active after 1 failure');
    await failMonitor.pollAll();
    assert.equal(db.getAgent('health-fail')?.state, 'active', 'still active after 2 failures');
    await failMonitor.pollAll();

    const agent = db.getAgent('health-fail');
    assert.equal(agent?.state, 'failed');
    assert.ok(agent?.failureReason?.includes('Health check failed'));
  });

  it('fires onAgentUpdate callback on state transitions', async () => {
    const updates: string[] = [];
    ensureActive('health-a1');
    captureOutput = 'stable output\nprompt> '; // will be same across polls

    const monitor = makeMonitor({
      onAgentUpdate: (name) => updates.push(name),
    });

    // Need 3 polls with same output for idle transition (baseline + IDLE_THRESHOLD=2)
    await monitor.pollAll();
    await monitor.pollAll();
    await monitor.pollAll();

    assert.ok(updates.includes('health-a1'));
  });

  it('fires onAgentUpdate on capture failure', async () => {
    db.createAgent({ name: 'health-cb-fail', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-cb-fail')!;
    db.updateAgentState('health-cb-fail', 'active', a.version, {
      tmuxSession: 'agent-health-cb-fail',
      proxyId: 'p1',
    });

    const updates: string[] = [];
    const cbFailDispatch = async () => ({ ok: false as const, error: 'Session not found' });
    const failMonitor = makeMonitor({
      proxyDispatch: cbFailDispatch,
      onAgentUpdate: (name) => updates.push(name),
    });

    // Requires 3 consecutive failures before marking as failed
    await failMonitor.pollAll();
    assert.ok(!updates.includes('health-cb-fail'), 'should not fail after 1 attempt');
    await failMonitor.pollAll();
    assert.ok(!updates.includes('health-cb-fail'), 'should not fail after 2 attempts');
    await failMonitor.pollAll();
    assert.ok(updates.includes('health-cb-fail'), 'should fail after 3 attempts');
  });

  it('records context % without triggering compact or reload', async () => {
    db.createAgent({ name: 'health-compact', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-compact')!;
    db.updateAgentState('health-compact', 'active', a.version, {
      tmuxSession: 'agent-health-compact',
      proxyId: 'p1',
    });

    captureOutput = 'some output\n95% context remaining\n> ';

    const monitor = makeMonitor();
    proxyCommands = [];
    await monitor.pollAll();

    // Context % should be recorded in DB
    const updated = db.getAgent('health-compact')!;
    assert.equal(updated.lastContextPct, 95);

    // No compact or reload actions — only capture commands
    const nonCapture = proxyCommands.filter(c => c.action !== 'capture' && c.action !== 'pane_activity');
    assert.equal(nonCapture.length, 0, 'should not send any compact/reload commands');
  });

  it('fires onMessageDelivered callback after successful delivery', async () => {
    db.createAgent({ name: 'health-cb-deliver', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-cb-deliver')!;
    db.updateAgentState('health-cb-deliver', 'active', a.version, {
      tmuxSession: 'agent-health-cb-deliver',
      proxyId: 'p1',
    });

    db.enqueueMessage({
      sourceAgent: 'sender',
      targetAgent: 'health-cb-deliver',
      envelope: '[from: sender]: callback test',
    });

    captureOutput = 'some output\n> ';

    const deliveredAgents: string[] = [];
    const locks = new LockManager(db.rawDb);
    const dispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      proxyCommands.push(command);
      if (command.action === 'capture') return { ok: true, data: captureOutput };
      if (command.action === 'has_session') return { ok: true, data: true };
      return { ok: true };
    };
    const dispatcher = new MessageDispatcher({
      db,
      locks,
      proxyDispatch: dispatch,
      orchestratorHost: 'http://localhost:3000',
      onMessageDelivered: (name) => deliveredAgents.push(name),
    });

    await dispatcher.tryDeliver('health-cb-deliver');
    assert.ok(deliveredAgents.includes('health-cb-deliver'));
  });

  it('does not deliver messages during poll (delivery is dispatcher-only)', async () => {
    db.createAgent({ name: 'health-deliver', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-deliver')!;
    db.updateAgentState('health-deliver', 'active', a.version, {
      tmuxSession: 'agent-health-deliver',
      proxyId: 'p1',
    });

    // Enqueue a message
    db.enqueueMessage({
      sourceAgent: 'other-agent',
      targetAgent: 'health-deliver',
      envelope: '[from: other-agent]: hello',
    });

    captureOutput = 'stable output for delivery\n> ';

    const monitor = makeMonitor();
    proxyCommands = [];

    // Two polls: baseline + idle detection
    await monitor.pollAll();
    await monitor.pollAll();

    // Health monitor should NOT have pasted anything — only capture + pane_activity commands
    const nonCapture = proxyCommands.filter(c => c.action !== 'capture' && c.action !== 'pane_activity' && c.action !== 'pane_activity');
    assert.equal(nonCapture.length, 0, 'health monitor should not deliver messages');
  });

  it('retries failed delivery with backoff (via dispatcher)', async () => {
    db.createAgent({ name: 'health-retry', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-retry')!;
    db.updateAgentState('health-retry', 'active', a.version, {
      tmuxSession: 'agent-health-retry',
      proxyId: 'p1',
    });

    const queued = db.enqueueMessage({
      sourceAgent: 'sender',
      targetAgent: 'health-retry',
      envelope: '[from: sender]: will fail',
    });

    captureOutput = 'retry test output\n> ';

    const retryDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'capture') return { ok: true, data: captureOutput };
      if (command.action === 'has_session') return { ok: true, data: true };
      if (command.action === 'paste') return { ok: false, error: 'tmux paste failed' };
      return { ok: true };
    };
    const retryLocks = new LockManager(db.rawDb);
    const retryDispatcher = new MessageDispatcher({
      db, locks: retryLocks, proxyDispatch: retryDispatch, orchestratorHost: 'http://localhost:3000',
    });

    // Delivery via dispatcher (not health monitor)
    await retryDispatcher.tryDeliver('health-retry');

    const updated = db.getPendingMessageById(queued.id)!;
    assert.equal(updated.retryCount, 1);
    assert.equal(updated.status, 'pending');
    assert.ok(updated.nextAttemptAt !== null);

    retryDispatcher.stop();
  });

  it('scheduleQuickPoll triggers a one-shot poll after ~1s', async () => {
    ensureActive('health-a1');
    captureOutput = 'quick-poll-test output\n> ';

    const updates: string[] = [];
    const monitor = makeMonitor({
      onAgentUpdate: (name) => updates.push(name),
    });

    // Establish baseline + build up unchangedCount with polls
    await monitor.pollAll(); // baseline
    await monitor.pollAll(); // unchangedCount = 1

    // Reset agent to active for the quick poll transition test
    ensureActive('health-a1');

    monitor.scheduleQuickPoll('health-a1');
    // Duplicate should be deduplicated
    monitor.scheduleQuickPoll('health-a1');

    // Wait for the 1s timer to fire
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));

    // Quick poll sees same output → unchangedCount reaches IDLE_THRESHOLD → idle
    const agent = db.getAgent('health-a1');
    assert.equal(agent?.state, 'idle');

    monitor.stop();
  });

  it('stop() clears pending quick poll timers', () => {
    const monitor = makeMonitor();
    monitor.scheduleQuickPoll('health-a1');
    monitor.stop(); // should not throw, timers cleared
  });

  it('auto-replies to sender on permanent failure (via dispatcher)', async () => {
    db.createAgent({ name: 'health-autoreply', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-autoreply')!;
    db.updateAgentState('health-autoreply', 'active', a.version, {
      tmuxSession: 'agent-health-autoreply',
      proxyId: 'p1',
    });

    // Enqueue and pre-fail 4 times so next failure is permanent
    const queued = db.enqueueMessage({
      sourceAgent: 'notify-me',
      targetAgent: 'health-autoreply',
      envelope: '[from: notify-me]: permanent fail',
    });
    for (let i = 0; i < 4; i++) {
      db.claimForDelivery(queued.id);
      db.markAttemptFailed(queued.id, `fail ${i + 1}`);
    }
    // Clear next_attempt_at so it's deliverable
    db.rawDb.prepare(`UPDATE pending_messages SET next_attempt_at = NULL WHERE id = ?`).run(queued.id);

    captureOutput = 'autoreply-test output\n> ';

    const autoReplyDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'capture') return { ok: true, data: captureOutput };
      if (command.action === 'has_session') return { ok: true, data: true };
      if (command.action === 'paste') return { ok: false, error: 'final failure' };
      return { ok: true };
    };
    const autoReplyLocks = new LockManager(db.rawDb);
    const autoReplyDispatcher = new MessageDispatcher({
      db, locks: autoReplyLocks, proxyDispatch: autoReplyDispatch, orchestratorHost: 'http://localhost:3000',
    });

    // Delivery via dispatcher directly (not health monitor)
    await autoReplyDispatcher.tryDeliver('health-autoreply');

    // Original message should be permanently failed
    const updated = db.getPendingMessageById(queued.id)!;
    assert.equal(updated.status, 'failed');

    // Auto-reply should be enqueued to the sender
    const senderMessages = db.getDeliverableMessages('notify-me');
    assert.ok(senderMessages.length >= 1);
    assert.ok(senderMessages.some(m => m.envelope.includes('[system]')));

    autoReplyDispatcher.stop();
  });

  it('drains queued messages after first delivery', async () => {
    db.createAgent({ name: 'health-drain', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-drain')!;
    db.updateAgentState('health-drain', 'active', a.version, {
      tmuxSession: 'agent-health-drain',
      proxyId: 'p1',
    });

    // Enqueue two messages
    const msg1 = db.enqueueMessage({ sourceAgent: 'sender', targetAgent: 'health-drain', envelope: '[from: sender]: msg1' });
    const msg2 = db.enqueueMessage({ sourceAgent: 'sender', targetAgent: 'health-drain', envelope: '[from: sender]: msg2' });

    // The dispatcher no longer waits for idle, so the drain loop can deliver immediately.
    let deliveryCount = 0;
    const drainDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'capture') {
        // After first delivery, simulate agent going active then idle again
        return { ok: true, data: 'some output\n> ' }; // always idle for test
      }
      if (command.action === 'has_session') return { ok: true, data: true };
      if (command.action === 'paste') {
        deliveryCount++;
        return { ok: true };
      }
      return { ok: true };
    };

    const drainLocks = new LockManager(db.rawDb);
    const drainDispatcher = new MessageDispatcher({
      db, locks: drainLocks, proxyDispatch: drainDispatch, orchestratorHost: 'http://localhost:3000',
    });

    // First delivery
    const delivered = await drainDispatcher.tryDeliver('health-drain');
    assert.ok(delivered, 'first message should be delivered');
    assert.equal(deliveryCount, 1);

    // Drain timer is scheduled — wait for it to fire (6s + buffer)
    await new Promise(resolve => setTimeout(resolve, 6500));

    // Second message should have been delivered by drain
    assert.equal(deliveryCount, 2);

    const updated1 = db.getPendingMessageById(msg1.id)!;
    const updated2 = db.getPendingMessageById(msg2.id)!;
    assert.equal(updated1.status, 'delivered');
    assert.equal(updated2.status, 'delivered');

    drainDispatcher.stop();
  });

  it('detects idle on first poll after self-heal (screen-diff baseline)', async () => {
    // Screen-diff needs 2 polls with same output to detect idle.
    db.createAgent({ name: 'health-selfheal', engine: 'codex', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-selfheal')!;
    db.updateAgentState('health-selfheal', 'active', a.version, {
      tmuxSession: 'agent-health-selfheal',
      proxyId: 'p1',
    });

    captureOutput = 'some output\n› ';

    const healDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'capture') return { ok: true, data: captureOutput };
      return { ok: true };
    };

    const healMonitor = makeMonitor({ proxyDispatch: healDispatch });

    // First poll establishes baseline
    await healMonitor.pollAll();
    assert.equal(db.getAgent('health-selfheal')?.state, 'active', 'still active after baseline poll');

    // Second poll — same output → not yet idle
    await healMonitor.pollAll();
    assert.equal(db.getAgent('health-selfheal')?.state, 'active', 'still active (threshold=2)');

    // Third poll — same output → idle
    await healMonitor.pollAll();
    assert.equal(db.getAgent('health-selfheal')?.state, 'idle', 'idle after 3 consecutive unchanged polls');

    healMonitor.stop();
  });

  it('stop() clears drain timers', async () => {
    db.createAgent({ name: 'health-drain-stop', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent('health-drain-stop')!;
    db.updateAgentState('health-drain-stop', 'active', a.version, {
      tmuxSession: 'agent-health-drain-stop',
      proxyId: 'p1',
    });

    db.enqueueMessage({ sourceAgent: 'sender', targetAgent: 'health-drain-stop', envelope: '[from: sender]: msg1' });
    db.enqueueMessage({ sourceAgent: 'sender', targetAgent: 'health-drain-stop', envelope: '[from: sender]: msg2' });

    let deliveryCount = 0;
    const stopDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'capture') return { ok: true, data: 'some output\n> ' };
      if (command.action === 'has_session') return { ok: true, data: true };
      if (command.action === 'paste') { deliveryCount++; return { ok: true }; }
      return { ok: true };
    };

    const stopLocks = new LockManager(db.rawDb);
    const stopDispatcher = new MessageDispatcher({
      db, locks: stopLocks, proxyDispatch: stopDispatch, orchestratorHost: 'http://localhost:3000',
    });

    await stopDispatcher.tryDeliver('health-drain-stop');
    assert.equal(deliveryCount, 1);

    // Stop before drain fires
    stopDispatcher.stop();

    await new Promise(resolve => setTimeout(resolve, 6500));
    // Should still be 1 — drain was cancelled
    assert.equal(deliveryCount, 1);
  });

  it('detects CLI exit to bare shell prompt and marks agent failed', async () => {
    const agentName = 'health-cli-exit';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'active', a.version, { tmuxSession: `agent-${agentName}` });

    // Pane output shows "No conversation found" and a bash prompt
    captureOutput = [
      'No conversation found with session ID: 353062a5-fe5b-4305-bb7c-ab9d09ce492b',
      'sammons@crankshaft:~/Desktop/claude_home$ ',
    ].join('\n');

    const monitor = makeMonitor();

    // First poll: increments counter but doesn't fail yet (need 2 consecutive)
    await monitor.pollAgent(db.getAgent(agentName)!);
    assert.equal(db.getAgent(agentName)!.state, 'active');

    // Second poll: confirms CLI exit, marks as failed
    ensureActive(agentName);
    await monitor.pollAgent(db.getAgent(agentName)!);
    const final = db.getAgent(agentName)!;
    assert.equal(final.state, 'failed');
    assert.ok(final.failureReason?.includes('session not found'));
  });

  it('detects zsh prompt (macOS default)', async () => {
    const agentName = 'health-cli-exit-zsh';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'active', a.version, { tmuxSession: `agent-${agentName}` });

    captureOutput = 'user@macbook ~ % \n';

    const monitor = makeMonitor();
    await monitor.pollAgent(db.getAgent(agentName)!);
    ensureActive(agentName);
    await monitor.pollAgent(db.getAgent(agentName)!);
    assert.equal(db.getAgent(agentName)!.state, 'failed');
  });

  it('detects root prompt', async () => {
    const agentName = 'health-cli-exit-root';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'active', a.version, { tmuxSession: `agent-${agentName}` });

    captureOutput = 'root@server:~# \n';

    const monitor = makeMonitor();
    await monitor.pollAgent(db.getAgent(agentName)!);
    ensureActive(agentName);
    await monitor.pollAgent(db.getAgent(agentName)!);
    assert.equal(db.getAgent(agentName)!.state, 'failed');
  });

  it('detects exit message even without shell prompt match', async () => {
    const agentName = 'health-cli-exit-msg';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'active', a.version, { tmuxSession: `agent-${agentName}` });

    // Exotic prompt format but clear exit message
    captureOutput = 'No conversation found with session ID: abc-123\n→ \n';

    const monitor = makeMonitor();
    await monitor.pollAgent(db.getAgent(agentName)!);
    ensureActive(agentName);
    await monitor.pollAgent(db.getAgent(agentName)!);
    assert.equal(db.getAgent(agentName)!.state, 'failed');
  });

  it('does not false-positive on normal Claude prompt', async () => {
    const agentName = 'health-no-false-pos';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'active', a.version, { tmuxSession: `agent-${agentName}` });

    // Normal Claude output with ❯ prompt
    captureOutput = '❯ \n';

    const monitor = makeMonitor();
    await monitor.pollAgent(db.getAgent(agentName)!);
    await monitor.pollAgent(db.getAgent(agentName)!);
    assert.notEqual(db.getAgent(agentName)!.state, 'failed'); // must not false-positive on CLI prompt
  });

  it('does not false-positive on Codex prompt', async () => {
    const agentName = 'health-no-false-codex';
    db.createAgent({ name: agentName, engine: 'codex', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'active', a.version, { tmuxSession: `agent-${agentName}` });

    // Codex prompt
    captureOutput = '› \n';

    const monitor = makeMonitor();
    await monitor.pollAgent(db.getAgent(agentName)!);
    await monitor.pollAgent(db.getAgent(agentName)!);
    assert.notEqual(db.getAgent(agentName)!.state, 'failed');
  });

  // ── GAP-005: Silent death masking ──

  it('detects CLI exit even when pane_activity is unchanged (GAP-005)', async () => {
    const agentName = 'health-gap005';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'active', a.version, {
      tmuxSession: `agent-${agentName}`,
      proxyId: 'p1',
    });

    // Dead CLI: shell prompt with frozen pane_activity timestamp
    const shellPrompt = 'sammons@crankshaft:~/Desktop/claude_home$ \n';
    let activityTs = 1000;
    const monitor = makeMonitor({
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        proxyCommands.push(command);
        if (command.action === 'pane_activity') {
          return { ok: true, data: activityTs };
        }
        if (command.action === 'capture') {
          return { ok: true, data: shellPrompt };
        }
        return { ok: true };
      },
    });

    // First poll: establishes baseline pane_activity, detects shell prompt (count=1)
    await monitor.pollAgent(db.getAgent(agentName)!);
    assert.equal(db.getAgent(agentName)!.state, 'active', 'still active after first detection');

    // Second poll: pane_activity unchanged (same timestamp) — old code would
    // take fast path and return without detecting exit. Fixed code still captures
    // and runs detectCliExit, confirming the death (count=2).
    ensureActive(agentName);
    await monitor.pollAgent(db.getAgent(agentName)!);
    assert.equal(db.getAgent(agentName)!.state, 'failed', 'must detect death despite unchanged pane_activity');
  });

  // ── CLI Recovery Detection ──

  it('heals failed agent when CLI is detected alive in tmux', async () => {
    const agentName = 'health-heal-basic';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'failed', a.version, {
      tmuxSession: `agent-${agentName}`,
      failedAt: new Date().toISOString(),
      failureReason: 'CLI exited to shell prompt',
    });

    // First poll with stale output — captures baseline snapshot
    captureOutput = 'old stale CLI output\n❯ \n';
    const monitor = makeMonitor();
    await monitor.pollAll();
    assert.equal(db.getAgent(agentName)!.state, 'failed');

    // Pane now shows DIFFERENT Claude Code UI — CLI was manually restarted
    captureOutput = 'bypass permissions\n❯ \n';

    // Second poll: detects change + CLI-alive signal, increments heal counter
    await monitor.pollAll();
    assert.equal(db.getAgent(agentName)!.state, 'failed');

    // Third poll: confirms CLI alive (2 consecutive), heals to active
    await monitor.pollAll();
    const healed = db.getAgent(agentName)!;
    assert.equal(healed.state, 'active');
    assert.equal(healed.failedAt, null);
    assert.equal(healed.failureReason, null);
  });

  it('does not heal when pane output matches failure snapshot (stale)', async () => {
    const agentName = 'health-no-heal-stale';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'active', a.version, {
      tmuxSession: `agent-${agentName}`,
    });

    // Simulate CLI exit detection which captures failure snapshot
    captureOutput = 'sammons@crankshaft:~/Desktop$ \n';
    const monitor = makeMonitor();
    await monitor.pollAgent(db.getAgent(agentName)!);
    ensureActive(agentName);
    await monitor.pollAgent(db.getAgent(agentName)!);
    assert.equal(db.getAgent(agentName)!.state, 'failed');

    // Now change pane output to CLI-alive signals but SAME as what was there
    // before failure — simulate stale pane by using the exact failure snapshot
    captureOutput = 'sammons@crankshaft:~/Desktop$ \n';
    await monitor.pollAll();
    await monitor.pollAll();
    assert.equal(db.getAgent(agentName)!.state, 'failed', 'should not heal on stale pane');
  });

  it('heals failed agent on context percentage signal', async () => {
    const agentName = 'health-heal-ctx';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'failed', a.version, {
      tmuxSession: `agent-${agentName}`,
      failedAt: new Date().toISOString(),
      failureReason: 'Health check failed',
    });

    // Baseline poll (stale)
    captureOutput = 'stale shell output\n';
    const monitor = makeMonitor();
    await monitor.pollAll();

    // CLI revived with different output
    captureOutput = 'current: 12.5\ntokens\n';
    await monitor.pollAll();
    await monitor.pollAll();
    assert.equal(db.getAgent(agentName)!.state, 'active');
  });

  it('does not heal when shell prompt is still present', async () => {
    const agentName = 'health-no-heal-shell';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'failed', a.version, {
      tmuxSession: `agent-${agentName}`,
      failedAt: new Date().toISOString(),
      failureReason: 'CLI exited',
    });

    // Shell prompt still at bottom — CLI not restarted
    captureOutput = 'sammons@crankshaft:~/Desktop$ \n';

    const monitor = makeMonitor();
    await monitor.pollAll();
    await monitor.pollAll();
    assert.equal(db.getAgent(agentName)!.state, 'failed');
  });

  it('does not heal without proxyId or tmuxSession', async () => {
    const agentName = 'health-no-heal-noprxy';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'failed', a.version, {
      failedAt: new Date().toISOString(),
      failureReason: 'no proxy',
    });

    captureOutput = 'bypass permissions\n❯ \n';

    const monitor = makeMonitor();
    await monitor.pollAll();
    await monitor.pollAll();
    assert.equal(db.getAgent(agentName)!.state, 'failed'); // no proxy, can't heal
  });

  it('logs cli_healed event on recovery', async () => {
    const agentName = 'health-heal-event';
    db.createAgent({ name: agentName, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(agentName)!;
    db.updateAgentState(agentName, 'failed', a.version, {
      tmuxSession: `agent-${agentName}`,
      failedAt: new Date().toISOString(),
      failureReason: 'CLI exited',
    });

    // Baseline poll
    captureOutput = 'stale output\n';
    const monitor = makeMonitor();
    await monitor.pollAll();

    // CLI revived
    captureOutput = 'context 45%\n❯ \n';
    await monitor.pollAll();
    await monitor.pollAll();

    const events = db.getEvents(agentName, 10);
    const healEvent = events.find(e => e.event === 'cli_healed');
    assert.ok(healEvent, 'should log cli_healed event');
  });

  it('auto-suspends idle agent after timeout with no messages or reminders', async () => {
    const name = 'health-autosuspend';
    db.createAgent({ name, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(name)!;
    db.updateAgentState(name, 'active', a.version, {
      tmuxSession: `agent-${name}`,
      proxyId: 'p1',
    });

    captureOutput = 'idle prompt\n> \n';
    const suspendCalls: string[] = [];

    const monitor = makeMonitor({
      idleSuspendMs: 50,
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        proxyCommands.push(command);
        if (command.action === 'capture') return { ok: true, data: captureOutput };
        if (command.action === 'has_session') return { ok: true, data: true };
        if (command.action === 'paste') {
          suspendCalls.push(('text' in command && command.text) as string ?? 'paste');
        }
        if (command.action === 'pane_activity') return { ok: true, data: 1 };
        return { ok: true };
      },
    });

    // First poll: baseline snapshot
    await monitor.pollAll();
    // Second poll: screen unchanged → idle
    await monitor.pollAll();

    const afterIdle = db.getAgent(name);
    assert.equal(afterIdle?.state, 'idle', 'should be idle after 2 unchanged polls');

    // Set lastActivity far in the past to trigger timeout
    db.updateAgentState(name, 'idle', afterIdle!.version, {
      lastActivity: new Date(Date.now() - 10_000).toISOString(),
    });

    // Third poll: should trigger auto-suspend
    await monitor.pollAll();
    // Give the async suspendAgent a tick to start
    await new Promise(r => setTimeout(r, 200));

    const afterSuspend = db.getAgent(name);
    // Should be suspending or suspended (depending on timing)
    assert.ok(
      afterSuspend?.state === 'suspending' || afterSuspend?.state === 'suspended',
      `expected suspending/suspended, got ${afterSuspend?.state}`,
    );

    const events = db.getEvents(name, 10);
    assert.ok(events.some(e => e.event === 'auto_suspend'), 'should log auto_suspend event');
    monitor.stop();
  });

  it('does not auto-suspend agent with pending messages', async () => {
    const name = 'health-nosuspend-msg';
    db.createAgent({ name, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(name)!;
    db.updateAgentState(name, 'active', a.version, {
      tmuxSession: `agent-${name}`,
      proxyId: 'p1',
    });

    captureOutput = 'idle prompt\n> \n';
    const monitor = makeMonitor({
      idleSuspendMs: 50,
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        proxyCommands.push(command);
        if (command.action === 'capture') return { ok: true, data: captureOutput };
        if (command.action === 'has_session') return { ok: true, data: true };
        if (command.action === 'pane_activity') return { ok: true, data: 1 };
        return { ok: true };
      },
    });

    // Poll twice to reach idle via screen-diff
    await monitor.pollAll();
    await monitor.pollAll();
    const idled = db.getAgent(name);
    assert.equal(idled?.state, 'idle', 'should be idle after 2 unchanged polls');

    // Set lastActivity far in the past to trigger timeout
    db.updateAgentState(name, 'idle', idled!.version, {
      lastActivity: new Date(Date.now() - 10_000).toISOString(),
    });

    // Enqueue a message so hasPendingMessages returns true
    db.enqueueMessage({ sourceAgent: null, targetAgent: name, envelope: 'test message' });

    // Poll again — should NOT auto-suspend due to pending message
    await monitor.pollAll();
    await new Promise(r => setTimeout(r, 200));

    const after = db.getAgent(name);
    assert.equal(after?.state, 'idle', 'should remain idle when messages pending');
    monitor.stop();
  });

  it('does not auto-suspend agent with active reminders', async () => {
    const name = 'health-nosuspend-rem';
    db.createAgent({ name, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(name)!;
    db.updateAgentState(name, 'active', a.version, {
      tmuxSession: `agent-${name}`,
      proxyId: 'p1',
    });

    captureOutput = 'idle prompt\n> \n';
    const monitor = makeMonitor({
      idleSuspendMs: 50,
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        proxyCommands.push(command);
        if (command.action === 'capture') return { ok: true, data: captureOutput };
        if (command.action === 'has_session') return { ok: true, data: true };
        if (command.action === 'pane_activity') return { ok: true, data: 1 };
        return { ok: true };
      },
    });

    // Poll twice to reach idle via screen-diff
    await monitor.pollAll();
    await monitor.pollAll();
    const idled = db.getAgent(name);
    assert.equal(idled?.state, 'idle', 'should be idle after 2 unchanged polls');

    // Set lastActivity far in the past to trigger timeout
    db.updateAgentState(name, 'idle', idled!.version, {
      lastActivity: new Date(Date.now() - 10_000).toISOString(),
    });

    // Create an imminent reminder (cadence nearly elapsed — fires within idle window)
    const rem = db.createReminder({ agentName: name, prompt: 'check something', cadenceMinutes: 5 });
    db.rawDb.prepare(
      "UPDATE reminders SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 minutes') WHERE id = ?"
    ).run(rem.id);

    // Poll again — should NOT auto-suspend due to imminent reminder
    await monitor.pollAll();
    await new Promise(r => setTimeout(r, 200));

    const after = db.getAgent(name);
    assert.equal(after?.state, 'idle', 'should remain idle when imminent reminder exists');
    monitor.stop();
  });

  it('auto-suspends agent with distant reminder', async () => {
    const name = 'health-suspend-dist-rem';
    db.createAgent({ name, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(name)!;
    db.updateAgentState(name, 'active', a.version, {
      tmuxSession: `agent-${name}`,
      proxyId: 'p1',
    });

    captureOutput = 'idle prompt\n> \n';
    const monitor = makeMonitor({
      idleSuspendMs: 50,
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        proxyCommands.push(command);
        if (command.action === 'capture') return { ok: true, data: captureOutput };
        if (command.action === 'has_session') return { ok: true, data: true };
        if (command.action === 'pane_activity') return { ok: true, data: 1 };
        if (command.action === 'suspend') return { ok: true };
        return { ok: true };
      },
    });

    await monitor.pollAll();
    await monitor.pollAll();
    const idled = db.getAgent(name);
    assert.equal(idled?.state, 'idle', 'should be idle after 2 unchanged polls');

    db.updateAgentState(name, 'idle', idled!.version, {
      lastActivity: new Date(Date.now() - 10_000).toISOString(),
    });

    // Create a distant reminder (24h cadence, just created — not imminent)
    db.createReminder({ agentName: name, prompt: 'daily check', cadenceMinutes: 1440 });

    await monitor.pollAll();
    await new Promise(r => setTimeout(r, 200));

    const after = db.getAgent(name);
    assert.equal(after?.state, 'suspending', 'should auto-suspend with distant reminder');
    monitor.stop();
  });
});

describe('HealthMonitor.stripAnsi', () => {
  it('strips CSI color sequences', () => {
    assert.equal(HealthMonitor.stripAnsi('\x1b[32mgreen\x1b[0m'), 'green');
    assert.equal(HealthMonitor.stripAnsi('\x1b[1;31mred bold\x1b[0m'), 'red bold');
  });

  it('strips OSC hyperlink sequences', () => {
    assert.equal(
      HealthMonitor.stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'),
      'link',
    );
  });

  it('returns plain text unchanged', () => {
    assert.equal(HealthMonitor.stripAnsi('hello world'), 'hello world');
    assert.equal(HealthMonitor.stripAnsi(''), '');
  });

  it('strips cursor movement sequences', () => {
    assert.equal(HealthMonitor.stripAnsi('\x1b[2J\x1b[Hcontent'), 'content');
  });
});

describe('HealthMonitor.takeSnapshot', () => {
  it('captures last N lines', () => {
    const output = 'line1\nline2\nline3\nline4\nline5\nline6\nline7';
    const snapshot = HealthMonitor.takeSnapshot(output, 3);
    assert.equal(snapshot, 'line5\nline6\nline7');
  });

  it('strips ANSI codes before snapshotting', () => {
    const output = '\x1b[32mline1\x1b[0m\n\x1b[31mline2\x1b[0m';
    const snapshot = HealthMonitor.takeSnapshot(output, 5);
    assert.equal(snapshot, 'line1\nline2');
  });

  it('trims trailing whitespace per line', () => {
    const output = 'line1   \nline2  \t\nline3';
    const snapshot = HealthMonitor.takeSnapshot(output, 5);
    assert.equal(snapshot, 'line1\nline2\nline3');
  });

  it('handles fewer lines than requested', () => {
    const output = 'only\ntwo';
    const snapshot = HealthMonitor.takeSnapshot(output, 5);
    assert.equal(snapshot, 'only\ntwo');
  });

  it('handles empty output', () => {
    assert.equal(HealthMonitor.takeSnapshot('', 5), '');
    assert.equal(HealthMonitor.takeSnapshot('\n\n', 5), '\n\n');
  });
});

describe('HealthMonitor indicators', () => {
  let db: Database;
  let tmpDir: string;
  let captureOutput: string;
  let indicatorUpdates: Array<{ agentName: string; indicators: unknown[] }>;
  const indMonitors: HealthMonitor[] = [];

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'health-ind-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    captureOutput = '> \n';
    indicatorUpdates = [];
  });

  afterEach(() => {
    for (const m of indMonitors) m.stop();
    indMonitors.length = 0;
  });

  function makeMonitorWithIndicators(): HealthMonitor {
    const dispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'capture') {
        return { ok: true, data: captureOutput };
      }
      if (command.action === 'has_session') {
        return { ok: true, data: true };
      }
      return { ok: true };
    };

    const locks = new LockManager(db.rawDb);

    const monitor = new HealthMonitor({
      db,
      locks,
      proxyDispatch: dispatch,
      orchestratorHost: 'http://localhost:3000',
      pollIntervalMs: 100,
      onIndicatorUpdate: (agentName, indicators) => {
        indicatorUpdates.push({ agentName, indicators });
      },
    });
    indMonitors.push(monitor);
    return monitor;
  }

  it('evaluates indicators against pane output', async () => {
    const indicatorDefs = JSON.stringify([
      { id: 'approval', regex: '(Yes|No|Always allow)', badge: 'Needs Approval', style: 'warning' },
    ]);
    db.createAgent({ name: 'ind-test-1', engine: 'claude', cwd: '/tmp', proxyId: 'p1', indicators: indicatorDefs });
    const a = db.getAgent('ind-test-1')!;
    db.updateAgentState('ind-test-1', 'active', a.version, {
      tmuxSession: 'agent-ind-test-1',
      proxyId: 'p1',
    });

    captureOutput = 'Do you want to continue? (Yes/No)\n> ';
    const monitor = makeMonitorWithIndicators();
    await monitor.pollAll();

    assert.ok(indicatorUpdates.length > 0, 'should have indicator update');
    const update = indicatorUpdates.find(u => u.agentName === 'ind-test-1');
    assert.ok(update, 'should have update for ind-test-1');
    assert.equal(update!.indicators.length, 1);
    assert.equal((update!.indicators[0] as { badge: string }).badge, 'Needs Approval');
  });

  it('clears indicators when regex no longer matches', async () => {
    captureOutput = 'Do you want to continue? (Yes/No)\n> ';
    const monitor = makeMonitorWithIndicators();

    // First poll — matches
    await monitor.pollAll();
    indicatorUpdates = [];

    // Second poll — no match
    captureOutput = 'Working on task...\n> ';
    await monitor.pollAll();

    const update = indicatorUpdates.find(u => u.agentName === 'ind-test-1');
    assert.ok(update, 'should have clearance update');
    assert.equal(update!.indicators.length, 0);
  });

  it('skips invalid regex gracefully', async () => {
    const indicatorDefs = JSON.stringify([
      { id: 'bad', regex: '([invalid', badge: 'Bad Regex', style: 'info' },
      { id: 'good', regex: 'hello', badge: 'Hello', style: 'info' },
    ]);
    db.createAgent({ name: 'ind-test-2', engine: 'claude', cwd: '/tmp', proxyId: 'p1', indicators: indicatorDefs });
    const a = db.getAgent('ind-test-2')!;
    db.updateAgentState('ind-test-2', 'active', a.version, {
      tmuxSession: 'agent-ind-test-2',
      proxyId: 'p1',
    });

    captureOutput = 'hello world\n> ';
    const monitor = makeMonitorWithIndicators();
    await monitor.pollAll();

    const update = indicatorUpdates.find(u => u.agentName === 'ind-test-2');
    assert.ok(update, 'should have update for ind-test-2');
    // Only the good regex should match; bad regex should be skipped
    assert.equal(update!.indicators.length, 1);
    assert.equal((update!.indicators[0] as { badge: string }).badge, 'Hello');
  });
});

describe('Permission prompt detection patterns', () => {
  const TOOL_PROMPT_RE = /^\s*(?:Allow|Do you want to allow)\s+(\S+?)(?:\s+tool)?\s*\?/i;
  const SELECTOR_RE = /^\s*[❯›●▸►>]\s*(Yes|No|Always allow|Allow once|Deny)/i;

  it('matches real Claude Code permission prompts', () => {
    assert.ok(TOOL_PROMPT_RE.test('  Allow Bash tool?  echo "hello"'));
    assert.ok(TOOL_PROMPT_RE.test('  Allow Read tool?  /path/to/file'));
    assert.ok(TOOL_PROMPT_RE.test('  Allow Edit tool?  /src/main.ts'));
    assert.ok(TOOL_PROMPT_RE.test('  Allow Write?'));
    assert.ok(TOOL_PROMPT_RE.test('  Allow mcp__supabase__execute_sql?'));
  });

  it('extracts tool name correctly', () => {
    const m = TOOL_PROMPT_RE.exec('  Allow Bash tool?  echo "hello"');
    assert.ok(m);
    assert.equal(m![1], 'Bash');
  });

  it('rejects agent output text containing "Allow" loosely', () => {
    assert.ok(!TOOL_PROMPT_RE.test('The system allowed access to the file'));
    assert.ok(!TOOL_PROMPT_RE.test('Allow me to explain this'));
    assert.ok(!TOOL_PROMPT_RE.test('granted / not granted'));
    assert.ok(!TOOL_PROMPT_RE.test('is blocked on a permission prompt: "Allow Bash tool?"'));
  });

  it('matches interactive selector lines', () => {
    assert.ok(SELECTOR_RE.test('❯ Yes'));
    assert.ok(SELECTOR_RE.test('  ❯ No'));
    assert.ok(SELECTOR_RE.test('  › Always allow'));
    assert.ok(SELECTOR_RE.test('  > Deny'));
  });

  it('rejects normal text with Yes/No', () => {
    assert.ok(!SELECTOR_RE.test('Yes, I can do that'));
    assert.ok(!SELECTOR_RE.test('No problem'));
    assert.ok(!SELECTOR_RE.test('  Yes'));
  });

  it('does not match alert text about permission prompts (recursive loop)', () => {
    const alertText = '⚠️ DrRobby is blocked on a permission prompt: "Allow Bash tool?"';
    assert.ok(!TOOL_PROMPT_RE.test(alertText));
  });
});

describe('Auto-recover circuit breaker', () => {
  let cbDb: Database;
  let cbTmpDir: string;
  const monitors: HealthMonitor[] = [];

  const CLAUDE_DETECTION = JSON.stringify({
    idlePatterns: [{ pattern: '^[\\u276f>]\\s*$', lines: 5 }],
    activePatterns: [],
    contextPattern: '(\\d+)\\s*tokens',
    idleThreshold: 2,
    autoRecover: true,
  });

  before(() => {
    cbTmpDir = mkdtempSync(join(tmpdir(), 'cb-test-'));
    cbDb = new Database(join(cbTmpDir, 'test.db'));
    cbDb.registerProxy('p1', 'tok', 'localhost:3100');
    cbDb.createEngineConfig({
      name: 'claude',
      engine: 'claude',
      detection: CLAUDE_DETECTION,
    });
  });

  afterEach(() => {
    for (const m of monitors) m.stop();
    monitors.length = 0;
  });

  after(() => {
    cbDb.close();
    rmSync(cbTmpDir, { recursive: true, force: true });
  });

  function makeCbMonitor(overrides?: Partial<ConstructorParameters<typeof HealthMonitor>[0]>): HealthMonitor {
    const monitor = new HealthMonitor({
      db: cbDb,
      locks: new LockManager(cbDb.rawDb),
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        if (command.action === 'capture') {
          return { ok: true, data: 'No conversation found with session ID abc123\nagent@host:~$ ' };
        }
        if (command.action === 'has_session') {
          return { ok: true, data: true };
        }
        return { ok: true };
      },
      orchestratorHost: 'http://localhost:3000',
      pollIntervalMs: 100,
      ...overrides,
    });
    monitors.push(monitor);
    return monitor;
  }

  it('trips circuit breaker after MAX_RECOVERY_ATTEMPTS within the sliding window', async () => {
    cbDb.createAgent({ name: 'cb-loop', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = cbDb.getAgent('cb-loop')!;
    cbDb.updateAgentState('cb-loop', 'active', a.version, {
      tmuxSession: 'agent-cb-loop',
      proxyId: 'p1',
    });

    const monitor = makeCbMonitor();

    // Pre-populate recovery history at the threshold
    const now = Date.now();
    const history = Array.from({ length: HealthMonitor.MAX_RECOVERY_ATTEMPTS }, (_, i) => now - i * 1000);
    (monitor as any).recoveryHistory.set('cb-loop', history);

    // Trigger exit detection (2 consecutive polls) — this should trip the breaker
    await monitor.pollAll();
    await monitor.pollAll();

    const events = cbDb.getEvents('cb-loop', 100);
    const tripped = events.filter((e: { event: string }) => e.event === 'circuit_breaker_tripped');
    assert.ok(tripped.length > 0, 'circuit_breaker_tripped event should be logged');
  });

  it('DISABLE_AUTO_RECOVER suppresses recovery (logs auto_recover_suppressed, never triggers)', async () => {
    cbDb.createAgent({ name: 'cb-disabled', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = cbDb.getAgent('cb-disabled')!;
    cbDb.updateAgentState('cb-disabled', 'active', a.version, {
      tmuxSession: 'agent-cb-disabled',
      proxyId: 'p1',
    });

    const monitor = makeCbMonitor({ autoRecoverDisabled: true });
    // Trigger exit detection (2 consecutive polls) → failed → maybeAutoRecover (suppressed)
    await monitor.pollAll();
    await monitor.pollAll();

    const events = cbDb.getEvents('cb-disabled', 100) as Array<{ event: string }>;
    assert.ok(events.some(e => e.event === 'auto_recover_suppressed'), 'should log auto_recover_suppressed');
    assert.ok(!events.some(e => e.event === 'auto_recover_triggered'), 'should NOT trigger auto-recovery when disabled');
  });

  it('applies exponential backoff delay on recovery attempts', async () => {
    cbDb.createAgent({ name: 'cb-backoff', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = cbDb.getAgent('cb-backoff')!;
    cbDb.updateAgentState('cb-backoff', 'active', a.version, {
      tmuxSession: 'agent-cb-backoff',
      proxyId: 'p1',
    });

    const monitor = makeCbMonitor();

    // Trigger one exit detection cycle (2 polls)
    await monitor.pollAll();
    await monitor.pollAll();

    const events = cbDb.getEvents('cb-backoff', 100);
    const triggered = events.filter((e: { event: string }) => e.event === 'auto_recover_triggered');
    assert.ok(triggered.length > 0, 'auto_recover_triggered event should be logged');

    // Check that meta includes attempt count and delay
    const meta = JSON.parse((triggered[0] as any).meta ?? '{}');
    assert.equal(meta.attempt, '1');
    assert.equal(meta.delayMs, '10000');
  });

  it('resets recovery history after stabilization period', async () => {
    cbDb.createAgent({ name: 'cb-stable', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = cbDb.getAgent('cb-stable')!;
    cbDb.updateAgentState('cb-stable', 'active', a.version, {
      tmuxSession: 'agent-cb-stable',
      proxyId: 'p1',
    });

    // Normal CLI output — no exit detected
    const monitor = makeCbMonitor({
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        if (command.action === 'capture') {
          return { ok: true, data: '❯ \nsome normal output\n' };
        }
        if (command.action === 'has_session') {
          return { ok: true, data: true };
        }
        return { ok: true };
      },
    });

    // Seed recovery history with timestamps older than stabilization period
    const staleTs = Date.now() - HealthMonitor.RECOVERY_STABILIZE_MS - 1000;
    (monitor as any).recoveryHistory.set('cb-stable', [staleTs, staleTs, staleTs]);
    assert.equal((monitor as any).recoveryHistory.get('cb-stable').length, 3);

    await monitor.pollAll();

    const history = (monitor as any).recoveryHistory.get('cb-stable');
    assert.ok(!history, 'recovery history should be cleared after stabilization period');
  });

  it('does not reset recovery history for agents still in failed state', async () => {
    cbDb.createAgent({ name: 'cb-failed', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = cbDb.getAgent('cb-failed')!;
    cbDb.updateAgentState('cb-failed', 'failed', a.version, {
      tmuxSession: 'agent-cb-failed',
      proxyId: 'p1',
      failedAt: new Date().toISOString(),
      failureReason: 'test failure',
    });

    const monitor = makeCbMonitor({
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        if (command.action === 'capture') {
          return { ok: true, data: 'agent@host:~$ ' };
        }
        if (command.action === 'has_session') {
          return { ok: true, data: true };
        }
        return { ok: true };
      },
    });

    const staleTs = Date.now() - HealthMonitor.RECOVERY_STABILIZE_MS - 1000;
    (monitor as any).recoveryHistory.set('cb-failed', [staleTs, staleTs]);

    await monitor.pollAll();

    const history = (monitor as any).recoveryHistory.get('cb-failed');
    assert.ok(history && history.length === 2, 'recovery history should NOT be cleared for failed agents');
  });
});
