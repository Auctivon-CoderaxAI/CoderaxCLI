import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.js";
import * as clientApi from "../src/client.js";

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
  assert.equal(
    source.includes("\r\n"),
    false,
    "src/cli.js must be checked out with LF line endings; see .gitattributes",
  );
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
  assert.match(help.stdout, /^  coderax products\b/m);

  assert.ok(packageJson.files.includes("src/"), "the published artifact must include src/");
  assert.equal(
    packageJson.files.some((entry) => entry.startsWith("test")),
    false,
    "tests must not ship in the artifact",
  );
});

test("[capability:shared-sdk-integrity] the shared client is dependency-free ESM with a stable surface", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(VERSION, packageJson.version, "src/version.js must match package.json");
  assert.equal(packageJson.dependencies, undefined, "the shared client must not depend on a runtime package");
  assert.deepEqual(Object.keys(clientApi).sort(), [...EXPECTED_CLIENT_EXPORTS].sort());
  for (const key of EXPECTED_CLIENT_EXPORTS) assert.equal(typeof clientApi[key], "function", key);

  const registry = await readFile(join(ROOT, "src/product-registry.js"), "utf8");
  assert.equal(/^\s*import\s/m.test(registry), false, "the shared product registry must stay dependency-free");
  assert.match(registry, /Object\.freeze/);

});
