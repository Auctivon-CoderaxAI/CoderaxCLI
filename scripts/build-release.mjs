#!/usr/bin/env node
/**
 * Build the release artifacts.
 *
 * Determinism: every archive entry is sorted, uid/gid are zero, permissions are
 * normalized, and a fixed mtime (SOURCE_DATE_EPOCH, default 1985-10-26T08:15Z,
 * the same epoch npm uses) replaces filesystem times. Building twice from the
 * same source therefore produces identical bytes; `npm run repro` proves it.
 *
 * Outputs (in dist/, or --out):
 *   coderax-cli-<version>.tgz                  npm-compatible tarball
 *   coderax-cli-<version>-standalone.tar.gz    POSIX standalone tree
 *   coderax-cli-<version>-standalone.zip       Windows standalone tree
 *   release-manifest.json                      versions, hashes, file inventory
 *   SHA256SUMS                                 checksums for every asset
 *   sbom.spdx.json                             SPDX SBOM
 *   release-notes.md                           notes for the GitHub Release
 *   install.sh / install.ps1                   installers (also release assets)
 *   uninstall.sh / uninstall.ps1               uninstallers
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createTarGz, createZip } from "./lib/archive.mjs";
import {
  COMPATIBILITY_BASIS,
  SUPPORTED_API_VERSION,
  SUPPORTED_DEPLOYMENT_RANGE,
} from "../src/compat.js";
import { NODE_REQUIREMENT, PACKAGE_NAME, VERSION as PACKAGE_VERSION } from "../src/version.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

const DEFAULT_SOURCE_DATE_EPOCH = 499162500; // 1985-10-26T08:15:00Z, npm's fixed pack time

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

const OUT = resolve(ROOT, option("out", "dist"));
const SOURCE_DATE_EPOCH = Number(process.env.SOURCE_DATE_EPOCH ?? DEFAULT_SOURCE_DATE_EPOCH);
if (!Number.isInteger(SOURCE_DATE_EPOCH) || SOURCE_DATE_EPOCH <= 0) {
  throw new Error("SOURCE_DATE_EPOCH must be a positive integer");
}
const OVERRIDE_VERSION = option("version", null);
if (OVERRIDE_VERSION !== null && !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(OVERRIDE_VERSION)) {
  throw new Error("--version must be a semantic version such as 1.2.3");
}
const VERSION = OVERRIDE_VERSION ?? PACKAGE_VERSION;
const MTIME = SOURCE_DATE_EPOCH * 1000;

const BASE = `${PACKAGE_NAME}-${VERSION}`;
const NPM_TARBALL = `${BASE}.tgz`;
const STANDALONE_TGZ = `${BASE}-standalone.tar.gz`;
const STANDALONE_ZIP = `${BASE}-standalone.zip`;
const STANDALONE_ROOT = `${BASE}/`;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function portable(path) {
  return path.split(sep).join("/");
}

async function walk(directory, bundled = false) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if ([".git", "coverage"].includes(entry.name) || (!bundled && ["dist", "node_modules"].includes(entry.name))) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, bundled)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** Resolve the npm `files` list into concrete repository-relative paths. */
async function packageFiles() {
  const selected = new Set(["package.json", "README.md"]);
  for (const entry of pkg.files ?? []) {
    if (entry.endsWith("/")) {
      for (const file of await walk(join(ROOT, entry))) selected.add(portable(relative(ROOT, file)));
    } else if (existsSync(join(ROOT, entry))) {
      selected.add(entry);
    }
  }
  return [...selected].sort((a, b) => a.localeCompare(b));
}

function isExecutable(file) {
  return file === "src/cli.js" || file.endsWith(".sh");
}

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".json", ".md", ".sh", ".ps1", ".cmd"]);
const CRLF_EXTENSIONS = new Set([".ps1", ".cmd"]);

/**
 * Normalize line endings at pack time so an artifact is identical whether it
 * was built from a Linux or a Windows checkout: scripts use CRLF, everything
 * else uses LF.
 */
function normalizeText(file, buffer) {
  const dot = file.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.slice(dot);
  if (!TEXT_EXTENSIONS.has(extension)) return buffer;
  let text = buffer.toString("utf8").replace(/\r\n/g, "\n");
  if (CRLF_EXTENSIONS.has(extension)) text = text.replace(/\n/g, "\r\n");
  return Buffer.from(text, "utf8");
}

async function entriesFrom(prefix, files, overrides = new Map()) {
  const entries = [];
  for (const file of files) {
    const raw = overrides.get(file) ?? (await readFile(join(ROOT, file)));
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    entries.push({
      path: `${prefix}${file}`,
      data: normalizeText(file, data),
      mode: isExecutable(file) ? 0o755 : 0o644,
    });
  }
  return entries;
}

