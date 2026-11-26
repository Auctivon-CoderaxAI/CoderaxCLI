#!/usr/bin/env node
/**
 * Prove the package installs from its own tarball on Linux, macOS and Windows
 * without touching a registry. Used by the CI matrix.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
// Exercise path quoting on every CI runner, even when its temp root has no spaces.
const temp = await mkdtemp(join(tmpdir(), "coderax-install-"));
const npm = "npm";

function fail(message) {
  console.error(message);
  const annotation = String(message).replace(/\r/g, "").replace(/\n/g, "%0A").slice(0, 900);
  console.log(`::error title=Install smoke::${annotation}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: root,
    // Windows resolves the npm shim through cmd.exe; without a shell spawnSync
    // reports ENOENT even though npm is on PATH.
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`command could not start: ${command} ${args.join(" ")}`);
    console.error(result.error.message);
  }
  if (result.status !== 0) {
    const detail = [
      `command failed: ${command} ${args.join(" ")}`,
      (result.stdout ?? "").trim(),
      (result.stderr ?? "").trim(),
    ].filter(Boolean).join("\n");
    fail(detail);
  }
  return result;
}

try {
  run(npm, ["pack", "--json", "--pack-destination", temp]);
  const candidates = (await readdir(temp)).filter((name) => name.endsWith(".tgz"));
  if (candidates.length !== 1) {
    fail(`npm pack left ${candidates.length} tarballs in ${temp}: ${candidates.join(", ")}`);
  }
  const tarball = join(temp, candidates[0]);
  const prefix = join(temp, "prefix");
  run(npm, [
    "install",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    tarball,
  ]);

  const bin =
    process.platform === "win32"
      ? join(prefix, "node_modules", ".bin", "coderax.cmd")
      : join(prefix, "node_modules", ".bin", "coderax");

  const version = run(bin, ["--version"]);
  if (!/coderax-cli \d+\.\d+\.\d+/.test(version.stdout)) {
    fail(`unexpected --version output: ${version.stdout}`);
  }

  const help = run(bin, ["--help"]);
  if (!help.stdout.includes("coderax work submit")) {
    fail("installed binary did not print the expected help");
  }

  console.log(`install smoke passed on ${process.platform}: ${version.stdout.trim()}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
