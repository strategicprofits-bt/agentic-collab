#!/usr/bin/env node
// GAP-051 empirical cross-paste repro harness.
//
// Exercises the REAL pasteText() (imported by absolute path so BEFORE = main
// checkout's tmux.ts, AFTER = fixed-branch tmux.ts) against K disposable `cat`
// tmux fixtures on the SAME shared tmux server the fleet uses. Each trial fires
// K CONCURRENT deliveries to DISTINCT sessions (the cross-session geometry that
// actually contends on the shared global paste-buffer stack — same-session
// deliveries are serialized by pasteText's per-session lock and do NOT race).
// Every delivery carries a globally-unique marker; after the trial settles we
// capture each pane and flag a cross-paste when pane i shows THIS TRIAL's marker
// for some j != i. Reports a RATE over N trials (Chloe's design): BEFORE must be
// nonzero, AFTER must be exactly 0.
//
// Usage: node gap051-repro.mjs /abs/path/to/src/proxy/tmux.ts <label> [K] [N]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const tmuxPath = process.argv[2];
const label = process.argv[3] ?? 'run';
const K = Number(process.argv[4] ?? 8);
const N = Number(process.argv[5] ?? 100);

if (!tmuxPath) { console.error('need path to tmux.ts'); process.exit(2); }
const tmux = await import(tmuxPath);
if (typeof tmux.pasteText !== 'function') { console.error('no pasteText export'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessions = Array.from({ length: K }, (_, i) => `gap051probe${i}`);

async function tmuxRaw(args) { try { return (await exec('tmux', args)).stdout; } catch { return ''; } }

async function setup() {
  for (const s of sessions) {
    await tmuxRaw(['kill-session', '-t', s]).catch(() => {});
    // disposable fixture: a bare `cat` — echoes pasted input to its pane, never
    // executes anything (safe even if a stray Enter arrived; pressEnter=false anyway).
    await exec('tmux', ['new-session', '-d', '-s', s, 'cat']);
  }
}
async function teardown() { for (const s of sessions) await tmuxRaw(['kill-session', '-t', s]); }

async function run() {
  await setup();
  let crossPanes = 0;       // individual panes that received a foreign current-trial marker
  let crossTrials = 0;      // trials with >= 1 cross-paste
  const totalPanes = N * K;
  const examples = [];

  for (let t = 0; t < N; t++) {
    // unique per-DELIVERY marker: trial + session-index + nonce
    const markers = sessions.map((_, i) => `MKt${t}s${i}u${(t * 131 + i * 7 + 17).toString(36)}`);
    // fire all K concurrent — cross-session contention on the shared stack
    await Promise.all(sessions.map((s, i) => tmux.pasteText(s, markers[i], false).catch(() => {})));
    await sleep(40); // let paste land in panes before capture

    let trialHadCross = false;
    for (let i = 0; i < K; i++) {
      const pane = await tmuxRaw(['capture-pane', '-t', sessions[i], '-p', '-S', '-40']);
      for (let j = 0; j < K; j++) {
        if (j === i) continue;
        if (pane.includes(markers[j])) {
          crossPanes++;
          trialHadCross = true;
          if (examples.length < 6) examples.push(`trial ${t}: pane s${i} showed s${j}'s marker (${markers[j]})`);
          break; // count each cross-pasted pane once
        }
      }
    }
    if (trialHadCross) crossTrials++;
    if (t % 20 === 19) process.stderr.write(`  [${label}] ${t + 1}/${N} trials, crossPanes=${crossPanes}\n`);
  }

  await teardown();

  console.log(JSON.stringify({
    label, tmuxPath, K, N, totalPanes,
    crossPanes, crossTrials,
    crossPaneRate: +(crossPanes / totalPanes).toFixed(4),
    crossTrialRate: +(crossTrials / N).toFixed(4),
    examples,
  }, null, 2));
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); teardown().finally(() => process.exit(1)); });
