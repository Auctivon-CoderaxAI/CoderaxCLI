import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const suite = process.argv[2] ?? "all";

if (!["all", "unit", "integration"].includes(suite)) {
  console.error(`usage: node scripts/run-tests.mjs [all|unit|integration]`);
  process.exit(2);
}

async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "harness") continue;
      if (suite === "unit" && entry.name === "integration") continue;
      files.push(...(await testFiles(full)));
    } else if (entry.name.endsWith(".test.js")) {
      files.push(full);
    }
  }
  return files;
}

const files = (await testFiles(join(root, "test"))).sort();
if (files.length === 0) {
  console.error(`tests: no ${suite} test files found`);
  process.exit(1);
}

console.log(`tests: ${suite} suite, ${files.length} files`);
for (const file of files) console.log(`  ${relative(root, file)}`);

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
