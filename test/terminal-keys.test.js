import test from "node:test";
import assert from "node:assert/strict";
import { KeyParser, sanitizePaste } from "../src/terminal/keys.js";

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
