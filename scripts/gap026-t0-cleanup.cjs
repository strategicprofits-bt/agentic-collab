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

  // 3) COUNT-VERIFY every invariant
  console.log('[3/3] VERIFY ...');
  const after = histogram(db);
  const afterTotal = total(after);
  const problems = [];
  if ((after[TARGET] || 0) !== 0) problems.push(`target not fully removed: ${after[TARGET]} remain`);
  if (deletedSum !== targetCount) problems.push(`deletedSum ${deletedSum} != before target ${targetCount}`);
  if (afterTotal !== beforeTotal - targetCount) problems.push(`total ${afterTotal} != expected ${beforeTotal - targetCount}`);
  for (const [k, v] of Object.entries(before)) {
    if (k === TARGET) continue;
    if ((after[k] || 0) !== v) problems.push(`class '${k}' changed: ${v} -> ${after[k] || 0} (MUST be unchanged)`);
  }
  db.close();

  if (problems.length) {
    console.error('\nVERIFY FAILED — no live class should have changed:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`Backup preserved at ${backup} for rollback.`);
    process.exit(1);
  }
  console.log(`      OK: '${TARGET}' -> 0; all ${Object.keys(before).length - 1} other classes unchanged; total ${beforeTotal} -> ${afterTotal} (-${targetCount}).`);
  console.log(`\nDONE. Backup: ${backup}  (file-size VACUUM reclamation is a separate deferred maintenance-window op).`);
}
main();
