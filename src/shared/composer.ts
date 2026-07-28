// ── Composer pane parsing + message correspondence ──
//
// Pure functions shared by the proxy (tmux.ts paste-verification) and the
// orchestrator (stranded-input watchdog). Kept in one place so the two callers
// can NEVER drift — drift between "did my paste submit" and "is this agent
// stranded" is what produced the S1 defect family.
//
// The composer is a small, fixed-height BOX at the very bottom of the Claude TUI
// pane, bounded by two border lines, with an indented hint line below it:
//
//     ──────────── AgentName ──     ← top border (has the title)
//     ❯ first line of the message   ← composer prompt line
//       wrapped continuation …      ← continuation lines (indented, NO glyph)
//     ──────────────────────────    ← bottom border
//       ⏵⏵ bypass permissions …     ← hint line (indented)

/** Minimum shared run (chars) for the composer to "correspond" to a message. */
export const MIN_CORRESPONDENCE_CHARS = 30;

/**
 * The composer's unsubmitted text (visual order, prompt glyph stripped, lines
 * space-joined) or null if the composer is empty.
 *
 * Two hazards threaded on ONE bounded walk (both un-mergeable if traded):
 *  - UNDER-detect: trim() BOTH ends per line so the INDENTED hint/continuation
 *    lines don't defeat the walk (the original hint-line miss).
 *  - OVER-detect: the walk is BOUNDED to the composer box — it enters at the
 *    bottom border and STOPS at the top border, never climbing into scrollback,
 *    where blockquoted "> …" system-prompt text would be misread as live input.
 *    MAX_SCAN backstops absent/malformed borders.
 */
export function extractComposerText(pane: string): string | null {
  const lines = pane.split('\n');
  const MAX_SCAN = 16; // composer box is tiny; generous cap, still finite
  let scanned = 0;
  let insideBox = false; // seen the bottom border → now within the composer box
  const collected: string[] = []; // box content lines, collected bottom-up
  for (let i = lines.length - 1; i >= 0 && scanned < MAX_SCAN; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    scanned++;
    if (line.startsWith('⏵')) continue; // hint line, rendered BELOW the box
    if (line.startsWith('─')) {
      if (!insideBox) { insideBox = true; continue; } // bottom border → enter box
      break; // top border → everything above is scrollback: STOP
    }
    if (insideBox) {
      // Any non-empty text inside the box = live unsubmitted input. Strip an
      // optional prompt glyph so a bare "❯"/"> " empty prompt reads as empty
      // while wrapped continuation lines (no glyph) still count.
      const content = line.replace(/^[❯>]\s*/, '').trim();
      if (content.length > 0) collected.push(content);
    } else {
      // A non-decoration line reached BEFORE any bottom border = a compact pane
      // with no rendered box. Only a composer prompt WITH text counts, and only
      // the "❯" composer glyph (NOT ">") — so a bare scrollback "> …" line that
      // happens to be last can never false-positive. Decide here and STOP.
      const m = line.match(/^❯\s+(.+)$/);
      if (m !== null && m[1] !== undefined && m[1].trim().length > 0) collected.push(m[1].trim());
      break;
    }
  }
  if (collected.length === 0) return null;
  return collected.reverse().join(' '); // bottom-up → visual order
}

/** True iff the composer holds ANY unsubmitted text (boolean view of extract). */
export function hasComposerText(pane: string): boolean {
  return extractComposerText(pane) !== null;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Length of the common prefix of two strings. */
function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Does the composer text CORRESPOND to `messageText` (a delivered envelope, or
 * the exact text a caller just pasted)?
 *
 * A genuine paste renders `messageText` into the composer FROM ITS START (the
 * dispatcher pastes the envelope verbatim, so the composer begins "[from: …"),
 * possibly wrapped/truncated at the capture width. So a real paste shares a long
 * COMMON PREFIX with `messageText` (≥ the ~33-char "[from: X, reply with collab
 * send X …" boilerplate, present in every envelope regardless of body length).
 *
 * This is TIGHT — an agent's OWN draft, incl. a drafted "collab send X --topic Y"
 * command, does NOT start with the envelope, so the common prefix is ~0; and the
 * TUI placeholder ("Try \"…\"") shares no prefix — so neither reaches the action
 * path. It is LOOSE enough to match a real paste as rendered (prefix, not
 * equality). Chosen over longest-common-substring specifically to avoid a
 * false-match on the shared "reply with collab send …" boilerplate mid-string.
 *
 * Documented residuals: (i) a message wrapping BEYOND the visible pane so only
 * its scrolled tail is captured (no "[from:" prefix) under-detects — safe
 * direction; (ii) an own-draft that literally begins by quoting the inbound
 * envelope still matches — closed later by a pane-based consumed signal.
 */
export function composerCorrespondsToMessage(composerText: string, messageText: string): boolean {
  const c = norm(composerText);
  const m = norm(messageText);
  if (c.length < MIN_CORRESPONDENCE_CHARS || m.length < MIN_CORRESPONDENCE_CHARS) return false;
  return commonPrefixLen(c, m) >= MIN_CORRESPONDENCE_CHARS;
}

/**
 * Does the composer still hold the exact text a caller just pasted? Used by the
 * proxy to decide whether a paste FAILED to submit (still sitting) vs succeeded.
 * Long pastes (message envelopes) use prefix-correspondence; SHORT pastes (hook
 * commands like "/compact", below the correspondence min-length) fall back to
 * containment, so a genuinely-unsubmitted short command is still caught while a
 * placeholder / own-draft / empty composer reads as submitted (no false-throw).
 */
export function composerHoldsPaste(composerText: string, pastedText: string): boolean {
  const c = norm(composerText);
  const p = norm(pastedText);
  if (p.length === 0) return false;
  if (p.length >= MIN_CORRESPONDENCE_CHARS) return commonPrefixLen(c, p) >= MIN_CORRESPONDENCE_CHARS;
  return c.includes(p);
}
