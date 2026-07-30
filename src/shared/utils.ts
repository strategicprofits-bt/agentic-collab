/**
 * Shared utility functions.
 */

/** POSIX-safe shell quoting. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a `--model <model>` flag fragment for injection into a launch command,
 * or an empty string when no model is pinned.
 *
 * Purpose: a resumed CLI session that carries no explicit `--model` inherits the
 * model persisted in its session transcript — which can be a poisoned CLI-default
 * if the session was ever created without a model. Injecting an explicit flag on
 * every respawn/resume makes the running model DETERMINISTIC (== the configured
 * model) instead of luck-of-inheritance.
 *
 * Returns '' for null/undefined/blank (an UNPINNED agent must still resolve to its
 * intended default — the negative control) and for any value that isn't a safe
 * model token (defends the shell interpolation surface against injection).
 */
export function buildModelFlag(model: string | null | undefined): string {
  if (!model) return '';
  const trimmed = model.trim();
  // Model identifiers are alphanumerics plus . _ - (e.g. claude-haiku-4-5-20251001).
  // Anything else is rejected rather than shell-quoted so a malformed/hostile value
  // can never break out of the flag position in an interpolated shell string.
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return '';
  return `--model ${trimmed}`;
}
