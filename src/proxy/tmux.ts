/**
 * Tmux operations. Runs on the host machine.
 * All tmux commands executed via child_process.
 *
 * Execution is ASYNC and shell-free: every tmux invocation goes through
 * `execFile('tmux', argv)` (never a shell). Async means a slow tmux command
 * never blocks Node's single event loop — the proxy HTTP server and heartbeat
 * keep running while tmux works, which prevents the missed-heartbeat/deregister
 * cascade seen under load. Shell-free (argv arrays, not command strings) also
 * removes the shell-quoting/injection surface entirely, so no manual escaping
 * is needed — session-name/key validation stays as defense-in-depth.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 10_000;

/**
 * Run a tmux command asynchronously (no shell). Returns trimmed stdout.
 * argv is passed literally to tmux — no shell parsing, no quoting concerns.
 */
async function tmuxExec(args: string[], opts: { timeout?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('tmux', args, {
      encoding: 'utf-8',
      timeout: opts.timeout ?? EXEC_TIMEOUT_MS,
    });
    return (stdout as string).trim();
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(`tmux command failed: tmux ${args.join(' ')}\n${msg}`);
  }
}

/**
 * Load text into a tmux paste buffer via stdin (`load-buffer -`), async.
 * Passing the text on stdin keeps message content off the argv/command line.
 * execFile's async form has no `input` option, so we write to stdin directly.
 */
function tmuxLoadBuffer(text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      'tmux',
      ['load-buffer', '-'],
      { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS },
      (err) => {
        if (err) reject(new Error(`tmux command failed: tmux load-buffer -\n${err.message}`));
        else resolve();
      },
    );
    child.stdin?.end(text);
  });
}

// Per-session paste serialization. Multiple pastes to the same tmux session
// (e.g. concurrent inbound messages from several agents) used to race their
// paste-then-Enter sequences, leaving text stuck in the input prompt because
// a second paste arrived before the first paste's Enter-retry could finish.
//
// We chain pastes per-sessionName so only one runs at a time. Pastes to
// different sessions remain concurrent. The chain stores a never-rejecting
// promise so a thrown paste doesn't block subsequent ones.
const sessionLocks = new Map<string, Promise<unknown>>();

function serializePerSession<T>(sessionName: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionName) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn whether prev resolved or threw
  const guard = next.catch(() => {}); // never-reject for chaining
  sessionLocks.set(sessionName, guard);
  // Cleanup map entry once this paste settles AND nothing else is queued
  // behind it. If something is queued, the map already points at a later
  // promise — we leave it alone.
  guard.then(() => {
    if (sessionLocks.get(sessionName) === guard) {
      sessionLocks.delete(sessionName);
    }
  });
  return next;
}

export function createSession(sessionName: string, cwd: string): Promise<void> {
  validateSessionName(sessionName);
  // Unset CLAUDECODE so spawned Claude Code instances don't think they're nested.
  // The proxy may itself be launched from within a Claude Code session.
  // Explicitly pass PATH so engines like Codex that spawn sub-shells don't lose
  // the collab bin directory that the proxy prepended at startup.
  const path = process.env['PATH'] ?? '';
  return tmuxExec([
    'new-session', '-d',
    '-s', sessionName,
    '-c', cwd,
    '-e', 'CLAUDECODE=',
    '-e', `PATH=${path}`,
  ]).then(() => {});
}

export function hasSession(sessionName: string): Promise<boolean> {
  validateSessionName(sessionName);
  return tmuxExec(['has-session', '-t', sessionName]).then(
    () => true,
    () => false,
  );
}

export function killSession(sessionName: string): Promise<void> {
  validateSessionName(sessionName);
  // Session may already be gone — swallow the error.
  return tmuxExec(['kill-session', '-t', sessionName]).then(
    () => {},
    () => {},
  );
}

export function clearHistory(sessionName: string): Promise<void> {
  validateSessionName(sessionName);
  // Session may be gone — non-fatal.
  return tmuxExec(['clear-history', '-t', sessionName]).then(
    () => {},
    () => {},
  );
}

