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

      // Genuine occupancy signal #1 (the one Claude v2.x actually exposes):
      // "Context left until auto-compact: N%" reports REMAINING headroom, so
      // occupancy used = 100 - N (a near-full "7%" reads as 93).
      if (contextPct === null) {
        const autoCompact = line.match(/Context left until auto-compact:\s*(\d+)%/i);
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

      // Cumulative session tokens: "24.9k tokens", "150K tokens", "NNNNN tokens",
      // "↓ 24.9k tokens", "/clear to save 202k tokens". Recorded as totalTokens
      // ONLY — never converted to a context %.
      if (totalTokens === undefined) {
        const tokenMatch = line.match(/↓?\s*(\d+(?:[.,]\d+)?)\s*([kKmM])?\s*tokens/);
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
