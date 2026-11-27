import test from "node:test";
import assert from "node:assert/strict";
import {
  TerminalSanitizer,
  sanitizeOneLine,
  sanitizeTerminalText,
  stripAnsi,
} from "../src/terminal/sanitize.js";

test("strips CSI colour, cursor and screen-control sequences", () => {
  assert.equal(sanitizeTerminalText("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitizeTerminalText("a\u001b[2Jb"), "ab");
  assert.equal(sanitizeTerminalText("a\u001b[10;20Hb"), "ab");
  assert.equal(sanitizeTerminalText("a\u001b[?25lb"), "ab");
  assert.equal(sanitizeTerminalText("a\u001b]0;window title\u0007b"), "ab");
});

test("strips clipboard, hyperlink and device-control sequences", () => {
  assert.equal(sanitizeTerminalText("safe\u001b]52;c;SGVsbG8=\u0007text"), "safetext");
  assert.equal(
    sanitizeTerminalText("click \u001b]8;;https://evil.example\u001b\\here\u001b]8;;\u001b\\"),
    "click here",
  );
  assert.equal(sanitizeTerminalText("a\u001bPq#0;2;0;0;0\u001b\\b"), "ab");
  assert.equal(sanitizeTerminalText("a\u001b_apc\u001b\\b"), "ab");
  assert.equal(sanitizeTerminalText("a\u001bXstring\u001b\\b"), "ab");
});

test("removes C0, DEL, C1 and bidi spoofing characters but keeps tabs", () => {
  assert.equal(sanitizeTerminalText("\u0000a\u0007b\u0008c\u007fd"), "abcd");
  assert.equal(sanitizeTerminalText("a\u009b2Jb"), "a2Jb");
  assert.equal(sanitizeTerminalText("a\u202eb\u202cc"), "abc");
  assert.equal(sanitizeTerminalText("a\u200eb\u2066c\u2069d"), "abcd");
  assert.equal(sanitizeTerminalText("a\u200bb\ufeffc"), "abc");
  assert.equal(sanitizeTerminalText("a\tb"), "a\tb");
});

test("normalises line endings and line separators", () => {
  assert.equal(sanitizeTerminalText("a\r\nb\rc\n"), "a\nb\nc\n");
  assert.equal(sanitizeTerminalText("a\u2028b\u2029c"), "a\nb\nc");
});

test("replaces lone surrogates instead of emitting invalid UTF-16", () => {
  assert.equal(sanitizeTerminalText("a\ud800b"), "a\ufffdb");
  assert.equal(sanitizeTerminalText("a\udc00b"), "a\ufffdb");
  assert.equal(sanitizeTerminalText("😀"), "😀");
});

test("a split escape sequence is held across chunks and still stripped", () => {
  const sanitizer = new TerminalSanitizer();
  assert.equal(sanitizer.push("before\u001b]52;c;"), "before");
  assert.equal(sanitizer.push("SGVsbG8=\u0007after"), "after");
  assert.equal(sanitizer.push("\u001b["), "");
  assert.equal(sanitizer.push("31mred"), "red");
  assert.equal(sanitizer.push("\u001b"), "");
  assert.equal(sanitizer.flush(), "");
});

test("an unterminated escape cannot grow memory without bound", () => {
  const sanitizer = new TerminalSanitizer({ maxPending: 16 });
  sanitizer.push("\u001b]52;c;" + "A".repeat(100));
  assert.equal(sanitizer.pending, "");
  assert.equal(sanitizer.push("visible"), "visible");
});

test("truncation is explicit and bounded", () => {
  const result = sanitizeTerminalText("x".repeat(100), { maxChars: 10 });
  assert.equal(result.startsWith("x".repeat(10)), true);
  assert.match(result, /truncated at 10 characters/);
});

test("sanitizeOneLine collapses whitespace and bounds a display line", () => {
  assert.equal(sanitizeOneLine("a\n\tb   c", { maxChars: 20 }), "a b c");
  const long = sanitizeOneLine("word ".repeat(50), { maxChars: 10 });
  assert.equal(long.length <= 11, true);
  assert.equal(long.endsWith("\u2026"), true);
});

test("stripAnsi makes PTY output assertable", () => {
  assert.equal(stripAnsi("\u001b[1;32mok\u001b[0m\r\n"), "ok\n");
});
