/**
 * TTY wiring for the interactive session.
 *
 * This module owns raw mode, key parsing, resize events and the accessible
 * line-oriented fallback. The session itself is transport-agnostic and fully
 * testable without a terminal.
 */

import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { KeyParser, sanitizePaste } from "./terminal/keys.js";
import { Editor } from "./terminal/editor.js";
import { InteractiveSession } from "./terminal/session.js";
import { TerminalRenderer } from "./terminal/renderer.js";
import { ConversationStore, PromptHistory, historyPathFor, normalizeHistorySettings } from "./terminal/history.js";
import { supportsColor, createTheme } from "./terminal/theme.js";
import { createTransport } from "./sdk.js";
import { CoderaxError } from "./client.js";

class EventQueue {
  constructor() {
    this.events = [];
    this.waiters = [];
    this.closed = false;
  }

  push(event) {
    if (this.closed) return;
    if (event === null) {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.events.push(event);
  }

  next() {
    if (this.events.length > 0) return Promise.resolve(this.events.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}

function attachRawInput({ stdin, queue, parser }) {
  const onData = (chunk) => {
    for (const event of parser.push(chunk)) {
      if (event.type === "paste") {
        queue.push({ type: "paste", text: sanitizePaste(event.text) });
      } else {
        queue.push(event);
      }
    }
  };
  const onEnd = () => queue.push(null);
  const onError = () => queue.push(null);
  stdin.setRawMode?.(true);
  stdin.resume?.();
  stdin.setEncoding?.("utf8");
  stdin.on("data", onData);
  stdin.on("end", onEnd);
  stdin.on("error", onError);
  return {
    cleanup() {
      stdin.off?.("data", onData);
      stdin.off?.("end", onEnd);
      stdin.off?.("error", onError);
      stdin.setRawMode?.(false);
      stdin.pause?.();
    },
  };
}

function attachLineInput({ stdin, stdout, queue }) {
  // Accessible mode relies on the terminal's own line editor and echo, which is
  // what screen readers expect. Menus and approvals are answered with numbers.
  const readline = createInterface({ input: stdin, output: stdout, terminal: true });
  readline.on("line", (line) => {
    if (line !== "") queue.push({ type: "text", text: line });
    queue.push({ type: "key", name: "enter" });
  });
  readline.on("close", () => queue.push(null));
  return {
    cleanup() {
      readline.close();
    },
  };
}

function attachResize({ stdout, queue }) {
  const onResize = () => {
    queue.push({ type: "resize", columns: stdout.columns || 80 });
  };
  stdout.on?.("resize", onResize);
  const onSignal = () => onResize();
  if (process.platform !== "win32") process.on?.("SIGWINCH", onSignal);
  return {
    cleanup() {
      stdout.off?.("resize", onResize);
      if (process.platform !== "win32") process.off?.("SIGWINCH", onSignal);
    },
  };
}

/**
 * @param {object} options
 * @param {object} options.settings resolved CLI settings (`baseUrl`, `token`, `configPath`, ...)
 * @param {"chat"|"work"} options.mode
 * @param {object} [options.env]
 * @param {object} [options.stdin]
 * @param {object} [options.stdout]
 * @param {boolean} [options.accessible]
 * @param {boolean} [options.noColor]
 * @param {string|boolean} [options.resume]
 * @param {boolean} [options.noHistory]
 * @param {Function} [options.sdkLoader]
 * @param {Function} [options.legacyFactory]
 */
export async function runInteractive({
  settings,
  mode = "chat",
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  accessible = false,
  noColor = false,
  resume = false,
  noHistory = false,
  sdkLoader,
  legacyFactory,
} = {}) {
  if (!stdin?.isTTY || !stdout?.isTTY) {
    throw new CoderaxError(
      "USAGE",
      "interactive mode requires a terminal; pass a prompt, pipe stdin, or run in a real terminal",
    );
  }
  if (!settings?.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no deployment configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  if (!settings.token) {
    throw new CoderaxError("UNAUTHENTICATED", "not signed in; run `coderax login` first");
  }

  const historySettings = normalizeHistorySettings(settings.history ?? {}, {
    ...env,
    ...(noHistory ? { CODERAX_HISTORY: "off" } : {}),
  });
  const history = await PromptHistory.open({
    path: historyPathFor(settings.configPath, env),
    settings: historySettings,
  });
  const conversations = await ConversationStore.open({
    path: join(dirname(settings.configPath), "conversations.json"),
    enabled: historySettings.enabled,
  });

  let initial = {
    mode: mode === "work" ? "work" : "chat",
    model: settings.model ?? "",
    agent: settings.agent ?? "",
    conversationId: null,
  };
  if (typeof resume === "string" && resume !== "") {
    const entry = conversations.find(resume);
    if (!entry) {
      throw new CoderaxError("RESUME_NOT_FOUND", `no saved conversation matches ${resume}`);
    }
    initial = {
      mode: entry.mode,
      model: entry.model || initial.model,
      agent: entry.agent || initial.agent,
      conversationId: entry.conversationId ?? entry.id,
    };
  }

  const color = !noColor && !accessible && supportsColor({ env, stream: stdout });
  const renderer = new TerminalRenderer({
    write: (text) => stdout.write(text),
    width: stdout.columns || 80,
    mode: accessible ? "accessible" : "interactive",
    theme: createTheme({ color, accessible }),
  });

  const sdk = await createTransport({
    settings: { ...settings, fetchImpl: settings.fetchImpl },
    env,
    loadModule: sdkLoader,
    legacyFactory,
  });

  const queue = new EventQueue();
  const parser = new KeyParser();
  const input = accessible
    ? attachLineInput({ stdin, stdout, queue })
    : attachRawInput({ stdin, queue, parser });
  const resize = attachResize({ stdout, queue });

  const session = new InteractiveSession({
    transport: sdk.transport,
    renderer,
    editor: new Editor(),
    history,
    conversations,
    ...initial,
    cwd: settings.cwd ?? process.cwd(),
  });

  let code = 0;
  try {
    code = await session.run({ nextEvent: () => queue.next() });
  } finally {
    resize.cleanup();
    input.cleanup();
    queue.close();
    parser.flush();
  }
  return code;
}

export { EventQueue };
