import test from "node:test";
import assert from "node:assert/strict";
import { MarkdownRenderer, parseInline, safeUrl } from "../src/terminal/markdown.js";

function plain(lines) {
  return lines.map((line) => line.map((segment) => segment.text).join("")).join("\n");
}

function render(text, options = {}) {
  const renderer = new MarkdownRenderer({ width: 60, ...options });
  const lines = [...renderer.feed(text), ...renderer.flush()];
  return { renderer, lines, text: plain(lines) };
}

test("renders headings, paragraphs, emphasis and inline code", () => {
  const { text, lines } = render("# Title\n\nHello **bold** and *italic* and `code`.");
  assert.match(text, /# Title/);
  assert.match(text, /Hello bold and italic and code\./);
  const styles = new Set(lines.flat().map((segment) => segment.style));
  assert.equal(styles.has("heading"), true);
  assert.equal(styles.has("bold"), true);
  assert.equal(styles.has("italic"), true);
  assert.equal(styles.has("code"), true);
});

test("links show a label and a safe URL, and unsafe schemes are not links", () => {
  const { text, lines } = render("[Coderax](https://coderax.example.com) [bad](javascript:alert(1))");
  assert.match(text, /Coderax/);
  assert.match(text, /https:\/\/coderax\.example\.com/);
  assert.equal(text.includes("javascript:"), false);
  assert.equal(lines.flat().some((segment) => segment.style === "link"), true);
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,x"), null);
  assert.equal(safeUrl("https://ok.test/x"), "https://ok.test/x");
});

test("code fences are highlighted without backticks or escape bytes", () => {
  const { text, lines } = render("```js\nconst x = 1; // note\n```\n");
  assert.equal(text.includes("```"), false);
  assert.match(text, /^ {2}const x = 1; \/\/ note$/m);
  const styles = new Set(lines.flat().map((segment) => segment.style));
  assert.equal(styles.has("keyword"), true);
  assert.equal(styles.has("number"), true);
  assert.equal(styles.has("comment"), true);
});

test("lists, task lists, quotes and rules render with accessible markers", () => {
  const { text } = render("- one\n- [x] done\n  - nested\n> quoted\n\n---\n");
  assert.match(text, /• one/);
  assert.match(text, /• ☑ done/);
  assert.match(text, /  • nested/);
  assert.match(text, /│ quoted/);
  assert.match(text, /─/);
});

test("tables render with a header divider and cell truncation", () => {
  const { text } = render("| name | value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |\n\n");
  assert.match(text, /name/);
  assert.match(text, /alpha/);
  assert.match(text, /┼/);
});

test("streaming text is not emitted until a line completes, then previewed", () => {
  const renderer = new MarkdownRenderer({ width: 40 });
  assert.deepEqual(renderer.feed("Hello wor"), []);
  assert.match(renderer.preview(), /Hello wor/);
  const lines = renderer.feed("ld\n");
  assert.equal(plain(lines), "Hello world");
  assert.equal(renderer.preview(), "");
});

test("a hostile escape sequence split across deltas is removed", () => {
  const renderer = new MarkdownRenderer({ width: 40 });
  const first = renderer.feed("safe \u001b]52;c;");
  assert.equal(plain(first), "");
  const second = renderer.feed("SGVsbG8=\u0007text\n");
  assert.equal(plain(second), "safe text");
  assert.equal(plain(second).includes("\u001b"), false);
  assert.equal(plain(second).includes("52;c;"), false);
});

test("an inline OSC 52 clipboard write never reaches the output", () => {
  const { text } = render("before \u001b]52;c;Y2xpcGJvYXJk\u0007after\n");
  assert.equal(text.trim(), "before after");
});

test("a replaced answer emits a revision notice and the new text", () => {
  const renderer = new MarkdownRenderer({ width: 40 });
  renderer.feed("old");
  const lines = renderer.replace("corrected answer\n");
  const text = plain(lines);
  assert.match(text, /response revised/);
  assert.match(text, /corrected answer/);
});

test("rendered output is capped with an explicit notice", () => {
  const renderer = new MarkdownRenderer({ width: 40, maxRenderedChars: 120 });
  const lines = [...renderer.feed(`${"word ".repeat(100)}\n`), ...renderer.flush()];
  assert.equal(renderer.stats.truncated, true);
  assert.match(plain(lines), /truncated/);
  assert.equal(renderer.feed("more\n").length, 0);
});

test("a single enormous line is kept in bounded buffers", () => {
  const renderer = new MarkdownRenderer({ width: 40, maxBufferChars: 1024, maxRenderedChars: 5000 });
  const emitted = renderer.feed("x".repeat(10_000));
  assert.equal(renderer.stats.bufferChars <= 2048, true);
  const lines = [...emitted, ...renderer.flush()];
  assert.equal(lines.length > 0, true);
  assert.equal(renderer.stats.truncated, true);
});

test("code blocks have a line cap and do not grow without bound", () => {
  const { text } = render("```\n1\n2\n3\n4\n5\n```\n", { maxCodeLines: 3 });
  assert.match(text, /further lines are hidden/);
});

test("inline parsing escapes unmatched markers and nested emphasis", () => {
  const segments = parseInline("**bold `code`** and \\*literal\\*");
  assert.equal(segments.map((segment) => segment.text).join(""), "bold code and *literal*");
  assert.equal(segments.some((segment) => segment.style === "bold"), true);
});

test("markdown preserves wide and combining characters", () => {
  const { text } = render("世界 👨‍👩‍👧‍👦 e\u0301\n");
  assert.match(text, /世界 👨‍👩‍👧‍👦 e\u0301/);
});
