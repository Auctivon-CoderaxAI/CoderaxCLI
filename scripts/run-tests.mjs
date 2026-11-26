#!/usr/bin/env node
/**
 * Run the suite and emit GitHub annotations for failing tests.
 *
 * Actions job logs are admin-only for this repository, while check-run
 * annotations are public. Without this wrapper a Windows failure is reported
 * only as "exit code 1", which makes a native-store regression impossible to
 * diagnose from outside the repository.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Pass the suite explicitly. With no arguments Node also treats helper scripts
// whose names look like tests (scripts/install-test.mjs) as test files, which
// would run the full installation acceptance before release artifacts exist.
const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join("test", name));

const result = spawnSync(process.execPath, ["--test", ...files], {
  encoding: "utf8",
  env: process.env,
});
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
process.stdout.write(stdout);
process.stderr.write(stderr);

if (result.error) {
  console.error(result.error.message);
  process.exit(result.status ?? 1);
}

if (result.status !== 0) {
  const failures = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .filter((line) => /^(not ok|✖)\s/.test(line))
    .slice(0, 30);
  for (const line of failures) {
    console.log(`::error title=Test failure::${line.replace(/\r/g, "").slice(0, 220)}`);
  }
}

process.exit(result.status ?? 1);
