import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isolationViolations } from "./lib/gates.mjs";
import { runtimeSources } from "./lib/runtime-sources.mjs";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const sources = await runtimeSources(root);

const violations = isolationViolations({ packageJson, lockfile, sources });

console.log(`isolation: ${sources.length} runtime modules scanned`);
console.log(`isolation: ${Object.keys(packageJson.dependencies ?? {}).length} runtime dependencies`);

if (violations.length > 0) {
  for (const violation of violations) {
    const message = `${violation.code}: ${violation.message}`.split("%").join("%25").split("\n").join("%0A");
    console.error(`isolation: ${violation.code}: ${violation.message}`);
    console.log(`::error title=Local execution surface::${message.slice(0, 2000)}`);
  }
  console.error(`isolation: FAILED with ${violations.length} violation(s)`);
  process.exit(1);
}
console.log("isolation: OK - no local inference, database, daemon, Docker or Ollama surface");
