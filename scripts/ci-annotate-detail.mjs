// Probe-only: emits the assertion details of a failing run as check
// annotations, which are readable without credentials. Exists only on the
// throwaway probe branch.
import { readFileSync } from "node:fs";

const file = process.argv[2];
let text = "";
try {
  text = readFileSync(file, "utf8");
} catch (error) {
  console.log(`::error::could not read ${file}: ${error.code}`);
  process.exit(0);
}

const escape = (value) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const lines = text.split(/\r?\n/);
const start = lines.findIndex((line) => line.includes("failing tests:"));
const body = start >= 0 ? lines.slice(start) : lines.slice(-60);

// Group into annotation-sized chunks without cutting mid-line.
const chunks = [];
let current = "";
for (const line of body) {
  if (current.length + line.length + 1 > 1300) {
    chunks.push(current);
    current = "";
  }
  current += `${line}\n`;
}
if (current.trim() !== "") chunks.push(current);

for (const chunk of chunks.slice(0, 14)) {
  console.log(`::error::${escape(chunk)}`);
}
console.log(`emitted ${Math.min(chunks.length, 14)} annotation chunk(s) from ${file}`);
