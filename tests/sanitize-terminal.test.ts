/**
 * Unit tests for terminal escape sanitization (CWE-150 fix).
 *
 * These tests verify that untrusted metadata from SKILL.md frontmatter
 * and remote APIs cannot inject terminal escape sequences that could:
 * - Clear the screen
 * - Move the cursor
 * - Change the terminal window title
 * - Render attacker-controlled text as if it were legitimate CLI output
 */

import { describe, it, expect } from 'vitest';
import { stripTerminalEscapes, sanitizeMetadata, formatGroupTitle } from '../src/sanitize.ts';

const dangerous = (s: string) => /[\x07\x1b\x80-\x9f]/.test(s);

describe('stripTerminalEscapes', () => {
  describe('CSI sequences (ESC[...)', () => {
    it('strips SGR color codes', () => {
      expect(stripTerminalEscapes('\x1b[31mred text\x1b[0m')).toBe('red text');
      expect(stripTerminalEscapes('\x1b[1;32mbold green\x1b[0m')).toBe('bold green');
      expect(stripTerminalEscapes('\x1b[38;5;145mextended color\x1b[0m')).toBe('extended color');
    });

    it('strips cursor movement sequences', () => {
      expect(stripTerminalEscapes('\x1b[H')).toBe(''); // cursor home
      expect(stripTerminalEscapes('\x1b[5;10H')).toBe(''); // cursor to row 5, col 10
      expect(stripTerminalEscapes('\x1b[A')).toBe(''); // cursor up
      expect(stripTerminalEscapes('\x1b[10B')).toBe(''); // cursor down 10
      expect(stripTerminalEscapes('\x1b[C')).toBe(''); // cursor forward
      expect(stripTerminalEscapes('\x1b[D')).toBe(''); // cursor back
    });

    it('strips screen clear sequences', () => {
      expect(stripTerminalEscapes('\x1b[2J')).toBe(''); // clear screen
      expect(stripTerminalEscapes('\x1b[3J')).toBe(''); // clear screen + scrollback
      expect(stripTerminalEscapes('\x1b[K')).toBe(''); // clear to end of line
      expect(stripTerminalEscapes('\x1b[2K')).toBe(''); // clear entire line
    });

    it('strips scroll sequences', () => {
      expect(stripTerminalEscapes('\x1b[S')).toBe(''); // scroll up
      expect(stripTerminalEscapes('\x1b[T')).toBe(''); // scroll down
    });
  });

  describe('OSC sequences (ESC]...BEL/ST)', () => {
    it('strips window title changes (OSC 0)', () => {
      expect(stripTerminalEscapes('\x1b]0;malicious title\x07')).toBe('');
      expect(stripTerminalEscapes('\x1b]0;[POC] hijacked\x07rest')).toBe('rest');
    });

    it('strips OSC with ST terminator (ESC\\)', () => {
      expect(stripTerminalEscapes('\x1b]0;title\x1b\\')).toBe('');
    });

    it('strips hyperlink sequences (OSC 8)', () => {
      expect(stripTerminalEscapes('\x1b]8;;https://evil.com\x07click\x1b]8;;\x07')).toBe('click');
    });
  });

  describe('simple escape sequences', () => {
    it('strips save/restore cursor', () => {
      expect(stripTerminalEscapes('\x1b7text\x1b8')).toBe('text');
    });

    it('strips other two-byte escapes', () => {
      expect(stripTerminalEscapes('\x1bM')).toBe(''); // reverse index
      expect(stripTerminalEscapes('\x1bc')).toBe(''); // reset terminal
    });
  });

  describe('control characters', () => {
    it('strips BEL character', () => {
      expect(stripTerminalEscapes('hello\x07world')).toBe('helloworld');
    });

    it('strips backspace', () => {
      expect(stripTerminalEscapes('hello\x08world')).toBe('helloworld');
    });

    it('strips carriage return', () => {
      expect(stripTerminalEscapes('hello\rworld')).toBe('helloworld');
    });

    it('preserves tabs and newlines', () => {
      expect(stripTerminalEscapes('hello\tworld')).toBe('hello\tworld');
      expect(stripTerminalEscapes('hello\nworld')).toBe('hello\nworld');
    });

    it('strips null bytes', () => {
      expect(stripTerminalEscapes('hello\x00world')).toBe('helloworld');
    });
  });

  describe('C1 control codes (8-bit)', () => {
    it('strips C1 control codes', () => {
      expect(stripTerminalEscapes('hello\x9bworld')).toBe('helloworld');
      expect(stripTerminalEscapes('hello\x9dworld')).toBe('helloworld');
    });
  });

  describe('preserves normal text', () => {
    it('leaves plain ASCII text unchanged', () => {
      expect(stripTerminalEscapes('hello world')).toBe('hello world');
    });

    it('leaves unicode text unchanged', () => {
      expect(stripTerminalEscapes('hello 日本語 world')).toBe('hello 日本語 world');
    });

    it('leaves emoji unchanged', () => {
      expect(stripTerminalEscapes('hello 🎉 world')).toBe('hello 🎉 world');
    });
  });

  describe('real-world attack payloads', () => {
    it('strips the POC payload from the bug report', () => {
      const malicious =
        '\x1b]0;[POC] skills output hijacked\x07\x1b[3J\x1b[2J\x1b[H\x1b[31m[POC] Terminal output injected from SKILL.md\x1b[0m\n\x1b[33mThis cleared the screen and overwrote CLI output.\x1b[0m';
      const result = stripTerminalEscapes(malicious);
      expect(result).not.toContain('\x1b');
      expect(result).not.toContain('\x07');
      expect(result).toContain('[POC] Terminal output injected from SKILL.md');
      expect(result).toContain('This cleared the screen and overwrote CLI output.');
    });

    it('strips concealed text attack', () => {
      const malicious = 'safe-skill\x1b[8m(downloads malware)\x1b[0m';
      const result = stripTerminalEscapes(malicious);
      expect(result).toBe('safe-skill(downloads malware)');
    });

    it('strips screen clear + fake output', () => {
      const malicious = 'safe-skill\x1b[2J\x1b[H\x1b[32m✓ Verified Safe\x1b[0m';
      const result = stripTerminalEscapes(malicious);
      expect(result).toBe('safe-skill✓ Verified Safe');
    });

    it('strips combined title change + clear + cursor move + colored text', () => {
      const malicious =
        '\x1b]0;pwned\x07' + // change title
        '\x1b[3J' + // clear scrollback
        '\x1b[2J' + // clear screen
        '\x1b[H' + // cursor home
        '\x1b[32mFake output\x1b[0m'; // green text
      const result = stripTerminalEscapes(malicious);
      expect(result).toBe('Fake output');
      expect(result).not.toContain('\x1b');
    });
  });

  describe('interposed control-char bypass (CWE-150)', () => {
    it('strips ESC + DEL (0x7f) + CSI body', () => {
      // \x1b\x7f[31m — DEL between ESC and [ defeats single-pass CSI_RE.
      // 3-phase approach: Phase 1 strips DEL, Phase 2 matches reassembled CSI.
      const result = stripTerminalEscapes('\x1b\x7f[31m');
      expect(dangerous(result)).toBe(false);
      expect(result).toBe('');
    });

    it('strips ESC + DEL + screen-clear body', () => {
      const result = stripTerminalEscapes('evil\x1b\x7f[2Jname');
      expect(dangerous(result)).toBe(false);
      expect(result).toBe('evilname');
    });

    it('strips ESC + C1 byte (0x80) + CSI body', () => {
      // Phase 1: C1_RE removes 0x80, Phase 2: CSI_RE matches reassembled \x1b[31m.
      const result = stripTerminalEscapes('\x1b\x80[31m');
      expect(dangerous(result)).toBe(false);
      expect(result).toBe('');
    });

    it('strips ESC + multiple interposed bytes + CSI body', () => {
      const result = stripTerminalEscapes('\x1b\x7f\x7f[31m');
      expect(dangerous(result)).toBe(false);
      expect(result).toBe('');
    });

    it('strips ESC + SUB (0x1a) + CSI body', () => {
      const result = stripTerminalEscapes('\x1b\x1a[2J');
      expect(dangerous(result)).toBe(false);
      expect(result).toBe('');
    });

    it('strips ESC + FS (0x1c) + OSC-like body', () => {
      const result = stripTerminalEscapes('\x1b\x1c]0;pwned\x07');
      expect(dangerous(result)).toBe(false);
      expect(result).toBe('');
    });

    it('strips ESC + BEL (0x07) spacer + CSI body', () => {
      // BEL is retained in Phase 1 (needed as OSC terminator), so this path differs.
      // After Phase 2, RESIDUAL_RE strips both ESC and BEL; residue '[31m' is inert.
      const result = stripTerminalEscapes('\x1b\x07[31m');
      expect(dangerous(result)).toBe(false);
      expect(result).toBe('[31m');
    });

    it('strips spacer inside CSI body (ESC [ <ctrl> ...)', () => {
      // Spacer inside the CSI parameter bytes; Phase 1 removes it, Phase 2 matches CSI.
      const result = stripTerminalEscapes('\x1b[\x7f2J');
      expect(dangerous(result)).toBe(false);
      expect(result).toBe('');
    });

    it('strips ESC + printable char (simple two-byte escape)', () => {
      // ESC followed by printable char is consumed by SIMPLE_ESC_RE
      const result = stripTerminalEscapes('hello\x1bworld');
      expect(dangerous(result)).toBe(false);
      expect(result).toBe('helloorld');
    });

    it('strips trailing lone ESC bytes', () => {
      // Truly lone ESC (end of string) is stripped by RESIDUAL_RE (Phase 3)
      expect(stripTerminalEscapes('\x1b')).toBe('');
      expect(stripTerminalEscapes('hello\x1b')).toBe('hello');
    });
  });
});

