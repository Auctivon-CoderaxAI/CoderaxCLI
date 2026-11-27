import { StringDecoder } from "node:string_decoder";

/**
 * Byte-level key decoding for interactive prompts.
 *
 * The distinction that matters for multi-line input:
 *
 * - Enter sends CR (`\r`, 0x0D) in a raw terminal, sometimes CRLF (`\r\n`)
 *   through Windows ConPTY or a paste.
 * - Ctrl+J sends LF (`\n`, 0x0A) and is a request for a newline inside the
 *   current input, not a submission.
 * - Ctrl+M is CR, so it is indistinguishable from Enter by definition and is
 *   reported as Enter rather than guessed.
 *
 * A decoder instance buffers a trailing CR and an incomplete escape sequence
 * across chunks, so a split UTF-8 or CRLF sequence is never misread.
 *
 * Interactive readers pass `chunkEol: true`: a terminal delivers Enter as a
 * lone CR with nothing after it, so the CR must be resolved at the end of each
 * chunk instead of waiting for the next keystroke. A CRLF split across chunks
 * then reads as Enter plus a soft newline, which an input buffer handles as an
 * empty line.
 */
export const KEY_TYPES = Object.freeze({
  TEXT: "text",
  ENTER: "enter",
  SOFT_NEWLINE: "ctrl+j",
  BACKSPACE: "backspace",
  TAB: "tab",
  CTRL_C: "ctrl+c",
  CTRL_D: "ctrl+d",
  CTRL_U: "ctrl+u",
  CTRL_W: "ctrl+w",
  ESCAPE: "escape",
  PASTE: "paste",
});

const ESC = "\u001b";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const MAX_ESCAPE_LENGTH = 32;
const MAX_PASTE_LENGTH = 1024 * 1024;

function appendText(events, text) {
  if (text === "") return;
  const last = events[events.length - 1];
  if (last && last.type === KEY_TYPES.TEXT) {
    last.text += text;
    return;
  }
  events.push({ type: KEY_TYPES.TEXT, text });
}

