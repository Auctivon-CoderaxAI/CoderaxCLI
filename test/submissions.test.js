import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubmissionLedger } from "../src/submissions.js";

async function tempLedger(baseUrl = "https://engine.test") {
  const dir = await mkdtemp(join(tmpdir(), "coderax-submissions-"));
  const path = join(dir, "submissions.json");
  return { path, ledger: createSubmissionLedger({ baseUrl, path }) };
}

test("a submission key survives a new process", async () => {
  const { path, ledger } = await tempLedger();
  assert.equal(await ledger.submission("key-1"), null);
  await ledger.upsertSubmission("key-1", {
    status: "submitting",
    objective: "change it",
    createdAt: "2026-11-27T00:00:00.000Z",
  });

  // A fresh instance is what the next CLI process sees after a crash.
  const reopened = createSubmissionLedger({ baseUrl: "https://engine.test", path });
  const record = await reopened.submission("key-1");
  assert.equal(record.status, "submitting");
  assert.equal(record.objective, "change it");
});

test("the ledger is private and contains no token", async () => {
  const { path, ledger } = await tempLedger();
  await ledger.upsertSubmission("key-2", { status: "uncertain" });
  const info = await stat(path);
  if (process.platform !== "win32") {
    assert.equal(info.mode & 0o777, 0o600);
  }
  const text = await readFile(path, "utf8");
  assert.equal(text.includes("token"), false);
});

test("deployments cannot collide on a submission key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coderax-submissions-"));
  const path = join(dir, "submissions.json");
  const first = createSubmissionLedger({ baseUrl: "https://one.test", path });
  const second = createSubmissionLedger({ baseUrl: "https://two.test", path });
  await first.upsertSubmission("shared-key", { status: "uncertain" });
  assert.equal(await second.submission("shared-key"), null);
  assert.equal((await first.submission("shared-key")).status, "uncertain");
});

test("task records are listed newest first", async () => {
  const { ledger } = await tempLedger();
  await ledger.upsertTask({ taskId: "task_1", updatedAt: "2026-11-27T00:00:01.000Z" });
  await ledger.upsertTask({ taskId: "task_2", updatedAt: "2026-11-27T00:00:05.000Z" });
  const tasks = await ledger.listTasks();
  assert.deepEqual(tasks.map((task) => task.taskId), ["task_2", "task_1"]);
});
