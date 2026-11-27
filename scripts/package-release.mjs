#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
function argument(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = argument("version", packageJson.version);
const platform = argument("platform", process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux");
const arch = argument("arch", process.arch);
const outDir = join(root, argument("out", "dist"));
const base = `coderax-cli-${version}-${platform}-${arch}`;
const stage = join(outDir, `stage-${platform}-${arch}`, "package");

await rm(join(outDir, `stage-${platform}-${arch}`), { recursive: true, force: true });
await mkdir(stage, { recursive: true });

const include = [
  "src",
  "contracts",
  "packages",
  "docs",
  "README.md",
  "ARCHITECTURE.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "install.sh",
  "install.ps1",
  "package.json",
];
for (const entry of include) {
  await cp(join(root, entry), join(stage, entry), {
    recursive: true,
    errorOnExist: false,
    filter: (source) => !source.includes("node_modules"),
  });
}
await chmod(join(stage, "src/cli.js"), 0o755);

const tarPath = join(outDir, `${base}.tar.gz`);
const zipPath = join(outDir, `${base}.zip`);
const tar = spawnSync("tar", ["-czf", tarPath, "-C", join(outDir, `stage-${platform}-${arch}`), "package"], {
  encoding: "utf8",
});
if (tar.status !== 0) {
  throw new Error(`tar failed: ${(tar.stderr || tar.stdout || "").trim() || tar.error?.message || "unknown error"}`);
}
await createZip(stage, zipPath);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
const archives = [];
for (const file of [tarPath, zipPath]) {
  const digest = sha256(await readFile(file));
  const name = file.split(/[\\/]/).pop();
  archives.push({ name, sha256: digest });
}
await writeFile(
  join(outDir, `SHA256SUMS-${platform}-${arch}`),
  `${archives.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n")}\n`,
);
await writeFile(
  join(outDir, `manifest-${platform}-${arch}.json`),
  `${JSON.stringify({
    name: packageJson.name,
    version,
    platform,
    arch,
    contractVersion: packageJson.coderax?.contractVersion ?? null,
    eventSchemaVersion: packageJson.coderax?.eventSchemaVersion ?? null,
    node: packageJson.engines?.node ?? null,
    archives,
  }, null, 2)}\n`,
);

process.stdout.write(`release: ${base}\n`);
for (const entry of archives) process.stdout.write(`  ${entry.name}  ${entry.sha256}\n`);
