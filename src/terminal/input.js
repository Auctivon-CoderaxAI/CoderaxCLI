import { KEY_TYPES, createKeyDecoder } from "./keys.js";
import {
  formatPrompt,
  renderPromptLine,
  resolveTerminalProfile,
  stringWidth,
  stripAnsi,
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

function trailingViewport(value, columns) {
  const text = stripAnsi(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  let start = text.length;
  for (const char of [...text].reverse()) {
    columns -= stringWidth(char);
    if (columns < 0) break;
    start -= char.length;
  }
  return text.slice(start);
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
  const queued = [];
  const interrupt = new AbortController();
  let eof = Boolean(input?.readableEnded);
  let pasteEnabled = false;
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
    const room = Math.max(0, width - stringWidth(promptText));
    write(
      `${renderPromptLine({ label, marker, profile: resolved, columns: width })}${trailingViewport(tail, room)}`,
    );
  };

  const settle = (error) => {
    const value = buffer;
    buffer = "";
    if (pending === null) {
      // Type-ahead: a complete line submitted before the caller asked for one
      // is kept for the next readLine instead of being dropped.
      if (!error) queued.push(value);
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
          {
            const error = new PromptCancelledError("interrupted");
            settle(error);
            interrupt.abort(error);
            return;
          }
        case KEY_TYPES.CTRL_D:
          // Ctrl+D leaves a non-empty line alone; on an empty line it ends the
          // session, matching shell and readline behaviour.
          if (buffer === "") {
            write(resolved.eol);
            onEnd();
            return;
          }
          break;
        default:
          // Arrows, Home/End and Tab are not used by this line editor.
          break;
      }
    }
  };

  const onData = (chunk) => {
    if (closed || eof || interrupt.signal.aborted) return;
    handle(decoder.push(chunk));
  };

  const onEnd = () => {
    if (closed || eof) return;
    eof = true;
    settle(new PromptCancelledError("end of input"));
  };

  input?.on?.("data", onData);
  input?.on?.("end", onEnd);
  input?.on?.("error", onEnd);

  /** Resolve with the submitted line, or reject with PromptCancelledError. */
  const readLine = async () => {
    if (closed) throw new PromptCancelledError("reader closed");
    if (interrupt.signal.aborted) throw interrupt.signal.reason;
    if (pending !== null) throw new Error("readLine() is not re-entrant");
    // Completed submissions remain available after EOF.
    if (queued.length > 0) return queued.shift();
    if (eof) throw new PromptCancelledError("end of input");
    if (supportsRawInput(input) && previousRaw === null) {
      previousRaw = Boolean(input.isRaw);
      input.setRawMode(true);
      if (resolved.ansi && typeof output?.write === "function") {
        pasteEnabled = true;
        write("\u001b[?2004h");
      }
    }
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      paint();
      input?.resume?.();
    });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    const active = pending;
    pending = null;
    buffer = "";
    queued.length = 0;
    input?.removeListener?.("data", onData);
    input?.removeListener?.("end", onEnd);
    input?.removeListener?.("error", onEnd);
    if (pasteEnabled) {
      try {
        write("\u001b[?2004l");
      } catch {
        // Output may already have closed; still restore the input stream.
      }
    }
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
    interruptSignal: interrupt.signal,
    readLine,
    close,
  };
}
