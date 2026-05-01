#!/usr/bin/env node
// Detect when sp-marketing's master HEAD has not made it to the live Sevalla deploy.
// Strategy: content-fingerprint. Compares the SHA-256 of maxprof/index.html on origin/master
// against the same file served by sp.strategicprofits.com. If they diverge AND the master
// commit is >5min old, fire a sev3 collab message.
//
// Why content-fingerprint instead of querying Sevalla's deploy API: Sevalla's documented
// deployments endpoint returns a thin shape (no commit_sha) and the per-deployment detail
// path the MCP uses is undocumented + hard to reach. Hashing one canonical file is
// platform-agnostic and accurate enough — if maxprof/index.html is divergent, the deploy
// is divergent.
//
// Schedule via launchd every 15 min.

import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = '/Users/benthole/Development/sp/sp-marketing';
const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const COLLAB_BIN = join(ROOT_DIR, 'bin', 'collab');
const CANARY_FILE = 'maxprof/index.html';
const CANARY_URL = 'https://sp.strategicprofits.com/maxprof/';
const STALE_THRESHOLD_MS = 5 * 60_000;
const APP_ID = '515f8a57-8b1d-450e-8ba1-e719746620d3';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function masterHead(): { sha: string; committedAt: Date; canaryHash: string } {
  execSync('git fetch origin master --quiet', { cwd: REPO_DIR, timeout: 20_000 });
  const sha = execSync('git rev-parse origin/master', { cwd: REPO_DIR }).toString().trim();
  const isoTime = execSync('git log -1 --format=%cI origin/master', { cwd: REPO_DIR }).toString().trim();
  const file = execSync(`git show origin/master:${CANARY_FILE}`, { cwd: REPO_DIR }).toString();
  return { sha, committedAt: new Date(isoTime), canaryHash: sha256(file) };
}

async function liveCanaryHash(): Promise<string> {
  const res = await fetch(CANARY_URL, { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`Live ${CANARY_URL} → ${res.status} ${res.statusText}`);
  return sha256(await res.text());
}

function alert(masterSha: string, ageMs: number): void {
  const ageMin = Math.floor(ageMs / 60000);
  const body =
    `🚨 *Sevalla deploy stuck* — sp-marketing master HEAD has not landed on ${CANARY_URL}.\n\n` +
    `• Master HEAD: \`${masterSha.slice(0, 7)}\` (${ageMin}m old)\n` +
    `• Canary file (${CANARY_FILE}) hash on origin/master ≠ live\n\n` +
    '*Manual deploy fix (Sevalla dashboard or API):*\n' +
    '```\n' +
    `# Hit Deploy on the dashboard for app ${APP_ID}, OR ask Claude to call sevalla MCP:\n` +
    `# POST /applications/${APP_ID}/deployments  body={branch:'master'}\n` +
    '```';
  const send = spawnSync(COLLAB_BIN, ['send', 'operator', '--topic', 'sev3-deploy-stuck', '--body', body], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (send.status !== 0) process.stderr.write(`collab send failed: ${(send.stderr ?? send.stdout ?? '').trim()}\n`);
}

async function main(): Promise<void> {
  const head = masterHead();
  const ageMs = Date.now() - head.committedAt.getTime();
  if (ageMs < STALE_THRESHOLD_MS) {
    process.stdout.write(`HEAD ${head.sha.slice(0, 7)} is ${Math.round(ageMs / 1000)}s old — under 5min threshold, skipping.\n`);
    return;
  }
  const live = await liveCanaryHash();
  if (live === head.canaryHash) {
    process.stdout.write(`OK: ${CANARY_FILE} on origin/master matches live (${head.canaryHash.slice(0, 8)}…).\n`);
    return;
  }
  process.stdout.write(
    `DIVERGENT: master ${head.sha.slice(0, 7)} (${head.canaryHash.slice(0, 8)}…) ` +
    `≠ live (${live.slice(0, 8)}…); HEAD ${Math.round(ageMs / 60000)}m old. Alerting.\n`,
  );
  alert(head.sha, ageMs);
}

main().catch((err) => {
  process.stderr.write(`deploy-divergence-check error: ${(err as Error).message}\n`);
  process.exit(1);
});
