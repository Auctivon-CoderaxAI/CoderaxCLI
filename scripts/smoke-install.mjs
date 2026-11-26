#!/usr/bin/env node
/**
 * Prove the package installs from its own tarball on Linux, macOS and Windows
 * without touching a registry. Used by the CI matrix.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), "coderax-install-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: root,
    // Windows resolves npm and .cmd shims through cmd.exe. Without a shell,
    // spawnSync reports ENOENT/EINVAL for `npm` even though it is on PATH.
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) {
    console.error(`command could not start: ${command} ${args.join(" ")}`);
    console.error(result.error.message);
  }
  if (result.status !== 0) {
    console.error(`command failed: ${command} ${args.join(" ")}`);
    console.error(result.stdout ?? "");
    console.error(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result;
}

try {
  const pack = run("npm", ["pack", "--json", "--pack-destination", temp]);
  const parsed = JSON.parse(pack.stdout.trim());
  const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed?.filename;
  if (!filename) {
    console.error("npm pack did not report a filename");
    process.exit(1);
  }

  const tarball = join(temp, filename);
  const prefix = join(temp, "prefix");
  run("npm", [
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
    console.error(`unexpected --version output: ${version.stdout}`);
    process.exit(1);
  }

  const help = run(bin, ["--help"]);
  if (!help.stdout.includes("coderax work submit")) {
    console.error("installed binary did not print the expected help");
    process.exit(1);
  }

  console.log(`install smoke passed on ${process.platform}: ${version.stdout.trim()}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
