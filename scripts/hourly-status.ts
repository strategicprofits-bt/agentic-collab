#!/usr/bin/env node
// 3x/day status report (10am, 2pm, 6pm America/Chicago) — agent health + auto-restart of stale proxies.
// Scheduled by ~/Library/LaunchAgents/com.spop.agentic-collab.status-report.plist.
// One-shot: collect → restart-if-stale → recollect → send → exit.

import { spawnSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROSTER_PATH = join(ROOT_DIR, 'config', 'expected-active-agents.json');
const RESTART_SCRIPT = join(ROOT_DIR, 'scripts', 'start-proxy-tmux.sh');
const COLLAB_BIN = join(ROOT_DIR, 'bin', 'collab');
const IDLE_THRESHOLD_HOURS = 24;
const TOPIC = 'info';

type AgentRecord = {
  name: string;
  state: string;
  proxyId: string | null;
  lastActivity: string | null;
};

type ProxyRecord = {
  proxyId: string;
  host: string;
  version?: string;
  versionMatch?: boolean;
};

function discoverOrchestratorUrl(): string {
  const env = process.env['ORCHESTRATOR_URL'];
  if (env) return env;
  // Prefer Docker-published orchestrator (matches collab CLI behavior)
  try {
    const raw = execSync(
      'docker ps --filter "label=io.agentic-collab.role=orchestrator" --format "{{.Ports}}"',
      { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    const m = raw.match(/(?:\d+\.\d+\.\d+\.\d+|::):(\d+)->/);
    if (m) return `http://localhost:${m[1]}`;
  } catch { /* fall through */ }
  for (const port of [3000, 3001]) {
    try {
      const r = execSync(`curl -sf -m 2 http://localhost:${port}/api/orchestrator/status`, { stdio: ['pipe', 'pipe', 'pipe'] });
      if (r.toString()) return `http://localhost:${port}`;
    } catch { /* try next */ }
  }
  throw new Error('Could not discover orchestrator (Docker or localhost:3000/3001)');
}

function resolveSecret(): string | undefined {
  return process.env['ORCHESTRATOR_SECRET'];
}

async function getJson<T>(url: string, secret?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (secret) headers['Authorization'] = `Bearer ${secret}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function loadRoster(): string[] {
  if (!existsSync(ROSTER_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(ROSTER_PATH, 'utf8')) as { agents?: string[] };
    return Array.isArray(raw.agents) ? raw.agents : [];
  } catch {
    return [];
  }
}

function isLocalProxy(proxy: ProxyRecord): boolean {
  const h = (proxy.host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  return h === hostname().toLowerCase();
}

function restartLocalProxy(): { ok: boolean; output: string } {
  // start-proxy-tmux.sh kills the existing tmux session + restarts the proxy in-place.
  const res = spawnSync('bash', [RESTART_SCRIPT, '--wait-healthy'], {
    timeout: 60_000,
    encoding: 'utf8',
  });
  const output = (res.stdout ?? '') + (res.stderr ?? '');
  return { ok: res.status === 0, output: output.trim() };
}

function hoursSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

function fmtPct(n: number): string {
  return n.toFixed(1);
}

async function main(): Promise<void> {
  const url = discoverOrchestratorUrl();
  const secret = resolveSecret();

  const proxiesBefore = await getJson<ProxyRecord[]>(`${url}/api/proxies`, secret);
  const stale = proxiesBefore.filter((p) => p.versionMatch === false);

  // Auto-restart any stale local proxies.
  const restarted: { proxyId: string; ok: boolean; reason?: string }[] = [];
  for (const p of stale) {
    if (!isLocalProxy(p)) {
      restarted.push({ proxyId: p.proxyId, ok: false, reason: `remote host ${p.host} — manual restart required` });
      continue;
    }
    const res = restartLocalProxy();
    restarted.push({ proxyId: p.proxyId, ok: res.ok, reason: res.ok ? undefined : res.output.split('\n').slice(-3).join(' / ') });
  }

  // Refresh proxy state after restart attempts (give registration ~3s).
  if (restarted.length > 0) await new Promise((r) => setTimeout(r, 3_000));
  const proxiesAfter = await getJson<ProxyRecord[]>(`${url}/api/proxies`, secret);
  const stillStale = proxiesAfter.filter((p) => p.versionMatch === false);

  const agents = await getJson<AgentRecord[]>(`${url}/api/agents`, secret);
  const failed = agents.filter((a) => a.state === 'failed');

  const roster = loadRoster();
  const longIdle: { name: string; hours: number }[] = [];
  if (roster.length > 0) {
    for (const name of roster) {
      const a = agents.find((x) => x.name === name);
      if (!a) continue;
      const h = hoursSince(a.lastActivity);
      if (h !== null && h >= IDLE_THRESHOLD_HOURS) longIdle.push({ name, hours: h });
    }
  }

  // Compose report
  const stamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });
  const lines: string[] = [];
  lines.push(`📊 *Agentic-Collab status* — ${stamp} CT`);
  lines.push('');

  if (stale.length === 0) {
    lines.push('✅ Proxies: all version-matched');
  } else {
    const okRestarts = restarted.filter((r) => r.ok);
    const failedRestarts = restarted.filter((r) => !r.ok);
    lines.push(`⚠️ Stale proxies detected: ${stale.length}`);
    if (okRestarts.length > 0) {
      lines.push(`  • Auto-restarted: ${okRestarts.map((r) => r.proxyId).join(', ')}`);
    }
    if (failedRestarts.length > 0) {
      lines.push(`  • Restart needs attention:`);
      for (const r of failedRestarts) lines.push(`    - ${r.proxyId}: ${r.reason ?? 'unknown'}`);
    }
    if (stillStale.length > 0) {
      lines.push(`  • Still stale after restart: ${stillStale.map((p) => p.proxyId).join(', ')}`);
    }
  }

  lines.push('');
  if (failed.length === 0) {
    lines.push(`✅ Agents: ${agents.length} total, none failed`);
  } else {
    lines.push(`🚨 Failed agents: ${failed.length}`);
    for (const a of failed) lines.push(`  • ${a.name}`);
  }

  lines.push('');
  if (roster.length === 0) {
    lines.push('ℹ️ Roster empty — long-idle check skipped');
  } else if (longIdle.length === 0) {
    lines.push(`✅ Roster (${roster.length}): all active within ${IDLE_THRESHOLD_HOURS}h`);
  } else {
    lines.push(`⏸ Long-idle roster agents (>${IDLE_THRESHOLD_HOURS}h):`);
    for (const x of longIdle) lines.push(`  • ${x.name} — idle ${fmtPct(x.hours)}h`);
  }

  lines.push('');
  lines.push(`_Roster: ${ROSTER_PATH.replace(process.env['HOME'] || '', '~')}_`);

  const body = lines.join('\n');

  // Send via collab CLI to operator on the 'info' topic.
  const send = spawnSync(COLLAB_BIN, ['send', 'operator', '--topic', TOPIC, '--body', body], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (send.status !== 0) {
    process.stderr.write(`collab send failed: ${(send.stderr ?? send.stdout ?? '').trim()}\n`);
    process.exit(1);
  }

  process.stdout.write(`status report sent (${body.length} chars, ${stale.length} stale, ${failed.length} failed, ${longIdle.length} long-idle)\n`);
}

main().catch((err) => {
  process.stderr.write(`hourly-status error: ${(err as Error).message}\n`);
  process.exit(1);
});
