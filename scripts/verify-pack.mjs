#!/usr/bin/env node
/**
 * Pack the exact release artifact, install it into a clean prefix, and verify
 * its bin entrypoint, dependency tree and package contents. This catches
 * "works from the checkout, broken when packed" failures before release.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const temp = await mkdtemp(join(tmpdir(), "coderax-pack-"));
const failures = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: options.cwd ?? root,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", ...(options.env ?? {}) },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

try {
  await mkdir(join(temp, "pack"), { recursive: true });
  const packOutput = run(npm, ["pack", "--json", "--pack-destination", join(temp, "pack")], {
    cwd: root,
  });
  let packed;
  try {
    packed = JSON.parse(packOutput);
  } catch {
    throw new Error(`npm pack did not return JSON:\n${packOutput}`);
  }
  expect(Array.isArray(packed) && packed.length === 1, "npm pack must produce exactly one tarball");
  const info = packed[0];
  const tarball = join(temp, "pack", info.filename);
  const contents = (info.files ?? []).map((file) => file.path.split(sep).join("/"));
  for (const forbidden of ["test/", "node_modules/", ".env", ".github/", "scripts/"]) {
    expect(!contents.some((file) => file === forbidden || file.startsWith(forbidden)), `packed archive contains ${forbidden}`);
  }
  for (const required of ["package.json", "src/cli.js", "README.md", "docs/CONTRACT.md"]) {
    expect(contents.includes(required), `packed archive is missing ${required}`);
  }
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(info.name === manifest.name, `packed name ${info.name} does not match ${manifest.name}`);
  expect(info.version === manifest.version, `packed version ${info.version} does not match ${manifest.version}`);

  const installDir = join(temp, "install");
  run(npm, ["install", "--prefix", installDir, "--no-audit", "--no-fund", "--ignore-scripts", tarball]);
  const packageDir = join(installDir, "node_modules", manifest.name);
  const installed = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  expect(installed.version === manifest.version, "installed version differs from package.json");
  expect(installed.dependencies == null || Object.keys(installed.dependencies).length === 0, "packed runtime must have no dependencies");
  const bin = installed.bin?.coderax;
  expect(typeof bin === "string" && bin.length > 0, "installed package has no bin.coderax");
  if (bin) {
    const target = join(packageDir, bin);
    expect((await stat(target)).isFile(), `bin target ${bin} is missing`);
    const versionOutput = run(process.execPath, [target, "--version"], { cwd: temp }).trim();
    expect(versionOutput.includes(manifest.version), `packed --version returned "${versionOutput}", expected it to include "${manifest.version}"`);
    const helpOutput = run(process.execPath, [target, "--help"], { cwd: temp });
    expect(helpOutput.includes("USAGE") || helpOutput.includes("Usage"), "packed --help did not print usage");
    const completionOutput = run(process.execPath, [target, "completion", "bash"], { cwd: temp });
    expect(completionOutput.includes("complete -F"), "packed completion output is incomplete");
  }

  const dependencyTree = JSON.parse(run(npm, ["ls", "--prefix", installDir, "--omit=dev", "--json"]));
  expect(Object.keys(dependencyTree.dependencies ?? {}).length === 1, "packed install unexpectedly contains extra packages");
  expect(dependencyTree.problems == null || dependencyTree.problems.length === 0, "packed dependency tree has problems");

  const topLevel = await readdir(packageDir);
  for (const name of ["node_modules", ".github", "test"]) {
    expect(!topLevel.includes(name), `installed package unexpectedly contains ${name}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`pack: ${failure}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`pack: ${info.filename} installs cleanly with a working bin and no runtime dependencies\n`);
    process.stdout.write(`  ${contents.length} files in the published package\n`);
  }
} catch (error) {
  process.stderr.write(`pack: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
