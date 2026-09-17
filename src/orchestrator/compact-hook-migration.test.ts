import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { migrateCompactHooks, NEW_COMPACT_HOOK, KNOWN_OLD_COMPACT_HOOKS } from './compact-hook-migration.ts';

const SHELL_HOOK = '[{"type":"shell","command":"/compact"}]';
const OLD_KEYSTROKES_HOOK = '[{"type":"keystrokes","actions":[{"paste":"/compact","post_wait_ms":200},{"keystroke":"Escape","post_wait_ms":100},{"keystroke":"Enter"}]}]';

describe('migrateCompactHooks', () => {
  let db: Database;
  let tmpDir: string;

  before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'compact-mig-')); });
  after(() => { db?.close(); rmSync(tmpDir, { recursive: true, force: true }); });
  beforeEach(() => {
    db?.close();
    db = new Database(join(tmpDir, `t-${Math.random().toString(36).slice(2)}.db`));
  });

  it('migrates the LIVE shell /compact hook to the new verified-paste hook', () => {
    db.createEngineConfig({ name: 'claude', engine: 'claude', hookCompact: SHELL_HOOK });
    const n = migrateCompactHooks(db);
    assert.equal(n, 1, 'should migrate 1 config');
    assert.equal(db.getEngineConfig('claude')?.hookCompact, NEW_COMPACT_HOOK);
  });

  it('migrates the old KEYSTROKES paste→Escape→Enter hook too (defensive completeness)', () => {
    db.createEngineConfig({ name: 'claude', engine: 'claude', hookCompact: OLD_KEYSTROKES_HOOK });
    assert.ok(KNOWN_OLD_COMPACT_HOOKS.has(OLD_KEYSTROKES_HOOK), 'old keystrokes hook must be a known-old');
    migrateCompactHooks(db);
    assert.equal(db.getEngineConfig('claude')?.hookCompact, NEW_COMPACT_HOOK);
  });

  it('PRESERVES a customized hook_compact (only replaces KNOWN-old defaults)', () => {
    const custom = '[{"type":"shell","command":"/compact --custom-flag"}]';
    db.createEngineConfig({ name: 'claude', engine: 'claude', hookCompact: custom });
    const n = migrateCompactHooks(db);
    assert.equal(n, 0, 'must not migrate a customization');
    assert.equal(db.getEngineConfig('claude')?.hookCompact, custom, 'customization untouched');
  });

  it('PRESERVES null hook_compact (codex/opencode use the adapter)', () => {
    db.createEngineConfig({ name: 'codex', engine: 'codex' });
    migrateCompactHooks(db);
    assert.equal(db.getEngineConfig('codex')?.hookCompact, null);
  });

  it('is IDEMPOTENT — a second run migrates nothing', () => {
    db.createEngineConfig({ name: 'claude', engine: 'claude', hookCompact: SHELL_HOOK });
    assert.equal(migrateCompactHooks(db), 1);
    assert.equal(migrateCompactHooks(db), 0, 'second run is a no-op');
    assert.equal(db.getEngineConfig('claude')?.hookCompact, NEW_COMPACT_HOOK);
  });

  it('does not touch a config already on the NEW hook (fresh-seed case)', () => {
    db.createEngineConfig({ name: 'claude', engine: 'claude', hookCompact: NEW_COMPACT_HOOK });
    assert.equal(migrateCompactHooks(db), 0);
  });

  it('the new hook is NOT itself a known-old (idempotency invariant)', () => {
    assert.ok(!KNOWN_OLD_COMPACT_HOOKS.has(NEW_COMPACT_HOOK), 'NEW must not be in the OLD set');
  });
});
