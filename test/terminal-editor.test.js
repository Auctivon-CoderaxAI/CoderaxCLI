import test from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/terminal/editor.js";

const key = (name, extra = {}) => ({ type: "key", name, ...extra });

test("inserts Unicode graphemes and backspaces whole cells", () => {
  const editor = new Editor();
  editor.insert("a😀世");
  assert.equal(editor.value, "a😀世");
  assert.equal(editor.col, 3);
  editor.backspace();
  assert.equal(editor.value, "a😀");
  editor.backspace();
  assert.equal(editor.value, "a");
});

test("multiline insertion, cursor movement and line joining", () => {
  const editor = new Editor();
  editor.insert("one\ntwo");
  assert.equal(editor.row, 1);
  assert.equal(editor.col, 3);
  editor.handleKey(key("home"));
  editor.backspace();
  assert.equal(editor.value, "onetwo");
  assert.equal(editor.row, 0);
  assert.equal(editor.col, 3);
});

test("Ctrl+J and Alt+Enter insert newlines; Enter requests submit", () => {
  const editor = new Editor();
  editor.insert("a");
  assert.equal(editor.handleKey(key("j", { ctrl: true })).action, null);
  assert.equal(editor.value, "a\n");
  editor.insert("b");
  assert.equal(editor.handleKey(key("enter", { alt: true })).action, null);
  assert.equal(editor.value, "a\nb\n");
  assert.equal(editor.handleKey(key("enter")).action, "submit");
});

test("word deletion and kill commands stay within the line", () => {
  const editor = new Editor();
  editor.insert("alpha beta gamma");
  editor.handleKey(key("w", { ctrl: true }));
  assert.equal(editor.value, "alpha beta ");
  editor.handleKey(key("k", { ctrl: true }));
  assert.equal(editor.value, "alpha beta ");
  editor.handleKey(key("u", { ctrl: true }));
  assert.equal(editor.value, "");
});

test("word and line movement with modifiers", () => {
  const editor = new Editor();
  editor.insert("one two");
  editor.handleKey(key("left", { ctrl: true }));
  assert.equal(editor.col, 4);
  editor.handleKey(key("a", { ctrl: true }));
  assert.equal(editor.col, 0);
  editor.handleKey(key("f", { ctrl: true }));
  assert.equal(editor.col, 1);
  editor.handleKey(key("e", { ctrl: true }));
  assert.equal(editor.col, 7);
});

test("Up/Down are history actions at the boundaries", () => {
  const editor = new Editor();
  editor.insert("line1\nline2");
  assert.equal(editor.handleKey(key("up")).action, null);
  assert.equal(editor.row, 0);
  assert.equal(editor.handleKey(key("up")).action, "history-prev");
  editor.handleKey(key("down"));
  assert.equal(editor.row, 1);
  assert.equal(editor.handleKey(key("down")).action, "history-next");
});

test("deleteForward joins the next line at the end of a line", () => {
  const editor = new Editor();
  editor.insert("ab\ncd");
  editor.handleKey(key("up"));
  editor.handleKey(key("end"));
  editor.handleKey(key("delete"));
  assert.equal(editor.value, "abcd");
});

test("paste with newlines is inserted as multiple lines", () => {
  const editor = new Editor();
  editor.handleKey({ type: "paste", text: "a\nb\nc" });
  assert.equal(editor.value, "a\nb\nc");
  assert.equal(editor.lines.length, 3);
});

test("the editor is bounded and reports oversized input", () => {
  const editor = new Editor({ maxChars: 10, maxLines: 3 });
  editor.insert("x".repeat(20));
  assert.equal(editor.value.length <= 10, true);
  const second = new Editor({ maxChars: 10, maxLines: 1 });
  second.insert("abc");
  assert.equal(second.newline().action, "too-large");
});

test("rendering uses cell width for wide characters and cursor placement", () => {
  const editor = new Editor();
  editor.insert("世界hello");
  const rendered = editor.render(12, { prompt: "> " });
  assert.equal(rendered.lines[0].text.startsWith("> 世界"), true);
  assert.equal(rendered.cursor.row >= 0, true);
  assert.equal(rendered.cursor.col >= 2, true);
});

test("a long line wraps and the cursor lands on the visible row", () => {
  const editor = new Editor();
  editor.insert("abcdefghij");
  editor.setCursor(0, 9);
  const rendered = editor.render(8, { prompt: "" });
  assert.equal(rendered.lines.length >= 2, true);
  assert.equal(rendered.cursor.row, 1);
  assert.equal(rendered.cursor.col, 1);
});

test("an empty editor still renders a cursor row", () => {
  const editor = new Editor();
  const rendered = editor.render(20, { prompt: "chat \u203a " });
  assert.equal(rendered.lines.length, 1);
  assert.equal(rendered.lines[0].text, "chat \u203a ");
  assert.equal(rendered.cursor.col, 7);
});

test("Ctrl+D exits only on an empty editor", () => {
  const editor = new Editor();
  editor.insert("x");
  assert.equal(editor.handleKey(key("d", { ctrl: true })).action, null);
  editor.clear();
  assert.equal(editor.handleKey(key("d", { ctrl: true })).action, "eof");
});
