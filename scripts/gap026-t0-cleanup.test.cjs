'use strict';
// Regression-lock for the GAP-026 T0 cleanup COUNT-VERIFY (Brienne gate finding @ f9807b6:
// the original exact-equality verify false-fails under the LIVE orchestrator's concurrent writes).
// Run: node --test scripts/gap026-t0-cleanup.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyCleanup } = require('./gap026-t0-cleanup.cjs'); // require.main guard → main() does not run

test('quiescent DB: a clean full delete passes', () => {
  const before = { idle_timeout_exceeded: 100, killed: 5, idle_detected: 10 };
  const after = { idle_timeout_exceeded: 0, killed: 5, idle_detected: 10 };
  assert.ok(verifyCleanup(before, after, 100, 100).ok);
});

test('LIVE DB (Brienne case): concurrent inserts to audit AND churn during the run do NOT false-fail', () => {
  const before = { idle_timeout_exceeded: 100, killed: 5, idle_detected: 10, activity_detected: 3 };
  // during the ~68-batch run: new killed (audit) + new idle_detected/activity_detected (churn) written
  const after = { idle_timeout_exceeded: 0, killed: 8, idle_detected: 25, activity_detected: 7 };
  const { ok, problems } = verifyCleanup(before, after, 100, 100);
  assert.ok(ok, 'legitimate increases must not be flagged: ' + JSON.stringify(problems));
});

test('LIVE DB: the pruneChurnEvents retention tick firing mid-run (churn DECREASES) does NOT false-fail', () => {
  const before = { idle_timeout_exceeded: 100, killed: 5, idle_detected: 10, activity_detected: 3 };
  // retention job removed old churn during the run → churn decreased (legitimate; excluded from check)
  const after = { idle_timeout_exceeded: 0, killed: 5, idle_detected: 2, activity_detected: 0 };
  assert.ok(verifyCleanup(before, after, 100, 100).ok, 'retention-managed churn decrease is not a violation');
});

test('REAL violation: an audit class decreased → fail (my delete must never remove a non-target row)', () => {
  const before = { idle_timeout_exceeded: 100, killed: 5 };
  const after = { idle_timeout_exceeded: 0, killed: 4 };
  const { ok, problems } = verifyCleanup(before, after, 100, 100);
  assert.equal(ok, false);
  assert.match(problems.join('|'), /killed.*DECREASED/);
});

test('target not fully removed → fail', () => {
  const { ok } = verifyCleanup({ idle_timeout_exceeded: 100 }, { idle_timeout_exceeded: 5 }, 95, 100);
  assert.equal(ok, false);
});

test('over-deletion backstop: deletedSum > targetCount → fail (would mean a non-target row was hit)', () => {
  const before = { idle_timeout_exceeded: 100, killed: 5 };
  const after = { idle_timeout_exceeded: 0, killed: 5 };
  const { ok, problems } = verifyCleanup(before, after, 101, 100);
  assert.equal(ok, false);
  assert.match(problems.join('|'), /deletedSum/);
});
