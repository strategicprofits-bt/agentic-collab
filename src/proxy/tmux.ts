/**
 * Tmux operations. Runs on the host machine.
 * All tmux commands executed via child_process.
 */

import { execSync, execFileSync, type ExecSyncOptions } from 'node:child_process';

const EXEC_OPTS: ExecSyncOptions = { encoding: 'utf-8', timeout: 10_000 };

function exec(cmd: string): string {
  try {
    return (execSync(cmd, EXEC_OPTS) as string).trim();
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(`tmux command failed: ${cmd}\n${msg}`);
  }
}

export function createSession(sessionName: string, cwd: string): void {
  validateSessionName(sessionName);
  // Unset CLAUDECODE so spawned Claude Code instances don't think they're nested.
  // The proxy may itself be launched from within a Claude Code session.
  // Explicitly pass PATH so engines like Codex that spawn sub-shells don't lose
  // the collab bin directory that the proxy prepended at startup.
  const path = process.env['PATH'] ?? '';
  exec(`tmux new-session -d -s '${esc(sessionName)}' -c '${esc(cwd)}' -e CLAUDECODE= -e PATH='${esc(path)}'`);
}

export function hasSession(sessionName: string): boolean {
  validateSessionName(sessionName);
  try {
    exec(`tmux has-session -t '${esc(sessionName)}'`);
    return true;
  } catch {
    return false;
  }
}

export function killSession(sessionName: string): void {
  validateSessionName(sessionName);
  try {
    exec(`tmux kill-session -t '${esc(sessionName)}'`);
  } catch {
    // Session may already be gone
  }
}

export function clearHistory(sessionName: string): void {
  validateSessionName(sessionName);
  try {
    exec(`tmux clear-history -t '${esc(sessionName)}'`);
  } catch {
    // Session may be gone — non-fatal
  }
}

export function listSessions(): string[] {
  try {
    const output = exec("tmux list-sessions -F '#{session_name}'");
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Paste text into a tmux pane via load-buffer + paste-buffer.
 * Optionally press Enter after pasting.
 */
// Delay between paste and Enter: 1ms per character (terminal ingestion rate),
// with a 1500ms floor. The Claude Code 2.x Ink-based TUI briefly drops input
// while finalizing a prior response ("Cooked for Ns" / "Crunched for Ns"
// transition) and the previous 500ms floor lost the Enter under that state.
// Bumping the floor and adding a verified retry below catches both cases.
function pasteEnterDelay(textLength: number): number {
  return Math.max(1500, textLength);
}

// Detect "input prompt has un-submitted text". Last lines look like
// "❯ <something>" when our Enter was eaten; an empty input prompt is "❯ "
// with nothing after.
function inputStillHasUnsubmittedText(sessionName: string): boolean {
  try {
    const pane = execSync(`tmux capture-pane -t '${esc(sessionName)}' -p -S -8`, EXEC_OPTS) as string;
    const lines = pane.split('\n').reverse();
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line) continue;
      const m = line.match(/^[❯>]\s+(.+)$/);
      if (m && m[1].trim().length > 0) return true;
      // First non-empty, non-prompt-related line ends the scan
      if (!line.startsWith('❯') && !line.startsWith('>') && !line.startsWith('─') && !line.startsWith('⏵')) return false;
    }
  } catch {
    /* capture failed — be conservative and don't retry */
  }
  return false;
}

// Dismiss any blocking modal Claude TUI shows (currently: feedback survey,
// trust dialog). These steal all keystrokes, so a paste lands in the prompt
// but Enter does nothing. Returns true if a modal was found and dismissed.
function dismissBlockingModal(sessionName: string): boolean {
  try {
    const pane = execSync(`tmux capture-pane -t '${esc(sessionName)}' -p -S -25`, EXEC_OPTS) as string;
    // "How is Claude doing this session? (optional)" — feedback survey.
    // Keys: 1 Bad, 2 Fine, 3 Good, 0 Dismiss. Send "0".
    if (/How is Claude doing this session/.test(pane) && /0:\s*Dismiss/.test(pane)) {
      execSync(`tmux send-keys -t '${esc(sessionName)}' '0'`, EXEC_OPTS);
      return true;
    }
    // Trust dialog ("Is this a project you trust?"). Default cursor on
    // "No, exit" — send Up + Enter to choose Yes. We pre-trust folders in
    // ~/.claude.json so this should rarely fire, but defensive.
    if (/Is this a project you (created or one you )?trust/.test(pane)) {
      execSync(`tmux send-keys -t '${esc(sessionName)}' Up Enter`, EXEC_OPTS);
      return true;
    }
  } catch {
    /* capture failed — give up silently */
  }
  return false;
}

