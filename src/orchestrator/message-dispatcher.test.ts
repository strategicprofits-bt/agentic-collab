import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import type { AgentState, ProxyCommand, ProxyResponse } from '../shared/types.ts';

describe('MessageDispatcher', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dispatcher-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setAgentState(name: string, state: AgentState): void {
    const agent = db.getAgent(name)!;
    db.updateAgentState(name, state, agent.version, {
      proxyId: 'p1',
      tmuxSession: `agent-${name}`,
    });
  }

  function makeDispatcher(
    proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>,
  ): MessageDispatcher {
    return new MessageDispatcher({
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch,
      orchestratorHost: 'http://localhost:3000',
    });
  }

  it('delivers to active Codex agents without pane capture', async () => {
    db.createAgent({ name: 'codex-active', engine: 'codex', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('codex-active', 'active');

    const queued = db.enqueueMessage({
      sourceAgent: null,
      targetAgent: 'codex-active',
      envelope: 'Please review the diff',
    });

    const commands: ProxyCommand[] = [];
    const dispatcher = makeDispatcher(async (_proxyId, command) => {
      commands.push(command);
      if (command.action === 'capture') {
        return { ok: false, error: 'delivery should not capture pane output' };
      }
      return { ok: true };
    });

    const delivered = await dispatcher.tryDeliver('codex-active');

    assert.equal(delivered, true);
    assert.ok(!commands.some(c => c.action === 'capture'));
    assert.equal(commands.filter(c => c.action === 'paste').length, 1);
    assert.equal(db.getPendingMessageById(queued.id)?.status, 'delivered');
  });

  it('drains queued delivery without waiting for an idle transition', async () => {
    db.createAgent({ name: 'codex-drain', engine: 'codex', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('codex-drain', 'active');

    const first = db.enqueueMessage({
      sourceAgent: null,
      targetAgent: 'codex-drain',
      envelope: 'First message',
    });
    const second = db.enqueueMessage({
      sourceAgent: null,
      targetAgent: 'codex-drain',
      envelope: 'Second message',
    });

    const commands: ProxyCommand[] = [];
    const dispatcher = makeDispatcher(async (_proxyId, command) => {
      commands.push(command);
      if (command.action === 'capture') {
        return { ok: false, error: 'drain loop should not capture pane output' };
      }
      return { ok: true };
    });

    const dispatcherInternals = MessageDispatcher as unknown as { DRAIN_INTERVAL_MS: number };
    const originalDrainIntervalMs = dispatcherInternals.DRAIN_INTERVAL_MS;
    dispatcherInternals.DRAIN_INTERVAL_MS = 20;

    try {
      const delivered = await dispatcher.tryDeliver('codex-drain');
      assert.equal(delivered, true);
      assert.equal(db.getPendingMessageById(first.id)?.status, 'delivered');
      assert.equal(db.getPendingMessageById(second.id)?.status, 'pending');
      assert.ok(!commands.some(c => c.action === 'capture'));
      assert.equal(commands.filter(c => c.action === 'paste').length, 1);

      // Codex submit actions include a delayed second Enter after the paste.
      await new Promise(resolve => setTimeout(resolve, 1400));

      assert.equal(db.getPendingMessageById(second.id)?.status, 'delivered');
      assert.equal(commands.filter(c => c.action === 'paste').length, 2);
    } finally {
      dispatcher.stop();
      dispatcherInternals.DRAIN_INTERVAL_MS = originalDrainIntervalMs;
    }
  });

  it('defers delivery when agent is active with recent token activity', async () => {
    db.createAgent({ name: 'busy-agent', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('busy-agent', 'active');
    // Simulate recent token activity
    db.recordTokenSnapshot('busy-agent', 8000, 45);

    db.enqueueMessage({
      sourceAgent: null,
      targetAgent: 'busy-agent',
      envelope: 'Should be deferred',
    });

    const commands: ProxyCommand[] = [];
    const dispatcher = makeDispatcher(async (_proxyId, command) => {
      commands.push(command);
      return { ok: true };
    });

    try {
      const delivered = await dispatcher.tryDeliver('busy-agent');
      assert.equal(delivered, false);
      assert.equal(commands.length, 0);
    } finally {
      dispatcher.stop();
    }
  });

  it('delivers when agent is active with no recent token activity', async () => {
    db.createAgent({ name: 'idle-active', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('idle-active', 'active');
    // No token snapshots recorded — agent has no recent activity

    const msg = db.enqueueMessage({
      sourceAgent: null,
      targetAgent: 'idle-active',
      envelope: 'Should deliver',
    });

    const commands: ProxyCommand[] = [];
    const dispatcher = makeDispatcher(async (_proxyId, command) => {
      commands.push(command);
      return { ok: true };
    });

    try {
      const delivered = await dispatcher.tryDeliver('idle-active');
      assert.equal(delivered, true);
      assert.ok(commands.some(c => c.action === 'paste'));
      assert.equal(db.getPendingMessageById(msg.id)?.status, 'delivered');
    } finally {
      dispatcher.stop();
    }
  });

  // ── GAP-070 resume-on-message coupling ──
  // A permissive proxy where a captured "> " prompt makes waitForCliReady detect readiness
  // immediately, so resumeAgent completes fast in-test.
  const readyProxy = async (_p: string, command: ProxyCommand): Promise<ProxyResponse> => {
    if (command.action === 'capture') return { ok: true, data: 'ready\n> \n' };
    if (command.action === 'has_session') return { ok: true, data: true };
    return { ok: true };
  };
  function makeCoupledDispatcher(active: (agentName: string) => boolean, proxy = readyProxy): MessageDispatcher {
    return new MessageDispatcher({
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: proxy,
      orchestratorHost: 'http://localhost:3000',
      isAutoSuspendActive: active,
    });
  }

  it('GAP-070: resumes a SUSPENDED agent that has a message waiting, then delivers (coupling ACTIVE)', async () => {
    db.createAgent({ name: 'sus-wake', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('sus-wake', 'suspended');
    const msg = db.enqueueMessage({ sourceAgent: null, targetAgent: 'sus-wake', envelope: 'wake up' });

    const dispatcher = makeCoupledDispatcher(() => true);
    try {
      await dispatcher.tryDeliver('sus-wake');
      const after = db.getAgent('sus-wake');
      assert.notEqual(after?.state, 'suspended', 'coupling must WAKE the suspended agent (resume attempted)');
      assert.equal(db.getPendingMessageById(msg.id)?.status, 'delivered', 'and deliver the waiting message');
    } finally {
      dispatcher.stop();
    }
  });

  it('GAP-070: does NOT resume a suspended agent when coupling is DORMANT (byte-unchanged legacy stall)', async () => {
    db.createAgent({ name: 'sus-dormant', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('sus-dormant', 'suspended');
    const msg = db.enqueueMessage({ sourceAgent: null, targetAgent: 'sus-dormant', envelope: 'held' });

    const dispatcher = makeCoupledDispatcher(() => false); // dormant/halted
    try {
      const delivered = await dispatcher.tryDeliver('sus-dormant');
      assert.equal(delivered, false, 'no delivery to a suspended agent when dormant');
      assert.equal(db.getAgent('sus-dormant')?.state, 'suspended', 'must stay suspended (legacy behavior)');
      assert.notEqual(db.getPendingMessageById(msg.id)?.status, 'delivered', 'message stays pending');
    } finally {
      dispatcher.stop();
    }
  });

  it('GAP-070 HALT ATOMICITY: coupling gates on the SAME live getter as suspend — false ⇒ no wake', async () => {
    // The dispatcher reads isAutoSuspendActive() live; in production this is the health monitor's
    // single combined (enabled && !halted) field, so a halt stops resume-on-message in the same
    // instant it stops suspend. Here a getter returning false (halted) ⇒ no resume.
    db.createAgent({ name: 'sus-halted', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('sus-halted', 'suspended');
    db.enqueueMessage({ sourceAgent: null, targetAgent: 'sus-halted', envelope: 'blocked by halt' });

    let halted = true;
    const dispatcher = makeCoupledDispatcher(() => !halted);
    try {
      await dispatcher.tryDeliver('sus-halted');
      assert.equal(db.getAgent('sus-halted')?.state, 'suspended', 'halted ⇒ coupling must not wake');
      // Re-arm live (un-halt) → next attempt wakes it (proves the same getter re-arms both).
      halted = false;
      await dispatcher.tryDeliver('sus-halted');
      assert.notEqual(db.getAgent('sus-halted')?.state, 'suspended', 'un-halt ⇒ coupling wakes on next attempt');
    } finally {
      dispatcher.stop();
    }
  });

  it('GAP-070 BOUNDED: does NOT wake a suspended agent with NO deliverable message', async () => {
    db.createAgent({ name: 'sus-nomsg', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('sus-nomsg', 'suspended');
    // no message enqueued
    const dispatcher = makeCoupledDispatcher(() => true);
    try {
      await dispatcher.tryDeliver('sus-nomsg');
      assert.equal(db.getAgent('sus-nomsg')?.state, 'suspended', 'never wake an agent for nothing');
    } finally {
      dispatcher.stop();
    }
  });

  it('GAP-070 NON-SUSPENDED PATH UNCHANGED: active agent delivers normally with coupling ACTIVE (no resume)', async () => {
    db.createAgent({ name: 'act-normal', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('act-normal', 'active');
    const msg = db.enqueueMessage({ sourceAgent: null, targetAgent: 'act-normal', envelope: 'normal delivery' });

    const events: string[] = [];
    const proxy = async (_p: string, command: ProxyCommand): Promise<ProxyResponse> => {
      events.push(command.action);
      if (command.action === 'capture') return { ok: true, data: 'ready\n> \n' };
      if (command.action === 'has_session') return { ok: true, data: true };
      return { ok: true };
    };
    const dispatcher = makeCoupledDispatcher(() => true, proxy);
    try {
      const delivered = await dispatcher.tryDeliver('act-normal');
      assert.equal(delivered, true, 'active agent delivers normally even with coupling active');
      assert.equal(db.getPendingMessageById(msg.id)?.status, 'delivered');
      assert.equal(db.getAgent('act-normal')?.state, 'active', 'state unchanged — never routed through resume');
    } finally {
      dispatcher.stop();
    }
  });

  it('GAP-070 SCOPE gates resume-coupling — an OUT-OF-SCOPE suspended agent is NOT woken', async () => {
    db.createAgent({ name: 'sus-outofscope', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('sus-outofscope', 'suspended');
    db.enqueueMessage({ sourceAgent: null, targetAgent: 'sus-outofscope', envelope: 'not for you' });
    // getter mirrors isAutoSuspendActive(name): only 'someone-else' is active → this agent is out of scope
    const dispatcher = makeCoupledDispatcher((name) => name === 'someone-else');
    try {
      await dispatcher.tryDeliver('sus-outofscope');
      assert.equal(db.getAgent('sus-outofscope')?.state, 'suspended', 'out-of-scope suspended agent must NOT be woken (scope gates resume too)');
    } finally {
      dispatcher.stop();
    }
  });

  it('GAP-070 SCOPE allows resume-coupling — an IN-SCOPE suspended agent IS woken', async () => {
    db.createAgent({ name: 'sus-inscope', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    setAgentState('sus-inscope', 'suspended');
    db.enqueueMessage({ sourceAgent: null, targetAgent: 'sus-inscope', envelope: 'wake, you are in scope' });
    const dispatcher = makeCoupledDispatcher((name) => name === 'sus-inscope');
    try {
      await dispatcher.tryDeliver('sus-inscope');
      assert.notEqual(db.getAgent('sus-inscope')?.state, 'suspended', 'in-scope suspended agent IS woken');
    } finally {
      dispatcher.stop();
    }
  });
});
