import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectInstallMethod } from "../src/diagnostics.js";

async function layout(root, { project = false } = {}) {
  const packageDir = join(root, "node_modules", "coderax-cli", "src");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "diagnostics.js"), "\n");
  if (project) await writeFile(join(root, "package.json"), "{}\n");
  return join(packageDir, "diagnostics.js");
}

test("[capability:installation-method] a project dependency is reported as npm-local", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "coderax-install-")), "project");
  const modulePath = await layout(root, { project: true });
  assert.equal(detectInstallMethod(modulePath), "npm-local");
});

test("[capability:installation-method] a Windows-shaped global prefix is npm-global", async () => {
  // Windows local and global installs share a package layout. Only a global
  // install puts the launcher next to node_modules rather than inside .bin.
  const root = join(await mkdtemp(join(tmpdir(), "coderax-install-")), "npm global");
  const modulePath = await layout(root);
  const windows = { platform: "win32" };
  assert.equal(detectInstallMethod(modulePath, windows), "npm-local");
  await writeFile(join(root, "coderax.cmd"), "@echo off\n");
  assert.equal(detectInstallMethod(modulePath, windows), "npm-global");
});

test("[capability:installation-method] a POSIX global prefix is npm-global", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "coderax-install-")), "npm global", "lib");
  const modulePath = await layout(root);
  assert.equal(detectInstallMethod(modulePath), "npm-global");
});
