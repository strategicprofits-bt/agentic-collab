// ── System-B telegram fan-out drop detection + alert (C) ──
//
// The /api/notify fan-out and the project-board→Ben send ignored telegramDispatcher.send()'s
// boolean result — a send returning false (Telegram API !ok) or throwing was swallowed, so a
// page could silently fail to reach Ben with NO surface. This module makes such a drop
// observable (logEvent) and actively surfaced to the Telegram-reaching monitors via
// enqueueMessage→collab — the same confirmed-watched, telegram-independent path the
// stranded-alert uses (health-monitor). It never writes the message body anywhere.
//
// Threshold is PER-RECIPIENT: a Telegram recipient (chatId) is DROPPED when it had >=1 send
// attempt and ZERO succeeded (that person got nothing). Chosen because the destinations table
// is empty, so redundant-to-one-person vs distinct-recipients cannot be grounded — per-recipient
// is correct under BOTH (a partial success to the SAME chatId is not a drop; a distinct chatId
// that got zero IS).

export type SendAttempt = { chatId: string; ok: boolean };

export const NOTIFY_DROP_TARGETS = ['DrRobby', 'SydneyAdamu'] as const;
export const NOTIFY_DROP_TOPIC = 'telegram-notify-drop';

/** Distinct chatIds that had at least one attempt and zero successes (the recipient got nothing). */
export function droppedRecipients(attempts: SendAttempt[]): string[] {
  const byChat = new Map<string, boolean>(); // chatId → anyOk
  for (const a of attempts) {
    byChat.set(a.chatId, (byChat.get(a.chatId) ?? false) || a.ok);
  }
  const dropped: string[] = [];
  for (const [chatId, anyOk] of byChat) {
    if (!anyOk) dropped.push(chatId);
  }
  return dropped;
}

/** Content-free alert body: recipient count + context + guidance. NO page body. */
export function buildNotifyDropBody(droppedCount: number, context: string): string {
  return (
    `⚠️ ${droppedCount} operator Telegram recipient(s) got NOTHING from ${context} — every ` +
    `send to them failed (Telegram API rejected or threw). Check Telegram reachability. This ` +
    `alert came via collab because Telegram is the failed channel.`
  );
}

/**
 * Surface a System-B telegram drop: a durable logEvent + an active alert to the Telegram-
 * reaching monitors via enqueueMessage→collab (mirrors the health-monitor alert envelope).
 * Deps are injected so this is unit-testable with no DB/network. No-op when nothing dropped.
 */
export function alertNotifyDrop(deps: {
  droppedChatIds: string[];
  context: string;
  enqueue: (target: string, envelope: string) => void;
  logEvent: (event: string, meta: Record<string, unknown>) => void;
}): void {
  if (deps.droppedChatIds.length === 0) return;
  deps.logEvent('telegram_notify_drop', {
    context: deps.context,
    droppedRecipientCount: deps.droppedChatIds.length,
  });
  const body = buildNotifyDropBody(deps.droppedChatIds.length, deps.context);
  const envelope = `[from: system, reply with collab send system --topic ${NOTIFY_DROP_TOPIC}]: '${body.replace(/'/g, "\\'")}'`;
  for (const target of NOTIFY_DROP_TARGETS) {
    deps.enqueue(target, envelope);
  }
}