export async function pasteText(sessionName: string, text: string, pressEnter: boolean): Promise<void> {
  validateSessionName(sessionName);
  // Verify tmux is responsive before pasting — catches locked/overloaded sessions
  try {
    execSync(`tmux capture-pane -t '${esc(sessionName)}' -p -S -1`, { ...EXEC_OPTS, timeout: 5000 });
  } catch {
    throw new Error(`tmux session "${sessionName}" is not responsive (capture-pane timed out)`);
  }

  // If a blocking modal is up (feedback survey, trust dialog), dismiss it
  // first — otherwise the modal eats every keystroke and the paste/Enter
  // both go nowhere visible.
  if (dismissBlockingModal(sessionName)) {
    await new Promise<void>((r) => setTimeout(r, 500));
  }

  // Pass text via stdin (input option) to avoid all shell escaping issues
  execSync('tmux load-buffer -', { ...EXEC_OPTS, input: text });
  exec(`tmux paste-buffer -t '${esc(sessionName)}'`);

  if (pressEnter) {
    await new Promise<void>((r) => setTimeout(r, pasteEnterDelay(text.length)));
    exec(`tmux send-keys -t '${esc(sessionName)}' Enter`);

    // Verify the input cleared. If text still sits in the prompt after 800ms,
    // the TUI was busy and the Enter was eaten — retry up to 2 times. If a
    // modal popped up between paste and Enter, dismiss + retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise<void>((r) => setTimeout(r, 800));
      if (!inputStillHasUnsubmittedText(sessionName)) return;
      if (dismissBlockingModal(sessionName)) {
        await new Promise<void>((r) => setTimeout(r, 400));
      }
      exec(`tmux send-keys -t '${esc(sessionName)}' Enter`);
    }
  }
}

/**
 * Capture the last N lines from the tmux pane.
 */
export function capturePaneLines(sessionName: string, lines: number): string {
  validateSessionName(sessionName);
  const safeLines = Math.max(1, Math.min(Math.floor(lines) || 50, 10000));
  return exec(`tmux capture-pane -t '${esc(sessionName)}' -p -S -${safeLines}`);
}

/**
 * Get the last activity timestamp for a tmux session pane.
 * Returns Unix timestamp (seconds) from tmux's #{window_activity}.
 */
export function paneActivity(sessionName: string): number {
  validateSessionName(sessionName);
  const output = exec(`tmux display-message -t '${esc(sessionName)}' -p '#{window_activity}'`);
  const ts = parseInt(output, 10);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Send raw keys to a tmux session.
 * Keys are validated to prevent shell injection — only known tmux key names
 * and safe patterns (e.g. "Escape Escape Escape", "C-c", "Enter") are allowed.
 */
const SAFE_KEYS_RE = /^[a-zA-Z0-9 -]+$/;

export function sendKeys(sessionName: string, keys: string): void {
  validateSessionName(sessionName);
  if (!SAFE_KEYS_RE.test(keys)) {
    throw new Error(`Invalid keys: "${keys}" — only alphanumeric, spaces, and hyphens allowed`);
  }
  exec(`tmux send-keys -t '${esc(sessionName)}' ${keys}`);
}

/**
 * Send raw tmux send-keys tokens without shell interpolation.
 * Used only by the constrained `collab tmux ... -- send-keys ...` escape hatch.
 */
export function sendKeysRaw(sessionName: string, keys: string[]): void {
  validateSessionName(sessionName);
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('keys required');
  }
  execFileSync('tmux', ['send-keys', '-t', sessionName, ...keys], EXEC_OPTS);
}

/**
 * Run `tmux display-message -p` for a session and return stdout.
 */
export function displayMessage(sessionName: string, format: string): string {
  validateSessionName(sessionName);
  if (!format) {
    throw new Error('format required');
  }
  return (execFileSync('tmux', ['display-message', '-t', sessionName, '-p', format], EXEC_OPTS) as string).trim();
}

/**
 * Resize the tmux window for a session to the given width and height.
 */
export function resizePane(sessionName: string, width: number, height: number): void {
  validateSessionName(sessionName);
  const w = Math.max(1, Math.min(Math.floor(width), 500));
  const h = Math.max(1, Math.min(Math.floor(height), 200));
  exec(`tmux resize-window -t '${esc(sessionName)}' -x ${w} -y ${h}`);
}

/**
 * Validate tmux session name — only allow safe characters.
 */
const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: "${name}" — only [a-zA-Z0-9_-] allowed`);
  }
}

/**
 * Escape single quotes for shell.
 */
function esc(s: string): string {
  return s.replace(/'/g, "'\\''");
}
