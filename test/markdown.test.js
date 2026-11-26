import test from "node:test";
import assert from "node:assert/strict";
import { MarkdownRenderer, renderMarkdown } from "../src/ui/markdown.js";
import { createStyle, stripAnsi, wrapPlain } from "../src/ui/ansi.js";

const plain = createStyle({ enabled: false });

function render(text, width = 60, indent = 0) {
  let output = "";
  renderMarkdown(text, { width, indent, style: plain, write: (chunk) => { output += chunk; } });
  return output;
}

test("renders headings, emphasis, lists and links", () => {
  const output = render("# Title\n\nSome **bold** and `code` and [docs](https://example.test).\n\n- first\n- second\n", 60);
  assert.match(output, /Title/);
  assert.match(output, /bold/);
  assert.match(output, /code/);
  assert.match(output, /docs/);
  assert.match(output, /• first/);
  assert.match(output, /• second/);
});

test("buffers a table and renders a bordered grid", () => {
  const output = render("| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n", 60);
  assert.match(output, /┌/);
  assert.match(output, /Name/);
  assert.match(output, /Value/);
  assert.match(output, /│ a/);
  assert.match(output, /│ b/);
  assert.match(output, /└/);
});

test("a table without a separator is rendered as plain lines", () => {
  const output = render("| not | a table |\n| just | text |", 60);
  assert.equal(output.includes("┌"), false);
  assert.match(output, /not/);
});

test("an open code fence is indented, highlighted and closed on end", () => {
  const output = render("```js\nconst x = 1;\n```\n", 60);
  assert.match(output, /┌─ js/);
  assert.match(output, /│ const x = 1;/);
  assert.match(output, /└─/);
});

test("diff lines are marked with +/- and hunks", () => {
  const output = render("```diff\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n```\n", 60);
  assert.match(output, /--- a\/file/);
  assert.match(output, /\+\+\+ b\/file/);
  assert.match(output, /@@ -1 \+1 @@/);
  assert.match(output, /-old/);
  assert.match(output, /\+new/);
});

test("ANSI and terminal control sequences from model text are stripped", () => {
  const output = render("hello \u001b[31mred\u001b[0m \u001b]0;title\u0007 world\n", 60);
  assert.match(output, /hello red world/);
  assert.equal(output.includes("\u001b"), false);
});

test("wrapping never exceeds the width and preserves a hanging indent", () => {
  const lines = wrapPlain("one two three four five six seven eight nine ten", 20, { hangingIndent: 2 });
  for (const line of lines) assert.ok(stripAnsi(line).length <= 20, line);
  assert.match(lines[1], /^  /);
});

test("incremental chunks split mid-line still render correctly", () => {
  let output = "";
  const renderer = new MarkdownRenderer({ width: 60, style: plain, write: (chunk) => { output += chunk; } });
  renderer.write("## Head");
  renderer.write("ing\n\npara");
  renderer.write("graph\n");
  renderer.end();
  assert.match(output, /Heading/);
  assert.match(output, /paragraph/);
});

test("a heading separator and quote are visual, not literal Markdown", () => {
  const output = render("# H\n> quoted\n---\n", 60);
  assert.match(output, /→? quoted|│ quoted/);
  assert.equal(output.includes("> quoted"), false);
  assert.match(output, /─{3,}/);
});
