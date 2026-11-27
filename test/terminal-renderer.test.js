import test from "node:test";
import assert from "node:assert/strict";
import { TerminalRenderer } from "../src/terminal/renderer.js";
import { Editor } from "../src/terminal/editor.js";
import { createTheme } from "../src/terminal/theme.js";

function makeRenderer(options = {}) {
  const output = [];
  const renderer = new TerminalRenderer({
    write: (text) => output.push(text),
    width: 40,
    theme: createTheme({ color: false }),
    ...options,
  });
  return { renderer, output, text: () => output.join("") };
}

test("interactive prompts render the editor and leave the cursor positioned", () => {
  const { renderer, text } = makeRenderer();
  const editor = new Editor();
  editor.insert("hello");
  renderer.beginInput({ prompt: "chat \u203a ", editor });
  assert.match(text(), /chat \u203a hello/);
  assert.equal(renderer.promptRows, 1);
  assert.equal(renderer.cursorRow, 0);
});

test("redrawing an unchanged prompt does not emit duplicate frames", () => {
  const { renderer, output } = makeRenderer();
  const editor = new Editor();
  editor.insert("same");
  renderer.beginInput({ prompt: "> ", editor });
  const length = output.length;
  renderer.updateInput({ prompt: "> ", editor });
  assert.equal(output.length, length);
});

test("streamed lines replace the prompt and redraw it below", () => {
  const { renderer, text } = makeRenderer();
  const editor = new Editor();
  renderer.beginInput({ prompt: "> ", editor });
  renderer.startResponse();
  renderer.writeLines([[{ text: "answer", style: null }]]);
  assert.match(text(), /answer/);
  assert.match(text(), /\u001b\[0J/);
  assert.match(text(), /> /);
  assert.equal(renderer.blockRows, 1);
});

test("hostile text is sanitised before it reaches the terminal", () => {
  const { renderer, text } = makeRenderer();
  renderer.startResponse();
  renderer.writeLines([[{ text: "a\u001b]52;c;Y2xsaXA=\u0007b", style: null }]]);
  assert.equal(text().includes("52;c;"), false);
  assert.equal(text().includes("\u001b]"), false);
});

test("resize reflows the last response block instead of losing it", () => {
  const { renderer, text } = makeRenderer({ width: 40 });
  renderer.startResponse();
  renderer.writeLines([[{ text: "one two three four five six", style: null }]]);
  const before = renderer.blockRows;
  renderer.resize(20);
  assert.equal(renderer.width, 20);
  assert.equal(renderer.blockRows >= before, true);
  assert.match(text(), /one two/);
});

test("a notice makes the last block non-redrawable, and resize says so", () => {
  const { renderer, text } = makeRenderer();
  renderer.startResponse();
  renderer.writeLines([[{ text: "answer", style: null }]]);
  renderer.note("notice");
  assert.equal(renderer.block.redrawable, false);
  renderer.resize(30);
  assert.match(text(), /resized 40 \u2192 30 columns/);
});

test("status and preview are shown above the prompt, not in scrollback", () => {
  const { renderer, text } = makeRenderer();
  const editor = new Editor();
  renderer.setPreview("partial response");
  renderer.setStatus({ busy: true, label: "Thinking", frame: "\u280b" });
  renderer.beginInput({ prompt: "> ", editor });
  assert.match(text(), /partial response/);
  assert.match(text(), /Thinking/);
  assert.equal(text().replace(/\r/g, "").includes("partial response\n"), true);
});

test("accessible mode emits no cursor control and no ANSI", () => {
  const { renderer, text } = makeRenderer({ mode: "accessible" });
  const editor = new Editor();
  renderer.beginInput({ prompt: "chat \u203a ", editor });
  renderer.startResponse();
  renderer.writeLines([[{ text: "plain **answer**", style: "bold" }]]);
  renderer.endInput();
  assert.equal(text().includes("\u001b"), false);
  assert.match(text(), /plain \*\*answer\*\*/);
  assert.doesNotMatch(text(), /chat \u203a\s*$/);
});

test("menus and permission panels are rendered with numbered choices", () => {
  const { renderer, text } = makeRenderer();
  renderer.showMenu({
    title: "Select a model",
    options: [{ value: "alpha" }, { value: "beta" }],
    selected: 1,
  });
  assert.match(text(), /Select a model/);
  assert.match(text(), /alpha/);
  assert.match(text(), /beta/);

  renderer.showPermission({
    entry: {
      request: {
        action: "read_file",
        displayResource: "/tmp/file",
        executionId: "exec_1",
        requestId: "srv_req_1",
        reason: "",
      },
    },
    options: [
      { decision: "once", label: "Allow once", key: "1" },
      { decision: "deny", label: "Deny", key: "2" },
    ],
    selected: 0,
  });
  assert.match(text(), /Permission requested/);
  assert.match(text(), /read_file/);
  assert.match(text(), /Allow once/);
});

test("the response block is capped", () => {
  const { renderer } = makeRenderer({ maxBlockLines: 5 });
  renderer.startResponse();
  for (let index = 0; index < 20; index += 1) {
    renderer.writeLines([[{ text: `line ${index}`, style: null }]]);
  }
  assert.equal(renderer.block.lines.length <= 5, true);
  assert.equal(renderer.block.redrawable, false);
});
