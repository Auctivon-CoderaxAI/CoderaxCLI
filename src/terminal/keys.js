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

export function createKeyDecoder({ bracketedPaste = true } = {}) {
  const utf8 = new StringDecoder("utf8");
  let pendingCR = false;
  let escape = "";
  let paste = null;
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
    const text = normalizePaste(paste);
    paste = null;
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
      paste += char;
      if (paste.endsWith(PASTE_END)) {
        paste = paste.slice(0, -PASTE_END.length);
        emitPaste(events);
      } else if (paste.length > MAX_PASTE_LENGTH) {
        emitPaste(events);
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