function normalizePaste(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isEscapeComplete(sequence) {
  if (sequence.length < 2) return false;
  if (sequence === ESC) return false;
  if (sequence[1] === "[") {
    // CSI: parameter bytes 0x30-0x3F, intermediates 0x20-0x2F, final 0x40-0x7E.
    for (let index = 2; index < sequence.length; index += 1) {
      const code = sequence.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return true;
      if (code < 0x20 || code > 0x3f) return true;
    }
    return false;
  }
  if (sequence[1] === "O") {
    return sequence.length >= 3 && sequence.charCodeAt(2) >= 0x40 && sequence.charCodeAt(2) <= 0x7e;
  }
  // Alt+<key> is ESC followed by one character.
  return true;
}

export function createKeyDecoder({ bracketedPaste = true, chunkEol = false } = {}) {
  const utf8 = new StringDecoder("utf8");
  let pendingCR = false;
  let escape = "";
  let paste = null;
  let discardPaste = false;
  let pasteTail = "";
  let ended = false;

  const handleEscape = (sequence, events) => {
    escape = "";
    if (bracketedPaste && sequence === PASTE_START) {
      paste = "";
      return;
    }
    events.push({ type: KEY_TYPES.ESCAPE, sequence });
  };

  const emitPaste = (events) => {
    if (paste === null) return;
    const text = !discardPaste && paste.length <= MAX_PASTE_LENGTH ? normalizePaste(paste) : "";
    paste = null;
    discardPaste = false;
    pasteTail = "";
    if (text !== "") events.push({ type: KEY_TYPES.PASTE, text });
  };

  const processChar = (char, events) => {
    if (pendingCR) {
      pendingCR = false;
      events.push({ type: KEY_TYPES.ENTER });
      // CRLF is one keypress, not Enter followed by Ctrl+J.
      if (char === "\n") return;
    }

    if (paste !== null) {
      pasteTail += char;
      if (!discardPaste) paste += char;
      if (pasteTail.endsWith(PASTE_END)) {
        if (!discardPaste) paste = paste.slice(0, -PASTE_END.length);
        emitPaste(events);
      } else {
        pasteTail = pasteTail.slice(1 - PASTE_END.length);
        if (paste.length >= MAX_PASTE_LENGTH + PASTE_END.length) {
          // Discard the payload, but continue matching the closing delimiter.
          discardPaste = true;
          paste = "";
        }
      }
      return;
    }

    if (escape !== "") {
      escape += char;
      if (isEscapeComplete(escape) || escape.length > MAX_ESCAPE_LENGTH) {
        handleEscape(escape, events);
      }
      return;
    }

    switch (char) {
      case "\r":
        pendingCR = true;
        return;
      case "\n":
        events.push({ type: KEY_TYPES.SOFT_NEWLINE });
        return;
      case "\u0003":
        events.push({ type: KEY_TYPES.CTRL_C });
        return;
      case "\u0004":
        events.push({ type: KEY_TYPES.CTRL_D });
        return;
      case "\u0008":
      case "\u007f":
        events.push({ type: KEY_TYPES.BACKSPACE });
        return;
      case "\t":
        events.push({ type: KEY_TYPES.TAB });
        return;
      case "\u0015":
        events.push({ type: KEY_TYPES.CTRL_U });
        return;
      case "\u0017":
        events.push({ type: KEY_TYPES.CTRL_W });
        return;
      case ESC:
        escape = ESC;
        return;
      default:
        appendText(events, char);
    }
  };

  /** Flush a trailing CR, an incomplete escape, a paste, or unused bytes. */
  const flush = () => {
    const events = [];
    if (pendingCR) {
      pendingCR = false;
      events.push({ type: KEY_TYPES.ENTER });
    }
    if (escape !== "") {
      const sequence = escape;
      escape = "";
      events.push({ type: KEY_TYPES.ESCAPE, sequence });
    }
    emitPaste(events);
    return events;
  };

  /** Feed one chunk (string or Buffer) and return the completed key events. */
  const push = (chunk, { final = false } = {}) => {
    if (ended) return [];
    const text = typeof chunk === "string" ? chunk : utf8.write(chunk);
    const events = [];
    for (const char of text) processChar(char, events);
    if (chunkEol && pendingCR) {
      pendingCR = false;
      events.push({ type: KEY_TYPES.ENTER });
    }
    if (final) events.push(...flush());
    return events;
  };

  /** Finish the stream, including any buffered UTF-8 tail. */
  const end = () => {
    if (ended) return [];
    const decoded = utf8.end();
    const events = decoded === "" ? [] : push(decoded);
    ended = true;
    return [...events, ...flush()];
  };

  return { push, flush, end };
}

/** Decode one complete chunk. Use createKeyDecoder for streaming input. */
export function decodeKeys(chunk, options = {}) {
  const decoder = createKeyDecoder(options);
  return [...decoder.push(chunk, { final: true }), ...decoder.end()];
}

/**
 * Terminal key sequence parser.
 *
 * Raw-mode stdin delivers bytes, not keys, and a single read can contain text,
 * control keys and partial escape sequences. The parser turns chunks into
 * semantic events, keeps an incomplete sequence until the rest arrives, and
 * supports bracketed paste so multi-line paste is never mistaken for submits.
 */

const CSI_KEYS = Object.freeze({
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "tab",
  "~": null,
});

function modifierFrom(parameter) {
  const value = Number(parameter);
  const modifiers = { 2: "shift", 3: "alt", 4: "shiftAlt", 5: "ctrl", 6: "ctrlShift", 7: "ctrlAlt", 8: "ctrlShiftAlt" };
  return modifiers[value] ?? null;
}

function applyModifiers(event, modifier) {
  if (modifier === null) return event;
  const next = { ...event };
  if (modifier.includes("Shift") || modifier.includes("shift")) next.shift = true;
  if (/Alt|alt/.test(modifier)) next.alt = true;
  if (/Ctrl|ctrl/.test(modifier)) next.ctrl = true;
  return next;
}

/**
 * Parse a complete CSI sequence body (without ESC [).
 */
function parseCsi(body) {
  if (body === "") return null;
  if (CSI_KEYS[body] !== undefined) {
    const name = CSI_KEYS[body];
    return name === null ? null : { type: "key", name };
  }

  // Bracketed paste start/end are handled by the caller.
  if (body === "200~" || body === "201~") return null;

  const match = /^(\d+)(?:;(\d+))?([~ABCDHFZ])$/.exec(body);
  if (!match) return null;
  const [, number, modifierValue, final] = match;
  const modifier = modifierFrom(modifierValue);

  if (final === "~") {
    const named = {
      1: "home",
      2: "insert",
      3: "delete",
      4: "end",
      5: "pageup",
      6: "pagedown",
      7: "home",
      8: "end",
      11: "f1",
      12: "f2",
      13: "f3",
      14: "f4",
    }[number];
    return named ? applyModifiers({ type: "key", name: named }, modifier) : null;
  }

  const named = CSI_KEYS[final];
  if (!named) return null;
  return applyModifiers({ type: "key", name: named }, modifier);
}

function controlEvent(code) {
  if (code === 0x0d) return { type: "key", name: "enter" };
  if (code === 0x0a) return { type: "key", name: "enter", ctrl: true };
  if (code === 0x09) return { type: "key", name: "tab" };
  if (code === 0x7f || code === 0x08) return { type: "key", name: "backspace" };
  if (code === 0x00) return { type: "key", name: "space", ctrl: true };
  if (code >= 0x01 && code <= 0x1a) {
    return { type: "key", name: String.fromCharCode(96 + code), ctrl: true };
  }
  return null;
}

export class KeyParser {
  constructor() {
    this.pending = "";
    this.pasting = false;
    this.paste = "";
    this.invalid = 0;
  }

  _emitText(events, text) {
    if (text === "") return;
    // Split any control characters that slipped through. This is a last line of
    // defence; the terminal reader also strips them.
    let run = "";
    for (const char of text) {
      const code = char.codePointAt(0);
      if (code < 0x20 || code === 0x7f) {
        if (run) events.push({ type: "text", text: run });
        run = "";
        const event = controlEvent(code);
        if (event) events.push(event);
      } else {
        run += char;
      }
    }
    if (run) events.push({ type: "text", text: run });
  }

  push(chunk) {
    const events = [];
    let text = this.pending + String(chunk ?? "");
    this.pending = "";
    let index = 0;

    while (index < text.length) {
      if (this.pasting) {
        const end = text.indexOf(`${ESC}[201~`, index);
        if (end === -1) {
          this.paste += text.slice(index);
          index = text.length;
          break;
        }
        this.paste += text.slice(index, end);
        index = end + 6;
        const pasted = this.paste;
        this.paste = "";
        this.pasting = false;
        events.push({ type: "paste", text: pasted });
        continue;
      }

      const char = text[index];
      const code = text.charCodeAt(index);

      if (char === ESC) {
        const next = text[index + 1];
        if (next === undefined) {
          this.pending = text.slice(index);
          index = text.length;
          break;
        }
        if (next === "[") {
          // Find the final byte.
          let end = index + 2;
          while (end < text.length && !/[@-~]/.test(text[end])) end += 1;
          if (end >= text.length) {
            this.pending = text.slice(index);
            index = text.length;
            break;
          }
          const body = text.slice(index + 2, end + 1);
          index = end + 1;

          if (body === "200~") {
            this.pasting = true;
            this.paste = "";
            continue;
          }
          if (body === "201~") continue;
          const event = parseCsi(body);
          if (event) events.push(event);
          else this.invalid += 1;
          continue;
        }
        if (next === "O") {
          // SS3 application cursor keys.
          const key = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" }[text[index + 2]];
          if (key) events.push({ type: "key", name: key });
          else this.invalid += 1;
          index += 3;
          continue;
        }
        // Alt+key.
        const altCode = text.charCodeAt(index + 1);
        if (altCode === 0x0d) {
          events.push({ type: "key", name: "enter", alt: true });
          index += 2;
          continue;
        }
        if (altCode < 0x20) {
          const event = controlEvent(altCode);
          if (event) events.push({ ...event, alt: true });
          index += 2;
          continue;
        }
        const altChar = String.fromCodePoint(text.codePointAt(index + 1));
        events.push({ type: "key", name: "alt", char: altChar });
        index += 1 + altChar.length;
        continue;
      }

      if (code < 0x20 || code === 0x7f) {
        const event = controlEvent(code);
        if (event) events.push(event);
        index += 1;
        continue;
      }

      // Collect printable text until the next control or escape byte.
      let end = index;
      while (end < text.length) {
        const current = text.charCodeAt(end);
        if (current < 0x20 || current === 0x7f || text[end] === ESC) break;
        end += 1;
      }
      this._emitText(events, text.slice(index, end));
      index = end;
    }

    return events;
  }

  flush() {
    const events = [];
    if (this.pasting) {
      // An unterminated paste is still data; it is bounded by the editor.
      events.push({ type: "paste", text: this.paste });
      this.pasting = false;
      this.paste = "";
    }
    if (this.pending === ESC) events.push({ type: "key", name: "escape" });
    this.pending = "";
    return events;
  }
}

/** Split a paste into safe text: no NULs or escape sequences. */
export function sanitizePaste(text) {
  return String(text ?? "")
    .replace(/\u001b\[201~/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}
