import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateStore, emptyState, taskRecord } from "../src/state.js";
import { tempDir } from "./helpers.js";

async function store(prefix = "coderax-state-") {
  const dir = await tempDir(prefix);
  return { dir, file: join(dir, "state.json"), state: new StateStore({ filePath: join(dir, "state.json") }) };
}

test("emptyState has the documented shape", () => {
  const state = emptyState();
  assert.equal(state.version, 1);
  assert.equal(state.active.mode, "chat");
  assert.deepEqual(state.tasks, {});
  assert.deepEqual(state.submissions, {});
});

test("the journal is created with private permissions where the OS enforces them", async () => {
  const { dir, file, state } = await store();
  await state.setActive({ mode: "work" });
  if (process.platform === "win32") {
    // Windows has no POSIX mode bits; the per-user profile ACL is the boundary.
    assert.equal((await stat(file)).isFile(), true);
  } else {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }
  assert.equal(JSON.parse(await readFile(file, "utf8")).active.mode, "work");
});

test("upsertTask merges patches and never wipes a field with undefined", async () => {
  const { state } = await store();
  await state.upsertTask({ taskId: "task_1", state: "running", lastSeq: 4, agent: "coderax" });
  await state.upsertTask({ taskId: "task_1", state: undefined, lastSeq: 5 });
  const task = await state.task("task_1");
  assert.equal(task.state, "running");
  assert.equal(task.lastSeq, 5);
  assert.equal(task.agent, "coderax");
});

test("a second process sees writes made under the lock", async () => {
  const { file } = await store();
  const first = new StateStore({ filePath: file });
  const second = new StateStore({ filePath: file });
  await first.load();
  await second.setActive({ chatConversationId: "conv_b" });
  await first.setActive({ mode: "work" });
  const merged = JSON.parse(await readFile(file, "utf8"));
  assert.equal(merged.active.chatConversationId, "conv_b");
  assert.equal(merged.active.mode, "work");
});

test("a corrupt journal is quarantined and reset instead of crashing", async () => {
  const { dir, file, state } = await store();
  await writeFile(file, "{not json", "utf8");
  const loaded = await state.load();
  assert.equal(loaded.version, 1);
  assert.match(state.warnings.join(" "), /unreadable/);
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(dir));
  assert.ok(entries.some((entry) => entry.startsWith("state.json.corrupt-")));
});

test("an older journal is repaired in place", async () => {
  const { file, state } = await store();
  await writeFile(file, JSON.stringify({ version: 0, active: { mode: "work" } }), "utf8");
  const loaded = await state.load();
  assert.equal(loaded.version, 1);
  assert.equal(loaded.active.mode, "work");
  assert.equal(loaded.history.chat.length, 0);
  assert.match(state.warnings.join(" "), /older shape/);
});

test("submission ledger, notifications and history are durable", async () => {
  const { state } = await store();
  await state.upsertSubmission("key", { status: "uncertain", conversationId: "conv_1" });
  assert.equal((await state.submission("key")).status, "uncertain");
  await state.markNotificationSeen("task:completed:x");
  assert.equal(await state.isNotificationSeen("task:completed:x"), true);
  await state.addHistory("work", "first");
  await state.addHistory("work", "first");
  await state.addHistory("work", "second");
  const snapshot = await state.snapshot();
  assert.deepEqual(snapshot.history.work, ["first", "second"]);
});

test("a lock failure rejects the update instead of losing it", async () => {
  const dir = await tempDir();
  const state = new StateStore({
    filePath: join(dir, "state.json"),
    lockImpl: async () => {
      throw Object.assign(new Error("locked"), { code: "STATE_LOCKED" });
    },
  });
  await assert.rejects(() => state.setActive({ mode: "work" }), /locked/);
});

test("taskRecord captures the accepted task without inventing an agent", () => {
  const record = taskRecord({
    accepted: { taskId: "t", conversationId: "c", state: "queued", generation: 2 },
    objective: "do it",
    agent: "coderax",
    mode: "cloud",
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(record.taskId, "t");
  assert.equal(record.generation, 2);
  assert.equal(record.lastSeq, 0);
  assert.equal(record.agent, "coderax");
});

test("history is bounded to 500 entries", async () => {
  const { state } = await store();
  for (let index = 0; index < 510; index += 1) {
    await state.addHistory("chat", `message-${index}`);
  }
  const snapshot = await state.snapshot();
  assert.equal(snapshot.history.chat.length, 500);
  assert.equal(snapshot.history.chat[0], "message-10");
});
