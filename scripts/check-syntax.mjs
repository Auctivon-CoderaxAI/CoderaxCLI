import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const failures = [];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) files.push(full);
  }
  return files;
}

const files = [];
for (const directory of ["src", "scripts", "test"]) {
  files.push(...(await walk(join(root, directory))));
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`${relative(root, file)}: ${(result.stderr ?? "").trim()}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`syntax: ${failure}`);
  process.exit(1);
}
console.log(`syntax: OK - ${files.length} modules parse`);
