import test from "node:test";
import assert from "node:assert/strict";
import { KEY_TYPES, KeyParser, createKeyDecoder, decodeKeys, sanitizePaste } from "../src/terminal/keys.js";

const types = (events) => events.map((event) => event.type);

test("Enter submits and Ctrl+J inserts a soft newline", () => {
  assert.deepEqual(types(decodeKeys("\r")), [KEY_TYPES.ENTER]);
  assert.deepEqual(types(decodeKeys("\n")), [KEY_TYPES.SOFT_NEWLINE]);
});

test("CRLF is one Enter, not Enter followed by Ctrl+J", () => {
  const events = decodeKeys("a\r\nb");
  assert.deepEqual(types(events), [KEY_TYPES.TEXT, KEY_TYPES.ENTER, KEY_TYPES.TEXT]);
  assert.equal(events[2].text, "b");
  assert.equal(events.filter((event) => event.type === KEY_TYPES.SOFT_NEWLINE).length, 0);
});

test("Ctrl+M is reported as Enter because it is the same byte", () => {
  // Ctrl+M sends 0x0D, exactly like Enter; the decoder must not invent a
  // separate key for an indistinguishable byte.
  assert.deepEqual(types(decodeKeys("\r")), [KEY_TYPES.ENTER]);
});

test("a CR and LF split across chunks still collapse to one Enter", () => {
  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push("a\r"), [{ type: KEY_TYPES.TEXT, text: "a" }]);
  assert.deepEqual(decoder.push("\nb"), [{ type: KEY_TYPES.ENTER }, { type: KEY_TYPES.TEXT, text: "b" }]);
});

test("a lone CR followed by text is Enter then the text", () => {
  const decoder = createKeyDecoder();
  decoder.push("\r");
  assert.deepEqual(decoder.push("x"), [{ type: KEY_TYPES.ENTER }, { type: KEY_TYPES.TEXT, text: "x" }]);
});

test("chunkEol resolves a lone Enter at the end of the chunk", () => {
  const decoder = createKeyDecoder({ chunkEol: true });
  assert.deepEqual(decoder.push("hi\r"), [
    { type: KEY_TYPES.TEXT, text: "hi" },
    { type: KEY_TYPES.ENTER },
  ]);
  assert.deepEqual(decoder.push("\r"), [{ type: KEY_TYPES.ENTER }]);

  const streaming = createKeyDecoder({ chunkEol: true });
  assert.deepEqual(streaming.push("a\r"), [{ type: KEY_TYPES.TEXT, text: "a" }, { type: KEY_TYPES.ENTER }]);
  assert.deepEqual(streaming.push("\nb"), [{ type: KEY_TYPES.SOFT_NEWLINE }, { type: KEY_TYPES.TEXT, text: "b" }]);
});

test("a trailing CR is flushed as Enter", () => {
  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push("ab\r"), [{ type: KEY_TYPES.TEXT, text: "ab" }]);
  assert.deepEqual(decoder.flush(), [{ type: KEY_TYPES.ENTER }]);
  assert.deepEqual(decoder.flush(), []);
});

test("control keys are distinct from text", () => {
  assert.deepEqual(types(decodeKeys("\u0003x\u007f\u0004")), [
    KEY_TYPES.CTRL_C,
    KEY_TYPES.TEXT,
    KEY_TYPES.BACKSPACE,
    KEY_TYPES.CTRL_D,
  ]);
});

test("bracketed paste keeps newlines as literal text", () => {
  const events = decodeKeys("\u001b[200~one\r\ntwo\u001b[201~");
  assert.deepEqual(types(events), [KEY_TYPES.PASTE]);
  assert.equal(events[0].text, "one\ntwo");
});

test("arrow and Alt keys are reported as escapes, including split sequences", () => {
  assert.deepEqual(decodeKeys("\u001b[A"), [{ type: KEY_TYPES.ESCAPE, sequence: "\u001b[A" }]);

  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push("\u001b"), []);
  assert.deepEqual(decoder.push("[B"), [{ type: KEY_TYPES.ESCAPE, sequence: "\u001b[B" }]);
  assert.deepEqual(decoder.push("\u001bb"), [{ type: KEY_TYPES.ESCAPE, sequence: "\u001bb" }]);
});

