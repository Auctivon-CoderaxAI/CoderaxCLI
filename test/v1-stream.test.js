import test from "node:test";
import assert from "node:assert/strict";
import { watchTask } from "../packages/workflow-sdk/src/v1/index.js";

function event(seq, type, payload = {}) {
  return {
    v: 1,
    eventId: `evt_${seq}`,
    taskId: "task_1",
    seq,
    at: `2026-11-27T00:00:0${seq}.000Z`,
    agent: "coderax",
    generation: 0,
    type,
    payload,
  };
}

function clientDouble({ batches, statuses = [] }) {
  let call = 0;
  return {
    get calls() {
      return call;
    },
    async *events() {
      const batch = batches[call] ?? [];
      call += 1;
      for (const item of batch) yield { event: item, id: item.eventId };
    },
    async task() {
      const explicit = statuses.shift();
      if (explicit) return explicit;
      return {
        taskId: "task_1",
        conversationId: "conversation_1",
        state: "running",
        agent: "coderax",
        mode: "cloud",
        generation: 0,
        createdAt: "2026-11-27T00:00:00.000Z",
        updatedAt: "2026-11-27T00:00:00.000Z",
        cancelRequested: false,
        steps: [],
      };
    },
  };
}

test("a replayed event id is applied once and sequencing is preserved", async () => {
  const client = clientDouble({
    batches: [
      [
        event(1, "task.started"),
        event(1, "task.started"),
        event(2, "text.delta", { text: "a" }),
        event(3, "task.completed", {}),
      ],
    ],
  });
  const seen = [];
  const result = await watchTask({
    client,
    taskId: "task_1",
    onEvent: (item) => seen.push(item.seq),
  });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(result.terminalEvent.type, "task.completed");
  assert.equal(result.lastSeq, 3);
});

test("a sequence gap reconnects from the last applied cursor", async () => {
  const client = clientDouble({
    batches: [
      [event(1, "task.started"), event(3, "text.delta", { text: "c" })],
      [event(2, "text.delta", { text: "b" }), event(3, "text.delta", { text: "c" })],
      [event(4, "task.completed", {})],
    ],
  });
  const seen = [];
  const reconnects = [];
  const result = await watchTask({
    client,
    taskId: "task_1",
    onEvent: (item) => seen.push(item.seq),
    onReconnect: (info) => reconnects.push(info),
    sleep: async () => {},
  });
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(reconnects.length >= 1, true);
  assert.equal(result.terminalEvent.type, "task.completed");
});

test("a stream that ends without an event trusts authoritative task state", async () => {
  const client = clientDouble({
    batches: [[event(1, "task.started")]],
    statuses: [
      {
        taskId: "task_1",
        conversationId: "conversation_1",
        state: "completed",
        agent: "coderax",
        mode: "cloud",
        generation: 0,
        createdAt: "2026-11-27T00:00:00.000Z",
        updatedAt: "2026-11-27T00:00:09.000Z",
        cancelRequested: false,
        steps: [],
      },
    ],
  });
  const result = await watchTask({ client, taskId: "task_1", sleep: async () => {} });
  assert.equal(result.terminalEvent, null);
  assert.equal(result.status.state, "completed");
  assert.equal(result.lastSeq, 1);
});

test("exhausting reconnects reports STREAM_INTERRUPTED with the cursor", async () => {
  const client = clientDouble({ batches: [[]] });
  await assert.rejects(
    () =>
      watchTask({
        client,
        taskId: "task_1",
        maxReconnects: 2,
        sleep: async () => {},
      }),
    (error) =>
      error.code === "STREAM_INTERRUPTED" &&
      error.details.taskId === "task_1" &&
      Number.isInteger(error.details.lastSeq),
  );
});

test("an abort during recovery is a cancellation, not a task failure", async () => {
  const controller = new AbortController();
  const client = clientDouble({ batches: [[]] });
  controller.abort();
  await assert.rejects(
    () => watchTask({ client, taskId: "task_1", signal: controller.signal, sleep: async () => {} }),
    (error) => error.code === "CANCELLED",
  );
});
