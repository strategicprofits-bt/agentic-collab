import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { droppedRecipients, buildNotifyDropBody, alertNotifyDrop, NOTIFY_DROP_TARGETS, NOTIFY_DROP_TOPIC } from './notify-drop.ts';

// System-B telegram fan-out (/api/notify + project-board→Ben) had swallow-shaped bugs:
// a send returning false / throwing was ignored, so a page could silently fail to reach
// Ben with no surface. This pins the PER-RECIPIENT drop threshold (chosen because the
// destinations table is empty at build time, so redundant-vs-distinct cannot be grounded —
// per-recipient is correct under BOTH): a Telegram recipient (chatId) is DROPPED when it had
// >=1 attempt and ZERO succeeded (that person got nothing). A partial success (another dest
// to the SAME chatId landed) is NOT a drop.

describe('droppedRecipients — per-recipient telegram drop detection', () => {
  it('no attempts → no drops', () => {
    assert.deepEqual(droppedRecipients([]), []);
  });

  it('all sends ok → no drops', () => {
    assert.deepEqual(droppedRecipients([{ chatId: 'ben', ok: true }]), []);
  });

  it('a recipient whose every attempt failed → dropped', () => {
    assert.deepEqual(droppedRecipients([{ chatId: 'ben', ok: false }]), ['ben']);
  });

  it('partial success to the SAME recipient (redundant paths) → NOT dropped', () => {
    // two enabled dests to the same chatId; one failed, one landed → Ben got it.
    assert.deepEqual(
      droppedRecipients([{ chatId: 'ben', ok: false }, { chatId: 'ben', ok: true }]),
      [],
    );
  });

  it('distinct recipients, one all-failed one ok → only the failed recipient dropped', () => {
    assert.deepEqual(
      droppedRecipients([{ chatId: 'ben', ok: true }, { chatId: 'ashley', ok: false }]),
      ['ashley'],
    );
  });

  it('same recipient, multiple attempts all fail → dropped ONCE (distinct)', () => {
    assert.deepEqual(
      droppedRecipients([{ chatId: 'ben', ok: false }, { chatId: 'ben', ok: false }]),
      ['ben'],
    );
  });
});

describe('buildNotifyDropBody + constants', () => {
  it('body is content-free-ish: count + context + guidance, no page body', () => {
    const body = buildNotifyDropBody(2, 'api/notify');
    assert.match(body, /2/);
    assert.match(body, /api\/notify/);
    assert.match(body, /telegram|phone|reach/i);
  });

  it('targets are the Telegram-reaching monitors on the drop topic', () => {
    assert.deepEqual([...NOTIFY_DROP_TARGETS], ['DrRobby', 'SydneyAdamu']);
    assert.equal(NOTIFY_DROP_TOPIC, 'telegram-notify-drop');
  });
});

describe('alertNotifyDrop — durable logEvent + enqueue→collab active-push', () => {
  function harness() {
    const enqueued: Array<{ target: string; envelope: string }> = [];
    const events: Array<{ event: string; meta: Record<string, unknown> }> = [];
    return {
      enqueued, events,
      enqueue: (target: string, envelope: string) => enqueued.push({ target, envelope }),
      logEvent: (event: string, meta: Record<string, unknown>) => events.push({ event, meta }),
    };
  }

  it('no drops → no-op (no false alarm, no event)', () => {
    const h = harness();
    alertNotifyDrop({ droppedChatIds: [], context: 'api/notify', enqueue: h.enqueue, logEvent: h.logEvent });
    assert.equal(h.enqueued.length, 0);
    assert.equal(h.events.length, 0);
  });

  it('drops → one durable event + an alert enqueued to BOTH monitors on the drop topic', () => {
    const h = harness();
    alertNotifyDrop({ droppedChatIds: ['ben', 'ashley'], context: 'api/notify', enqueue: h.enqueue, logEvent: h.logEvent });
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0]!.event, 'telegram_notify_drop');
    assert.equal(h.events[0]!.meta['droppedRecipientCount'], 2);
    assert.deepEqual(h.enqueued.map((e) => e.target).sort(), ['DrRobby', 'SydneyAdamu']);
    for (const e of h.enqueued) {
      assert.match(e.envelope, /telegram-notify-drop/);
      assert.match(e.envelope, /got NOTHING/);
    }
  });
});
