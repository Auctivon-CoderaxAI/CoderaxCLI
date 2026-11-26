import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { checkIsolation } from "./lib/standalone.mjs";

const root = process.cwd();

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const sources = [];
for (const file of await walk(join(root, "src"))) {
  sources.push({
    path: relative(root, file).split(sep).join("/"),
    text: await readFile(file, "utf8"),
  });
}

const violations = checkIsolation({ packageJson, lockfile, sources });
console.log(`isolation: ${sources.length} runtime modules scanned`);
console.log(`isolation: runtime dependencies ${Object.keys(packageJson.dependencies ?? {}).length}`);

if (violations.length > 0) {
  for (const violation of violations) console.error(`isolation: ${violation.code}: ${violation.message}`);
  console.error(`isolation: FAILED with ${violations.length} violation(s)`);
  process.exit(1);
}
console.log("isolation: OK - no local inference, database, daemon, Docker or Ollama surface");
