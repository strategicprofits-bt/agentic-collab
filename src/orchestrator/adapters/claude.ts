/**
 * Claude Code CLI adapter.
 */

import { SPINNER_REGEX, type EngineAdapter, type SpawnOptions, type ResumeOptions, type IdleState, type ContextResult } from './types.ts';
import { shellQuote, validModelId } from '../../shared/utils.ts';

export class ClaudeAdapter implements EngineAdapter {
  readonly engine = 'claude';
  readonly supportsResumePrompt = false;

  buildSpawnCommand(opts: SpawnOptions): string {
    const parts = ['claude'];

    if (opts.dangerouslySkipPermissions === true) {
      parts.push('--dangerously-skip-permissions');
    }

    // Reject a malformed model token rather than push it raw (defends the argv).
    const spawnModel = validModelId(opts.model);
    if (spawnModel) {
      parts.push('--model', spawnModel);
    }

    // Claude Code uses --effort for reasoning effort (low, medium, high)
    if (opts.thinking) {
      parts.push('--effort', opts.thinking);
    }

    // Pre-set session ID so we can resume later without parsing output
    if (opts.sessionId) {
      parts.push('--session-id', opts.sessionId);
    }

    if (opts.appendSystemPrompt) {
      parts.push('--append-system-prompt', shellQuote(opts.appendSystemPrompt));
    }

    if (opts.task) {
      // Positional argument for initial prompt in interactive mode.
      // Do NOT use -p/--print — that exits after the first response.
      parts.push(shellQuote(opts.task));
    }

    return parts.join(' ');
  }

  buildResumeCommand(opts: ResumeOptions): string {
    const parts = ['claude'];

    if (opts.dangerouslySkipPermissions === true) {
      parts.push('--dangerously-skip-permissions');
    }

    if (opts.sessionId) {
      parts.push('--resume', opts.sessionId);
    }

    // Pin the model explicitly on resume. Without it, `claude --resume` inherits
    // the model recorded in the session transcript — which can be a poisoned
    // CLI-default if the session was ever created without --model. Mirrors
    // buildSpawnCommand so spawn and resume resolve the same configured model.
    // Reject a malformed model token rather than push it raw (defends the argv).
    const resumeModel = validModelId(opts.model);
    if (resumeModel) {
      parts.push('--model', resumeModel);
    }

    if (opts.appendSystemPrompt) {
      parts.push('--append-system-prompt', shellQuote(opts.appendSystemPrompt));
    }

    return parts.join(' ');
  }

  detectIdleState(paneOutput: string): IdleState {
    const lines = paneOutput.split('\n');

    // Search bottom-up through captured lines, skipping the status bar
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;

      // Skip status bar lines (token counts, version info, permission mode, /ide hints, context warnings, usage tier)
      if (/\d+(?:[.,]\d+)?\s*[kKmM]?\s*tokens/.test(line)) continue;
      if (/current:.*latest:/.test(line)) continue;
      if (/bypass permissions/.test(line)) continue;
      if (/\/ide\s/.test(line)) continue;
      if (/Context left until/.test(line)) continue;
      if (/Remote Control/.test(line)) continue;
      if (/using extra usage/i.test(line)) continue;
      if (/using standard usage/i.test(line)) continue;

      // Claude Code shows "❯" (U+276F) or ">" prompt when waiting for input.
      // v2.1.139+ shows placeholder hints after the prompt character.
      if (/^[\u276f>](\s|$)/.test(line)) return 'waiting_for_input';

      // Horizontal rule separators (─ U+2500) around the input area
      if (/^[\u2500\u25aa\s]+$/.test(line)) continue;

      // Claude shows tool execution indicators
      if (/^\s*(Read|Write|Edit|Bash|Glob|Grep|Agent|WebFetch|WebSearch)\s/.test(line)) return 'running_tool';
      if (SPINNER_REGEX.test(line)) return 'running_tool';

      // Streaming output (partial lines, thinking indicators)
      if (/^\.{2,}$/.test(line)) return 'streaming';
      if (/thinking/i.test(line) && /\.\.\./i.test(line)) return 'streaming';

      // If we see a prompt-like pattern (e.g. "claude>"), it's waiting
      if (/claude.*[>\u276f]\s*$/.test(line)) return 'waiting_for_input';

      // If we hit actual content, it's not idle
      break;
    }

