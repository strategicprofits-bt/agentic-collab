import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerDeathWatcher, type ServerProbe } from './server-death-watcher.ts';

/** Mutable fake probe driven by the test. */
function fakeProbe(init: Partial<Record<keyof ServerProbe, unknown>> = {}): {
  probe: ServerProbe;
  set: (k: keyof ServerProbe, v: unknown) => void;
  calls: Record<string, number>;
} {
  const state: Record<string, unknown> = {
    tmuxServerPid: '100',
    socketInode: '5000',
    free: 'mem', who: 'who', last: 'last', dmesgTail: 'dmesg',
    ...init,
  };
  const calls: Record<string, number> = {};
  const mk = (k: string) => async () => {
    calls[k] = (calls[k] ?? 0) + 1;
    const v = state[k];
    if (v instanceof Error) throw v;
    return v as string | null;
  };
  const probe: ServerProbe = {
    tmuxServerPid: mk('tmuxServerPid'),
    socketInode: mk('socketInode'),
    free: mk('free'), who: mk('who'), last: mk('last'), dmesgTail: mk('dmesgTail'),
  };
  return { probe, set: (k, v) => { state[k as string] = v; }, calls };
}

const TS = '2026-08-10T00:00:00.000Z';

test('first observation establishes baseline, emits no event', async () => {
  const { probe } = fakeProbe();
  const w = new ServerDeathWatcher(probe);
  assert.equal(await w.poll(TS), null);
  assert.deepEqual(w.getBaseline(), { pid: '100', inode: '5000' });
});

test('no change → no event', async () => {
  const { probe } = fakeProbe();
  const w = new ServerDeathWatcher(probe);
  await w.poll(TS); // baseline
  assert.equal(await w.poll(TS), null);
  assert.equal(await w.poll(TS), null);
});

test('PID change → death event with old/new identity', async () => {
  const f = fakeProbe();
  const w = new ServerDeathWatcher(f.probe);
  await w.poll(TS); // baseline pid=100
  f.set('tmuxServerPid', '200'); // recreate
  const ev = await w.poll(TS);
  assert.ok(ev, 'expected a death report');
  assert.equal(ev!.oldPid, '100');
  assert.equal(ev!.newPid, '200');
  assert.equal(ev!.detectedAt, TS);
  assert.deepEqual(w.getBaseline(), { pid: '200', inode: '5000' });
});

test('inode change (same PID) → death event', async () => {
  const f = fakeProbe();
  const w = new ServerDeathWatcher(f.probe);
  await w.poll(TS);
  f.set('socketInode', '9999'); // socket recreated, pid coincidentally reused
  const ev = await w.poll(TS);
  assert.ok(ev);
  assert.equal(ev!.oldInode, '5000');
  assert.equal(ev!.newInode, '9999');
});

test('death→recreate: null gap holds baseline, fires on return with new pid', async () => {
  const f = fakeProbe();
  const w = new ServerDeathWatcher(f.probe);
  await w.poll(TS); // baseline pid=100
  // server down at probe time — pid null: hold, no event, baseline preserved
  f.set('tmuxServerPid', null);
  assert.equal(await w.poll(TS), null);
  assert.deepEqual(w.getBaseline(), { pid: '100', inode: '5000' });
  // recreated with a new pid → now it's a detected change
  f.set('tmuxServerPid', '300');
  const ev = await w.poll(TS);
  assert.ok(ev);
  assert.equal(ev!.oldPid, '100');
  assert.equal(ev!.newPid, '300');
});

test('event fires exactly once per change (baseline advances)', async () => {
  const f = fakeProbe();
  const w = new ServerDeathWatcher(f.probe);
  await w.poll(TS);
  f.set('tmuxServerPid', '200');
  assert.ok(await w.poll(TS), 'first poll after change fires');
  assert.equal(await w.poll(TS), null, 'second poll at same identity is silent');
});

test('snapshot captures all probe fields', async () => {
  const f = fakeProbe();
  const w = new ServerDeathWatcher(f.probe);
  await w.poll(TS);
  f.set('tmuxServerPid', '200');
  const ev = await w.poll(TS);
  assert.deepEqual(ev!.snapshot, { free: 'mem', who: 'who', last: 'last', dmesg: 'dmesg' });
});

test('snapshot swallows a failing probe → null field, still returns', async () => {
  const f = fakeProbe();
  const w = new ServerDeathWatcher(f.probe);
  await w.poll(TS);
  f.set('tmuxServerPid', '200');
  f.set('dmesgTail', new Error('EPERM')); // dmesg_restrict=1
  f.set('free', new Error('boom'));
  const ev = await w.poll(TS);
  assert.ok(ev, 'report still returned despite probe failures');
  assert.equal(ev!.snapshot.dmesg, null);
  assert.equal(ev!.snapshot.free, null);
  assert.equal(ev!.snapshot.who, 'who'); // unaffected probe survives
});

test('a throwing identity probe cannot crash poll (treated as unavailable)', async () => {
  const f = fakeProbe();
  const w = new ServerDeathWatcher(f.probe);
  await w.poll(TS);
  f.set('tmuxServerPid', new Error('tmux gone'));
  assert.equal(await w.poll(TS), null, 'throwing pid probe → null → hold, no crash');
  assert.deepEqual(w.getBaseline(), { pid: '100', inode: '5000' });
});

test('unknown baseline inode is backfilled without a spurious death', async () => {
  const f = fakeProbe({ socketInode: null });
  const w = new ServerDeathWatcher(f.probe);
  await w.poll(TS); // baseline { pid:100, inode:null }
  f.set('socketInode', '5000'); // inode becomes readable, pid unchanged
  assert.equal(await w.poll(TS), null, 'null→value inode backfill is not a death');
  assert.deepEqual(w.getBaseline(), { pid: '100', inode: '5000' });
});
