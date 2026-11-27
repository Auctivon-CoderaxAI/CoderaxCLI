#!/usr/bin/env node
/**
 * Cross-platform syntax check for every JavaScript file in the repository.
 *
 * A hardcoded file list silently skips new modules; walking the tree keeps the
 * CI check honest as the terminal implementation grows.
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directories = ["src", "scripts", "test", "packages"];
const files = [];

function walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(path);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) {
      files.push(path);
    }
  }
}

for (const directory of directories) walk(join(root, directory));

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`syntax error: ${relative(root, file)}\n${result.stderr ?? ""}\n`);
  }
}

if (failed > 0) {
  process.stderr.write(`${failed} file(s) failed the syntax check\n`);
  process.exit(1);
}
process.stdout.write(`syntax ok: ${files.length} file(s)\n`);
