#!/usr/bin/env node
/**
 * Prove the package installs from its own tarball on Linux, macOS and Windows
 * without touching a registry. Used by the CI matrix.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
// Exercise path quoting on every CI runner, even when its temp root has no spaces.
const temp = await mkdtemp(join(tmpdir(), "coderax install-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function quoteCmdArg(value) {
  // cmd.exe expands percent variables even within quotes.
  if (/["%\r\n]/.test(value)) throw new Error("unsupported character in Windows smoke command");
  return `"${value}"`;
}

function run(command, args) {
  const options = { encoding: "utf8", cwd: root };
  // The Windows npm and coderax shims are batch scripts. /s strips the outer
  // quotes, leaving the executable and each argument quoted inside /c.
  const result = process.platform === "win32" && command !== process.execPath
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", [
        "/d", "/v:off", "/s", "/c", `"${[command, ...args].map(quoteCmdArg).join(" ")}"`,
      ], { ...options, windowsVerbatimArguments: true })
    : spawnSync(command, args, options);
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
  run(process.execPath, [join(root, "scripts", "build-release.mjs"), "--out", temp]);
  const manifest = JSON.parse(readFileSync(join(temp, "release-manifest.json"), "utf8"));
  const tarball = join(temp, `coderax-cli-${manifest.version}.tgz`);
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
