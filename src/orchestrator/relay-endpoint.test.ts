import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { relayReplyToOperator } from './relay-policy.ts';

function recordingSend() {
  const calls: Array<{ botToken: string; chatId: string; text: string }> = [];
  const send = async (botToken: string, chatId: string, text: string) => {
    calls.push({ botToken, chatId, text });
    return true;
  };
  return { calls, send };
}

describe('relayReplyToOperator — env creds + dedup wiring', () => {
  const savedToken = process.env['OPERATOR_RELAY_BOT_TOKEN'];
  const savedChat = process.env['OPERATOR_RELAY_CHAT_ID'];

  beforeEach(() => {
    process.env['OPERATOR_RELAY_BOT_TOKEN'] = 'bot-tok';
    process.env['OPERATOR_RELAY_CHAT_ID'] = 'chat-99';
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env['OPERATOR_RELAY_BOT_TOKEN'];
    else process.env['OPERATOR_RELAY_BOT_TOKEN'] = savedToken;
    if (savedChat === undefined) delete process.env['OPERATOR_RELAY_CHAT_ID'];
    else process.env['OPERATOR_RELAY_CHAT_ID'] = savedChat;
  });

  it('relays via the dispatcher when the operator is away and env creds are present', async () => {
    const { calls, send } = recordingSend();
    const out = await relayReplyToOperator({
      agent: 'AgentA', message: 'msg-away-1', topic: 'status', clientCount: 0, nowMs: 1000, send,
    });
    assert.equal(out.relayed, true);
    assert.equal(out.reason, 'sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.botToken, 'bot-tok');
    assert.equal(calls[0]!.chatId, 'chat-99');
    assert.equal(calls[0]!.text, '[AgentA] msg-away-1');
  });

  it('is a no-op when env creds are absent (credential-agnostic pre-provisioning)', async () => {
    delete process.env['OPERATOR_RELAY_BOT_TOKEN'];
    delete process.env['OPERATOR_RELAY_CHAT_ID'];
    const { calls, send } = recordingSend();
    const out = await relayReplyToOperator({
      agent: 'AgentB', message: 'msg-nocreds', topic: 'status', clientCount: 0, nowMs: 1000, send,
    });
    assert.equal(out.relayed, false);
    assert.equal(out.reason, 'no-creds');
    assert.equal(calls.length, 0);
  });

  it('does not relay while a dashboard client is connected (no double-push)', async () => {
    const { calls, send } = recordingSend();
    const out = await relayReplyToOperator({
      agent: 'AgentC', message: 'msg-present', topic: 'status', clientCount: 1, nowMs: 1000, send,
    });
    assert.equal(out.relayed, false);
    assert.equal(out.reason, 'on-dashboard');
    assert.equal(calls.length, 0);
  });

  it('skips a telegram-prefixed topic — the poller owns it', async () => {
    const { calls, send } = recordingSend();
    const out = await relayReplyToOperator({
      agent: 'AgentD', message: 'msg-tele', topic: 'telegram-sev3', clientCount: 0, nowMs: 1000, send,
    });
    assert.equal(out.relayed, false);
    assert.equal(out.reason, 'telegram-topic-poller-owns');
    assert.equal(calls.length, 0);
  });

  it('dedups a repeated identical reply within the cooldown window', async () => {
    const { calls, send } = recordingSend();
    const first = await relayReplyToOperator({
      agent: 'AgentE', message: 'dupe-msg', topic: 'status', clientCount: 0, nowMs: 1000, send,
    });
    assert.equal(first.relayed, true);
    const second = await relayReplyToOperator({
      agent: 'AgentE', message: 'dupe-msg', topic: 'status', clientCount: 0, nowMs: 2000, send,
    });
    assert.equal(second.relayed, false);
    assert.equal(second.reason, 'dedup');
    assert.equal(calls.length, 1); // only the first actually dispatched
  });
});
