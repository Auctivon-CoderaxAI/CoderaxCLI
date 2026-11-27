import test from "node:test";
import assert from "node:assert/strict";
import { createStyle, stripAnsi, visibleLength } from "../src/ui/ansi.js";
import { renderTable } from "../src/ui/tables.js";

const headers = ["COMMAND", "STATUS", "RESULT", "DETAILS"];
const rows = [["deploy", "ready", "ok", "cloud workspace"]];

test("a bordered table counts its padding and both outer borders", () => {
  const lines = renderTable({ headers, rows, width: 36, style: createStyle() }).split("\n");
  assert.match(stripAnsi(lines[0]), /^┌/);
  assert.deepEqual(lines.map(visibleLength), [36, 36, 36, 36, 36]);
});

test("a narrow table shows labeled values without exceeding the available width", () => {
  const output = renderTable({ headers, rows, width: 19 });
  assert.match(output, /^COMMAND: deploy$/m);
  assert.match(output, /^RESULT: ok$/m);
  assert.ok(output.split("\n").every((line) => visibleLength(line) <= 19));
});
