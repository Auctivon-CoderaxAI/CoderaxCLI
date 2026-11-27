import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConversationStore,
  historyPathFor,
  isSensitivePrompt,
  normalizeHistorySettings,
  PromptHistory,
} from "../src/terminal/history.js";

async function tempPath(name = "history.json") {
  const dir = await mkdtemp(join(tmpdir(), "coderax-history-"));
  return join(dir, name);
}

test("history settings are bounded and environment-aware", () => {
  assert.deepEqual(normalizeHistorySettings({}, {}), {
    enabled: true,
    maxEntries: 200,
    retentionDays: 30,
  });
  assert.equal(normalizeHistorySettings({ enabled: false }, {}).enabled, false);
  assert.equal(normalizeHistorySettings({}, { CODERAX_HISTORY: "off" }).enabled, false);
  assert.equal(normalizeHistorySettings({}, { CODERAX_HISTORY: "on" }).enabled, true);
  assert.equal(normalizeHistorySettings({ maxEntries: 99999 }, {}).maxEntries, 200);
  assert.equal(normalizeHistorySettings({}, { CODERAX_HISTORY_MAX_ENTRIES: "5" }).maxEntries, 5);
  assert.equal(normalizeHistorySettings({}, { CODERAX_HISTORY_RETENTION_DAYS: "7" }).retentionDays, 7);
});

test("prompts that look sensitive are detected", () => {
  assert.equal(isSensitivePrompt("please summarize this file"), false);
  assert.equal(isSensitivePrompt("password=hunter2"), true);
  assert.equal(isSensitivePrompt("Authorization: Bearer abcdefghijklmnop"), true);
  assert.equal(isSensitivePrompt(`token: ${"1234567890abcdef".repeat(2)}`), true);
  assert.equal(isSensitivePrompt("-----BEGIN OPENSSH PRIVATE KEY-----"), true);
  assert.equal(isSensitivePrompt("read @src/index.js"), true);
  assert.equal(isSensitivePrompt("mail me at dev@example.com"), false);
});

test("prompts are persisted with private permissions and never responses", async (t) => {
  const path = await tempPath();
  const history = await PromptHistory.open({ path, settings: {} });
  const result = await history.add("summarize the repository", { mode: "chat" });
  assert.equal(result.stored, true);
  const raw = await readFile(path, "utf8");
  assert.match(raw, /summarize the repository/);
  assert.equal(history.list().length, 1);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o077, 0);
  } else {
    t.diagnostic("Windows ACL verification is covered by secure-store tests");
  }
});

test("sensitive prompts and attachment references are never written", async () => {
  const path = await tempPath();
  const history = await PromptHistory.open({ path, settings: {} });
  assert.equal((await history.add("password=hunter2")).reason, "sensitive");
  assert.equal((await history.add("read @src/private.js")).reason, "sensitive");
  await assert.rejects(() => readFile(path, "utf8"), (error) => error.code === "ENOENT");
});

test("history can be cleared, disabled and re-enabled", async () => {
  const path = await tempPath();
  const history = await PromptHistory.open({ path, settings: {} });
  await history.add("one");
  await history.setEnabled(false);
  assert.equal(history.enabled, false);
  assert.equal(history.size, 0);
  assert.equal((await history.add("two")).reason, "disabled");
  await assert.rejects(() => readFile(path, "utf8"), (error) => error.code === "ENOENT");
  await history.setEnabled(true);
  await history.add("three");
  assert.equal(history.size, 1);
});

test("retention prunes by age and count", async () => {
  let clock = 1_000_000_000_000;
  const path = await tempPath();
  const history = await PromptHistory.open({
    path,
    settings: { maxEntries: 2, retentionDays: 1 },
    now: () => clock,
  });
  await history.add("old");
  clock += 2 * 24 * 60 * 60 * 1000;
  await history.add("newer");
  await history.add("newest");
  await history.add("newest 2");
  assert.deepEqual(history.list().map((entry) => entry.text), ["newest", "newest 2"]);
});

test("clearing removes the file", async () => {
  const path = await tempPath();
  const history = await PromptHistory.open({ path, settings: {} });
  await history.add("one");
  await history.clear();
  assert.equal(history.size, 0);
  await assert.rejects(() => readFile(path, "utf8"), (error) => error.code === "ENOENT");
});

test("historyPathFor honours the override and lives beside the config", () => {
  // Built with join() so the expectation follows the host separator instead of
  // asserting POSIX paths on Windows.
  assert.equal(
    historyPathFor(join("/home/me", ".coderax", "config.json")),
    join("/home/me", ".coderax", "history.json"),
  );
  assert.equal(historyPathFor("/x/config.json", { CODERAX_HISTORY_FILE: "/tmp/h.json" }), "/tmp/h.json");
});

test("conversation metadata stores no responses and hides sensitive titles", async () => {
  const path = await tempPath("conversations.json");
  const store = await ConversationStore.open({ path });
  const entry = await store.upsert({
    conversationId: "srv-1",
    mode: "work",
    model: "gpt-4.1",
    agent: "reviewer",
    prompt: "build a release checklist",
  });
  assert.equal(entry.mode, "work");
  const raw = await readFile(path, "utf8");
  assert.match(raw, /release checklist/);
  const sensitive = await store.upsert({ conversationId: "srv-2", prompt: "password=hunter2" });
  assert.equal(sensitive.title, "Untitled session");
  const after = await readFile(path, "utf8");
  assert.equal(after.includes("hunter2"), false);
  assert.equal(after.includes("response"), false);
});

test("conversation metadata is bounded and can be cleared", async () => {
  const path = await tempPath("conversations.json");
  const store = await ConversationStore.open({ path, enabled: true });
  for (let index = 0; index < 60; index += 1) {
    await store.upsert({ conversationId: `srv-${index}`, prompt: `prompt ${index}` });
  }
  assert.equal(store.list().length, 50);
  assert.equal(JSON.parse(await readFile(path, "utf8")).conversations.length, 50);
  await store.clear();
  assert.equal(store.list().length, 0);
});

test("disabling history prevents conversation metadata from being persisted", async () => {
  const path = await tempPath("conversations-disabled.json");
  const store = await ConversationStore.open({ path, enabled: false });
  await store.upsert({ conversationId: "srv-1", prompt: "private prompt" });
  await assert.rejects(() => readFile(path, "utf8"), (error) => error.code === "ENOENT");
  assert.equal(store.list().length, 1);
});
