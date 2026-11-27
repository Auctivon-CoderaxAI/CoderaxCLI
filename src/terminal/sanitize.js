/**
 * Untrusted terminal text sanitisation.
 *
 * Model output, tool output, file names and permission resources all reach the
 * terminal. Any of them can contain bytes that a terminal interprets as
 * commands: colour changes, cursor movement, screen erasure, window titles,
 * hyperlinks, clipboard writes (OSC 52) or device control. This module removes
 * every escape and control sequence before text is measured or rendered.
 *
 * It is streaming-safe: `TerminalSanitizer` holds an incomplete escape sequence
 * across chunk boundaries, so an attacker cannot split OSC 52 over two SSE
 * deltas to bypass per-delta sanitisation.
 */

const ESC = 0x1b;
const BEL = 0x07;
const C1_START = 0x80;
const C1_END = 0x9f;
const DEL = 0x7f;

// Invisible characters used to spoof or reorder text. ZWJ (U+200D) and the
// variation selectors are deliberately kept: emoji sequences need them.
const DROPPED_CODE_POINTS = new Set([
  0x061c, // Arabic letter mark
  0x200b, // zero width space
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e, // bidi embedding/override
  0x2060, // word joiner
  0x2066,
  0x2067,
  0x2068,
  0x2069, // bidi isolates
  0xfeff, // byte order mark
]);

const MAX_PENDING = 4096;

function isControl(code) {
  return code < 0x20 || code === DEL || (code >= C1_START && code <= C1_END);
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Consume one escape sequence starting at `start` (the ESC code unit).
 * Returns the index just past the sequence and whether it was complete.
 */
function scanEscape(text, start) {
  const next = text[start + 1];
  if (next === undefined) return { end: text.length, complete: false };

  if (next === "[") {
    // CSI: parameter and intermediate bytes, then one final byte 0x40-0x7e.
    let index = start + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return { end: index + 1, complete: true };
      if (code === ESC) return { end: index, complete: true };
      index += 1;
    }
    return { end: text.length, complete: false };
  }

  if (next === "]") {
    // OSC: terminated by BEL or ST (ESC \).
    let index = start + 2;
    while (index < text.length) {
      if (text.charCodeAt(index) === BEL) return { end: index + 1, complete: true };
      if (text.charCodeAt(index) === ESC && text[index + 1] === "\\") {
        return { end: index + 2, complete: true };
      }
      index += 1;
    }
    return { end: text.length, complete: false };
  }

  if (next === "P" || next === "X" || next === "^" || next === "_") {
    // DCS, SOS, PM and APC: terminated by ST only.
    let index = start + 2;
    while (index < text.length) {
      if (text.charCodeAt(index) === ESC && text[index + 1] === "\\") {
        return { end: index + 2, complete: true };
      }
      index += 1;
    }
    return { end: text.length, complete: false };
  }

  // Two-character escape (including ESC ( B charset selection and ESC 7/8).
  if (next === "(" || next === ")" || next === "#") {
    if (text[start + 2] === undefined) return { end: text.length, complete: false };
    return { end: start + 3, complete: true };
  }
  return { end: start + 2, complete: true };
}

/**
 * Stateful sanitiser for streaming input. Feed arbitrary chunks; only plain,
 * safe text is returned. `flush()` discards a dangling escape prefix.
 */
export class TerminalSanitizer {
  constructor({ maxPending = MAX_PENDING } = {}) {
    this.pending = "";
    this.maxPending = maxPending;
    this.droppedSequences = 0;
  }

  push(chunk) {
    if (chunk === undefined || chunk === null) return "";
    let text = this.pending + String(chunk);
    this.pending = "";
    let out = "";

    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);

      if (code === ESC) {
        const scan = scanEscape(text, index);
        this.droppedSequences += 1;
        if (!scan.complete) {
          const rest = text.slice(index);
          // An attacker can flood an unterminated sequence; never grow without
          // bound. Dropping it is the safe failure mode.
          this.pending = rest.length <= this.maxPending ? rest : "";
          return out;
        }
        index = scan.end - 1;
        continue;
      }

      if (code === 0x0d) {
        // Normalise CRLF and lone CR to a single newline.
        if (text.charCodeAt(index + 1) === 0x0a) continue;
        out += "\n";
        continue;
      }

      if (code === 0x09) {
        out += "\t";
        continue;
      }

      if (code === 0x0a) {
        out += "\n";
        continue;
      }

      if (isControl(code)) {
        continue;
      }

      if (isHighSurrogate(code)) {
        const low = text.charCodeAt(index + 1);
        if (isLowSurrogate(low)) {
          const point = text.slice(index, index + 2);
          const value = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
          if (!DROPPED_CODE_POINTS.has(value)) out += point;
          index += 1;
          continue;
        }
        out += "\uFFFD";
        continue;
      }

      if (isLowSurrogate(code)) {
        out += "\uFFFD";
        continue;
      }

      if (DROPPED_CODE_POINTS.has(code)) continue;
      if (code === 0x2028 || code === 0x2029) {
        out += "\n";
        continue;
      }
      out += text[index];
    }

    return out;
  }

  flush() {
    // A dangling escape prefix is never displayed.
    this.pending = "";
    return "";
  }
}

/**
 * Sanitise a complete string. `maxChars` bounds terminal memory for a single
 * untrusted payload; the overflow is marked explicitly.
 */
export function sanitizeTerminalText(input, { maxChars = 200_000 } = {}) {
  const text = input === undefined || input === null ? "" : String(input);
  const sanitizer = new TerminalSanitizer();
  let output = sanitizer.push(text);
  output += sanitizer.flush();
  if (output.length > maxChars) {
    const limit = Math.max(0, maxChars);
    output = `${output.slice(0, limit)}\n\u2026 terminal output truncated at ${limit} characters`;
  }
  return output;
}

/** Collapse a value to one safe display line. */
export function sanitizeOneLine(input, { maxChars = 300 } = {}) {
  const text = sanitizeTerminalText(input, { maxChars: Math.max(maxChars * 4, maxChars + 8) });
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > maxChars ? `${line.slice(0, maxChars)}\u2026` : line;
}

/** Remove ANSI sequences only; used to make PTY output assertable. */
export function stripAnsi(input) {
  return sanitizeTerminalText(input, { maxChars: Number.MAX_SAFE_INTEGER });
}
