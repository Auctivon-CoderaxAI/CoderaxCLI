import test from "node:test";
import assert from "node:assert/strict";
import { KEY_TYPES, createKeyDecoder, decodeKeys } from "../src/terminal/keys.js";

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
