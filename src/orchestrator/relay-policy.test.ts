import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideRelay, relayOperatorReply, DEFAULT_RELAY_POLICY } from './relay-policy.ts';

describe('decideRelay — presence-aware operator-reply routing', () => {
  it('relays a plain-topic reply when no dashboard client is connected (operator away)', () => {
    const d = decideRelay({ topic: 'status', clientCount: 0, alreadySentRecently: false });
    assert.equal(d.relay, true);
    assert.equal(d.reason, 'presence-away');
  });

  it('does NOT relay a plain-topic reply while a dashboard client is connected (no double-push)', () => {
    const d = decideRelay({ topic: 'status', clientCount: 1, alreadySentRecently: false });
    assert.equal(d.relay, false);
    assert.equal(d.reason, 'on-dashboard');
  });

  it('skips a telegram-prefixed topic inline — the poller owns those (always-push override)', () => {
    const d = decideRelay({ topic: 'telegram-sev3', clientCount: 0, alreadySentRecently: false });
    assert.equal(d.relay, false);
    assert.equal(d.reason, 'telegram-topic-poller-owns');
  });

  it('suppresses a recently-sent duplicate via the dedup noise floor', () => {
    const d = decideRelay({ topic: 'status', clientCount: 0, alreadySentRecently: true });
    assert.equal(d.relay, false);
    assert.equal(d.reason, 'dedup');
  });

  it('never relays a neverTopics entry, even when the operator is away', () => {
    const policy = { ...DEFAULT_RELAY_POLICY, neverTopics: ['heartbeat'] };
    const d = decideRelay({ topic: 'heartbeat', clientCount: 0, alreadySentRecently: false, policy });
    assert.equal(d.relay, false);
    assert.equal(d.reason, 'never-topic');
  });

  it('relays an alwaysTopics entry even while a dashboard client is connected', () => {
    const policy = { ...DEFAULT_RELAY_POLICY, alwaysTopics: ['completion'] };
    const d = decideRelay({ topic: 'completion', clientCount: 3, alreadySentRecently: false, policy });
    assert.equal(d.relay, true);
    assert.equal(d.reason, 'always-topic');
  });

  it('is case-insensitive on the telegram-topic prefix', () => {
    const d = decideRelay({ topic: 'Telegram', clientCount: 0, alreadySentRecently: false });
    assert.equal(d.relay, false);
    assert.equal(d.reason, 'telegram-topic-poller-owns');
  });
});

describe('relayOperatorReply — dispatch wiring', () => {
  function recordingSend() {
    const calls: Array<{ botToken: string; chatId: string; text: string }> = [];
    const send = async (botToken: string, chatId: string, text: string) => {
      calls.push({ botToken, chatId, text });
      return true;
    };
    return { calls, send };
  }

  it('dispatches to the operator phone when the decision relays and creds are present', async () => {
    const { calls, send } = recordingSend();
    const out = await relayOperatorReply({
      agent: 'CoachBeard',
      message: 'the report is ready',
      topic: 'status',
      clientCount: 0,
      alreadySentRecently: false,
      creds: { botToken: 'tok', chatId: 'chat-1' },
      send,
    });
    assert.equal(out.relayed, true);
    assert.equal(out.reason, 'sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.botToken, 'tok');
    assert.equal(calls[0]!.chatId, 'chat-1');
    assert.equal(calls[0]!.text, '[CoachBeard] the report is ready');
  });

  it('is a safe no-op when creds are absent (credential-agnostic, pre-provisioning)', async () => {
    const { calls, send } = recordingSend();
    const out = await relayOperatorReply({
      agent: 'CoachBeard',
      message: 'hello',
      topic: 'status',
      clientCount: 0,
      alreadySentRecently: false,
      creds: null,
      send,
    });
    assert.equal(out.relayed, false);
    assert.equal(out.reason, 'no-creds');
    assert.equal(calls.length, 0);
  });

  it('does not dispatch when the decision says do-not-relay (operator on-dashboard)', async () => {
    const { calls, send } = recordingSend();
    const out = await relayOperatorReply({
      agent: 'CoachBeard',
      message: 'hello',
      topic: 'status',
      clientCount: 2,
      alreadySentRecently: false,
      creds: { botToken: 'tok', chatId: 'chat-1' },
      send,
    });
    assert.equal(out.relayed, false);
    assert.equal(out.reason, 'on-dashboard');
    assert.equal(calls.length, 0);
  });

  it('reports send-failed when the dispatcher returns false', async () => {
    const calls: number[] = [];
    const send = async () => { calls.push(1); return false; };
    const out = await relayOperatorReply({
      agent: 'X', message: 'm', topic: 'status', clientCount: 0, alreadySentRecently: false,
      creds: { botToken: 't', chatId: 'c' }, send, log: () => {},
    });
    assert.equal(out.relayed, false);
    assert.equal(out.reason, 'send-failed');
    assert.equal(calls.length, 1);
  });
});

describe('relayOperatorReply — failure observability (a broken relay must not be silent)', () => {
  function recordingLog() {
    const logs: Array<{ level: string; message: string }> = [];
    return { logs, log: (level: 'error' | 'warn', message: string) => { logs.push({ level, message }); } };
  }

  it('logs an error when the dispatcher returns false — the broken relay is observable', async () => {
    const { logs, log } = recordingLog();
    const out = await relayOperatorReply({
      agent: 'AgentF', message: 'unreachable', topic: 'status', clientCount: 0,
      alreadySentRecently: false, creds: { botToken: 't', chatId: 'c' },
      send: async () => false, log,
    });
    assert.equal(out.reason, 'send-failed');
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.level, 'error');
    assert.match(logs[0]!.message, /AgentF/);
  });

  it('logs an error AND resolves (never rejects) when the dispatcher throws', async () => {
    const { logs, log } = recordingLog();
    const out = await relayOperatorReply({
      agent: 'AgentG', message: 'boom', topic: 'status', clientCount: 0,
      alreadySentRecently: false, creds: { botToken: 't', chatId: 'c' },
      send: async () => { throw new Error('network down'); }, log,
    });
    assert.equal(out.relayed, false);
    assert.equal(out.reason, 'send-threw');
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.level, 'error');
    assert.match(logs[0]!.message, /network down/);
  });

  it('does NOT log on a successful send', async () => {
    const { logs, log } = recordingLog();
    const out = await relayOperatorReply({
      agent: 'AgentH', message: 'ok', topic: 'status', clientCount: 0,
      alreadySentRecently: false, creds: { botToken: 't', chatId: 'c' },
      send: async () => true, log,
    });
    assert.equal(out.relayed, true);
    assert.equal(logs.length, 0);
  });

  it('does NOT log for a normal do-not-relay decision (on-dashboard)', async () => {
    const { logs, log } = recordingLog();
    const out = await relayOperatorReply({
      agent: 'AgentI', message: 'x', topic: 'status', clientCount: 2,
      alreadySentRecently: false, creds: { botToken: 't', chatId: 'c' },
      send: async () => true, log,
    });
    assert.equal(out.reason, 'on-dashboard');
    assert.equal(logs.length, 0);
  });
});
