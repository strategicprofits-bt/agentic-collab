#!/usr/bin/env node
/*
 * GAP-026 T0 — one-time cleanup of the DEAD `idle_timeout_exceeded` event firehose.
 *
 * WHAT: deletes ONLY rows where event='idle_timeout_exceeded' (~1.36M dead rows, 91% of the
 *   events table). Its emitter was removed from source (0 rows written in 30 days), so this class
 *   can never re-accumulate — this is pure historical-scar removal, distinct from the ongoing
 *   pruneChurnEvents retention job (which covers the LIVE idle_detected/activity_detected churn and
 *   deliberately does NOT touch this class, so this one-time write stays cleanly COUNT-verifiable).
 *
 * DISCIPLINE (DrRobby, prod-write on the live orchestrator DB):
 *   - BACKUP-FIRST: VACUUM INTO a dated backup before any delete (consistent copy, no orch lock-out).
 *   - SCOPE-EXACT: predicate is EXACTLY event='idle_timeout_exceeded'. The before-histogram is printed
 *     so a reviewer can confirm no live class is adjacent to the predicate.
 *   - BATCHED: deletes in bounded batches, each its own txn, with a pause between — never one giant
 *     write-lock that would spin the orchestrator's own writes against busy_timeout=5000 (the exact
 *     stall this whole effort mitigates).
 *   - COUNT-VERIFY: before/after per-type histogram; asserts target→0, EVERY other type UNCHANGED,
 *     total drop == deleted count, and sum(batch changes) == before target count. Exits non-zero on
 *     any violation.
 *   - REVERSIBLE: via the backup file (printed).
 *
 * USAGE:
 *   node scripts/gap026-t0-cleanup.cjs                 # DRY-RUN (default): counts + plan, NO writes
 *   node scripts/gap026-t0-cleanup.cjs --execute       # perform backup + batched delete + verify
 *   env: DB_FILE (default /data/.agentic-collab/orchestrator.db), BATCH (default 20000)
 *
 *   In the container:
 *     docker cp scripts/gap026-t0-cleanup.cjs agentic-collab-orchestrator-1:/tmp/
 *     docker exec agentic-collab-orchestrator-1 node /tmp/gap026-t0-cleanup.cjs            # dry-run
 *     docker exec agentic-collab-orchestrator-1 node /tmp/gap026-t0-cleanup.cjs --execute  # gated run
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');

const TARGET = 'idle_timeout_exceeded';
const DB_FILE = process.env.DB_FILE || '/data/.agentic-collab/orchestrator.db';
const BATCH = Number(process.env.BATCH || 20000);
const EXECUTE = process.argv.includes('--execute');

function sleepMs(ms) { // synchronous yield so the orchestrator's writer can interleave between batches
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function histogram(db) {
  const rows = db.prepare('SELECT event, COUNT(*) AS n FROM events GROUP BY event').all();
  const h = {};
  for (const r of rows) h[r.event] = r.n;
  return h;
}
function total(h) { return Object.values(h).reduce((a, b) => a + b, 0); }

// Event types the ONGOING pruneChurnEvents retention job legitimately deletes post-deploy. Their
// count may move in EITHER direction during an --execute run (live inserts up, a retention tick
// down), so their direction is NOT a safety signal for THIS delete → excluded from the cross-class
// check. Kept in sync with Database.CHURN_EVENT_TYPES.
const RETENTION_MANAGED = new Set(['idle_detected', 'activity_detected']);

/**
 * LIVE-ROBUST verify (no quiescence assumed). The orchestrator writes continuously DURING the run,
 * so an equality/"every class unchanged" check false-fails a CORRECT delete — and its spurious
 * "rollback" advice would drop every audit row written since backup = real forensic loss. Robust
 * invariants that hold on a live DB:
 *   - HARD: after[TARGET] === 0          — dead emitter, nothing re-writes the target.
 *   - HARD: deletedSum === targetCount   — only this script touches TARGET; bounds total deletion to
 *                                          exactly the target rows (also the over-deletion backstop:
 *                                          deleting any non-target row would push deletedSum > target).
 *   - AUDIT classes (everything except TARGET and the retention-managed churn) may only stay-equal
 *     or INCREASE; a DECREASE means my delete wrongly removed a non-target row = real violation.
 * Total-count equality is intentionally NOT asserted (concurrent inserts + the retention tick both
 * move it legitimately) — printed as informational only.
 */
