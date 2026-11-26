import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startWorkflowHarness } from "./support/workflow-harness.js";
import { cliWorkspace, json, runCapabilityCli } from "./support/cli-harness.js";

async function harness(t, options) {
  const instance = await startWorkflowHarness(options);
  t.after(() => instance.close());
  return instance;
}

async function createsArtifact(server, cwd) {
  const result = await runCapabilityCli(["create-document", "an artifact to test", "--json"], {
    harness: server,
    cwd,
  });
  assert.equal(result.code, 0, result.stderr);
  return json(result.stdout).artifacts[0];
}

test("artifacts list and inspect read the authoritative task-scoped records", async (t) => {
  const server = await harness(t);
  const cwd = await cliWorkspace();
  const artifact = await createsArtifact(server, cwd);
  const taskId = [...server.state.tasks.keys()][0];

  const list = await runCapabilityCli(["artifacts", "list", "--task", taskId, "--json"], { harness: server, cwd });
  assert.equal(list.code, 0, list.stderr);
  assert.equal(json(list.stdout).artifacts.length, 1);

  const inspect = await runCapabilityCli(
    ["artifacts", "inspect", artifact.artifactId, "--task", taskId, "--json"],
    { harness: server, cwd },
  );
  assert.equal(inspect.code, 0, inspect.stderr);
  const record = json(inspect.stdout).artifact;
  assert.equal(record.artifactId, artifact.artifactId);
  assert.equal(record.path, "result.md");
  assert.equal(record.digest, artifact.digest);
  assert.equal(record.bytes, artifact.bytes);
});

test("artifacts download verifies the published digest", async (t) => {
  const server = await harness(t);
  const cwd = await cliWorkspace();
  const artifact = await createsArtifact(server, cwd);
  const out = join(cwd, "downloaded.md");

  const taskId = [...server.state.tasks.keys()][0];
  const result = await runCapabilityCli(
    ["artifacts", "download", artifact.artifactId, "--task", taskId, "--out", out, "--json"],
    { harness: server, cwd },
  );
  assert.equal(result.code, 0, result.stderr);
  const document = json(result.stdout);
  assert.equal(document.download.sha256, artifact.digest.slice(7));
  assert.match(await readFile(out, "utf8"), /an artifact to test/);
});

test("a tampered content digest is refused and no file is written", async (t) => {
  const server = await harness(t, { tamperContent: true });
  const cwd = await cliWorkspace();
  const artifact = await createsArtifact(server, cwd);
  const out = join(cwd, "tampered.md");

  const taskId = [...server.state.tasks.keys()][0];
  const result = await runCapabilityCli(
    ["artifacts", "download", artifact.artifactId, "--task", taskId, "--out", out],
    { harness: server, cwd },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ARTIFACT_INTEGRITY_FAILED/);
  await assert.rejects(() => access(out));
});

test("an existing destination is not replaced without --force", async (t) => {
  const server = await harness(t);
  const cwd = await cliWorkspace();
  const artifact = await createsArtifact(server, cwd);
  const out = join(cwd, "existing.md");
  await writeFile(out, "do not lose this\n");

  const taskId = [...server.state.tasks.keys()][0];
  const refused = await runCapabilityCli(
    ["artifacts", "download", artifact.artifactId, "--task", taskId, "--out", out],
    { harness: server, cwd },
  );
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /ARTIFACT_DESTINATION_EXISTS/);
  assert.equal(await readFile(out, "utf8"), "do not lose this\n");

  const replaced = await runCapabilityCli(
    ["artifacts", "download", artifact.artifactId, "--task", taskId, "--out", out, "--force"],
    { harness: server, cwd },
  );
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.match(await readFile(out, "utf8"), /an artifact to test/);
});

test("an unknown artifact is a not-found failure", async (t) => {
  const server = await harness(t);
  const cwd = await cliWorkspace();
  await createsArtifact(server, cwd);
  const taskId = [...server.state.tasks.keys()][0];
  const result = await runCapabilityCli(
    ["artifacts", "inspect", "artifact-does-not-exist", "--task", taskId],
    { harness: server, cwd },
  );
  assert.equal(result.code, 5);
  assert.match(result.stderr, /NOT_FOUND/);
});

test("an artifact name cannot choose a directory outside the destination", async (t) => {
  const server = await harness(t, { artifactPath: "nested/evil.md" });
  const cwd = await cliWorkspace();
  const artifact = await createsArtifact(server, cwd);

  const taskId = [...server.state.tasks.keys()][0];
  const result = await runCapabilityCli(
    ["artifacts", "download", artifact.artifactId, "--task", taskId, "--json"],
    { harness: server, cwd },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(json(result.stdout).download.path, join(cwd, "evil.md"));
  await assert.rejects(() => access(join(cwd, "nested")));
});

test("artifacts list requires a task", async (t) => {
  const server = await harness(t);
  const cwd = await cliWorkspace();
  const result = await runCapabilityCli(["artifacts", "list"], { harness: server, cwd });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--task/);
});
