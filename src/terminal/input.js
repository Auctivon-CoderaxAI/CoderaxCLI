import { KEY_TYPES, createKeyDecoder } from "./keys.js";
import {
  formatPrompt,
  renderPromptLine,
  resolveTerminalProfile,
  stringWidth,
  truncateToWidth,
} from "./prompt.js";

/**
 * Interactive line reader for the chat prompt.
 *
 * Readline treats every newline as a submission, which makes Ctrl+J (a newline
 * inside the current message) impossible to express. This reader consumes the
 * byte-level events from `keys.js` instead, so Enter submits and Ctrl+J inserts
 * a newline. Rendering is delegated to `prompt.js`, which keeps ANSI, line
 * clearing and width handling consistent with the rest of the terminal.
 *
 * Raw mode is only entered when the input stream can support it; the caller
 * keeps the readline path for anything else, so piped and non-TTY sessions are
 * unaffected.
 */
export class PromptCancelledError extends Error {
  constructor(message = "prompt cancelled") {
    super(message);
    this.name = "PromptCancelledError";
    this.code = "CANCELLED";
  }
}

export function supportsRawInput(stream) {
  return Boolean(
    stream?.isTTY && typeof stream.setRawMode === "function" && typeof stream.on === "function",
  );
}

function dropLastWord(value) {
  const trimmed = value.replace(/\s+$/, "");
  const cut = trimmed.search(/\S+$/);
  if (cut === -1) return "";
  return trimmed.slice(0, cut);
}

export function createInteractiveReader({
  input = process.stdin,
  output = process.stdout,
  profile,
  label = "coderax",
  marker = ">",
  columns,
} = {}) {
  const resolved =
    profile ??
    resolveTerminalProfile({
      isTTY: Boolean(output?.isTTY),
      columns: columns ?? output?.columns ?? null,
    });
  const width = Math.max(1, Number(columns ?? resolved.columns) || 80);
  const promptText = formatPrompt({ label, marker, profile: resolved });
  // A lone CR is Enter here: nothing follows it in an interactive terminal.
  const decoder = createKeyDecoder({ chunkEol: true });

  let buffer = "";
  let queued = null;
  let pending = null;
  let closed = false;
  let previousRaw = null;

  const write = (text) => {
    if (text === "" || typeof output?.write !== "function") return;
    output.write(text);
  };

  const paint = () => {
    if (!resolved.isTTY) return;
    // Only the last physical line is echoed; the full multi-line buffer is
    // still what Enter submits.
    const tail = buffer.slice(buffer.lastIndexOf("\n") + 1);
    const room = Math.max(1, width - stringWidth(promptText));
    write(
      `${renderPromptLine({ label, marker, profile: resolved, columns: width })}${truncateToWidth(
        tail,
        room,
        "",
      )}`,
    );
  };

  const settle = (error) => {
    const value = buffer;
    buffer = "";
    if (pending === null) {
      // Type-ahead: a complete line submitted before the caller asked for one
      // is kept for the next readLine instead of being dropped.
      if (!error && queued === null) queued = value;
      return;
    }
    const { resolve, reject } = pending;
    pending = null;
    if (error) reject(error);
    else resolve(value);
  };

  const handle = (events) => {
    for (const event of events) {
      switch (event.type) {
        case KEY_TYPES.TEXT:
        case KEY_TYPES.PASTE:
          buffer += event.text;
          if (pending) paint();
          break;
        case KEY_TYPES.SOFT_NEWLINE:
          buffer += "\n";
          if (pending) paint();
          break;
        case KEY_TYPES.BACKSPACE: {
          const chars = [...buffer];
          chars.pop();
          buffer = chars.join("");
          if (pending) paint();
          break;
        }
        case KEY_TYPES.CTRL_U:
          buffer = "";
          if (pending) paint();
          break;
        case KEY_TYPES.CTRL_W:
          buffer = dropLastWord(buffer);
          if (pending) paint();
          break;
        case KEY_TYPES.ENTER:
          write(resolved.eol);
          settle(null);
          break;
        case KEY_TYPES.CTRL_C:
          write(resolved.eol);
          settle(new PromptCancelledError("interrupted"));
          break;
        case KEY_TYPES.CTRL_D:
          // Ctrl+D leaves a non-empty line alone; on an empty line it ends the
          // session, matching shell and readline behaviour.
          if (buffer === "") {
            write(resolved.eol);
            settle(new PromptCancelledError("end of input"));
          }
          break;
        default:
          // Arrows, Home/End and Tab are not used by this line editor.
          break;
      }
    }
  };

  const onData = (chunk) => {
    if (closed) return;
    handle(decoder.push(chunk));
  };

  const onEnd = () => {
    if (!closed) settle(new PromptCancelledError("end of input"));
  };

  input?.on?.("data", onData);
  input?.on?.("end", onEnd);

  /** Resolve with the submitted line, or reject with PromptCancelledError. */
  const readLine = () => {
    if (closed) return Promise.reject(new PromptCancelledError("reader closed"));
    if (pending !== null) return Promise.reject(new Error("readLine() is not re-entrant"));
    if (queued !== null) {
      const line = queued;
      queued = null;
      return Promise.resolve(line);
    }
    if (supportsRawInput(input) && previousRaw === null) {
      previousRaw = Boolean(input.isRaw);
      input.setRawMode(true);
    }
    input?.resume?.();
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      paint();
    });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    const active = pending;
    pending = null;
    buffer = "";
    queued = null;
    input?.removeListener?.("data", onData);
    input?.removeListener?.("end", onEnd);
    if (previousRaw !== null) {
      try {
        input.setRawMode(Boolean(previousRaw));
      } catch {
        // The terminal may already be gone; nothing to restore.
      }
      previousRaw = null;
    }
    input?.pause?.();
    active?.reject(new PromptCancelledError("reader closed"));
  };

  return {
    get profile() {
      return resolved;
    },
    get prompt() {
      return promptText;
    },
    get pending() {
      return pending !== null;
    },
    readLine,
    close,
  };
}
