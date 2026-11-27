import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownRenderer } from "../src/terminal/markdown.js";
import { Editor } from "../src/terminal/editor.js";
import { PromptHistory } from "../src/terminal/history.js";
import { TerminalRenderer } from "../src/terminal/renderer.js";
import { createTheme } from "../src/terminal/theme.js";
import { InteractiveSession } from "../src/terminal/session.js";

test("a multi-megabyte stream is rendered with bounded buffers and a truncation notice", () => {
  const renderer = new MarkdownRenderer({ width: 80, maxRenderedChars: 50_000 });
  const chunk = "word ".repeat(20) + "\n";
  let lines = 0;
  for (let index = 0; index < 1200; index += 1) {
    lines += renderer.feed(chunk).length;
    if (renderer.truncated) break;
  }
  assert.equal(renderer.truncated, true);
  assert.equal(renderer.stats.bufferChars <= renderer.maxBufferChars, true);
  assert.equal(lines > 0, true);
});

test("the interactive block, tool ring and editor are capped", async () => {
  const output = [];
  const renderer = new TerminalRenderer({
    write: (text) => output.push(text),
    width: 80,
    theme: createTheme({ color: false }),
    maxBlockLines: 40,
  });
  const editor = new Editor({ maxChars: 1000, maxLines: 10 });
  const transport = {
    kind: "test",
    capabilities: { verifiedPermissions: false },
    async stream({ onEvent }) {
      for (let index = 0; index < 500; index += 1) onEvent({ type: "tool", name: `t${index}`, status: "ok" });
      onEvent({ type: "delta", text: `${"line\n".repeat(5000)}` });
      return { text: "done", conversationId: null };
    },
    async respondPermission() {},
    async close() {},
  };
  const session = new InteractiveSession({
    transport,
    renderer,
    editor,
    setIntervalFn: null,
    maxToolEvents: 25,
  });
  session.running = true;
  await session.handleEvent({ type: "text", text: "go" });
  await session.handleEvent({ type: "key", name: "enter" });
  await session.sendPromise;
  assert.equal(session.toolEvents.length, 25);
  assert.equal(renderer.block.lines.length <= 40, true);
  assert.equal(renderer.block.redrawable, false);
  assert.equal(session.busy, false);

  editor.insert("x".repeat(5000));
  assert.equal(editor.value.length <= 1000, true);
});

test("prompt history stays capped on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coderax-memory-"));
  const history = await PromptHistory.open({ path: join(dir, "history.json"), settings: { maxEntries: 20 } });
  for (let index = 0; index < 100; index += 1) {
    await history.add(`prompt ${index}`);
  }
  assert.equal(history.size, 20);
  const reloaded = await PromptHistory.open({ path: join(dir, "history.json"), settings: { maxEntries: 20 } });
  assert.equal(reloaded.size, 20);
});
