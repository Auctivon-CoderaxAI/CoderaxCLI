/**
 * Terminal key sequence parser.
 *
 * Raw-mode stdin delivers bytes, not keys, and a single read can contain text,
 * control keys and partial escape sequences. The parser turns chunks into
 * semantic events, keeps an incomplete sequence until the rest arrives, and
 * supports bracketed paste so multi-line paste is never mistaken for submits.
 */

const ESC = "\u001b";

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
