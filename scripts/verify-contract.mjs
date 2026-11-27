import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { API_MAJOR, API_VERSION, ROUTE } from "../packages/workflow-sdk/src/index.js";
import { contractViolations } from "./lib/gates.mjs";

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
const sources = [];
for (const file of await walk(join(root, "src"))) {
  sources.push({
    path: relative(root, file).split(sep).join("/"),
    text: await readFile(file, "utf8"),
  });
}

const docs = {
  contract: await readFile(join(root, "docs/CONTRACT.md"), "utf8"),
  compatibility: await readFile(join(root, "docs/COMPATIBILITY.md"), "utf8"),
};

const violations = contractViolations({
  packageJson,
  apiVersion: API_VERSION,
  apiMajor: API_MAJOR,
  route: ROUTE,
  sources,
  docs,
});

console.log(`contract: CLI ${packageJson.version}, API ${API_VERSION}.x from the shared SDK`);
console.log(`contract: ${sources.length} runtime modules checked against ${Object.keys(ROUTE).length} published routes`);

if (violations.length > 0) {
  for (const violation of violations) {
    const message = `${violation.code}: ${violation.message}`.split("%").join("%25").split("\n").join("%0A");
    console.error(`contract: ${violation.code}: ${violation.message}`);
    console.log(`::error title=Contract violation::${message.slice(0, 2000)}`);
  }
  console.error(`contract: FAILED with ${violations.length} violation(s)`);
  process.exit(1);
}
console.log("contract: OK - no stale SDK, no undocumented operation");
