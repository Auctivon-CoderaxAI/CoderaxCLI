import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkIsolation, fixtures } from "../scripts/lib/standalone.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function runtimeSources() {
  const sources = [];
  for (const name of (await readdir(join(ROOT, "src"))).filter((file) => file.endsWith(".js"))) {
    sources.push({ path: `src/${name}`, text: await readFile(join(ROOT, "src", name), "utf8") });
  }
  return sources;
}

test("[capability:dependency-security] there are no runtime dependencies or install scripts", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8"));

  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(Object.keys(lockfile.packages).length, 1, "the lockfile must contain only the root package");

  const violations = checkIsolation({ packageJson, lockfile, sources: await runtimeSources() });
  assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
});

test("[capability:workload-isolation] the CLI has no local inference, database, daemon, Docker or Ollama surface", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8"));
  const sources = await runtimeSources();

  for (const source of sources) {
    for (const token of ["docker", "ollama", "sqlite", "onnxruntime", "transformers"]) {
      assert.equal(
        new RegExp(`\\b${token}\\b`, "i").test(source.text),
        false,
        `${source.path} mentions ${token}; execution must stay cloud-hosted`,
      );
    }
  }

  const violations = checkIsolation({ packageJson, lockfile, sources });
  assert.deepEqual(violations, []);
});

test("the isolation gate rejects every class of local-execution dependency", () => {
  for (const fixture of fixtures()) {
    const violations = checkIsolation(fixture.input);
    assert.ok(
      violations.some((violation) => violation.code === fixture.expect),
      `${fixture.name} should raise ${fixture.expect}, got ${JSON.stringify(violations)}`,
    );
  }
});
