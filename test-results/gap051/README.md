# GAP-051 — cross-agent tmux paste-buffer race: empirical evidence

Tracked proof for the crit-4 (behavioral red/green) gate criterion of the
named-buffer fix in `src/proxy/tmux.ts`. Committed here (not left as untracked
files + a number in a message) per the GAP-027 evidence-placement lesson.

## What the race is

Every agent session shares ONE tmux server → ONE fleet-global paste-buffer
stack. The pre-fix delivery path used an **unnamed** `load-buffer -` /
`paste-buffer` pair. A concurrent delivery to another agent, landing its
`load-buffer` between this agent's load and paste, makes this agent paste the
WRONG (most-recently-loaded) text — cross-agent content injection.

## The harness — `gap051-repro.mjs`

Drives the **real `pasteText()`** (imported by absolute path, so BEFORE = the
`main` checkout's `tmux.ts`, AFTER = this branch's fixed `tmux.ts`) against `K`
disposable `cat` tmux fixtures on the shared server. Each of `N` trials fires
`K` CONCURRENT deliveries to DISTINCT sessions (the cross-session geometry that
actually contends on the shared stack — same-session deliveries are serialized
by `pasteText`'s per-session lock and do not race). Every delivery carries a
globally-unique marker; each pane is captured immediately post-paste. A
cross-paste = pane *i* shows this trial's marker for some *j ≠ i*.

Fixtures are namespaced `gap051probe*`, disposable, and torn down after the run;
no live `agent-*` session is ever touched.

### ⚠️ Structural safety guard (the BEFORE condition is itself the hazard)

The **BEFORE** condition runs the UNFIXED code, whose unnamed `load-buffer`/
`paste-buffer` races the fleet-GLOBAL shared paste-buffer stack. Run against the
live shared tmux server under fleet load, that race can cross-paste a probe
marker into a REAL agent's pane — i.e. running the RED harness live *induces the
very GAP-051 hazard on production*. A verification step must never become a new
harm vector.

The harness therefore **refuses** (not merely warns) to run the unfixed
condition when the target tmux server hosts any live `agent-*` session — it exits
before creating any fixture. Detection is self-contained: the fixed module
exports `nextPasteBufferName`; its absence means pre-fix code was imported. The
**AFTER/fixed** condition is safe-by-construction (unique named buffers never
touch the shared stack) and is always allowed. Escape hatch for a genuinely
isolated/throwaway server only: `GAP051_ALLOW_UNFIXED_LIVE=1`.

Run the BEFORE condition only on a quiesced or throwaway tmux server.

```
# BEFORE (reproduces the race against main's unnamed code)
node test-results/gap051/gap051-repro.mjs /path/to/main/src/proxy/tmux.ts BEFORE 8 100

# AFTER (against this branch's named-buffer code — expect 0)
node test-results/gap051/gap051-repro.mjs /path/to/branch/src/proxy/tmux.ts AFTER 8 100
```

## Results (K=8, N=100 → 800 panes/condition)

| Condition | cross-pasted panes | trials affected | source |
|-----------|-------------------|-----------------|--------|
| **BEFORE** (unnamed) | 614/800 (76.75%) | 90/100 | `gap051-before.json` |
| **AFTER** (named `-b`/`-d`) | 0/800 (0%) | 0/100 | `gap051-after.json` |

Independently reproduced by ChloeOBrian (BEFORE 607/800, AFTER 0/800) and
first-party GREEN-reproduced by BrienneOfTarth against the frozen SHA (0/800).
Two independent parties, same high-rate race pre-fix, same zero post-fix.
