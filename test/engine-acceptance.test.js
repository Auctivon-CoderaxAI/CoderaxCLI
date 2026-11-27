import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CONTRACT_FINGERPRINT,
  CONTRACT_VERSION,
} from "../src/engine-contract.js";
import { EngineClient } from "../src/engine-client.js";
import {
  EngineTaskSynchronizer,
  enginePartition,
} from "../src/engine-sync.js";

/**
 * Cross-repository acceptance against a real WorkflowEngine HTTP application.
 *
 * This test is skipped unless an engine origin and owner token are supplied.
 * `scripts/run-engine-acceptance.mjs` starts the engine repository's own
 * `startTestApp()` harness at the pinned commit and sets both variables, so the
 * suite exercises the actual server (`@coderax/sdk`'s peer implementation), not
 * a mirror of legacy Coderax handlers.
 */

const URL = process.env.CODERAX_ENGINE_URL;
const TOKEN = process.env.CODERAX_ENGINE_TOKEN;
const enabled = typeof URL === "string" && URL !== "" && typeof TOKEN === "string" && TOKEN !== "";

function memoryStore() {
  let snapshot = null;
  return {
    path: "memory",
    snapshot: () => snapshot,
    load: async () => (snapshot === null ? null : structuredClone(snapshot)),
    persist: async (value) => {
      snapshot = structuredClone(value);
    },
  };
}

async function makeSync(url, token, store = memoryStore()) {
  const client = new EngineClient({
    baseUrl: url,
    token,
    timeoutMs: 10_000,
    eventTimeoutMs: 10_000,
  });
  const partition = enginePartition({ baseUrl: url, token, env: {} });
  const sync = new EngineTaskSynchronizer({ client, store, partition, sleep: async () => {} });
  await sync.load();
  return { client, sync, store, partition };
}

test("the engine publishes the pinned 1.2.0 contract", { skip: !enabled }, async () => {
  const { client } = await makeSync(URL, TOKEN);
  const handshake = await client.handshake();
  assert.equal(handshake.contractVersion, CONTRACT_VERSION);
  assert.equal(handshake.contractMajor, 1);
  assert.equal(handshake.eventSchemaVersion, 1);
  assert.equal(handshake.chatStreamVersion, 1);
  assert.equal(handshake.contractFingerprint, CONTRACT_FINGERPRINT);
  assert.equal(handshake.compatible, true);
  const report = await client.compatibility();
  assert.deepEqual(report.problems, []);
});

test("submit is idempotent, events replay durably and a second client sees the same task", { skip: !enabled }, async () => {
  const first = await makeSync(URL, TOKEN);
  const key = `cli-accept-${randomUUID()}`;
  const objective = "Prepare the acceptance checklist";

  const submitted = await first.sync.submit({ objective, idempotencyKey: key });
  assert.equal(submitted.accepted.state, "queued");
  assert.equal(submitted.replayed, false);
  const taskId = submitted.accepted.taskId;

  const text = [];
  const result = await first.sync.follow(taskId, {
    onEvent: (event, outcome) => {
      if (outcome.kind === "delta") text.push(outcome.text);
    },
  });
  assert.equal(result.terminal.state, "completed");
  assert.equal(result.confirmed, true);
  assert.ok(result.cursor > 0);
  assert.match(text.join(""), /A verified result\./);

  // A duplicate submission with the same key must return the original task.
  const duplicate = await makeSync(URL, TOKEN);
  const replayed = await duplicate.sync.submit({ objective, idempotencyKey: key });
  assert.equal(replayed.accepted.taskId, taskId);
  assert.equal(replayed.accepted.replayed, true);

  // A fresh client (the other surface) reads the same authoritative task and
  // can replay the full event history from zero.
  const second = await makeSync(URL, TOKEN);
  const shared = await second.sync.reconcile(taskId);
  assert.equal(shared.state, "completed");
  assert.equal(shared.generation, submitted.accepted.generation);
  const replay = await second.sync.follow(taskId);
  assert.equal(replay.terminal.state, "completed");
  assert.equal(replay.cursor, result.cursor);
});

test("notifications are durable and acknowledgement is idempotent", { skip: !enabled }, async () => {
  const { client, sync } = await makeSync(URL, TOKEN);
  // Produce a completion in this test so the assertion does not depend on a
  // previous test having run (node --test may filter by name).
  const seeded = await sync.submit({ objective: "Seed a completion notification" });
  await sync.follow(seeded.accepted.taskId);
  const list = await sync.notifications();
  assert.ok(list.unread >= 1);
  const taskId = list.notifications.find((notification) => !notification.read)?.taskId;
  assert.ok(taskId, "the engine must expose an unread completion notification");

  const first = await sync.acknowledge(taskId);
  assert.equal(first.notifications.find((entry) => entry.taskId === taskId)?.read, true);
  const second = await sync.acknowledge(taskId);
  assert.equal(second.unread, first.unread);
  const after = await client.notifications();
  assert.ok(after.unread <= list.unread);
});
