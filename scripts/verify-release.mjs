#!/usr/bin/env node
/**
 * Verify built release artifacts before anything is published.
 *
 * This is the gate that makes a checksum worth trusting: it recomputes every
 * hash, parses every archive, and checks the properties that keep installation
 * safe (executable launchers, no install-time scripts, no runtime services).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { readTar, readZip } from "./lib/archive.mjs";
import { SUPPORTED_ENGINE_RANGE } from "../src/compat.js";
import { NODE_REQUIREMENT, PACKAGE_NAME, VERSION } from "../src/version.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = resolve(ROOT, process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "dist");

const failures = [];
const notes = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}
function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
function readJson(buffer) {
  return JSON.parse(buffer.toString("utf8"));
}

const manifestPath = join(DIST, "release-manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`coderax verify: ${manifestPath} is missing; run \`npm run build\` first`);
  process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const base = `${PACKAGE_NAME}-${VERSION}`;
const npmTarballName = `${base}.tgz`;
const standaloneTgzName = `${base}-standalone.tar.gz`;
const standaloneZipName = `${base}-standalone.zip`;
const root = `${base}/`;

check(manifest.schemaVersion === 1, "manifest schemaVersion must be 1");
check(manifest.name === PACKAGE_NAME, "manifest name does not match package.json");
check(manifest.version === VERSION, "manifest version does not match package.json");
check(manifest.node === NODE_REQUIREMENT, "manifest node requirement does not match package.json");
check(
  manifest.supportedWorkflowEngine === SUPPORTED_ENGINE_RANGE,
  "manifest WorkflowEngine range does not match src/compat.js",
);

// --- checksums -------------------------------------------------------------
const sums = (await readFile(join(DIST, "SHA256SUMS"), "utf8")).trim().split("\n");
const sumsByName = new Map();
for (const line of sums) {
  const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
  check(match !== null, `malformed SHA256SUMS line: ${line}`);
  if (match) sumsByName.set(match[2], match[1]);
}

const expectedAssets = [npmTarballName, standaloneTgzName, standaloneZipName, "install.sh", "install.ps1", "uninstall.sh", "uninstall.ps1", "sbom.spdx.json", "release-notes.md"];
for (const name of expectedAssets) check(sumsByName.has(name), `SHA256SUMS is missing ${name}`);
for (const name of sumsByName.keys()) check(expectedAssets.includes(name), `SHA256SUMS lists an unexpected file: ${name}`);

for (const [name, expected] of sumsByName) {
  const path = join(DIST, name);
  if (!existsSync(path)) {
    failures.push(`checksummed file is missing: ${name}`);
    continue;
  }
  check(sha256(await readFile(path)) === expected, `checksum mismatch for ${name}`);
}

for (const artifact of manifest.artifacts ?? []) {
  const path = join(DIST, artifact.name);
  if (!existsSync(path)) {
    failures.push(`manifest artifact is missing: ${artifact.name}`);
    continue;
  }
  const data = await readFile(path);
  check(data.length === artifact.size, `${artifact.name} size does not match the manifest`);
  check(sha256(data) === artifact.sha256, `${artifact.name} sha256 does not match the manifest`);
}

// --- package rules ---------------------------------------------------------
const pkg = readJson(await readFile(join(DIST, `${base}.tgz`)).then((data) => {
  const entries = readTar(gunzipSync(data));
  const entry = entries.get("package/package.json");
  if (!entry) failures.push("npm tarball is missing package/package.json");
  return entry?.data ?? Buffer.from("{}");
}));
check(pkg.name === PACKAGE_NAME, "tarball package.json name mismatch");
check(pkg.version === VERSION, "tarball package.json version mismatch");
check(pkg.private === true, "tarball package.json must stay private until publication is authorized");
for (const name of ["preinstall", "install", "postinstall"]) {
  check(pkg.scripts?.[name] === undefined, `package.json must not define a ${name} script`);
}

// --- npm tarball -----------------------------------------------------------
const npmEntries = readTar(gunzipSync(await readFile(join(DIST, npmTarballName))));
for (const path of npmEntries.keys()) {
  check(path.startsWith("package/"), `npm tarball entry outside package/: ${path}`);
  check(!path.includes(".."), `npm tarball entry escapes its root: ${path}`);
  check(!/(^|\/)(node_modules|\.git|dist|coverage)\//.test(path), `npm tarball contains a forbidden path: ${path}`);
  check(!/(^|\/)\.env(\.|$)/.test(path), `npm tarball contains an environment file: ${path}`);
  check(!/\.log$/.test(path), `npm tarball contains a log file: ${path}`);
}
const npmCli = npmEntries.get("package/src/cli.js");
check(npmCli !== undefined, "npm tarball is missing src/cli.js");
if (npmCli) {
  check(npmCli.data.toString("utf8").startsWith("#!/usr/bin/env node"), "src/cli.js must start with a node shebang");
  check((npmCli.mode & 0o111) !== 0, "src/cli.js must be executable inside the npm tarball");
}
for (const file of ["config.js", "client.js", "discover.js", "product-commands.js", "product-registry.js", "version.js", "compat.js", "diagnostics.js", "maintenance.js"]) {
  check(npmEntries.has(`package/src/${file}`), `npm tarball is missing src/${file}`);
}
check(npmEntries.has("package/README.md"), "npm tarball is missing README.md");

// The CLI is an access client, not an installer: shipping code that spawns
// processes would make it possible to start runtimes or services behind the
// operator's back.
for (const [path, entry] of npmEntries) {
  if (!path.endsWith(".js")) continue;
  check(
    !entry.data.toString("utf8").includes("child_process"),
    `${path} must not spawn processes`,
  );
}

// --- standalone tree -------------------------------------------------------
const tgzEntries = readTar(gunzipSync(await readFile(join(DIST, standaloneTgzName))));
const zipEntries = readZip(await readFile(join(DIST, standaloneZipName)));

for (const path of tgzEntries.keys()) {
  check(path.startsWith(root), `standalone tarball entry outside ${root}: ${path}`);
  check(!path.includes(".."), `standalone tarball entry escapes its root: ${path}`);
  check(!/(^|\/)(node_modules|\.git|dist|coverage)\//.test(path), `standalone tarball contains a forbidden path: ${path}`);
}

const launcher = tgzEntries.get(`${root}bin/coderax`);
check(launcher !== undefined, "standalone tarball is missing bin/coderax");
if (launcher) {
  check(launcher.data.toString("utf8").startsWith("#!/bin/sh"), "bin/coderax must start with a POSIX shebang");
  check(launcher.data.toString("utf8").includes("../src/cli.js"), "bin/coderax must resolve src/cli.js relative to itself");
  check((launcher.mode & 0o111) !== 0, "bin/coderax must be executable");
}
check(tgzEntries.has(`${root}bin/coderax.cmd`), "standalone tarball is missing bin/coderax.cmd");
check(tgzEntries.has(`${root}install.sh`), "standalone tarball is missing install.sh");
check(tgzEntries.has(`${root}uninstall.sh`), "standalone tarball is missing uninstall.sh");
check(tgzEntries.has(`${root}package.json`), "standalone tarball is missing package.json");
check(tgzEntries.has(`${root}src/cli.js`), "standalone tarball is missing src/cli.js");

check(zipEntries.size === tgzEntries.size, `zip and tarball entry counts differ (${zipEntries.size} vs ${tgzEntries.size})`);
for (const [path, entry] of tgzEntries) {
  const zipped = zipEntries.get(path);
  check(zipped !== undefined, `zip is missing ${path}`);
  if (zipped) {
    check(zipped.data.equals(entry.data), `zip and tarball disagree about ${path}`);
    check((zipped.mode & 0o777) === (entry.mode & 0o777), `zip and tarball disagree about the mode of ${path}`);
  }
}

// --- file inventory --------------------------------------------------------
const manifestFiles = new Map((manifest.files ?? []).map((file) => [file.path, file]));
check(manifestFiles.size > 0, "manifest file inventory is empty");
for (const [path, entry] of tgzEntries) {
  const relative = path.slice(root.length);
  const recorded = manifestFiles.get(relative);
  check(recorded !== undefined, `manifest is missing ${relative}`);
  if (recorded) {
    check(recorded.sha256 === sha256(entry.data), `manifest hash mismatch for ${relative}`);
    check(recorded.size === entry.data.length, `manifest size mismatch for ${relative}`);
    check(recorded.mode === (entry.mode & 0o777).toString(8).padStart(4, "0"), `manifest mode mismatch for ${relative}`);
  }
}

// --- SBOM ------------------------------------------------------------------
const sbom = readJson(await readFile(join(DIST, "sbom.spdx.json")));
check(sbom.spdxVersion === "SPDX-2.3", "SBOM must be SPDX-2.3");
check(sbom.packages?.[0]?.versionInfo === VERSION, "SBOM version does not match the release");
check(
  sbom.packages?.[0]?.externalRefs?.[0]?.referenceLocator === `pkg:npm/${PACKAGE_NAME}@${VERSION}`,
  "SBOM purl does not match the release",
);

// --- report ----------------------------------------------------------------
notes.push(`${npmEntries.size} files in the npm tarball, ${tgzEntries.size} in the standalone tree`);
notes.push(`${manifest.artifacts?.length ?? 0} artifacts, ${sumsByName.size} checksums, ${manifestFiles.size} inventoried files`);

for (const note of notes) console.log(`  ok  ${note}`);
if (failures.length > 0) {
  console.error(`\ncoderax verify: ${failures.length} problem(s) found`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`coderax verify: PASS (${PACKAGE_NAME} ${VERSION})`);