describe('sanitizeMetadata', () => {
  it('strips escape sequences and trims', () => {
    expect(sanitizeMetadata('  \x1b[31mhello\x1b[0m  ')).toBe('hello');
  });

  it('collapses newlines into spaces', () => {
    expect(sanitizeMetadata('line1\nline2\nline3')).toBe('line1 line2 line3');
  });

  it('collapses carriage returns into spaces', () => {
    // CR is stripped as control char, then newline collapsed
    expect(sanitizeMetadata('line1\r\nline2')).toBe('line1 line2');
  });

  it('handles the full POC payload', () => {
    const malicious =
      '\u001b]0;[POC] skills output hijacked\u0007\u001b[3J\u001b[2J\u001b[H\u001b[31m[POC] Terminal output injected from SKILL.md\u001b[0m\n\u001b[33mThis cleared the screen and overwrote CLI output.\u001b[0m';
    const result = sanitizeMetadata(malicious);
    expect(result).not.toContain('\x1b');
    expect(result).not.toContain('\x07');
    // Newline is collapsed to space
    expect(result).toBe(
      '[POC] Terminal output injected from SKILL.md This cleared the screen and overwrote CLI output.'
    );
  });

  it('handles normal skill names unchanged', () => {
    expect(sanitizeMetadata('next-best-practices')).toBe('next-best-practices');
    expect(sanitizeMetadata('AI SDK')).toBe('AI SDK');
    expect(sanitizeMetadata('Creating Diagrams')).toBe('Creating Diagrams');
  });

  it('handles normal descriptions unchanged', () => {
    expect(sanitizeMetadata('Build UIs with @nuxt/ui v4')).toBe('Build UIs with @nuxt/ui v4');
    expect(sanitizeMetadata('Guide for implementing smooth, native-feeling animations')).toBe(
      'Guide for implementing smooth, native-feeling animations'
    );
  });

  it('blocks interposed control-char bypass', () => {
    const result = sanitizeMetadata('  \x1b\x7f[31mhello\x1b\x7f[0m  ');
    expect(dangerous(result)).toBe(false);
    expect(result).toBe('hello');
  });

  it('strips spacer-byte bypasses (v1 regression)', () => {
    // Control char between ESC and [ prevented CSI_RE from matching in v1;
    // now Phase 1 removes spacer, Phase 2 matches the reassembled CSI sequence
    expect(stripTerminalEscapes('\x1b\x01[2J')).toBe('');
    // Double-ESC: CSI_RE consumes the second ESC[2J; the leading lone ESC is removed by Phase 3 catch-all
    expect(stripTerminalEscapes('\x1b\x1b[2J')).toBe('');
    // C1 spacer between ESC and the CSI introducer `[`
    expect(stripTerminalEscapes('\x1b\x90[2J')).toBe('');
  });

  it('never leaves ESC/BEL/C1 introducer bytes in output', () => {
    const payloads = [
      '\x1b\x01[2J',
      '\x9b2J',
      '\x1b]0;\x1b[2J\x07',
      '\x1bP0;1|1\x1b\\',
      '\x1b]0;unterminated',
      '\x1b',
      '\x07',
      'plugin-\x1b[31mred\x1b[0m-name',
    ];
    for (const p of payloads) {
      expect(dangerous(stripTerminalEscapes(p))).toBe(false);
      expect(dangerous(sanitizeMetadata(p))).toBe(false);
    }
  });

  it('caps input length to prevent ReDoS on unterminated sequences', () => {
    const longInput = '\x1b]'.repeat(50000) + 'x';
    const start = performance.now();
    stripTerminalEscapes(longInput);
    const elapsed = performance.now() - start;
    // With 4KB cap, this should complete in well under 1 second
    expect(elapsed).toBeLessThan(1000);
  });

  it('4096-boundary truncation cannot strand a live escape sequence', () => {
    // Fill to exactly 4095 bytes, then append \x1b[31m (5 bytes) — truncated at 4096
    const filler = 'A'.repeat(4095);
    const input = filler + '\x1b[31m';
    const result = stripTerminalEscapes(input);
    // Truncation may split the sequence, but no ESC/BEL/C1 can survive Phase 3
    expect(result).not.toMatch(/[\x07\x1b\x80-\x9f]/);
    expect(result.length).toBeLessThanOrEqual(4096);
  });
});

describe('formatGroupTitle', () => {
  it('converts kebab-case to Title Case', () => {
    expect(formatGroupTitle('document-skills')).toBe('Document Skills');
    expect(formatGroupTitle('ai-sdk')).toBe('Ai Sdk');
    expect(formatGroupTitle('single')).toBe('Single');
  });

  it('strips escape sequences from group names', () => {
    expect(formatGroupTitle('plugin-\x1b[31mred\x1b[0m-name')).toBe('Plugin Red Name');
    expect(formatGroupTitle('\x1b]0;pwned\x07evil-plugin')).toBe('Evil Plugin');
  });

  it('handles empty and escape-only input', () => {
    expect(formatGroupTitle('')).toBe('');
    expect(formatGroupTitle('\x1b[2J')).toBe('');
    expect(formatGroupTitle('\x07')).toBe('');
  });
});
