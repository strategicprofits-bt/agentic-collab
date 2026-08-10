import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportServerDeath, SERVER_DEATH_ALERT_TARGETS } from './server-death-alert.ts';
import type { TmuxServerDeathReport } from '../shared/types.ts';

function spyDeps() {
  const events: Array<{ agent: string; event: string; meta: Record<string, unknown> }> = [];
  const enqueued: Array<{ target: string; envelope: string }> = [];
  const notified: string[] = [];
  return {
    events, enqueued, notified,
    deps: {
      logEvent: (agent: string, event: string, meta: Record<string, unknown>) =>
        events.push({ agent, event, meta }),
      enqueue: (target: string, envelope: string) => enqueued.push({ target, envelope }),
      notify: (target: string) => notified.push(target),
    },
  };
}

function report(over: Partial<TmuxServerDeathReport> = {}): TmuxServerDeathReport {
  return {
    oldPid: '100', oldInode: '5000', newPid: '200', newInode: '9000',
    detectedAt: '2026-08-10T00:00:00.000Z',
    snapshot: { free: 'mem', who: 'who', last: 'last', dmesg: null },
    ...over,
  };
}

test('logs a tmux_server_died event with full payload under system', () => {
  const s = spyDeps();
  reportServerDeath(s.deps, new Set(), 'proxy-1', report());
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0]!.agent, 'system');
  assert.equal(s.events[0]!.event, 'tmux_server_died');
  assert.equal(s.events[0]!.meta['proxyId'], 'proxy-1');
  assert.equal(s.events[0]!.meta['oldPid'], '100');
  assert.equal(s.events[0]!.meta['newPid'], '200');
});

test('pages exactly Chloe + Sydney, enqueue then notify each', () => {
  const s = spyDeps();
  const out = reportServerDeath(s.deps, new Set(), 'proxy-1', report());
  assert.deepEqual(out.targets, [...SERVER_DEATH_ALERT_TARGETS]);
  assert.deepEqual(s.enqueued.map((e) => e.target), ['ChloeOBrian', 'SydneyAdamu']);
  assert.deepEqual(s.notified, ['ChloeOBrian', 'SydneyAdamu']);
});

test('alert envelope is a well-formed system message', () => {
  const s = spyDeps();
  reportServerDeath(s.deps, new Set(), 'proxy-1', report());
  const env = s.enqueued[0]!.envelope;
  assert.match(env, /^\[from: system, reply with collab send system --topic tmux-server-death\]:/);
  assert.match(env, /server PID 100→200/);
});

test('dedupe: same proxy+newPid → one alert only', () => {
  const s = spyDeps();
  const seen = new Set<string>();
  const first = reportServerDeath(s.deps, seen, 'proxy-1', report());
  const second = reportServerDeath(s.deps, seen, 'proxy-1', report());
  assert.equal(first.handled, true);
  assert.equal(second.handled, false);
  assert.deepEqual(second.targets, []);
  assert.equal(s.events.length, 1, 'event logged once');
  assert.equal(s.enqueued.length, 2, 'paged 2 targets once, not 4');
});

test('dedupe is per (proxyId,newPid): a genuinely new death still alerts', () => {
  const s = spyDeps();
  const seen = new Set<string>();
  reportServerDeath(s.deps, seen, 'proxy-1', report({ newPid: '200' }));
  const again = reportServerDeath(s.deps, seen, 'proxy-1', report({ newPid: '300' }));
  assert.equal(again.handled, true, 'a new server pid is a new death');
  assert.equal(s.events.length, 2);
});

test('dedupe is per proxy: same newPid on a different proxy still alerts', () => {
  const s = spyDeps();
  const seen = new Set<string>();
  reportServerDeath(s.deps, seen, 'proxy-1', report({ newPid: '200' }));
  const other = reportServerDeath(s.deps, seen, 'proxy-2', report({ newPid: '200' }));
  assert.equal(other.handled, true);
});

test('OOM hint surfaces when dmesg shows the killer', () => {
  const s = spyDeps();
  reportServerDeath(s.deps, new Set(), 'proxy-1', report({
    snapshot: { free: 'mem', who: 'w', last: 'l', dmesg: 'Out of memory: Killed process 100 (tmux)' },
  }));
  assert.match(s.enqueued[0]!.envelope, /OOM-killer lines/);
});
