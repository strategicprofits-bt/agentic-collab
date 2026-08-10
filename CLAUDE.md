# agentic-collab

Zero-dependency orchestrator for AI coding agents via tmux. Node 24 native TypeScript — no build step, no npm install.

## Quick Start

```bash
./start.sh          # orchestrator (Docker :3000) + proxy (host :3100)
node --test --test-timeout=90000 'src/**/*.test.ts'  # ~875 tests (timeout guards hangs)
npx tsc --noEmit    # type check
```

## Architecture

```
Orchestrator (Docker :3000)      Proxy (host :3100)
  SQLite WAL | HTTP API           tmux session mgmt
  WebSocket | Health Monitor  ←→  File upload streaming
  Persona loader                  Heartbeats every 15s
```

Agent state machine: `void → spawning → active ↔ idle → suspending → suspended → failed`

## Source Map

```
src/
├── orchestrator/        # Docker container
│   ├── main.ts, database.ts, routes.ts
│   ├── lifecycle.ts     # 3-phase locking, watchdog timers
│   ├── health-monitor.ts
│   ├── persona.ts       # YAML frontmatter parsing
│   └── adapters/        # claude.ts, codex.ts, opencode.ts
├── proxy/               # Host process
│   ├── main.ts, tmux.ts
├── shared/              # types.ts, lock.ts, websocket-server.ts
└── dashboard/           # Vanilla JS SPA (index.html)
```

## Key Patterns

- **3-phase locking**: lifecycle.ts uses optimistic concurrency via version column
- **Health monitor**: 30s poll cycle, idle detection via tmux parsing, 80%→compact, 90%→reload
- **Message dispatch**: event-driven queue with cool-down coordination (300ms after lifecycle ops)
- **Personas**: `persistent-agents/*.md` with YAML frontmatter (engine, cwd, model, hooks)
- **Operator-reply relay** (P2a): agent → operator replies (`POST /api/dashboard/reply`) reach the operator's phone by DEFAULT, but only when no live dashboard WebSocket session is connected (presence-aware — no double-push while he is watching). Two tiers: a **plain topic** → presence-aware relay (`relay-policy.ts` `decideRelay`); a **`telegram*` topic** → always-push override, relayed unconditionally by the external poller (the inline path skips these to avoid double-send). This retires the old "must prefix `--topic telegram*` to reach the phone" convention. Relay creds are ENV-injected (`OPERATOR_RELAY_BOT_TOKEN` / `OPERATOR_RELAY_CHAT_ID`), never stored at-rest; unprovisioned → safe no-op.

## Testing

```bash
node --test --test-timeout=90000 'src/**/*.test.ts'   # all tests (--test-timeout fails a hung test/hook loudly instead of stranding the run)
node --test --test-timeout=90000 --watch 'src/**/*.test.ts'   # watch mode
node --test src/orchestrator/*.test.ts   # subset
```

## Deploy

The orchestrator runs from an image **built from local src** (`build: context: .`) — merged/committed code does NOT reach the running orchestrator until the image is rebuilt and the container recreated. Two distinct actions, do not conflate them:

- **DEPLOY** = `scripts/deploy.sh` — the sanctioned way to ship new code. `docker compose build` (**fails LOUD** on a broken build — never ships stale), then `up -d`, waits healthy, **asserts the container was recreated this run** (image-freshness), restarts the proxy (`KillMode=process` → tmux server untouched, no reap), and verifies. Use `--ref <sha>` to refuse unless `HEAD` matches. This is the only path that guarantees **deployed == current src**, verified not assumed.
- **RESTART** = `systemctl restart agentic-orchestrator` — **recovery, not deploy**. The unit carries `ExecStartPre=-docker compose build`, so a restart *does* rebuild-from-current-src in the normal case; but the leading `-` means a **failed** build is tolerated and the orchestrator comes back on the **last-good image** (alive-on-stale > down, for the fleet-coordination substrate). So a plain restart is best-effort-fresh with a silent-stale fallback — fine for recovery, **not** a substitute for `deploy.sh` when you need a guaranteed-fresh, build-verified ship.

Rule of thumb: shipping code → `scripts/deploy.sh`. Bouncing a wedged orchestrator → `systemctl restart`. Crash-recovery is automatic (Docker `restart: unless-stopped`, no rebuild — avoids rebuild-in-crash-loop). See `docs/orchestrator-deploy-mechanism.md` for the unit delta + rationale.

## Commits

Use conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`

For story-linked work:
```
<story-slug>: description

Motivation: <why>
Changes:
 - <file>: <one-line>
```

## Don't

- Add npm dependencies (zero-dep is a design constraint)
- Skip the type check (`npx tsc --noEmit`)
- Push directly to main (use worktree + PR)
- Use --no-verify on commits
