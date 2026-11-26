import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src/cli.js");
const IS_WINDOWS = process.platform === "win32";

const EXPECTED_CLIENT_EXPORTS = [
  "CoderaxError",
  "formatJson",
  "redact",
  "redactValue",
  "request",
  "streamRequest",
];

test("[capability:executable-entrypoints] the package exposes an executable coderax entrypoint", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.bin.coderax, "src/cli.js");
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.private, true, "keep accidental publishing impossible until authorized");
  assert.deepEqual(Object.keys(packageJson.bin), ["coderax"]);

  const source = await readFile(CLI, "utf8");
  assert.equal(source.split("\n")[0], "#!/usr/bin/env node");

  if (!IS_WINDOWS) {
    const mode = (await stat(CLI)).mode & 0o777;
    assert.ok(mode & 0o111, `src/cli.js must be executable, mode is ${mode.toString(8)}`);
  }

  const version = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^coderax-cli \d+\.\d+\.\d+\s*$/);

  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:\n  coderax products/);

  assert.ok(packageJson.files.includes("src/"), "the published artifact must include src/");
  assert.equal(
    packageJson.files.some((entry) => entry.startsWith("test")),
    false,
    "tests must not ship in the artifact",
  );
});

test("[capability:shared-sdk-integrity] the shared client is dependency-free ESM with a stable surface", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const versionSource = await readFile(join(ROOT, "src/version.js"), "utf8");
  const declared = /export const VERSION = "([^"]+)"/.exec(versionSource)?.[1];
  assert.equal(declared, packageJson.version, "src/version.js must match package.json");
  assert.equal(
    packageJson.dependencies,
    undefined,
    "the shared client must not depend on a runtime package",
  );

  const client = await readFile(join(ROOT, "src/client.js"), "utf8");
  assert.equal(/^\s*import\s/m.test(client), false, "src/client.js must stay dependency-free");
  assert.equal(/\brequire\s*\(/.test(client), false);

  const exports = [...client.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+(\w+)/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(exports, [...EXPECTED_CLIENT_EXPORTS].sort(), "the shared client surface changed");

  const registry = await readFile(join(ROOT, "src/product-registry.js"), "utf8");
  assert.equal(/^\s*import\s/m.test(registry), false, "the shared product registry must stay dependency-free");
  assert.match(registry, /Object\.freeze/);

  const modules = (await readdir(join(ROOT, "src"))).filter((name) => name.endsWith(".js"));
  for (const name of modules) {
    const source = await readFile(join(ROOT, "src", name), "utf8");
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith("./") || specifier.startsWith("node:"),
        `${name} imports ${specifier}; only relative modules and node: builtins are allowed`,
      );
    }
  }
});