export function listSessions(): Promise<string[]> {
  return tmuxExec(['list-sessions', '-F', '#{session_name}']).then(
    (output) => output.split('\n').filter(Boolean),
    () => [],
  );
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
async function inputStillHasUnsubmittedText(sessionName: string): Promise<boolean> {
  try {
    const pane = await tmuxExec(['capture-pane', '-t', sessionName, '-p', '-S', '-8']);
    const lines = pane.split('\n').reverse();
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line) continue;
      const m = line.match(/^[❯>]\s+(.+)$/);
      if (m && m[1] && m[1].trim().length > 0) return true;
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
async function dismissBlockingModal(sessionName: string): Promise<boolean> {
  try {
    const pane = await tmuxExec(['capture-pane', '-t', sessionName, '-p', '-S', '-25']);
    // "How is Claude doing this session? (optional)" — feedback survey.
    // Keys: 1 Bad, 2 Fine, 3 Good, 0 Dismiss. Send "0".
    if (/How is Claude doing this session/.test(pane) && /0:\s*Dismiss/.test(pane)) {
      await tmuxExec(['send-keys', '-t', sessionName, '0']);
      return true;
    }
    // Trust dialog ("Is this a project you trust?"). Default cursor on
    // "No, exit" — send Up + Enter to choose Yes. We pre-trust folders in
    // ~/.claude.json so this should rarely fire, but defensive.
    if (/Is this a project you (created or one you )?trust/.test(pane)) {
      await tmuxExec(['send-keys', '-t', sessionName, 'Up', 'Enter']);
      return true;
    }
  } catch {
    /* capture failed — give up silently */
  }
  return false;
}

export function pasteText(sessionName: string, text: string, pressEnter: boolean): Promise<void> {
  validateSessionName(sessionName);
  // Serialize concurrent pastes to the same session so paste-then-Enter
  // sequences can't interleave and leave text stuck in the prompt.
  return serializePerSession(sessionName, async () => {
    // Verify tmux is responsive before pasting — catches locked/overloaded sessions
    try {
      await tmuxExec(['capture-pane', '-t', sessionName, '-p', '-S', '-1'], { timeout: 5000 });
    } catch {
      throw new Error(`tmux session "${sessionName}" is not responsive (capture-pane timed out)`);
    }

    // If a blocking modal is up (feedback survey, trust dialog), dismiss it
    // first — otherwise the modal eats every keystroke and the paste/Enter
    // both go nowhere visible.
    if (await dismissBlockingModal(sessionName)) {
      await new Promise<void>((r) => setTimeout(r, 500));
    }

    // Pass text via stdin (load-buffer -) to avoid all shell escaping issues
    // and keep message content off the argv/command line.
    await tmuxLoadBuffer(text);
    await tmuxExec(['paste-buffer', '-t', sessionName]);

    if (pressEnter) {
      await new Promise<void>((r) => setTimeout(r, pasteEnterDelay(text.length)));
      await tmuxExec(['send-keys', '-t', sessionName, 'Enter']);

      // Verify the input cleared. If text still sits in the prompt, retry up
      // to 5 times with progressively longer delays. The Claude Code 2.x TUI
      // can take several seconds to transition out of "Cooked"/"Crunched"
      // states. Total retry window: ~10s before we hand off to the watchdog.
      const retryDelays = [800, 1200, 1500, 2000, 2500];
      for (const delay of retryDelays) {
        await new Promise<void>((r) => setTimeout(r, delay));
        if (!(await inputStillHasUnsubmittedText(sessionName))) return;
        if (await dismissBlockingModal(sessionName)) {
          await new Promise<void>((r) => setTimeout(r, 400));
        }
        await tmuxExec(['send-keys', '-t', sessionName, 'Enter']);
      }
    }
  });
}

/**
 * Capture the last N lines from the tmux pane.
 */
export function capturePaneLines(sessionName: string, lines: number): Promise<string> {
  validateSessionName(sessionName);
  const safeLines = Math.max(1, Math.min(Math.floor(lines) || 50, 10000));
  return tmuxExec(['capture-pane', '-t', sessionName, '-p', '-S', `-${safeLines}`]);
}

/**
 * Get the last activity timestamp for a tmux session pane.
 * Returns Unix timestamp (seconds) from tmux's #{window_activity}.
 */
export function paneActivity(sessionName: string): Promise<number> {
  validateSessionName(sessionName);
  return tmuxExec(['display-message', '-t', sessionName, '-p', '#{window_activity}']).then((output) => {
    const ts = parseInt(output, 10);
    return Number.isFinite(ts) ? ts : 0;
  });
}

/**
 * Send raw keys to a tmux session.
 * Keys are validated to prevent injection — only known tmux key names
 * and safe patterns (e.g. "Escape Escape Escape", "C-c", "Enter") are allowed.
 * Space-separated keys become separate argv tokens (matching tmux send-keys).
 */
const SAFE_KEYS_RE = /^[a-zA-Z0-9 -]+$/;

export function sendKeys(sessionName: string, keys: string): Promise<void> {
  validateSessionName(sessionName);
  if (!SAFE_KEYS_RE.test(keys)) {
    throw new Error(`Invalid keys: "${keys}" — only alphanumeric, spaces, and hyphens allowed`);
  }
  return tmuxExec(['send-keys', '-t', sessionName, ...keys.split(' ').filter(Boolean)]).then(() => {});
}

/**
 * Send raw tmux send-keys tokens without shell interpolation.
 * Used only by the constrained `collab tmux ... -- send-keys ...` escape hatch.
 */
export function sendKeysRaw(sessionName: string, keys: string[]): Promise<void> {
  validateSessionName(sessionName);
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('keys required');
  }
  return tmuxExec(['send-keys', '-t', sessionName, ...keys]).then(() => {});
}

/**
 * Run `tmux display-message -p` for a session and return stdout.
 */
export function displayMessage(sessionName: string, format: string): Promise<string> {
  validateSessionName(sessionName);
  if (!format) {
    throw new Error('format required');
  }
  return tmuxExec(['display-message', '-t', sessionName, '-p', format]);
}

/**
 * Resize the tmux window for a session to the given width and height.
 */
export function resizePane(sessionName: string, width: number, height: number): Promise<void> {
  validateSessionName(sessionName);
  const w = Math.max(1, Math.min(Math.floor(width), 500));
  const h = Math.max(1, Math.min(Math.floor(height), 200));
  return tmuxExec(['resize-window', '-t', sessionName, '-x', String(w), '-y', String(h)]).then(() => {});
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