/** npm expects package/package.json first; deterministic order for the rest. */
function npmOrder(entries) {
  const weight = (path) => {
    if (path === "package/package.json") return 0;
    if (path === "package/README.md") return 1;
    return 2;
  };
  return [...entries].sort((a, b) => weight(a.path) - weight(b.path) || a.path.localeCompare(b.path));
}

const POSIX_LAUNCHER = `#!/bin/sh
# Coderax CLI launcher (standalone install). Generated by the release build.
set -eu
target=$0
while [ -L "$target" ]; do
  link=$(readlink "$target")
  case $link in
    /*) target=$link ;;
    *) target=$(dirname "$target")/$link ;;
  esac
done
dir=$(cd -P "$(dirname "$target")" && pwd)
exec node "$dir/../src/cli.js" "$@"
`;

const WINDOWS_LAUNCHER = [
  "@echo off",
  "setlocal",
  "node \"%~dp0..\\src\\cli.js\" %*",
  "exit /b %ERRORLEVEL%",
  "",
].join("\r\n");

async function releaseNotes() {
  const changelog = await readFile(join(ROOT, "CHANGELOG.md"), "utf8").catch(() => "");
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${VERSION}]`));
  if (start === -1) return `## ${VERSION}\n\nSee CHANGELOG.md for details.\n`;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return `${lines.slice(start, end === -1 ? undefined : end).join("\n").trim()}\n`;
}

const lock = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8"));
const runtimePackages = pkg.bundleDependencies.map((name, index) => {
  const { version, resolved } = lock.packages[`node_modules/${name}`];
  return {
    name,
    versionInfo: version,
    SPDXID: `SPDXRef-Runtime-${index}`,
    downloadLocation: resolved.startsWith("https:") ? resolved : "NOASSERTION",
    filesAnalyzed: false,
  };
});

function sbom() {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${PACKAGE_NAME}@${VERSION}`,
    documentNamespace: `https://github.com/Auctivon-CoderaxAI/CoderaxCLI/releases/tag/v${VERSION}/sbom`,
    creationInfo: {
      created: new Date(MTIME).toISOString(),
      creators: ["Tool: coderax-cli-build-release"],
    },
    comment:
      "Coderax CLI bundles its pinned capability SDK and schema validator. It never installs Ollama, containers, local AI runtimes, databases, or background services.",
    packages: [
      {
        name: PACKAGE_NAME,
        versionInfo: VERSION,
        SPDXID: "SPDXRef-Package",
        downloadLocation: `https://github.com/Auctivon-CoderaxAI/CoderaxCLI/releases/tag/v${VERSION}`,
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        supplier: "NOASSERTION",
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: `pkg:npm/${PACKAGE_NAME}@${VERSION}`,
          },
        ],
      },
      ...runtimePackages,
    ],
    relationships: [
      ...runtimePackages.map((entry) => ({
        spdxElementId: "SPDXRef-Package",
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: entry.SPDXID,
      })),
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: "SPDXRef-Package",
      },
    ],
  };
}

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

if (pkg.version !== PACKAGE_VERSION) throw new Error("package.json and src/version.js disagree about the version");
if (pkg.name !== PACKAGE_NAME) throw new Error("package name mismatch between package.json and src/version.js");

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const packageList = await packageFiles();
const scriptFiles = ["install.sh", "install.ps1", "uninstall.sh", "uninstall.ps1"];
for (const script of scriptFiles) {
  if (!existsSync(join(ROOT, "scripts", script))) throw new Error(`missing installer: scripts/${script}`);
}

// The installers must be able to extract an archive without trusting the host
// tar/zip implementation, and without downloading a second helper. Their safe
// extractor is embedded at build time as base64; verify-release decodes it and
// compares it with these sources so the shipped copy cannot drift.
const EXTRACTOR_SOURCES = [
  ["scripts/lib/archive.mjs", "@CODERAX_ARCHIVE_B64@"],
  ["scripts/lib/safe-extract.mjs", "@CODERAX_EXTRACT_B64@"],
];

async function injectExtractors(script) {
  let text = await readFile(join(ROOT, "scripts", script), "utf8");
  for (const [source, marker] of EXTRACTOR_SOURCES) {
    const body = await readFile(join(ROOT, source));
    text = text.split(marker).join(body.toString("base64"));
  }
  return Buffer.from(text, "utf8");
}

const installerScripts = new Map();
for (const script of scriptFiles) {
  installerScripts.set(
    script,
    script.startsWith("install") ? await injectExtractors(script) : await readFile(join(ROOT, "scripts", script)),
  );
}

