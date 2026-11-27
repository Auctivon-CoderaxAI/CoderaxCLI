import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeSources } from "../scripts/lib/runtime-sources.mjs";
import { isolationViolations } from "../scripts/lib/gates.mjs";
import { checkIsolation, fixtures } from "../scripts/lib/standalone.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("[capability:dependency-security] there are no runtime dependencies or install scripts", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8"));

  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(Object.keys(lockfile.packages).length, 1, "the lockfile must contain only the root package");

  const violations = checkIsolation({ packageJson, lockfile, sources: await runtimeSources(ROOT) });
  assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
});

test("[capability:workload-isolation] the CLI has no local inference, database, daemon, Docker or Ollama surface", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8"));
  const sources = await runtimeSources(ROOT);

  const violations = isolationViolations({ packageJson, lockfile, sources });
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

test("static imports and reexports cannot evade isolation through formatting", () => {
  const sources = [{
    path: "src/example.mjs",
    text: 'import"./local.mjs";import{Socket}from"node:net";export*from"node:http";export{fork}from/* gap */"node:child_process";',
  }, {
    path: "src/example.cjs",
    text: 'require ("node:sqlite");',
  }];
  const violations = checkIsolation({ packageJson: { bin: { coderax: "src/cli.js" } }, sources });
  for (const name of ["node:net", "node:http", "node:child_process", "node:sqlite"]) {
    assert.ok(violations.some(({ code, message }) => code === "LOCAL_EXECUTION_SURFACE" && message.includes(name)));
  }
});

test("the isolation gate accepts only the root of the lockfile", () => {
  const packageJson = { bin: { coderax: "src/cli.js" } };
  const root = { "": { name: "coderax-cli" } };
  assert.deepEqual(checkIsolation({ packageJson, lockfile: { lockfileVersion: 3, packages: root } }), []);
  for (const entry of [{}, { dev: true }, { optional: true }]) {
    const lockfile = { lockfileVersion: 3, packages: { ...root, "node_modules/example": entry } };
    assert.ok(checkIsolation({ packageJson, lockfile }).some(({ code }) => code === "RUNTIME_DEPENDENCY"));
  }
});
