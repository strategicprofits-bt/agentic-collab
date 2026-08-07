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
import { extractComposerText, composerHoldsPaste } from '../shared/composer.ts';

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
 * Load text into a NAMED tmux paste buffer via stdin (`load-buffer -b <name> -`),
 * async. Passing the text on stdin keeps message content off the argv/command
 * line. execFile's async form has no `input` option, so we write to stdin.
 *
 * The `-b <name>` is load-bearing (GAP-051): every agent session shares ONE tmux
 * server, hence ONE global paste-buffer stack. An UNNAMED `load-buffer -` pushes
 * the top of that shared stack, and a later UNNAMED `paste-buffer` pastes the
 * top — so a concurrent delivery to ANOTHER agent, landing its own load-buffer
 * between this agent's load and paste, makes this agent paste the WRONG text
 * (cross-agent content injection). A unique named buffer sidesteps the shared
 * top-of-stack entirely: we load into and paste from a name only this delivery
 * uses. See nextPasteBufferName.
 */
function tmuxLoadBuffer(text: string, bufferName: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      'tmux',
      ['load-buffer', '-b', bufferName, '-'],
      { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS },
      (err) => {
        if (err)
          reject(
            new Error(`tmux command failed: tmux load-buffer -b ${bufferName} -\n${err.message}`),
          );
        else resolve();
      },
    );
    child.stdin?.end(text);
  });
}

/**
 * Process-global monotonic counter for paste-buffer names. GLOBAL (not
 * per-session) is load-bearing (GAP-051, DrRobby's sanitization-injectivity
 * catch): a per-session counter would let session-A-1 and session-B-1 collide
 * whenever two DISTINCT sessions sanitize to the same string. With ONE
 * process-global counter every delivery in this process gets a DISTINCT value
 * regardless of session, so `pid`+`seq` alone is already globally + temporally
 * unique on a single host — the session prefix is debuggability only, never
 * load-bearing for uniqueness, so a non-injective sanitize cannot cause a
 * collision.
 */
let pasteBufferSeq = 0;

/**
 * Sanitize a session name into a tmux-buffer-name-safe token (non-[A-Za-z0-9_]
 * → `_`). Debuggability/readability ONLY — uniqueness rests on the pid+seq
 * suffix, so this sanitize being non-injective (`a/b` and `a_b` both → `a_b`) is
 * harmless. Session names reaching here are already validated to [a-zA-Z0-9_-],
 * so this is defense-in-depth.
 */
