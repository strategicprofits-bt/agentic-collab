// ── Presence-aware operator-reply relay policy (P2a) ──
//
// Operator ("Ben") replies posted by agents via POST /api/dashboard/reply are
// dashboard-WebSocket-only. Historically they reached his phone ONLY when the
// agent prefixed the topic with "telegram*", which an external poller relays —
// so plain-topic replies were silently dropped whenever he was not watching the
// dashboard. This module is the single tunable decision point that fixes that:
// relay operator-bound replies to the phone BY DEFAULT, but only when no live
// dashboard WebSocket session is connected (he is away), so we never double-push
// content he is already seeing live.
//
// Two-tier behavior (intended, documented in CLAUDE.md):
//  - plain topic         → presence-aware relay (this module).
//  - "telegram*" topic   → skipped here; the external poller always-relays them
//                          (an always-push override, presence-be-damned). Skipping
//                          inline avoids double-sending the same message.
//
// decideRelay is PURE (no I/O). relayOperatorReply layers the dispatch on top and
// is credential-agnostic: with no creds it is a safe no-op, so the code ships and
// its tests pass before the bot token is provisioned (env-injected, never at-rest).

/** The single tunable relay policy. `mode` is presence-aware today; the topic
 * lists are reserved knobs for tuning without a re-architecture. */
export type RelayPolicy = {
  mode: 'presence-aware';
  /** Topics relayed regardless of presence (e.g. completions). Reserved knob. */
  alwaysTopics: string[];
  /** Topics never relayed to the phone (routine noise). Reserved knob. */
  neverTopics: string[];
};

export const DEFAULT_RELAY_POLICY: RelayPolicy = {
  mode: 'presence-aware',
  alwaysTopics: [],
  neverTopics: [],
};

export type RelayDecision = { relay: boolean; reason: string };

/**
 * Decide whether an operator-bound reply should be relayed to the phone. Pure —
 * all inputs are passed in, so a classifier/env misread can never itself send.
 *
 * Precedence (first match wins):
 *  1. "telegram*" topic → the poller owns it (skip here, no double-send).
 *  2. neverTopics       → never relay.
 *  3. dedup             → suppress a recently-sent identical message (noise floor).
 *  4. alwaysTopics      → relay regardless of presence.
 *  5. presence          → relay iff no dashboard client is connected (operator away).
 */
export function decideRelay(input: {
  topic: string;
  clientCount: number;
  alreadySentRecently: boolean;
  policy?: RelayPolicy;
}): RelayDecision {
  const policy = input.policy ?? DEFAULT_RELAY_POLICY;
  const topic = input.topic ?? '';

  if (topic.toLowerCase().startsWith('telegram')) {
    return { relay: false, reason: 'telegram-topic-poller-owns' };
  }
  if (policy.neverTopics.includes(topic)) {
    return { relay: false, reason: 'never-topic' };
  }
  if (input.alreadySentRecently) {
    return { relay: false, reason: 'dedup' };
  }
  if (policy.alwaysTopics.includes(topic)) {
    return { relay: true, reason: 'always-topic' };
  }
  if (input.clientCount > 0) {
    return { relay: false, reason: 'on-dashboard' };
  }
  return { relay: true, reason: 'presence-away' };
}

/**
 * Apply the relay decision and, if it relays AND creds are present, dispatch to
 * the operator's phone. Credential-agnostic: `creds: null` → safe no-op. The
 * `send` dependency is injected (the orchestrator passes telegramDispatcher.send)
 * so this is fully unit-testable without a real Telegram call.
 */
export async function relayOperatorReply(deps: {
  agent: string;
  message: string;
  topic: string;
  clientCount: number;
  alreadySentRecently: boolean;
  policy?: RelayPolicy;
  creds: { botToken: string; chatId: string } | null;
  send: (botToken: string, chatId: string, text: string) => Promise<boolean>;
}): Promise<{ relayed: boolean; reason: string }> {
  const decision = decideRelay({
    topic: deps.topic,
    clientCount: deps.clientCount,
    alreadySentRecently: deps.alreadySentRecently,
    policy: deps.policy ?? DEFAULT_RELAY_POLICY,
  });
  if (!decision.relay) return { relayed: false, reason: decision.reason };
  if (!deps.creds) return { relayed: false, reason: 'no-creds' };

  const text = `[${deps.agent}] ${deps.message}`;
  const ok = await deps.send(deps.creds.botToken, deps.creds.chatId, text);
  return { relayed: ok, reason: ok ? 'sent' : 'send-failed' };
}

// ── Env-injected credentials + dedup noise-floor + wiring ──
// Kept here (not in routes.ts) so the whole relay decision+dispatch lives in one
// unit-testable module and routes.ts only passes in live values from its ctx.

const relaySentHashes = new Map<string, number>();
const RELAY_DEDUP_MS = 4 * 60 * 60 * 1000; // 4h noise-floor (mirrors /api/notify)

/** FNV-1a hash of agent+message for dedup (independent of routes.ts's copy). */
function relayHash(agent: string, message: string): string {
  let h = 0x811c9dc5;
  const s = `${agent}:${message}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Read the ENV-injected relay credentials, or null if unprovisioned. The token
 * is never stored at-rest — same-token-vs-scoped-bot is a pure deploy wiring. */
export function operatorRelayCreds(): { botToken: string; chatId: string } | null {
  const botToken = process.env['OPERATOR_RELAY_BOT_TOKEN'];
  const chatId = process.env['OPERATOR_RELAY_CHAT_ID'];
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

/**
 * Full presence-aware relay for one operator-bound reply: reads env creds + the
 * dedup noise-floor, applies the policy, and dispatches via the injected `send`.
 * `clientCount` is the live dashboard-WS count (presence); `nowMs` is injected
 * for testable dedup. Credential-agnostic: unprovisioned → safe no-op.
 */
export async function relayReplyToOperator(deps: {
  agent: string;
  message: string;
  topic: string;
  clientCount: number;
  nowMs: number;
  send: (botToken: string, chatId: string, text: string) => Promise<boolean>;
  policy?: RelayPolicy;
}): Promise<{ relayed: boolean; reason: string }> {
  const hash = relayHash(deps.agent, deps.message);
  const last = relaySentHashes.get(hash);
  const alreadySentRecently = last !== undefined && (deps.nowMs - last) < RELAY_DEDUP_MS;

  const out = await relayOperatorReply({
    agent: deps.agent,
    message: deps.message,
    topic: deps.topic,
    clientCount: deps.clientCount,
    alreadySentRecently,
    policy: deps.policy ?? DEFAULT_RELAY_POLICY,
    creds: operatorRelayCreds(),
    send: deps.send,
  });

  if (out.relayed) {
    relaySentHashes.set(hash, deps.nowMs);
    if (relaySentHashes.size > 500) {
      for (const [k, ts] of relaySentHashes) {
        if (deps.nowMs - ts > RELAY_DEDUP_MS) relaySentHashes.delete(k);
      }
    }
  }
  return out;
}
