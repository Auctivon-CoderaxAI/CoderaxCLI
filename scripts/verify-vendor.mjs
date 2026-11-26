import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Verify the vendored canonical SDK against the engine's published SHA256SUMS.
 * A mismatch means the client and the contract it validates are not the bytes
 * the engine published, so the CLI must not run.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor");

const sums = await readFile(join(vendor, "SHA256SUMS"), "utf8");
let checked = 0;
let failed = 0;

for (const line of sums.split("\n")) {
  const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line.trim());
  if (match === null) continue;
  const [, expected, name] = match;
  let bytes;
  try {
    bytes = await readFile(join(vendor, name));
  } catch {
    console.error(`vendor: missing ${name}`);
    failed += 1;
    continue;
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    console.error(`vendor: ${name} does not match its published sha256`);
    failed += 1;
    continue;
  }
  checked += 1;
}

if (failed > 0) {
  process.exit(1);
}
if (checked === 0) {
  console.error("vendor: SHA256SUMS listed no artifacts");
  process.exit(1);
}
console.log(`vendor: ${checked} published artifact(s) verified`);
