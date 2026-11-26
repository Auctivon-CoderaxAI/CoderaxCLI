import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const suite = process.argv[2] ?? "all";

if (!["all", "unit", "integration"].includes(suite)) {
  console.error("usage: node scripts/run-tests.mjs [all|unit|integration]");
  process.exit(2);
}

async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "harness") continue;
      // The unit suite must not pull in integration tests, and the integration
      // suite must run only its own files.
      if (entry.name === "integration" && suite === "unit") continue;
      files.push(...(await testFiles(full)));
    } else if (entry.name.endsWith(".test.js")) {
      files.push(full);
    }
  }
  return files;
}

const start = suite === "integration" ? join(root, "test/integration") : join(root, "test");
const files = (await testFiles(start)).sort();
if (files.length === 0) {
  console.error(`tests: no ${suite} test files found`);
  process.exit(1);
}

console.log(`tests: ${suite} suite, ${files.length} files`);
for (const file of files) console.log(`  ${relative(root, file)}`);

const child = spawn(process.execPath, ["--test", ...files], {
  stdio: ["ignore", "pipe", "pipe"],
});

let combined = "";
child.stdout.on("data", (chunk) => {
  combined += chunk;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  combined += chunk;
  process.stderr.write(chunk);
});

child.on("close", (code) => {
  if (code !== 0) {
    // Job logs need repository access, but check-run annotations are public.
    // Emit the failure tail so the exact failing assertion is reviewable.
    const tail = combined
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .slice(-60)
      .join("\n");
    const message = tail.replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
    console.log(`::error title=Test suite failed (${suite})::${message.slice(0, 60000)}`);
  }
  process.exit(code ?? 1);
});
