import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntEnv, selectFastPollAgents } from './health-monitor.ts';

/**
 * Lane-a (2026-08-05 OOM incident) fast-poll env-config. The GATE-CRITICAL property is
 * DEFAULT-INERT: shipping the mechanism must change NOTHING until Ben-tuned env values land.
 */

describe('parseIntEnv — fail-safe positive-int env parse', () => {
  it('missing var → default', () => {
    assert.equal(parseIntEnv('X', 2000, {}), 2000);
  });
  it('empty string → default', () => {
    assert.equal(parseIntEnv('X', 2000, { X: '' }), 2000);
  });
  it('valid positive int → parsed', () => {
    assert.equal(parseIntEnv('X', 2000, { X: '5000' }), 5000);
  });
  it('non-numeric → default (fail-safe, never NaN)', () => {
    assert.equal(parseIntEnv('X', 2000, { X: 'abc' }), 2000);
  });
  it('zero → default (fail-safe; <= 0 rejected)', () => {
    assert.equal(parseIntEnv('X', 2000, { X: '0' }), 2000);
  });
  it('negative → default', () => {
    assert.equal(parseIntEnv('X', 2000, { X: '-4' }), 2000);
  });
  it('non-integer (2.5) → default', () => {
    assert.equal(parseIntEnv('X', 2000, { X: '2.5' }), 2000);
  });
  it('default 0 (the FAST_POLL_MAX_AGENTS inert default) is preserved when unset', () => {
    assert.equal(parseIntEnv('FAST_POLL_MAX_AGENTS', 0, {}), 0);
  });
});

describe('selectFastPollAgents — cap honoring, DEFAULT-INERT', () => {
  const mk = (...names: string[]) => names.map((name) => ({ name }));
  const ts = new Map<string, number>([['a', 30], ['b', 10], ['c', 20], ['d', 40]]);

  it('★ DEFAULT-INERT: cap 0 (the default) returns the input UNCHANGED (same reference)', () => {
    const agents = mk('a', 'b', 'c', 'd');
    const out = selectFastPollAgents(agents, 0, ts);
    assert.equal(out, agents, 'cap 0 must be a literal no-op — same array reference');
  });
  it('cap < 0 also returns input unchanged (fail-safe)', () => {
    const agents = mk('a', 'b', 'c');
    assert.equal(selectFastPollAgents(agents, -1, ts), agents);
  });
  it('cap >= length returns input unchanged (nothing to drop)', () => {
    const agents = mk('a', 'b', 'c');
    assert.equal(selectFastPollAgents(agents, 3, ts), agents);
    assert.equal(selectFastPollAgents(agents, 99, ts), agents);
  });
  it('cap < length → the cap MOST-RECENTLY-ACTIVE agents (by lastActivityTs desc)', () => {
    const agents = mk('a', 'b', 'c', 'd'); // ts: a=30 b=10 c=20 d=40
    const out = selectFastPollAgents(agents, 2, ts).map((x) => x.name);
    assert.deepEqual(out, ['d', 'a'], 'top-2 by recency: d(40), a(30)');
  });
  it('missing timestamp treated as 0 (least recent, dropped first)', () => {
    const agents = mk('a', 'z'); // z has no ts → 0
    const out = selectFastPollAgents(agents, 1, ts).map((x) => x.name);
    assert.deepEqual(out, ['a'], 'a(30) kept over z(missing=0)');
  });
  it('does not mutate the input array', () => {
    const agents = mk('a', 'b', 'c', 'd');
    const snapshot = agents.map((x) => x.name);
    selectFastPollAgents(agents, 2, ts);
    assert.deepEqual(agents.map((x) => x.name), snapshot, 'input array unmutated');
  });
});
