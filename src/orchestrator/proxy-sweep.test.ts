import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sweepStaleProxies, type ProxySweepDeps } from './proxy-sweep.ts';

const CFG = { staleSeconds: 45, failSeconds: 90 };

/**
 * Fake world: each proxy has an AGE (seconds since last heartbeat). listStaleProxies(threshold)
 * returns proxies whose age exceeds the threshold — exactly the DB query's semantics. This is the
 * ONLY liveness input the sweep has; there is deliberately no HTTP/pull channel to model.
 */
function makeDeps(proxyAges: Record<string, number>, agentsByProxy: Record<string, string[]> = {}) {
  const removed: string[] = [];
  const failedAgents: Array<{ agent: string; proxyId: string }> = [];
  const logs: string[] = [];
  const allAgents = Object.entries(agentsByProxy).flatMap(([pid, names]) =>
    names.map((n) => ({ name: n, proxyId: pid, version: 1 })));
  const deps: ProxySweepDeps = {
    listStaleProxies: (threshold) =>
      Object.entries(proxyAges)
        .filter(([, age]) => age > threshold)
        .map(([proxyId, age]) => ({ proxyId, lastHeartbeat: `age=${age}s` }) as never),
    removeProxy: (id) => removed.push(id),
    listAgents: () => allAgents as never,
    isRunning: () => true,
    failAgent: (agent, proxyId) => failedAgents.push({ agent: (agent as { name: string }).name, proxyId }),
    log: (m) => logs.push(m),
  };
  return { deps, removed, failedAgents, logs };
}

describe('GAP-026 T1 — proxy bounded heartbeat-grace sweep', () => {
  it('(a) live-but-slow: enters grace, then recovers on a resumed heartbeat — NEVER failed', () => {
    const grace = new Set<string>();
    // Sweep 1: heartbeat aged to 60s (stale >45, but < 90 fail) → grace, no fail/alert.
    const w1 = makeDeps({ P: 60 }, { P: ['a1', 'a2'] });
    const r1 = sweepStaleProxies(w1.deps, CFG, grace);
    assert.deepEqual(r1.graced, ['P']);
    assert.deepEqual(r1.failed, []);
    assert.deepEqual(w1.removed, []);
    assert.deepEqual(w1.failedAgents, [], 'no agent failed during grace');
    assert.ok(grace.has('P'));

    // Sweep 2: heartbeat resumed (age 5s, not stale) → recovered, grace cleared, still never failed.
    const w2 = makeDeps({ P: 5 }, { P: ['a1', 'a2'] });
    const r2 = sweepStaleProxies(w2.deps, CFG, grace);
    assert.deepEqual(r2.recovered, ['P']);
    assert.deepEqual(r2.failed, []);
    assert.deepEqual(w2.failedAgents, []);
    assert.equal(grace.has('P'), false, 'grace cleared on recovery');
  });

  it('(b) genuinely-dead: heartbeat age past failSeconds → proxy removed + its agents failed', () => {
    const grace = new Set<string>();
    const w = makeDeps({ P: 100 }, { P: ['a1', 'a2'] });
    const r = sweepStaleProxies(w.deps, CFG, grace);
    assert.deepEqual(r.failed, ['P']);
    assert.deepEqual(w.removed, ['P']);
    assert.deepEqual(w.failedAgents, [
      { agent: 'a1', proxyId: 'P' },
      { agent: 'a2', proxyId: 'P' },
    ]);
    assert.equal(grace.has('P'), false);
  });

  it('(c) http-alive-but-non-heartbeating: still failed at failSeconds (no pull path exists to spare it)', () => {
    // Structural proof of invariant (2): the sweep has NO health-check input. A proxy whose HTTP
    // would answer is indistinguishable here from any other — only heartbeat age matters. age>90 → fail.
    const grace = new Set<string>();
    const depKeys = Object.keys(makeDeps({}).deps);
    assert.equal(depKeys.some((k) => /health|ping|http|reach/i.test(k)), false,
      'sweep must have no pull/health-check dependency — death authority is heartbeat-age only');
    const w = makeDeps({ P: 300 }, { P: ['a1'] }); // heartbeat wedged long ago; HTTP irrelevant
    const r = sweepStaleProxies(w.deps, CFG, grace);
    assert.deepEqual(r.failed, ['P']);
    assert.deepEqual(w.failedAgents, [{ agent: 'a1', proxyId: 'P' }]);
  });

  it('grace → fail transition: a graced proxy that keeps not-heartbeating is failed once age passes failSeconds', () => {
    const grace = new Set<string>();
    sweepStaleProxies(makeDeps({ P: 60 }, { P: ['a1'] }).deps, CFG, grace); // grace
    assert.ok(grace.has('P'));
    const w = makeDeps({ P: 95 }, { P: ['a1'] }); // now past fail window
    const r = sweepStaleProxies(w.deps, CFG, grace);
    assert.deepEqual(r.failed, ['P']);
    assert.deepEqual(w.failedAgents, [{ agent: 'a1', proxyId: 'P' }]);
    assert.equal(grace.has('P'), false);
  });

  it('grace entry is logged/reported ONCE across repeated stale sweeps (dedup)', () => {
    const grace = new Set<string>();
    const r1 = sweepStaleProxies(makeDeps({ P: 60 }).deps, CFG, grace);
    const r2 = sweepStaleProxies(makeDeps({ P: 62 }).deps, CFG, grace);
    assert.deepEqual(r1.graced, ['P']);
    assert.deepEqual(r2.graced, [], 'no re-report while it stays in grace');
    assert.ok(grace.has('P'));
  });

  it('mixed fleet: healthy untouched, stale graced, dead failed — only the dead proxy’s agents fail', () => {
    const grace = new Set<string>();
    const w = makeDeps(
      { P1: 30, P2: 60, P3: 100 },
      { P1: ['h1'], P2: ['s1'], P3: ['d1', 'd2'] },
    );
    const r = sweepStaleProxies(w.deps, CFG, grace);
    assert.deepEqual(r.graced, ['P2']);
    assert.deepEqual(r.failed, ['P3']);
    assert.deepEqual(w.removed, ['P3']);
    assert.deepEqual(w.failedAgents.map((f) => f.agent).sort(), ['d1', 'd2'], 'only the dead proxy’s agents failed');
    assert.equal(grace.has('P1'), false); // healthy never entered grace
    assert.ok(grace.has('P2'));
  });
});