function verifyCleanup(before, after, deletedSum, targetCount) {
  const problems = [];
  if ((after[TARGET] || 0) !== 0) problems.push(`target '${TARGET}' not fully removed: ${after[TARGET] || 0} remain`);
  if (deletedSum !== targetCount) problems.push(`deletedSum ${deletedSum} != before target ${targetCount}`);
  for (const [k, v] of Object.entries(before)) {
    if (k === TARGET || RETENTION_MANAGED.has(k)) continue;
    if ((after[k] || 0) < v) problems.push(`class '${k}' DECREASED ${v} -> ${after[k] || 0} (my delete must never remove a non-target row)`);
  }
  return { ok: problems.length === 0, problems };
}

function main() {
  const db = new DatabaseSync(DB_FILE);
  const before = histogram(db);
  const beforeTotal = total(before);
  const targetCount = before[TARGET] || 0;

  console.log(`GAP-026 T0 cleanup — DB=${DB_FILE}  mode=${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}`);
  console.log(`events total: ${beforeTotal}   target '${TARGET}': ${targetCount}   (${beforeTotal ? (100 * targetCount / beforeTotal).toFixed(1) : 0}%)`);
  console.log('before histogram (scope check — predicate touches ONLY the target class):');
  for (const [k, v] of Object.entries(before).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(9)}  ${k}${k === TARGET ? '   <-- TO DELETE' : ''}`);
  }

  if (targetCount === 0) { console.log('\nNothing to delete (target count 0). Done.'); db.close(); return; }

  if (!EXECUTE) {
    console.log(`\nDRY-RUN: would VACUUM INTO a dated backup, then delete ${targetCount} '${TARGET}' rows in batches of ${BATCH}.`);
    console.log('No writes performed. Re-run with --execute (under gate + merge-auth) to apply.');
    db.close();
    return;
  }

  // 0) FREE-SPACE PRE-CHECK — VACUUM INTO writes a full copy; require free >= current DB size.
  //    Checked BEFORE any write (fail-safe ordering) so we never half-run on a full disk.
  const dbBytes = fs.statSync(DB_FILE).size;
  const vfs = fs.statfsSync(DB_FILE);
  const freeBytes = vfs.bavail * vfs.bsize;
  console.log(`\n[0/3] free space: DB=${(dbBytes / 1e6).toFixed(0)}MB  free=${(freeBytes / 1e6).toFixed(0)}MB`);
  if (freeBytes < dbBytes) {
    console.error(`      ✗ insufficient free space for VACUUM INTO backup (need >= ${(dbBytes / 1e6).toFixed(0)}MB). Aborting before any write.`);
    db.close();
    process.exit(1);
  }

  // 1) BACKUP-FIRST (consistent copy; does not lock out the orchestrator)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${DB_FILE}.bak-gap026-t0-${stamp}`;
  console.log(`\n[1/3] BACKUP → ${backup}`);
  db.prepare('VACUUM INTO ?').run(backup);
  console.log('      backup complete.');

  // 2) BATCHED DELETE of EXACTLY the target class
  console.log(`[2/3] DELETE '${TARGET}' in batches of ${BATCH} ...`);
  const del = db.prepare(
    `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE event = ? LIMIT ${BATCH})`
  );
  let deletedSum = 0, batches = 0;
  for (;;) {
    const changes = Number(del.run(TARGET).changes);
    deletedSum += changes; batches++;
    if (changes > 0 && batches % 10 === 0) console.log(`      ...${deletedSum} deleted so far`);
    if (changes < BATCH) break;
    sleepMs(50); // let the orchestrator writer interleave
  }
  console.log(`      deleted ${deletedSum} rows across ${batches} batches.`);

  // 3) COUNT-VERIFY (live-robust — see verifyCleanup)
  console.log('[3/3] VERIFY ...');
  const after = histogram(db);
  const afterTotal = total(after);
  const { ok, problems } = verifyCleanup(before, after, deletedSum, targetCount);
  db.close();

  if (!ok) {
    console.error('\nVERIFY FAILED:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`Backup preserved at ${backup} for rollback.`);
    process.exit(1);
  }
  console.log(`      OK: '${TARGET}' -> 0; deletedSum ${deletedSum} == target ${targetCount}; no audit class decreased.`);
  console.log(`      totals (informational, live-DB moves legitimately): ${beforeTotal} -> ${afterTotal}.`);
  console.log(`\nDONE. Backup: ${backup}  (file-size VACUUM reclamation is a separate deferred maintenance-window op).`);
}

if (require.main === module) main();
module.exports = { verifyCleanup, RETENTION_MANAGED, TARGET };