    return 'unknown';
  }

  parseContextPercent(paneOutput: string): ContextResult {
    const lines = paneOutput.split('\n');

    // GAP-012: current-window OCCUPANCY and CUMULATIVE session tokens are two
    // distinct quantities and must be extracted independently. The "NNNNN tokens"
    // figure in the v2.x status bar (e.g. "/clear to save 202k tokens") is a
    // CUMULATIVE session count — it exceeds the window and keeps climbing across
    // compactions, so it is NOT window occupancy and must NEVER be divided by
    // 200k to fabricate a context %. It is recorded as totalTokens only.
    // contextPct is populated ONLY from a genuine occupancy line, else stays null.
    let contextPct: number | null = null;
    let totalTokens: number | undefined;

    // Search bottom-up through the status-bar region (last 20 lines), capturing
    // the first occurrence of each signal.
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      const line = lines[i] ?? '';

      // Genuine occupancy signal #1: REMAINING headroom until auto-compact → occupancy = 100 - N
      // (a near-full "7%" reads as 93). GAP-122: the Claude TUI drifted the format ~2026-10-13
      // under a steady .296 binary (server/Statsig render change), moving the % BEFORE the phrase
      // — "N% until auto-compact" — which the old "Context left until auto-compact: N%" regex
      // missed, nulling context_pct fleet-wide for ~3 weeks. Match BOTH (old kept, new added);
      // the optional word tolerates "N% left/remaining until auto-compact".
      //
      // GAP-122 HARDENING: the occupancy phrase is matched ONLY when it is the WHOLE trimmed line
      // (a standalone status-bar indicator), NOT when it appears embedded in prose. The first
      // unanchored version FALSE-captured the phrase out of received collab-message / chat text
      // (us discussing a "1% until auto-compact" value) → bogus context_pct=99 fleet-wide + a
      // false GAP-118 alert. `^…$` on the trimmed line excludes the mid-sentence prose case.
      if (contextPct === null) {
        const bar = line.trim();
        const autoCompact = bar.match(/^context left until auto-compact:\s*(\d+)%$/i)
          ?? bar.match(/^(\d+)%\s*(?:\w+\s+)?until auto-compact$/i);
        if (autoCompact) {
          contextPct = Math.max(0, Math.min(100, 100 - parseInt(autoCompact[1]!, 10)));
        }
      }

      // Genuine occupancy signal #2 (legacy): "XX% context" — taken as-is.
      if (contextPct === null) {
        const pctMatch = line.match(/(\d+)%\s*context/i);
        if (pctMatch) {
          contextPct = Math.min(100, parseInt(pctMatch[1]!, 10));
        }
      }

      // Cumulative session tokens — the "new task? /clear to save NNNk tokens" line
      // ONLY. GAP-097: a bare "N tokens" also matches the TRANSIENT per-turn streaming
      // counter (resets each turn), so anchor on "/clear to save" to capture the real
      // cumulative figure and ignore the transient. Recorded as totalTokens ONLY —
      // never converted to a context %.
      //
      // GAP-125: the trailing word "tokens" is NO LONGER required. A pending-update nag
      // ("✔ Update installed · Restart to update") shares the status-bar line and steals its
      // width, TRUNCATING "/clear to save 124.6k tokens" to "/clear to save 124.6k to…" — the
      // "tokens" word is cut off. The old ...\s*tokens anchor then missed, nulling totalTokens
      // fleet-wide from ~2026-11-03 (snapshots stopped + the 700k auto-compact backstop went
      // dark). The number+unit IS the signal. To keep this parse-WIDENING from false-capturing
      // "/clear to save N" quoted mid-sentence in collab prose (this feeds the 700k ACTION gate
      // — the GAP-122 leg-2 lesson), the phrase is anchored to the START of the trimmed line as
      // a standalone status-bar indicator (optional "new task?" chrome prefix), NOT matched
      // anywhere in the line. Mid-sentence prose has words before the phrase → no match.
      if (totalTokens === undefined) {
        const tokenMatch = line.trim().match(/^(?:new task\?\s*)?\/clear to save\s+(\d+(?:[.,]\d+)?)\s*([kKmM])?\b/i);
        if (tokenMatch) {
          let tokens = parseFloat(tokenMatch[1]!.replace(/,/g, ''));
          const suffix = tokenMatch[2];
          if (suffix === 'k' || suffix === 'K') tokens *= 1_000;
          else if (suffix === 'm' || suffix === 'M') tokens *= 1_000_000;
          totalTokens = Math.round(tokens);
        }
      }

      if (contextPct !== null && totalTokens !== undefined) break;
    }

    const confident = contextPct !== null || totalTokens !== undefined;
    return totalTokens !== undefined
      ? { contextPct, totalTokens, confident }
      : { contextPct, confident };
  }

  buildExitCommand(): string {
    return '/exit';
  }

  buildCompactCommand(): string {
    return '/compact';
  }

  buildRenameCommand(name: string): string | null {
    return `/rename ${name}`;
  }

  interruptKeys(): string[] {
    return ['Escape', 'Escape', 'Escape'];
  }

  buildSubmitCommand(task: string): string {
    return task;
  }

  extractSessionId(_paneOutput: string): string | null {
    // Claude uses --session-id at spawn time, so we don't need to parse output.
    return null;
  }

  buildDetectSessionCommand(_cwd: string): string | null {
    // Claude pre-generates session IDs at spawn time via --session-id.
    // No post-spawn detection needed.
    return null;
  }
}
