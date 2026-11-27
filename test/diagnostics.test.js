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

test(
  "[capability:installation-method] a Windows global prefix with a shim is npm-global",
  // `main` detects a Windows global install by the launcher npm writes into the
  // prefix (`coderax.cmd`), because a project dependency with bin-links disabled
  // has the identical `<prefix>/node_modules/<name>` layout and must stay
  // npm-local -- see test/release.test.js "npm install diagnostics use the
  // supplied layout for removal advice". That branch is win32-only.
  { skip: process.platform !== "win32" && "Windows-only install layout" },
  async () => {
    // npm on Windows installs global packages at `<prefix>/node_modules/<name>`
    // and puts its global launcher directly in the prefix.
    const root = join(await mkdtemp(join(tmpdir(), "coderax-install-")), "npm global");
    const modulePath = await layout(root);
    await writeFile(join(root, "coderax.cmd"), "");
    assert.equal(detectInstallMethod(modulePath), "npm-global");
  },
);

test("[capability:installation-method] a POSIX global prefix is npm-global", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "coderax-install-")), "npm global", "lib");
  const modulePath = await layout(root);
  assert.equal(detectInstallMethod(modulePath), "npm-global");
});
