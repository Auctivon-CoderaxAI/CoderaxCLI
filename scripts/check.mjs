#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { VERSION } from "../src/version.js";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

async function walk(directory, output = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, output);
    else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) output.push(full);
  }
  return output;
}

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`${relative(root, file)}: ${(result.stderr || "").trim()}`);
  }
}

function checkImports(file, source) {
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      failures.push(`${relative(root, file)}: runtime dependency import "${specifier}" is not allowed`);
    }
  }
}

const sourceFiles = await walk(join(root, "src"));
const packageFiles = await walk(join(root, "packages"));
const scriptFiles = await walk(join(root, "scripts"));
const testFiles = await walk(join(root, "test"));

for (const file of [...sourceFiles, ...packageFiles, ...scriptFiles, ...testFiles]) checkSyntax(file);
for (const file of [...sourceFiles, ...packageFiles]) {
  const source = await readFile(file, "utf8");
  checkImports(file, source);
  if (/\brequire\s*\(/.test(source)) failures.push(`${relative(root, file)}: CommonJS require() is not allowed in an ESM runtime`);
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (packageJson.private !== true) failures.push("package.json must remain private until registry publication is authorized");
if (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0) {
  failures.push("the runtime must have zero dependencies");
}
if (packageJson.devDependencies && Object.keys(packageJson.devDependencies).length > 0) {
  failures.push("the project must not require install-time dependencies");
}
const bin = packageJson.bin?.coderax;
if (!bin) failures.push("package.json bin.coderax is missing");
else {
  try {
    const info = await stat(join(root, bin));
    if (!info.isFile()) failures.push(`bin target ${bin} is not a file`);
  } catch {
    failures.push(`bin target ${bin} does not exist`);
  }
}
const version = VERSION;
if (!version || version !== packageJson.version) {
  failures.push(`package.json version ${packageJson.version} does not match src/version.js ${version}`);
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`check: ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`check: ${sourceFiles.length} source files, ${scriptFiles.length} scripts and ${testFiles.length} tests are valid; zero runtime dependencies\n`);