function sanitizeForBufferName(session: string): string {
  return session.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Build a globally + temporally unique tmux paste-buffer name for ONE delivery.
 *   buf = `<sanitizedSession>-<pid>-<seq>`
 *   - sanitizedSession: which agent this went to — debuggability, NOT load-bearing
 *   - pid: disambiguates across proxy RESTARTS (a post-restart counter reset
 *     cannot collide with a buffer lingering from a pre-restart process)
 *   - seq: process-global monotonic counter — the SOLE guarantor of uniqueness
 *     within a process, independent of session sanitization
 * Exported for the uniqueness/injectivity tests. Advances the global counter on
 * every call (each call names a distinct delivery).
 */
export function nextPasteBufferName(sessionName: string): string {
  const seq = ++pasteBufferSeq;
  return `${sanitizeForBufferName(sessionName)}-${process.pid}-${seq}`;
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

/**
 * Least-privilege allowlist for agent session environments (deny-all path-1).
 * Only these env vars survive from the inherited tmux server-global env into a
 * spawned agent session; every other var (all ~90 production credentials —
 * Stripe, Supabase, DB, LLM keys, Doppler, etc.) is neutralized with `-e KEY=`
 * (set-empty — tmux 3.4 new-session has no `-u`; `-e KEY=` overrides the value).
 *
 * Deny-by-default: a var not listed here is removed. Adding a var here is a
 * security decision — keep it tight. Note this closes only PATH-1 (the inherited
 * server env); PATH-2 (the login shell re-fetching Doppler at init) needs the
 * operator-side loader guard. Neither path alone closes the class.
 */
export const ALLOWED_SESSION_ENV = new Set<string>([
  // shell / terminal / locale (TMP is deliberately NOT here — it is an -e override)
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'SHLVL', 'PWD', 'OLDPWD',
  'LANG', 'LS_COLORS', 'LESSCLOSE', 'LESSOPEN', 'XDG_DATA_DIRS', '_',
  'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  // tmux
  'TMUX', 'TMUX_PANE',
  // claude code runtime (non-secret)
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_EFFORT',
  // collab CLI runtime — the agent cannot function without these, AND the path-2
  // loader guard keys on COLLAB_AGENT, so scrubbing it would fail the guard OPEN.
  'COLLAB_AGENT', 'COLLAB_PERSONA_FILE', 'ORCHESTRATOR_URL',
  // misc functional / systemd (non-secret)
  'GIT_EDITOR', 'AI_AGENT', 'COREPACK_ENABLE_AUTO_PIN', 'NoDefaultCurrentDirectoryInExePath',
  'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'MEMORY_PRESSURE_WATCH', 'MEMORY_PRESSURE_WRITE',
  'PORT', 'PROXY_PORT',
  // credentials deliberately KEPT (no-break sequencing): GH_TOKEN pending a git
  // credential helper — dropping it would break the gh CLI mid-task.
  'GH_TOKEN', 'GITHUB_TOKEN',
  // NOTE: ANTHROPIC_API_KEY / OPENAI_API_KEY are intentionally NOT here — claude
  // auth is OAuth (~/.claude/.credentials.json), so the key is scrub-safe.
]);

/**
 * Keys that buildCreateSessionArgs sets AUTHORITATIVELY via `-e`. These are
 * EXCLUDED from the scrub so it can never emit a SECOND `-e TMP=`/`-e TMPDIR=`
 * (or, worse, an `-e PATH=` blanking the path). Coherent-by-construction: the
 * scrub and the explicit overrides never both set these keys, so a future
 * arg-ordering refactor cannot silently reopen the TMP-clobber. The explicit
 * `-e` override is the sole authority for these keys.
 */
const E_OVERRIDE_KEYS = new Set<string>(['CLAUDECODE', 'PATH', 'TMPDIR', 'TMP']);

/**
 * Given the key names present in the session's inherited environment, return the
 * `tmux new-session -e KEY=` argument list for every key that must be NEUTRALIZED:
 * every key that is NOT allowlisted AND NOT an `-e`-override key. Each is set to
 * the EMPTY string, which OVERRIDES the inherited server-global value on the
 * initial pane (no secret value survives).
 *
 * Why `-e KEY=` and not `-u KEY`: tmux 3.4 `new-session` has NO `-u` flag
 * (synopsis: `[-AdDEPX] [-c] [-e environment] [-f flags]...`) — a `-u` arg is
 * rejected outright ("command new-session: unknown flag -u") and would throw on
 * EVERY spawn (fleet-kill). `-e KEY=` is the supported mechanism and, verified
 * empirically, overrides an inherited credential to empty. Trade-off: the key is
 * left PRESENT-BUT-EMPTY (no secret VALUE) rather than fully absent — the security
 * invariant (no secret values in agent env) holds; true per-session unset is not
 * available at new-session time on this tmux.
 *
 * Key names are validated against a strict identifier pattern; any that don't
 * match are skipped defensively so an unsafe token can never be emitted into the
 * session command. Pure — no side effects, never reads values (names only).
 */
export function envScrubArgs(
  keys: Iterable<string>,
  allowed: ReadonlySet<string> = ALLOWED_SESSION_ENV,
): string[] {
  const args: string[] = [];
  for (const key of keys) {
    if (allowed.has(key)) continue;
    if (E_OVERRIDE_KEYS.has(key)) continue; // authoritative -e override, never double-set
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    args.push('-e', `${key}=`);
  }
  return args;
}

/**
 * Parse the KEY names out of `tmux show-environment -g` stdout (value-free —
 * values are never returned or logged). Each set var is `KEY=value`; a leading
 * `-KEY` marks a var already removed from the global env (skip it). Malformed
 * lines (blank, or no `=`) are skipped defensively. Splits on the FIRST `=` so
 * values containing `=` don't corrupt the key.
 */
export function parseServerEnvKeys(showEnvOutput: string): string[] {
  const keys: string[] = [];
  for (const line of showEnvOutput.split('\n')) {
    if (line === '' || line.startsWith('-')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // no '=', or '=' at position 0 (empty key) → malformed
    keys.push(line.slice(0, eq));
  }
  return keys;
}

/**
 * Build the `tmux new-session` argv for an agent session. Pure (env + scrub keys
 * injectable) so the spawn-env hygiene is unit-testable without shelling out.
 *
 * Per-session `-e` overrides matter: tmux new-sessions inherit the tmux SERVER
 * global env, NOT this command's env, so a poisoned/credential server-env value
 * can only be neutralized with an explicit `-e VAR=...` on this command (tmux 3.4
 * new-session has no `-u`).
 * - scrubKeys : every inherited key NOT allowlisted becomes `-e KEY=` (set-empty,
 *               deny-all path-1). Sourced from `show-environment -g` (the actual
 *               inherited env) by the caller; defaults to [] so pure callers stay identical.
 * - CLAUDECODE= : spawned Claude Code instances don't think they're nested.
 * - PATH=       : engines like Codex that spawn sub-shells keep the collab bin.
 * - TMPDIR=/tmp : os.tmpdir() falls TMPDIR -> TMP -> TEMP -> /tmp; pinning TMPDIR
 *                 makes it short-circuit to /tmp regardless of a poisoned TMP.
 * - TMP=        : clear any inherited TMP so a secret value clobbered onto the
 *                 server env is absent from the spawn env entirely (Facet-B).
 */
export function buildCreateSessionArgs(
  sessionName: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  scrubKeys: Iterable<string> = [],
): string[] {
  const path = env['PATH'] ?? '';
  return [
    'new-session', '-d',
    '-s', sessionName,
    '-c', cwd,
    ...envScrubArgs(scrubKeys),
    '-e', 'CLAUDECODE=',
    '-e', `PATH=${path}`,
    '-e', 'TMPDIR=/tmp',
    '-e', 'TMP=',
  ];
}

/**
 * Read the tmux SERVER global env key names — the ACTUAL set a new session
 * inherits. Enumerating this (not process.env) is complete-by-construction: the
 * tmux server survives proxy restarts, so its env is decoupled from the current
 * proxy process.env (server-global ⊆ process.env is coincidental, not
 * guaranteed). Read as late as possible before spawn to minimize the TOCTOU
 * window. If no server is running yet, `show-environment -g` fails — a fresh
 * server will inherit THIS proxy's env, so fall back to process.env keys.
 */
export async function readInheritedEnvKeys(
  exec: (args: string[]) => Promise<string> = tmuxExec,
): Promise<string[]> {
  try {
    return parseServerEnvKeys(await exec(['show-environment', '-g']));
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    // No tmux server yet: the new-session about to run will START the server,
    // inheriting THIS proxy process's env → process.env IS the inheritance
    // surface, so enumerating it is correct (and complete) in this case.
    if (/no server running|error connecting to|failed to connect/i.test(msg)) {
      return Object.keys(process.env);
    }
    // Server is UP but the enumeration read failed. Fail CLOSED: process.env is
    // only a COINCIDENTAL superset of the server-global env (the server survives
    // proxy restarts), so silently falling back could leave a server-global cred
    // un-scrubbed. Refuse the spawn — deny-by-default must hold even on read
    // failure. The caller rejects; lifecycle retries.
    throw new Error(`refusing to spawn unscrubbed session: server env enumeration failed: ${msg}`);
  }
}

export async function createSession(sessionName: string, cwd: string): Promise<void> {
  validateSessionName(sessionName);
  const scrubKeys = await readInheritedEnvKeys();
  await tmuxExec(buildCreateSessionArgs(sessionName, cwd, process.env, scrubKeys));
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

// Did MY paste fail to submit — i.e. does the composer STILL hold the text I just
// pasted? Correspondence-based (not "is there ANY text"): the composer must still
// CORRESPOND to `pastedText`. This is the Part A twin of the watchdog's guard,
// sharing shared/composer.ts so the two can't drift. It matters because the
// bounded box-walk now (correctly) sees text a bare heuristic missed — including
// the TUI's fresh-composer PLACEHOLDER ("❯ Try \"…\"") — and a bare "is there text"
// check would FALSE-throw on a placeholder after a SUCCESSFUL submit, stranding
// the message as pending → redelivery (double-delivery). Requiring correspondence
// to MY text means a placeholder / the agent's own draft / empty all read as
// "submitted" (no throw); only my un-submitted paste still sitting there throws.
async function inputStillHasUnsubmittedText(sessionName: string, pastedText: string): Promise<boolean> {
  try {
    const pane = await tmuxExec(['capture-pane', '-t', sessionName, '-p', '-S', '-8']);
    const composer = extractComposerText(pane);
    if (composer === null) return false; // empty composer → my paste submitted
    return composerHoldsPaste(composer, pastedText);
  } catch {
    /* capture failed — be conservative and don't retry */
  }
  return false;
}

// A blocking modal Claude TUI can show, and the keystroke(s) that dismiss it.
// These modals steal all keystrokes, so a paste lands in the prompt but Enter
// does nothing (the modal-swallow that stranded delivered messages).
export type ModalKind = 'feedback-survey' | 'trust-dialog' | 'status-family';
export interface ModalMatch {
  kind: ModalKind;
  keys: string[];
}

// Match a blocking-modal SIGNATURE in the pane text (no positional/structural
// judgement — that guard is applied by classifyModal below).
function matchModalSignature(pane: string): ModalMatch | null {
  // "How is Claude doing this session? (optional)" — feedback survey.
  // Keys: 1 Bad, 2 Fine, 3 Good, 0 Dismiss. Send "0".
  // RESIDUAL (documented, DrRobby-accepted 2026-07-28): unlike the Escape-
  // dismissed full-screen overlays (real-capture-confirmed footer-absent), the
  // survey dismisses with NUMBER keys — evidence it renders INLINE, which would
  // keep the ⏵ footer present. The structural guard below then treats a REAL
  // inline survey as "working pane" and does NOT dismiss it (false-negative →
  // survey-strand persists). This is backstopped by the pasteText Enter-retry+
  // throw path and is monitorable (a survey-wedge surfaces as an escalation);
  // the survey discriminator is refined against a real induced-survey capture in
  // a follow-up. The guard DOES kill the survey FALSE-positive either way
  // (content quoting the survey keeps the footer → no match). Could not induce a
  // real survey to verify inline-vs-full-screen.
  if (/How is Claude doing this session/.test(pane) && /0:\s*Dismiss/.test(pane)) {
    return { kind: 'feedback-survey', keys: ['0'] };
  }
  // Trust dialog ("Is this a project you trust?"). Default cursor on "No, exit"
  // — send Up + Enter to choose Yes. We pre-trust folders in ~/.claude.json so
  // this should rarely fire, but defensive.
  if (/Is this a project you (created or one you )?trust/.test(pane)) {
    return { kind: 'trust-dialog', keys: ['Up', 'Enter'] };
  }
  // Full-screen overlays opened by /status, /usage, /model, /help, /resume. All
  // are dismissed with Escape. Signatures are the REAL Claude Code v2.1.220
  // headers (captured live 2026-07-28); the a289e43 patterns were stale for
  // /help, /model, /resume (real overlays render different headers, so those
  // modals were never dismissed) — kept here as OR-alternates for version
  // robustness. The structural guard (below) makes these broad signatures safe.
  if (
    /Settings\s+Status\s+Config\s+Usage\s+Stats/.test(pane) || // /status, /usage (tabbed panel)
    /Help\s+General\s+Commands\s+Custom commands/.test(pane) || // /help (v2.1.220 tab header)
    /Available commands|Keyboard shortcuts:/.test(pane) || // /help (legacy)
    /Select model\b|Switch between Claude models/.test(pane) || // /model picker (v2.1.220)
    /Select (a|the) model|Switch to a different model/.test(pane) || // /model (legacy)
    /Resume session \(\d+ of \d+\)/.test(pane) || // /resume picker (v2.1.220)
    /Resume a conversation|Select a( previous)? conversation to resume/.test(pane) // /resume (legacy)
  ) {
    return { kind: 'status-family', keys: ['Escape'] };
  }
  return null;
}

// True if the pane still shows the normal working-TUI composer chrome — the ⏵
// permission-mode hint line rendered below the composer box. A real blocking
// modal is a FULL-SCREEN overlay that REPLACES this chrome, so its presence
// means any signature match is quoted CONTENT (a message echoing the signature
// text), not a live overlay. Checked over the tail of the capture, where the
// footer renders. Fleet calibration: agents spawn permissions:skip (bypass), so
// "⏵⏵ bypass permissions on" is present in every working pane; accept-edits /
// plan modes render their own ⏵ line. (If an agent ever ran WITHOUT a ⏵ footer,
// a content-quote could still false-match, but the pasteText Enter-retry+throw
// path backstops delivery — no strand, just the pre-existing one-shot behavior.)
function paneShowsWorkingComposer(pane: string): boolean {
  const tail = pane
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-8);
  return tail.some((l) => l.startsWith('⏵'));
}

// Pure: classify any blocking modal and its dismiss keys, or null if none.
// Applies the structural guard — a signature match is only a real modal when the
// working-composer chrome is ABSENT (a full-screen overlay replaced it). This
// kills the position-blind false-positive where a message quoting a modal
// signature would otherwise trigger a spurious Escape (and, with PR-2's retry, a
// 4x-Escape + re-deliver loop) on a live working pane. Same discipline as the
// stranded-input watchdog: do not act on content that merely resembles the
// trigger. Doubles as the DISMISSAL VERIFIER — after sending the dismiss keys we
// re-capture and only treat the modal as gone once this returns null. Exported
// for exhaustive unit testing.
export function classifyModal(pane: string): ModalMatch | null {
  const match = matchModalSignature(pane);
  if (match === null) return null;
  if (paneShowsWorkingComposer(pane)) return null; // signature is quoted content
  return match;
}

// IO seam for dismissBlockingModal so the verify/retry loop is unit-testable
// without a live tmux (mirrors makeWatchdog's injectable overrides).
export interface DismissIO {
  capture: () => Promise<string>;
  sendKeys: (keys: string[]) => Promise<void>;
  delay: (ms: number) => Promise<void>;
}

// Verify + retry: send the dismiss keys, RE-CAPTURE, and only report success
// once classifyModal confirms the modal is gone. The original strand cause was
// a single unverified Escape racing the modal's slow async render (it missed,
// the modal stayed up, and the next paste was swallowed) — so a modal that
// outlasts the first keystroke is re-dismissed with backoff. Returns true iff a
// modal was present AND is now verified-gone; false if none was present or it
// could not be cleared (so the caller never assumes a swallowing modal is gone).
const DISMISS_VERIFY_DELAYS = [300, 500, 800, 1200];
export async function dismissBlockingModalWith(io: DismissIO): Promise<boolean> {
  let modal = classifyModal(await io.capture());
  if (!modal) return false;
  for (const delay of DISMISS_VERIFY_DELAYS) {
    await io.sendKeys(modal.keys);
    await io.delay(delay);
    modal = classifyModal(await io.capture());
    if (!modal) return true;
  }
  return false;
}

// Real wrapper binding the IO seam to tmux. Capture failures throw out of
// io.capture and are swallowed here (give up silently, same as before).
async function dismissBlockingModal(sessionName: string): Promise<boolean> {
  try {
    return await dismissBlockingModalWith({
      capture: () => tmuxExec(['capture-pane', '-t', sessionName, '-p', '-S', '-25']),
      sendKeys: (keys) => tmuxExec(['send-keys', '-t', sessionName, ...keys]).then(() => {}),
      delay: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    });
  } catch {
    /* capture/send failed — give up silently */
    return false;
  }
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

    // Pass text via stdin (load-buffer -b <name> -) to avoid all shell escaping
    // issues and keep message content off the argv/command line. A UNIQUE named
    // buffer per delivery (GAP-051) prevents a concurrent delivery to another
    // agent from racing the shared top-of-stack and cross-pasting its text here.
    // `-d` deletes the buffer immediately after pasting so the stack can't grow.
    //
    // `-d` deletes ONLY on a successful paste. If paste-buffer throws AFTER
    // load-buffer created the buffer, the uniquely-named buffer would ORPHAN —
    // and unlike the old unnamed stack (bounded by tmux's buffer-limit eviction),
    // an explicitly-named buffer persists, so repeated paste failures could
    // accumulate buffers. Best-effort delete-buffer on the failure path bounds
    // that. It is qualified (`-b <name>`) so it never touches the shared stack;
    // cleanup errors are swallowed (e.g. load-buffer itself failed → no buffer).
    // Re-throw preserves the not-submitted signal the dispatcher needs to retry.
    const bufferName = nextPasteBufferName(sessionName);
    try {
      await tmuxLoadBuffer(text, bufferName);
      await tmuxExec(['paste-buffer', '-b', bufferName, '-d', '-t', sessionName]);
    } catch (err) {
      await tmuxExec(['delete-buffer', '-b', bufferName]).catch(() => {});
      throw err;
    }

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
        if (!(await inputStillHasUnsubmittedText(sessionName, text))) return;
        if (await dismissBlockingModal(sessionName)) {
          await new Promise<void>((r) => setTimeout(r, 400));
        }
        await tmuxExec(['send-keys', '-t', sessionName, 'Enter']);
      }

      // After all retries: if the input STILL holds unsubmitted text, the paste
      // landed but was never submitted (TUI submit-wedge, or a modal we could
      // not dismiss). Do NOT return silently — a silent return marks the
      // message 'delivered' although the agent never consumed it (the
      // false-delivered trap that stranded agents' queues). THROW so
      // deliverToAgent surfaces an error and the dispatcher keeps the message
      // PENDING for retry; the stranded-input watchdog is the recovery path of
      // last resort.
      if (await inputStillHasUnsubmittedText(sessionName, text)) {
        throw new Error(
          `paste to "${sessionName}" not submitted after ${retryDelays.length} retries — composer still holds the pasted text (TUI submit-wedge or undismissed modal)`,
        );
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
