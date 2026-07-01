/**
 * Sanitize untrusted strings before terminal output.
 *
 * Strips ALL terminal escape sequences from a string, including:
 *   - CSI sequences  (ESC [ ... final_byte)    — cursor movement, screen clear, SGR colors
 *   - OSC sequences  (ESC ] ... BEL/ST)         — window title, hyperlinks
 *   - Simple escapes (ESC followed by one char)  — e.g. ESC 7 (save cursor)
 *   - C1 control codes (0x80–0x9F)
 *   - Raw control characters (BEL, BS, etc.)     — except \t and \n which are safe
 *
 * This defends against CWE-150 (terminal escape injection) where
 * untrusted data (e.g., skill name/description from SKILL.md frontmatter
 * or remote APIs) could clear the screen, move the cursor, change the
 * window title, or render attacker-controlled text that looks like
 * legitimate CLI output.
 */

// CSI sequences: ESC[ followed by parameter bytes (0x30-0x3F), intermediate bytes (0x20-0x2F), and a final byte (0x40-0x7E)
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;

// OSC sequences: ESC] ... terminated by BEL (\x07) or ST (ESC\)
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

// DCS, PM, APC sequences: ESC P|^|_ ... terminated by ST (ESC\)
const DCS_PM_APC_RE = /\x1b[P^_][\s\S]*?(?:\x1b\\)/g;

// Simple two-byte escape sequences: ESC followed by a single char in 0x20-0x7E range
// Includes ESC 7 (DECSC), ESC 8 (DECRC), ESC c (RIS), ESC M (RI), etc.
const SIMPLE_ESC_RE = /\x1b[\x20-\x7e]/g;

// C1 control codes (0x80-0x9F) — used as 8-bit equivalents of ESC sequences
const C1_RE = /[\x80-\x9f]/g;

// Raw control characters except tab (\x09), newline (\x0a), and BEL (\x07).
// BEL is excluded here so it can still serve as an OSC terminator in Phase 2.
const CONTROL_PRE_RE = /[\x00-\x06\x08\x0b\x0c\x0d-\x1a\x1c-\x1f\x7f]/g;

// Final catch-all: remove BEL, residual ESC (0x1b), and CSI introducer (0x9b)
const RESIDUAL_RE = /[\x07\x1b\x9b]/g;

/**
 * Strip all terminal escape sequences and dangerous control characters
 * from a string.
 *
 * The stripping order is critical to prevent bypass via "spacer" bytes:
 *   1. Remove C1 codes and raw control chars (excl. BEL) FIRST — these
 *      can act as inert spacers that prevent sequence regexes from
 *      matching (e.g. \x1b\x01[2J won't match CSI_RE because of the
 *      \x01, but after \x01 is removed, the remaining \x1b[2J is a
 *      valid CSI sequence). BEL is kept so OSC_RE can still match its
 *      terminator.
 *   2. Remove full escape sequences (OSC, DCS, CSI, simple ESC+char).
 *   3. Unconditionally strip any residual BEL, ESC, or CSI-introducer
 *      bytes that survived (e.g. a lone trailing \x1b, or a BEL that
 *      was not part of a matched OSC).
 *
 * Safe for use on untrusted input before printing to the terminal.
 */
export function stripTerminalEscapes(str: string): string {
  return (
    str
      // Phase 1: Remove spacer bytes that could prevent sequence matching
      .replace(C1_RE, '') // C1 control codes (0x80-0x9F)
      .replace(CONTROL_PRE_RE, '') // Raw control chars (keep \t, \n, BEL)
      // Phase 2: Remove well-formed escape sequences
      .replace(OSC_RE, '') // OSC (longest match first; needs BEL as terminator)
      .replace(DCS_PM_APC_RE, '') // DCS/PM/APC
      .replace(CSI_RE, '') // CSI sequences
      .replace(SIMPLE_ESC_RE, '') // Simple ESC+char
      // Phase 3: Catch-all for any residual escape/control introducers
      .replace(RESIDUAL_RE, '')
  );
}

/**
 * Sanitize a skill metadata string (name, description, etc.) for safe terminal display.
 *
 * In addition to stripping escape sequences, this also trims whitespace and
 * collapses internal newlines into spaces (skill names/descriptions should
 * be single-line when displayed).
 */
export function sanitizeMetadata(str: string): string {
  return stripTerminalEscapes(str)
    .replace(/[\r\n]+/g, ' ')
    .replace(RESIDUAL_RE, '') // Re-check after newline collapse (ESC+\n → ESC+space)
    .trim();
}

/**
 * Sanitize a plugin group name and convert from kebab-case to Title Case
 * for display as a section header in terminal output.
 *
 * Centralizes the repeated pattern of sanitize → split('-') → capitalize → join.
 */
export function formatGroupTitle(group: string): string {
  return sanitizeMetadata(group)
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
