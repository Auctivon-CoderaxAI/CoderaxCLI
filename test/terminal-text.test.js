import test from "node:test";
import assert from "node:assert/strict";
import {
  displayWidth,
  expandTabs,
  graphemeWidth,
  graphemes,
  padToWidth,
  truncateToWidth,
  wrapSegments,
  wrapText,
} from "../src/terminal/text.js";

test("ASCII and combining marks use terminal cell widths", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("e\u0301"), 1);
  assert.equal(graphemeWidth("\u0301"), 0);
  assert.equal(displayWidth(""), 0);
});

test("CJK, emoji, flags and keycaps occupy two cells", () => {
  assert.equal(displayWidth("世界"), 4);
  assert.equal(displayWidth("😀"), 2);
  assert.equal(displayWidth("👨‍👩‍👧‍👦"), 2);
  assert.equal(displayWidth("🇺🇸"), 2);
  assert.equal(displayWidth("❤️"), 2);
  assert.equal(displayWidth("1️⃣"), 2);
  // Text-presentation pictographs stay narrow.
  assert.equal(displayWidth("❤"), 1);
  assert.equal(displayWidth("⚠"), 1);
});

test("graphemes never split surrogate pairs or emoji sequences", () => {
  assert.deepEqual(graphemes("a😀b"), ["a", "😀", "b"]);
  assert.equal(graphemes("👨‍👩‍👧‍👦").length, 1);
  assert.equal(graphemes("e\u0301").length, 1);
});

test("tabs expand relative to the current column", () => {
  assert.equal(expandTabs("\ta"), "    a");
  assert.equal(expandTabs("ab\tc"), "ab  c");
  assert.equal(expandTabs("abcd\tc"), "abcd    c");
});

test("word wrap respects width and keeps words intact", () => {
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapText("supercalifragilistic", 8), ["supercal", "ifragili", "stic"]);
  assert.deepEqual(wrapText("a b c", 3), ["a b", "c"]);
});

test("wide characters wrap by cells, not by string length", () => {
  assert.deepEqual(wrapText("世界世界", 5), ["世界", "世界"]);
  assert.deepEqual(wrapText("ab世界", 4), ["ab世", "界"]);
});

test("styled wrapping preserves each segment's style", () => {
  const lines = wrapSegments(
    [
      { text: "bold ", style: "bold" },
      { text: "plain words", style: null },
    ],
    8,
  );
  assert.equal(lines[0].map((segment) => segment.text).join(""), "bold");
  assert.equal(lines[1][0].style, null);
  const styles = new Set(lines.flat().map((segment) => segment.style));
  assert.equal(styles.has("bold"), true);
});

test("trailing spaces are not emitted as their own line", () => {
  assert.deepEqual(wrapText("abc   ", 10), ["abc"]);
  assert.deepEqual(wrapText("", 10), [""]);
});

test("truncateToWidth and padToWidth are cell-aware", () => {
  assert.equal(truncateToWidth("世界abc", 4), "世界");
  assert.equal(truncateToWidth("世界abc", 3), "世\u2026");
  assert.equal(padToWidth("世", 4), "世  ");
  assert.equal(padToWidth("x", 3, "right"), "  x");
  assert.equal(padToWidth("x", 3, "center"), " x ");
});
