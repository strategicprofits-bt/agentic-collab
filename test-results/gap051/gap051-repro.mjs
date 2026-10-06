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

// ── STRUCTURAL SAFETY REFUSAL (GAP-051, mechanize-don't-recall) ──
// The BEFORE/RED condition runs the UNFIXED code, whose unnamed load-buffer/
// paste-buffer races the fleet-GLOBAL shared paste-buffer stack. Run against the
// live shared tmux server under fleet load, that race can cross-paste a probe
// marker into a REAL agent's pane — i.e. running the RED harness live INDUCES the
// very GAP-051 hazard on production. A verification step must never become a new
// harm vector. So REFUSE (not merely warn — a warning is recall-dependent) to run
// the unfixed condition whenever the target tmux server hosts live `agent-*`
// sessions. Self-detecting: the FIXED module exports nextPasteBufferName; its
// ABSENCE means we imported pre-fix (unnamed) code. The AFTER/fixed condition is
// safe-by-construction (unique named buffers never touch the shared stack) and is
// always allowed. Override for a genuinely isolated/throwaway server:
// GAP051_ALLOW_UNFIXED_LIVE=1 (documented escape hatch, off by default).
const isFixed = typeof tmux.nextPasteBufferName === 'function';
if (!isFixed && process.env.GAP051_ALLOW_UNFIXED_LIVE !== '1') {
  const names = (await tmuxRaw(['ls', '-F', '#{session_name}'])).split('\n').filter(Boolean);
  const liveAgents = names.filter((s) => s.startsWith('agent-'));
  if (liveAgents.length > 0) {
    console.error(
      `REFUSING to run the BEFORE/unfixed (unnamed-buffer) harness: the target tmux ` +
      `server hosts ${liveAgents.length} live agent-* session(s), so the unnamed-buffer ` +
      `race could cross-paste a probe marker into a REAL agent's pane (inducing the ` +
      `GAP-051 hazard on the live fleet). Run the BEFORE condition ONLY on a quiesced/` +
      `throwaway server. The AFTER/fixed condition (module exporting nextPasteBufferName) ` +
      `is safe-by-construction and always allowed. Override (isolated server only): ` +
      `GAP051_ALLOW_UNFIXED_LIVE=1.`,
    );
    process.exit(3);
  }
}

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
