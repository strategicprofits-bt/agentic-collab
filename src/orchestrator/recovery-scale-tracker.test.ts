import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RecoveryScaleTracker,
  hypothesisThreshold,
  RECOVERY_SCALE_PAGING_ENABLED,
} from './recovery-scale-tracker.ts';

const SID = (n: number) => `sid-${n}`;

test('SHADOW is the shipped default — paging disabled', () => {
  assert.equal(RECOVERY_SCALE_PAGING_ENABLED, false);
});

test('fresh-sid reap: prior non-null, new differs → counted', () => {
  const t = new RecoveryScaleTracker();
  const r = t.record({ agentName: 'A', priorSid: SID(1), newSid: SID(2), activeAgents: 20, nowMs: 1000 });
  assert.equal(r.isFreshSid, true);
  assert.equal(r.windowCount, 1);
});

test('prior-null (first spawn from no session) is NOT a reap', () => {
  const t = new RecoveryScaleTracker();
  const r = t.record({ agentName: 'A', priorSid: null, newSid: SID(2), activeAgents: 20, nowMs: 1000 });
  assert.equal(r.isFreshSid, false);
  assert.equal(r.windowCount, 0);
});

test('resumed (new == prior) is NOT a reap — keys on sid-continuity, not label', () => {
  const t = new RecoveryScaleTracker();
  const r = t.record({ agentName: 'A', priorSid: SID(1), newSid: SID(1), activeAgents: 20, nowMs: 1000 });
  assert.equal(r.isFreshSid, false);
  assert.equal(r.windowCount, 0);
});

test('new-null (non-claude engine, no session id) is NOT a reap', () => {
  const t = new RecoveryScaleTracker();
  const r = t.record({ agentName: 'A', priorSid: SID(1), newSid: null, activeAgents: 20, nowMs: 1000 });
  assert.equal(r.isFreshSid, false);
});

test('window prunes events older than 120s', () => {
  const t = new RecoveryScaleTracker();
  t.record({ agentName: 'A', priorSid: SID(1), newSid: SID(2), activeAgents: 20, nowMs: 0 });
  // 119s later → both in window
  let r = t.record({ agentName: 'B', priorSid: SID(3), newSid: SID(4), activeAgents: 20, nowMs: 119_000 });
  assert.equal(r.windowCount, 2);
  // 121s after the first → the first (t=0) has aged out, only the t=119s one + this remain
  r = t.record({ agentName: 'C', priorSid: SID(5), newSid: SID(6), activeAgents: 20, nowMs: 121_000 });
  assert.equal(r.windowCount, 2);
});

test('SHADOW: no alert even at a mass-reap count (paging disabled)', () => {
  const t = new RecoveryScaleTracker(); // default pagingEnabled=false
  let last;
  for (let i = 0; i < 20; i++) {
    last = t.record({ agentName: `A${i}`, priorSid: SID(i), newSid: SID(100 + i), activeAgents: 21, nowMs: 1000 + i });
  }
  assert.equal(last!.windowCount, 20);
  assert.equal(last!.alert, undefined); // shadow logs, never pages
});

test('PAGING ENABLED: alert fires once threshold crossed, carries N/M/window', () => {
  const t = new RecoveryScaleTracker({ pagingEnabled: true, thresholdFn: () => 3 });
  assert.equal(t.record({ agentName: 'A', priorSid: SID(1), newSid: SID(11), activeAgents: 21, nowMs: 1 }).alert, undefined);
  assert.equal(t.record({ agentName: 'B', priorSid: SID(2), newSid: SID(12), activeAgents: 21, nowMs: 2 }).alert, undefined);
  const third = t.record({ agentName: 'C', priorSid: SID(3), newSid: SID(13), activeAgents: 21, nowMs: 3 });
  assert.ok(third.alert, 'threshold of 3 crossed → alert');
  assert.equal(third.alert!.windowCount, 3);
  assert.equal(third.alert!.activeAgents, 21);
  assert.equal(third.alert!.windowSec, 120);
});

test('dedupe: one page per episode, not per agent', () => {
  const t = new RecoveryScaleTracker({ pagingEnabled: true, thresholdFn: () => 3 });
  let alerts = 0;
  for (let i = 0; i < 20; i++) {
    const r = t.record({ agentName: `A${i}`, priorSid: SID(i), newSid: SID(100 + i), activeAgents: 21, nowMs: 1000 + i });
    if (r.alert) alerts++;
  }
  assert.equal(alerts, 1, 'a 20-reap episode pages exactly once, not 18 times');
});

test('episode resets after the window drains → can page again on a new episode', () => {
  const t = new RecoveryScaleTracker({ pagingEnabled: true, thresholdFn: () => 2 });
  // episode 1
  t.record({ agentName: 'A', priorSid: SID(1), newSid: SID(11), activeAgents: 21, nowMs: 0 });
  assert.ok(t.record({ agentName: 'B', priorSid: SID(2), newSid: SID(12), activeAgents: 21, nowMs: 1 }).alert);
  // 130s later — window drained, new episode
  t.record({ agentName: 'C', priorSid: SID(3), newSid: SID(13), activeAgents: 21, nowMs: 130_000 });
  const r = t.record({ agentName: 'D', priorSid: SID(4), newSid: SID(14), activeAgents: 21, nowMs: 130_001 });
  assert.ok(r.alert, 'a fresh episode after the window drained pages again');
});

test('hypothesisThreshold = max(3, ceil(0.2 × active))', () => {
  assert.equal(hypothesisThreshold(0), 3);
  assert.equal(hypothesisThreshold(10), 3); // ceil(2)=2 → floor 3
  assert.equal(hypothesisThreshold(21), 5); // ceil(4.2)=5
  assert.equal(hypothesisThreshold(30), 6); // ceil(6)=6
  assert.equal(hypothesisThreshold(100), 20);
});
