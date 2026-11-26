import { createInterface } from "node:readline/promises";
import { clearLine, termWidth, truncate, visibleLength } from "./ansi.js";

/**
 * A small interactive layer over Node's readline. Readline owns cursor
 * movement, history, paste and Tab completion; this class adds Coderax's
 * commands, multiline continuation, list selection and a hidden secret prompt.
 */
export class PromptSession {
  constructor({ input = process.stdin, output = process.stdout, error = process.stderr, history = [], completer, style } = {}) {
    this.input = input;
    this.output = output;
    this.error = error;
    this.style = style;
    this.closed = false;
    this.paused = false;
    this.suspended = false;
    this.currentQuestion = null;
    this.readline = createInterface({
      input,
      output,
      terminal: Boolean(input.isTTY && output.isTTY),
      history: history.slice(-200),
      historySize: 200,
      removeHistoryDuplicates: true,
      completer: completer ? (line) => completer(line) : undefined,
    });
    this.readline.on("SIGINT", () => {
      this.interrupted = true;
      this.readline.close();
    });
  }

  get terminal() {
    return Boolean(this.input.isTTY && this.output.isTTY);
  }

  pause() {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.readline.pause();
  }

  resume() {
    if (!this.paused || this.closed) return;
    this.paused = false;
    this.readline.resume();
  }

  async ask(prompt) {
    if (this.closed) throw Object.assign(new Error("input closed"), { code: "INPUT_CLOSED" });
    this.interrupted = false;
    try {
      const answer = await this.readline.question(prompt);
      return answer;
    } catch (error) {
      if (this.interrupted) {
        throw Object.assign(new Error("cancelled"), { code: "CANCELLED" });
      }
      if (error?.code === "ERR_USE_AFTER_CLOSE") {
        throw Object.assign(new Error("input closed"), { code: "INPUT_CLOSED" });
      }
      throw error;
    }
  }

  /**
   * Multiline input: a trailing backslash continues; in multiline mode a blank
   * line submits, so a pasted block or a considered prompt stays one message.
   */
  async message({ prompt = "> ", continuation = "\u2026 ", multiline = false } = {}) {
    const lines = [];
    for (;;) {
      const line = await this.ask(lines.length === 0 ? prompt : continuation);
      if (multiline) {
        if (line.trim() === "" && lines.length > 0) break;
        lines.push(line);
        continue;
      }
      if (line.endsWith("\\")) {
        lines.push(line.slice(0, -1));
        continue;
      }
      lines.push(line);
      break;
    }
    return lines.join("\n").trim();
  }

  async secret(prompt = "Owner token: ") {
    if (!this.terminal || typeof this.input.setRawMode !== "function") {
      const value = await this.ask(prompt);
      return value.trim();
    }
    this.readline.pause();
    this.output.write(prompt);
    this.input.setRawMode(true);
    this.input.resume();
    this.input.setEncoding("utf8");
    return new Promise((resolve, reject) => {
      let value = "";
      const onData = (chunk) => {
        for (const char of String(chunk)) {
          if (char === "\r" || char === "\n") {
            cleanup();
            this.output.write("\n");
            resolve(value.trim());
            return;
          }
          if (char === "\u0003") {
            cleanup();
            this.output.write("\n");
            reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
            return;
          }
          if (char === "\u007f" || char === "\b") {
            value = [...value].slice(0, -1).join("");
            continue;
          }
          if (char === "\u001b") continue;
          value += char;
        }
      };
      const cleanup = () => {
        this.input.removeListener("data", onData);
        this.input.setRawMode(false);
        this.input.pause();
        this.readline.resume();
      };
      this.input.on("data", onData);
    });
  }

  /**
   * Numbered selection. In a non-interactive shell the caller must name the
   * value; an interactive prompt never guesses.
   */
  async select({
    title,
    items,
    render = (item) => String(item.label ?? item),
    label = "Select",
    allowCancel = true,
    defaultIndex = 0,
  } = {}) {
    if (!Array.isArray(items) || items.length === 0) return null;
    this.output.write(`${this.style?.bold(title ?? label) ?? title ?? label}\n`);
    items.forEach((item, index) => {
      const marker = index === defaultIndex ? this.style?.cyan("\u276f") ?? ">" : " ";
      this.output.write(` ${marker} ${String(index + 1).padStart(2)}. ${render(item)}\n`);
    });
    for (;;) {
      const answer = (await this.ask(`${label} [1-${items.length}${allowCancel ? ", q" : ""}]: `)).trim();
      if (answer === "" ) return items[defaultIndex] ?? null;
      if (allowCancel && (answer === "q" || answer === "quit" || answer === "cancel")) return null;
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= items.length) return items[index - 1];
      const byName = items.find((item) => String(item.id ?? item.value ?? item.label ?? "").toLowerCase() === answer.toLowerCase());
      if (byName) return byName;
      this.output.write(`${this.style?.yellow("\u26a0") ?? "!"} Choose a number between 1 and ${items.length}.\n`);
    }
  }

  async confirm(question, { defaultYes = false } = {}) {
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    const answer = (await this.ask(`${question} ${suffix} `)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return answer === "y" || answer === "yes";
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.readline.close();
    } catch {
      // Already closed.
    }
  }
}

/** A transient status line on stderr; never contaminates stdout or JSON. */
export class Spinner {
  constructor({ stream = process.stderr, style, text = "working", intervalMs = 90 } = {}) {
    this.stream = stream;
    this.style = style;
    this.text = text;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.frame = 0;
    this.startedAt = 0;
    this.active = false;
    this.frames = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
  }

  start(text) {
    if (text) this.text = text;
    if (this.active) return this;
    this.active = true;
    this.startedAt = Date.now();
    if (!this.stream?.isTTY) return this;
    this.timer = setInterval(() => this.#render(), this.intervalMs);
    this.timer.unref?.();
    this.#render();
    return this;
  }

  setText(text) {
    this.text = text;
    if (this.active) this.#render();
  }

  #render() {
    if (!this.stream?.isTTY) return;
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const frame = this.frames[this.frame % this.frames.length];
    this.frame += 1;
    const line = `${this.style?.cyan(frame) ?? frame} ${this.text} ${this.style?.dim(`${elapsed}s`) ?? `${elapsed}s`}`;
    clearLine(this.stream);
    this.stream.write(truncate(line, termWidth(this.stream)));
    this.stream.write("\r");
  }

  stop(finalText) {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream?.isTTY) {
      clearLine(this.stream);
      if (finalText) this.stream.write(`${finalText}\n`);
    } else if (finalText) {
      this.stream.write(`${finalText}\n`);
    }
  }
}

export function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function cursorWidth(prompt) {
  return visibleLength(prompt);
}
