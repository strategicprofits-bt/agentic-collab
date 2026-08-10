# Orchestrator Deploy Mechanism — the `--build` footgun fix

**Owner:** Gilfoyle · **Status:** for Brienne+Roz gate → DrRobby auth → apply · **Date:** 2026-08-10 · **Task:** #12

## Problem (caught on the GAP-056 deploy)

The orchestrator runs from a Docker image **built from local src** (`docker-compose.yml`: `build: context: .`; no src volume-mount). The systemd unit's `ExecStart` is:

```
ExecStart=/usr/bin/docker compose up -d
```

`up -d` **reuses the existing image** — it does not rebuild. So after merging code to `main` and syncing the local checkout, a plain `systemctl restart agentic-orchestrator` brings the container back on the **stale, previously-baked image**: merge ≠ image ≠ running. On 2026-08-10 the running image was still the 2026-08-05 build even though `main` had advanced; only an explicit `docker compose up -d --build` deployed the merged code. Left unfixed, the **next** deploy-via-plain-restart silently ships stale.

## Fix — two layers, host-side only (no orchestrator image change)

### Layer 1 — systemd unit (`/etc/systemd/system/agentic-orchestrator.service`)

Add one line so a restart rebuilds-from-current-src before starting:

```diff
 [Service]
 Type=oneshot
 RemainAfterExit=yes
 WorkingDirectory=/home/agent/agentic-collab
 User=agent
 Group=agent
 Environment=PERSONAS_HOST_DIR=/home/agent/agentic-collab/persistent-agents
+ExecStartPre=-/usr/bin/docker compose build
 ExecStart=/usr/bin/docker compose up -d
 ExecStop=/usr/bin/docker compose down
```

**The leading `-` is load-bearing.** It makes a build failure **non-fatal**: if `docker compose build` fails, `ExecStartPre` is skipped and `ExecStart` starts the container on the **last-good image** — orchestrator stays **alive-on-stale** rather than **down**. For the fleet-coordination substrate (with the 2026-08-05 restart-loop/OOM incident history), alive-stale > down. Build-success is enforced **loudly at deploy time** (Layer 2), not at restart time.

Crash-recovery is unaffected: Docker's `restart: unless-stopped` restarts the container directly, **never** running systemd `ExecStartPre` — so there is **no rebuild inside a crash-loop** (avoids amplifying the 2026-08-05 failure mode).

Net: a plain `systemctl restart agentic-orchestrator` becomes best-effort-fresh (rebuild, fallback to last-good on build-fail) = **recovery**, not a guaranteed-fresh deploy.

### Layer 2 — canonical deploy script (`scripts/deploy.sh`)

The sanctioned way to ship. `docker compose build` (**fails LOUD** — no `-`), `up -d`, wait-healthy, **assert the container was recreated this run** (freshness), restart proxy (`KillMode=process`, tmux-safe), verify (proxy active + GAP-056 watcher armed-log). `--ref <sha>` refuses unless `HEAD` matches (deploy-the-right-commit guard); `--no-proxy`, `--dry-run` supported. Encodes the exact deploy-verify sequence run by hand on the GAP-056 deploy.

### Layer 3 — docs (`CLAUDE.md` § Deploy)

Makes the **DEPLOY (deploy.sh, fail-loud, must-be-fresh) vs RESTART (recovery, best-effort, alive>last-good)** distinction explicit so the next person does not treat a plain restart as a deploy and silently get last-good on a failed build.

## Why this is not a chicken-and-egg (dissolved by construction)

Activating this fix touches **nothing in the orchestrator image**: the unit is systemd host-config (activated by `daemon-reload`), `deploy.sh` runs on the host (never baked into the image), and the docs are docs. There is **no image to ship stale**, so the ironic "the `--build` fix itself ships stale via the no-build mechanism" failure mode cannot occur. (A future machine-detectable freshness check — a build-SHA baked into the image + exposed at `/api/orchestrator/status` — WOULD be orchestrator src and must deploy with explicit `--build`; kept as a separate follow-up so this task stays image-free.)

## Apply steps (after gate + DrRobby auth)

1. `sudo` edit `/etc/systemd/system/agentic-orchestrator.service` — add the `ExecStartPre=-...` line (diff above). Baseline captured via `systemctl cat`, not `cp`.
2. `sudo systemctl daemon-reload` — **blip-free** (host-config only; does not touch the running container).
3. Merge the repo PR (`scripts/deploy.sh` + this doc + `CLAUDE.md`).
4. **Verify-restart** (fleet blip — bundle under DrRobby orchestration + alert-team arming, same as GAP-056): a plain `systemctl restart agentic-orchestrator` and confirm it rebuilds fresh (container recreated, image `Created` advances) → proves the footgun is closed.

## Rollback

Remove the `ExecStartPre` line + `daemon-reload` → back to baseline (plain `up -d`). `deploy.sh` and docs are inert additive files; deleting them changes nothing operational.
