// GAP-026 Stage 1 — claude-actually-running liveness signal (PROCESS-based).
//
// The kill-path guards (killAgent / recoverAgent) must reap ONLY when Claude is genuinely
// not running — never a live agent on a false death signal. Bare has_session is too coarse
// (a dead-CLI shell keeps the tmux session, so has_session=true self-heals a dead agent —
// the Fix A regression this stage closes).
//
// SIGNAL = tmux `#{pane_current_command}` (the pane's FOREGROUND process), not pane content:
//   - A running Claude Code TUI is a Node process that OWNS the pane foreground, so the
//     command is `claude`/`node` continuously — including when IDLE (no output) and during
//     Bash tool-calls (those are piped child subprocesses, not the pane's foreground). Verified
//     empirically: live agents report `claude` across rapid samples; a plain shell reports `bash`.
//   - When the CLI exits, the shell becomes foreground → `bash`/`sh`/`zsh`.
// This is immune to the leftover-Claude-UI-after-death that fools content matching (the exact
// pane state — shell prompt with a stale "bypass permissions" status line — that masked the
// GilDeathCanary CLI-exit death as idle). It also cannot false-kill an idle-but-alive agent
// (still `claude`), which is the overshoot direction the gate names as make-or-break.

export type PaneLiveness = 'claude' | 'shell' | 'other';

const CLAUDE_COMMANDS = /^(claude|node)$/i;
// Login shells arrive prefixed with '-', e.g. '-bash'. Match the common interactive shells.
const SHELL_COMMANDS = /^-?(bash|sh|zsh|dash|fish|ash|ksh|tcsh|csh)$/i;

/**
 * Classify a pane's foreground command (`#{pane_current_command}`).
 *   'claude' — Claude Code CLI is running (alive; active OR idle).
 *   'shell'  — the CLI has exited to an interactive shell (dead-CLI).
 *   'other'  — anything else (editor/pager/unknown) — treated as alive by callers (never reap
 *              on an unrecognized command; the safe under-recovery direction).
 */
export function classifyPaneCommand(paneCurrentCommand: string | null | undefined): PaneLiveness {
  const cmd = (paneCurrentCommand ?? '').trim();
  if (!cmd) return 'other';
  if (CLAUDE_COMMANDS.test(cmd)) return 'claude';
  if (SHELL_COMMANDS.test(cmd)) return 'shell';
  return 'other';
}
