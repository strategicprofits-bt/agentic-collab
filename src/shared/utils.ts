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
  const valid = validModelId(model);
  return valid ? `--model ${valid}` : '';
}

/**
 * Return the trimmed model id if it is a safe token, else null.
 *
 * Model identifiers are alphanumerics plus . _ - (e.g. claude-haiku-4-5-20251001).
 * Anything else is REJECTED (not shell-quoted) so a malformed/hostile value can
 * never break out of the flag position — whether it is interpolated into a shell
 * string (buildModelFlag) or pushed as a raw argv token by an engine adapter.
 * The single source of model-token validity for both paths.
 */
export function validModelId(model: string | null | undefined): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}
