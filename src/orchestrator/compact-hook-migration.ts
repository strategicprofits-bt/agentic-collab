// F1 (.274 harden) — engine-config compact-hook migration.
//
// The startup seed is insert-if-absent (main.ts), so a change to the default claude
// compact hook in default-engine-configs does NOT reach a running orchestrator — the live
// DB keeps whatever it was first seeded with. Verified 2026-09-17: the live claude config
// carried an OLD shell hook ([{type:shell,command:/compact}]) that submits /compact with a
// RAW un-retried Enter, which strands on the 2.1.274 Ink-transition input-drop (Brienne:
// 0/5 submit on idle). This migration UPDATES the live config to the new verified-paste hook
// so the fix actually reaches the fleet.
//
// Safety-by-construction (harmful-if-wrong — it mutates engine-config state at startup):
//  • EXACT-match only against a closed set of KNOWN-old defaults → never clobbers a
//    customization (anything not in the set is left untouched).
//  • IDEMPOTENT: the new hook is not itself a known-old, so a second run is a no-op; a
//    fresh-seeded config (already on the new hook) is untouched.
//  • Caller wraps in try/catch so a migration failure never breaks orchestrator startup.

import type { Database } from './database.ts';
import { DEFAULT_ENGINE_CONFIGS } from './default-engine-configs.ts';

/** The target hook — sourced from the canonical default so the two cannot drift. */
export const NEW_COMPACT_HOOK: string = (() => {
  const claude = DEFAULT_ENGINE_CONFIGS.find((c) => c.name === 'claude');
  if (!claude?.hookCompact) throw new Error('claude default engine config is missing hookCompact');
  return claude.hookCompact;
})();

/**
 * The closed set of historical claude compact-hook defaults this migration replaces. Both
 * submit /compact via a RAW un-retried Enter (strand-prone on .274):
 *  1. the live shell hook (what the running fleet actually carries), and
 *  2. the source keystrokes hook (paste→Escape→Enter) that a fresh orchestrator would have
 *     seeded — included defensively so a fresh-then-old install is also covered.
 * Anything else (including null, and any operator customization) is left untouched.
 */
export const KNOWN_OLD_COMPACT_HOOKS: ReadonlySet<string> = new Set([
  '[{"type":"shell","command":"/compact"}]',
  '[{"type":"keystrokes","actions":[{"paste":"/compact","post_wait_ms":200},{"keystroke":"Escape","post_wait_ms":100},{"keystroke":"Enter"}]}]',
]);

/**
 * Replace any engine config whose hook_compact EXACTLY matches a known-old default with the
 * new verified-paste hook. Returns the number of configs migrated (0 = nothing to do).
 */
export function migrateCompactHooks(db: Database): number {
  let migrated = 0;
  for (const config of db.listEngineConfigs()) {
    const current = config.hookCompact;
    if (current !== null && current !== NEW_COMPACT_HOOK && KNOWN_OLD_COMPACT_HOOKS.has(current)) {
      db.updateEngineConfig(config.name, { hookCompact: NEW_COMPACT_HOOK });
      migrated++;
    }
  }
  return migrated;
}
