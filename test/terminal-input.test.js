import test from "node:test";
import assert from "node:assert/strict";
import {
  PromptCancelledError,
  createInteractiveReader,
  supportsRawInput,
} from "../src/terminal/input.js";
import { resolveTerminalProfile } from "../src/terminal/prompt.js";

function fakeInput() {
  const listeners = new Map();
  const stream = {
    isTTY: true,
    isRaw: false,
    setRawMode(value) {
      this.isRaw = value;
    },
    resume() {},
    pause() {},
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    removeListener(event, fn) {
      listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== fn));
    },
    emit(event, value) {
      for (const fn of listeners.get(event) ?? []) fn(value);
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length;
    },
  };
  return stream;
}

function fakeOutput({ isTTY = true } = {}) {
  const written = [];
  return {
    isTTY,
    columns: 40,
    write: (text) => written.push(text),
    output: () => written.join(""),
  };
}

function makeReader(options = {}) {
  const input = fakeInput();
  const output = fakeOutput(options.output);
  const reader = createInteractiveReader({
    input,
    output,
    profile: resolveTerminalProfile({
      platform: "linux",
      env: { TERM: "xterm-256color" },
      isTTY: output.isTTY,
      columns: 40,
    }),
    label: "coderax",
    ...options.reader,
  });
  return { input, output, reader };
}

test("raw mode is only claimed on a TTY that can provide it", () => {
  assert.equal(supportsRawInput(fakeInput()), true);
  assert.equal(supportsRawInput({ isTTY: false, on() {}, setRawMode() {} }), false);
  assert.equal(supportsRawInput({ isTTY: true, on() {} }), false);
  assert.equal(supportsRawInput(null), false);
});

test("Ctrl+J inserts a newline and Enter submits the whole message", async () => {
  const { input, output, reader } = makeReader();
  const line = reader.readLine();
  assert.equal(input.isRaw, true, "readLine must enter raw mode");
  input.emit("data", Buffer.from("hello\nworld\r"));
  assert.equal(await line, "hello\nworld");
  assert.match(output.output(), /coderax> /);
  reader.close();
});

test("backspace editing and Ctrl+U work before submitting", async () => {
  const { input, reader } = makeReader();
  const line = reader.readLine();
  input.emit("data", Buffer.from("abc\u007f"));

  const cleared = reader.readLine.bind(reader);
  input.emit("data", Buffer.from("\u0015xyz\r"));
  assert.equal(await line, "xyz");

  const second = cleared();
  input.emit("data", Buffer.from("\r"));
  assert.equal(await second, "");
  reader.close();
});

test("Ctrl+C and Ctrl+D on an empty line cancel the prompt", async () => {
  const cancelled = makeReader();
  const first = cancelled.reader.readLine();
  cancelled.input.emit("data", Buffer.from("\u0003"));
  await assert.rejects(first, (error) => error instanceof PromptCancelledError && error.code === "CANCELLED");
  cancelled.reader.close();

  const eof = makeReader();
  const second = eof.reader.readLine();
  eof.input.emit("data", Buffer.from("\u0004"));
  await assert.rejects(second, { code: "CANCELLED" });
  eof.reader.close();
});

test("Ctrl+D leaves a non-empty line alone", async () => {
  const { input, reader } = makeReader();
  const line = reader.readLine();
  input.emit("data", Buffer.from("kept\u0004\r"));
  assert.equal(await line, "kept");
  reader.close();
});

test("a line typed before readLine is queued instead of dropped", async () => {
  const { input, reader } = makeReader();
  input.emit("data", Buffer.from("/exit\r"));
  assert.equal(await reader.readLine(), "/exit");
  reader.close();
});

test("close restores raw mode, detaches listeners and cancels a pending line", async () => {
  const { input, reader } = makeReader();
  input.isRaw = true;
  const pending = reader.readLine();
  reader.close();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(input.isRaw, true, "the previous raw-mode state must be restored");
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  await assert.rejects(reader.readLine(), { code: "CANCELLED" });
});
