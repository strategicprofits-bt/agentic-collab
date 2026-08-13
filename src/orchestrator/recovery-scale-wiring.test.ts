import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordRecoveryScale, type LifecycleContext } from './lifecycle.ts';
import { RecoveryScaleTracker } from './recovery-scale-tracker.ts';

// Focused, infra-free coverage of the recoverAgent→tracker wiring glue (`recordRecoveryScale`).
// The tracker's own window/threshold logic is covered by recovery-scale-tracker.test.ts; here we
// verify the ctx plumbing: fresh-sid → event logged; non-fresh → nothing; absent tracker → no-op;
// and that a db failure can NEVER throw into the lifecycle path.

type LoggedEvent = { name: string; event: string; meta: unknown };

function makeCtx(opts: {
  tracker?: RecoveryScaleTracker;
  activeAgents?: number;
  logEventThrows?: boolean;
}): { ctx: LifecycleContext; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  const active = opts.activeAgents ?? 3;
  const db = {
    listAgents: () => Array.from({ length: active }, (_, i) => ({ name: `a${i}`, state: 'active' })),
    logEvent: (name: string, event: string, _detail: unknown, meta: unknown) => {
      if (opts.logEventThrows) throw new Error('db down');
      events.push({ name, event, meta });
    },
  } as unknown as LifecycleContext['db'];
  const ctx = { db, recoveryScaleTracker: opts.tracker } as unknown as LifecycleContext;
  return { ctx, events };
}

describe('recordRecoveryScale (recoverAgent wiring glue)', () => {
  it('fresh-sid reap → logs recovery_scale_fresh_sid with windowCount', () => {
    const { ctx, events } = makeCtx({ tracker: new RecoveryScaleTracker() });
    recordRecoveryScale(ctx, 'Alice', 'sid-old', 'sid-new');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, 'recovery_scale_fresh_sid');
    assert.equal(events[0]!.name, 'Alice');
    assert.equal((events[0]!.meta as { windowCount: number }).windowCount, 1);
  });

  it('prior-null (first spawn, not a reap) → logs nothing', () => {
    const { ctx, events } = makeCtx({ tracker: new RecoveryScaleTracker() });
    recordRecoveryScale(ctx, 'Bob', null, 'sid-new');
    assert.equal(events.length, 0);
  });

  it('resumed same sid (not context loss) → logs nothing', () => {
    const { ctx, events } = makeCtx({ tracker: new RecoveryScaleTracker() });
    recordRecoveryScale(ctx, 'Cara', 'sid-x', 'sid-x');
    assert.equal(events.length, 0);
  });

  it('no tracker injected → no-op, no throw', () => {
    const { ctx, events } = makeCtx({}); // tracker omitted = absent on the ctx
    assert.doesNotThrow(() => recordRecoveryScale(ctx, 'Dan', 'sid-old', 'sid-new'));
    assert.equal(events.length, 0);
  });

  it('shadow mode → never emits a recovery_scale_alert even above the hypothesis threshold', () => {
    // paging disabled by default; drive well past max(3, ceil(0.2*active)) and assert no alert.
    const { ctx, events } = makeCtx({ tracker: new RecoveryScaleTracker(), activeAgents: 5 });
    for (let i = 0; i < 10; i++) recordRecoveryScale(ctx, `x${i}`, `old${i}`, `new${i}`);
    assert.ok(events.every((e) => e.event === 'recovery_scale_fresh_sid'));
    assert.equal(events.filter((e) => e.event === 'recovery_scale_alert').length, 0);
  });

  it('db.logEvent failure is swallowed — observability never breaks recovery', () => {
    const { ctx } = makeCtx({ tracker: new RecoveryScaleTracker(), logEventThrows: true });
    assert.doesNotThrow(() => recordRecoveryScale(ctx, 'Eve', 'sid-old', 'sid-new'));
  });
});