test("split UTF-8 bytes decode to one character", () => {
  const bytes = Buffer.from("\u00e9", "utf8");
  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push(bytes.subarray(0, 1)), []);
  assert.deepEqual(decoder.push(bytes.subarray(1)), [{ type: KEY_TYPES.TEXT, text: "\u00e9" }]);
});

test("end flushes a pending CR and the UTF-8 tail once", () => {
  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push("x\r"), [{ type: KEY_TYPES.TEXT, text: "x" }]);
  assert.deepEqual(decoder.end(), [{ type: KEY_TYPES.ENTER }]);
  assert.deepEqual(decoder.end(), []);
});

test("parses printable runs and control keys", () => {
  const parser = new KeyParser();
  const events = parser.push("hello\u0003");
  assert.deepEqual(events, [
    { type: "text", text: "hello" },
    { type: "key", name: "c", ctrl: true },
  ]);
});

test("parses arrow, home, end, delete and page keys", () => {
  const parser = new KeyParser();
  const events = parser.push("\u001b[A\u001b[B\u001b[D\u001b[C\u001b[H\u001b[F\u001b[3~\u001b[5~\u001b[6~");
  assert.deepEqual(
    events.map((event) => event.name),
    ["up", "down", "left", "right", "home", "end", "delete", "pageup", "pagedown"],
  );
});

test("a sequence split across reads is parsed once complete", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("\u001b["), []);
  assert.deepEqual(parser.push("A"), [{ type: "key", name: "up" }]);
  assert.deepEqual(parser.push("\u001b[1;"), []);
  assert.deepEqual(parser.push("5D"), [{ type: "key", name: "left", ctrl: true }]);
});

test("application cursor keys and modifiers are understood", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("\u001bOA"), [{ type: "key", name: "up" }]);
  assert.deepEqual(parser.push("\u001b[1;2A"), [{ type: "key", name: "up", shift: true }]);
  assert.deepEqual(parser.push("\u001b[1;3C"), [{ type: "key", name: "right", alt: true }]);
  assert.deepEqual(parser.push("\u001b[Z"), [{ type: "key", name: "tab" }]);
});

test("Alt+Enter is a newline key, Enter is submit", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("\u001b\r"), [{ type: "key", name: "enter", alt: true }]);
  assert.deepEqual(parser.push("\r"), [{ type: "key", name: "enter" }]);
  assert.deepEqual(parser.push("\n"), [{ type: "key", name: "enter", ctrl: true }]);
});

test("bracketed paste is a single paste event, even when split", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("a\u001b[200~line1\nli"), [{ type: "text", text: "a" }]);
  const events = parser.push("ne2\u001b[201~b");
  assert.deepEqual(events, [
    { type: "paste", text: "line1\nline2" },
    { type: "text", text: "b" },
  ]);
});

test("an unterminated paste is still delivered on flush", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("\u001b[200~abc"), []);
  assert.deepEqual(parser.flush(), [{ type: "paste", text: "abc" }]);
});

test("a lone escape is resolved on flush, not as text", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("\u001b"), []);
  assert.deepEqual(parser.flush(), [{ type: "key", name: "escape" }]);
});

test("unknown sequences are ignored without corrupting later input", () => {
  const parser = new KeyParser();
  const events = parser.push("\u001b[999~ok");
  assert.deepEqual(events.at(-1), { type: "text", text: "ok" });
  assert.equal(parser.invalid >= 1, true);
});

test("paste sanitisation removes escape and C0 bytes", () => {
  assert.equal(sanitizePaste("a\r\nb\rc\u0000d\u001b[31m"), "a\nb\ncd[31m");
});

test("an oversized paste discards embedded keys through a split closing delimiter", () => {
  const decoder = createKeyDecoder({ chunkEol: true });
  const limit = 1024 * 1024;
  const full = "x".repeat(limit);
  assert.deepEqual(decoder.push(`\u001b[200~${full}\u001b[201~`), [{ type: KEY_TYPES.PASTE, text: full }]);
  assert.deepEqual(decoder.push(`\u001b[200~${full}y\r\u0003\u001b[20`), []);
  assert.deepEqual(decoder.push("1~ok\r"), [{ type: KEY_TYPES.TEXT, text: "ok" }, { type: KEY_TYPES.ENTER }]);
});
