import test from "node:test";
import assert from "node:assert/strict";
import {
  ASCII_FRAMES,
  BRAILLE_FRAMES,
  createWaitIndicator,
  renderWaitFrame,
  selectFrames,
} from "../src/terminal/wait-indicator.js";
import { resolveTerminalProfile } from "../src/terminal/prompt.js";

function fakeStream({ isTTY = true, columns = 40 } = {}) {
  const writes = [];
  return {
    isTTY,
    columns,
    writes,
    write(text) {
      writes.push(text);
    },
    get output() {
      return writes.join("");
    },
  };
}

function fakeTimers() {
  const handles = new Map();
  let nextId = 1;
  return {
    setInterval(fn, ms) {
      const handle = { id: nextId, fn, ms, unref() {} };
      nextId += 1;
      handles.set(handle.id, handle);
      return handle;
    },
    clearInterval(handle) {
      handles.delete(handle.id);
    },
    tick(times = 1) {
      for (let round = 0; round < times; round += 1) {
        for (const handle of [...handles.values()]) handle.fn();
      }
    },
    get size() {
      return handles.size;
    },
  };
}

function ttyProfile(overrides = {}) {
  return resolveTerminalProfile({
    platform: "linux",
    env: { TERM: "xterm-256color" },
    isTTY: true,
    columns: 40,
    ...overrides,
  });
}

test("a non-TTY indicator writes nothing at all", () => {
  const stream = fakeStream({ isTTY: false });
  const timers = fakeTimers();
  const indicator = createWaitIndicator({
    stream,
    isTTY: false,
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });

  indicator.start("thinking").update("still thinking").stop().succeed("done").fail("no");

  assert.equal(stream.output, "");
  assert.equal(timers.size, 0);
  assert.equal(indicator.active, false);
});

test("a TTY indicator paints, animates, and clears on stop", () => {
  const stream = fakeStream();
  const timers = fakeTimers();
  const indicator = createWaitIndicator({
    stream,
    isTTY: true,
    profile: ttyProfile(),
    label: "waiting",
    intervalMs: 25,
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });

  indicator.start();
  assert.equal(indicator.active, true);
  assert.equal(timers.size, 1);
  assert.ok(stream.output.includes(BRAILLE_FRAMES[0]));
  assert.ok(stream.output.includes("waiting"));
  assert.ok(stream.output.startsWith("\r\u001b[2K"));

  const before = stream.writes.length;
  timers.tick();
  assert.equal(stream.writes.length, before + 1);
  assert.ok(stream.writes.at(-1).includes(BRAILLE_FRAMES[1]));

  indicator.stop();
  assert.equal(indicator.active, false);
  assert.equal(timers.size, 0);
  assert.equal(stream.writes.at(-1), "\r\u001b[2K");

  const settled = stream.writes.length;
  indicator.stop();
  assert.equal(stream.writes.length, settled);
});

test("start is idempotent so a second call cannot stack timers", () => {
  const stream = fakeStream();
  const timers = fakeTimers();
  const indicator = createWaitIndicator({
    stream,
    isTTY: true,
    profile: ttyProfile(),
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });

  indicator.start("one").start("two");
  assert.equal(timers.size, 1);
  assert.equal(indicator.label, "two");
  indicator.stop();
});

test("succeed and fail leave one final line and no timer", () => {
  const successStream = fakeStream();
  const successTimers = fakeTimers();
  const success = createWaitIndicator({
    stream: successStream,
    isTTY: true,
    profile: ttyProfile(),
    setIntervalImpl: successTimers.setInterval,
    clearIntervalImpl: successTimers.clearInterval,
  });
  success.start("saving").succeed("saved");
  assert.equal(successTimers.size, 0);
  assert.ok(successStream.output.endsWith("\u2713 saved\r\n"));

  const failureStream = fakeStream();
  const failureTimers = fakeTimers();
  const failure = createWaitIndicator({
    stream: failureStream,
    isTTY: true,
    profile: ttyProfile(),
    setIntervalImpl: failureTimers.setInterval,
    clearIntervalImpl: failureTimers.clearInterval,
  });
  failure.start("saving").fail("save failed");
  assert.ok(failureStream.output.endsWith("\u2717 save failed\r\n"));
});

test("legacy consoles use ASCII frames and ASCII result marks", () => {
  const legacy = resolveTerminalProfile({ platform: "win32", env: {}, isTTY: true });
  assert.deepEqual(selectFrames(legacy), ASCII_FRAMES);

  const stream = fakeStream();
  const timers = fakeTimers();
  const indicator = createWaitIndicator({
    stream,
    isTTY: true,
    profile: legacy,
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });

  indicator.start("working");
  assert.ok(stream.output.includes("- working"));
  indicator.succeed("finished");
  assert.ok(stream.output.endsWith("OK finished\r\n"));
});

test("labels are one sanitized line and are clipped to the terminal width", () => {
  const stream = fakeStream({ columns: 12 });
  const timers = fakeTimers();
  const indicator = createWaitIndicator({
    stream,
    isTTY: true,
    profile: ttyProfile({ columns: 12 }),
    columns: 12,
    label: "line one\nline two\u001b[31m",
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });

  indicator.start();
  assert.equal(indicator.label, "line one line two");
  assert.equal(stream.output.includes("\n"), false);
  assert.equal(stream.output.includes("\u001b[31m"), false);
  assert.ok(stream.writes.at(-1).length <= 12 + "\r\u001b[2K".length);
  indicator.stop();
});

test("renderWaitFrame cycles and clamps", () => {
  assert.equal(renderWaitFrame({ frames: ["a", "b"], index: 2, label: "x", columns: 10 }), "a x");
  assert.equal(renderWaitFrame({ frames: ["a"], index: -1, label: "", columns: 10 }), "a");
  assert.equal(renderWaitFrame({ frames: ["frame"], index: 0, label: "abcdef", columns: 4 }), "fra\u2026");
});
