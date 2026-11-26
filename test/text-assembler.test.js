import test from "node:test";
import assert from "node:assert/strict";
import { TextAssembler } from "../src/ui/text-assembler.js";

test("deltas append in order", () => {
  const assembler = new TextAssembler();
  assert.deepEqual(assembler.delta("Hello"), { kind: "delta", text: "Hello" });
  assert.deepEqual(assembler.delta(" world"), { kind: "delta", text: " world" });
  assert.equal(assembler.text, "Hello world");
});

test("a cumulative snapshot emits only the unseen suffix", () => {
  const assembler = new TextAssembler();
  assembler.delta("Hello");
  assert.deepEqual(assembler.snapshot("Hello world"), {
    kind: "delta",
    text: " world",
    snapshot: true,
  });
  assert.equal(assembler.text, "Hello world");
});

test("a snapshot and its incremental delta never print the same text twice", () => {
  const assembler = new TextAssembler();
  assert.equal(assembler.snapshot("Hello world").kind, "delta");
  assert.deepEqual(assembler.delta(" world"), { kind: "duplicate" });
  assert.equal(assembler.text, "Hello world");
});

test("a snapshot that repeats the displayed text is ignored", () => {
  const assembler = new TextAssembler();
  assembler.delta("Hello");
  assert.deepEqual(assembler.snapshot("Hello"), { kind: "duplicate" });
  assert.equal(assembler.text, "Hello");
});

test("a rewritten snapshot is a single replacement", () => {
  const assembler = new TextAssembler();
  assembler.delta("old draft");
  assert.deepEqual(assembler.snapshot("corrected answer"), {
    kind: "replace",
    text: "corrected answer",
  });
  assert.equal(assembler.text, "corrected answer");
  // A normal delta after the rewrite is new text, not a duplicate.
  assert.deepEqual(assembler.delta("!"), { kind: "delta", text: "!" });
  assert.equal(assembler.text, "corrected answer!");
});