const versionOverride = new Map([["package.json", JSON.stringify({ ...pkg, version: VERSION }, null, 2) + "\n"]]);
const runtimeFiles = (await Promise.all(
  pkg.bundleDependencies.map((name) => walk(join(ROOT, "node_modules", name), true)),
)).flat().map((file) => portable(relative(ROOT, file)));
const bundledFiles = [...packageList, ...runtimeFiles];
const npmEntries = npmOrder(await entriesFrom("package/", bundledFiles, versionOverride));

const standaloneFiles = [...bundledFiles, ...scriptFiles];
const overrides = new Map([
  ...versionOverride,
  ["bin/coderax", POSIX_LAUNCHER],
  ["bin/coderax.cmd", WINDOWS_LAUNCHER],
  ...scriptFiles.map((file) => [file, null]),
]);
for (const file of scriptFiles) {
  overrides.set(file, installerScripts.get(file));
}
// bin/* are launchers, not repository files; add them explicitly.
async function standaloneEntries() {
  const entries = await entriesFrom(STANDALONE_ROOT, standaloneFiles.filter((file) => !file.startsWith("bin/")), overrides);
  for (const launcher of ["bin/coderax", "bin/coderax.cmd"]) {
    entries.push({
      path: `${STANDALONE_ROOT}${launcher}`,
      data: Buffer.from(overrides.get(launcher)),
      mode: launcher.endsWith(".cmd") ? 0o644 : 0o755,
    });
  }
  // Explicit layout marker: diagnostics can identify a standalone install from
  // any prefix, including one the installer was pointed at by --prefix.
  entries.push({
    path: `${STANDALONE_ROOT}install-layout.json`,
    data: Buffer.from(`${JSON.stringify({ layout: "standalone", version: VERSION }, null, 2)}\n`),
    mode: 0o644,
  });
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

const standaloneEntriesList = await standaloneEntries();
const npmTarball = createTarGz(npmEntries, { mtime: MTIME });
const standaloneTgz = createTarGz(standaloneEntriesList, { mtime: MTIME });
const standaloneZip = createZip(standaloneEntriesList, { mtime: MTIME });

const artifacts = [
  { name: NPM_TARBALL, data: npmTarball },
  { name: STANDALONE_TGZ, data: standaloneTgz },
  { name: STANDALONE_ZIP, data: standaloneZip },
];

for (const artifact of artifacts) await writeFile(join(OUT, artifact.name), artifact.data);
await writeFile(join(OUT, "release-notes.md"), await releaseNotes());
for (const script of scriptFiles) {
  await writeFile(join(OUT, script), installerScripts.get(script));
}
const sbomBody = `${JSON.stringify(sbom(), null, 2)}\n`;
await writeFile(join(OUT, "sbom.spdx.json"), sbomBody);

const manifest = {
  schemaVersion: 1,
  name: PACKAGE_NAME,
  version: VERSION,
  sourceDate: new Date(MTIME).toISOString(),
  sourceDateEpoch: SOURCE_DATE_EPOCH,
  node: NODE_REQUIREMENT,
  supportedApiVersion: `${SUPPORTED_API_VERSION}.x`,
  supportedDeploymentRange: SUPPORTED_DEPLOYMENT_RANGE,
  compatibilityBasis: COMPATIBILITY_BASIS,
  commit: commit(),
  reproducible: "Run `npm run repro`; identical source and SOURCE_DATE_EPOCH produce identical artifact hashes.",
  artifacts: artifacts.map((artifact) => ({
    name: artifact.name,
    size: artifact.data.length,
    sha256: sha256(artifact.data),
    sha512: createHash("sha512").update(artifact.data).digest("base64"),
  })),
  files: standaloneEntriesList.map((entry) => ({
    path: entry.path.slice(STANDALONE_ROOT.length),
    size: entry.data.length,
    sha256: sha256(entry.data),
    mode: entry.mode.toString(8).padStart(4, "0"),
  })),
};
await writeFile(join(OUT, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const checksumTargets = [
  ...artifacts.map((artifact) => artifact.name),
  ...scriptFiles,
  "sbom.spdx.json",
  "release-notes.md",
].sort();
const checksumLines = [];
for (const name of checksumTargets) {
  const data = await readFile(join(OUT, name));
  checksumLines.push(`${sha256(data)}  ${name}`);
}
await writeFile(join(OUT, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

console.log(`coderax-cli ${VERSION} release artifacts -> ${portable(relative(ROOT, OUT)) || "."}`);
for (const artifact of artifacts) {
  console.log(`  ${artifact.name.padEnd(46)} ${String(artifact.data.length).padStart(9)} bytes  ${sha256(artifact.data)}`);
}
console.log(`  ${"SHA256SUMS".padEnd(46)} ${checksumTargets.length} checksums`);
console.log(`  ${"release-manifest.json".padEnd(46)} ${manifest.files.length} files inventoried`);
