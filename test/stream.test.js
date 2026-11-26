import test from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, watchTask } from "../src/engine/stream.js";
import { CoderaxError, CancelledError } from "../src/errors.js";

function event(seq, type = "text.delta", extra = {}) {
  return {
    v: 1,
    eventId: `evt_${seq}`,
    taskId: "task_1",
    seq,
    at: new Date().toISOString(),
    agent: "coderax",
    generation: 0,
    type,
    ...(type === "text.delta" ? { payload: { text: `chunk-${seq}` } } : {}),
    ...extra,
  };
}

function terminal(seq) {
  return event(seq, "task.completed", { payload: { summary: "done" } });
}

function makeClient({ batches, statuses = [], errors = [] }) {
  let call = 0;
  let statusCall = 0;
  return {
    calls: () => call,
    statusCalls: () => statusCall,
    async *events(taskId, { after, signal }) {
      const index = call;
      call += 1;
      if (errors[index]) throw errors[index];
      const batch = batches[index] ?? [];
      for (const entry of batch) {
        if (signal?.aborted) throw new CancelledError();
        if (entry.error) throw entry.error;
        if (entry.seq > after) yield { event: entry, id: String(entry.seq) };
      }
    },
    async task() {
      const status = statuses[statusCall];
      statusCall += 1;
      if (status instanceof Error) throw status;
      return status ?? { taskId: "task_1", state: "running", generation: 0, conversationId: "conv_1", agent: "coderax", mode: "cloud", cancelRequested: false, steps: [], createdAt: "", updatedAt: "" };
    },
  };
}

test("backoff is bounded and grows", () => {
  assert.ok(backoffDelay(1, { random: () => 0 }) >= 250);
  assert.ok(backoffDelay(1, { random: () => 1 }) <= 500);
  assert.ok(backoffDelay(8, { random: () => 1 }) <= 15_000);
});

test("watchTask streams events, deduplicates and returns the terminal event", async () => {
  const client = makeClient({ batches: [[event(1), event(2), terminal(3)]] });
  const seen = [];
  const result = await watchTask({
    client,
    taskId: "task_1",
    after: 0,
    onEvent: async (entry) => seen.push(entry.seq),
    sleep: async () => {},
  });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(result.lastSeq, 3);
  assert.equal(result.terminalEvent.type, "task.completed");
  assert.equal(result.status, null);
});

test("watchTask ignores duplicate event ids and stale sequence numbers", async () => {
  const client = makeClient({
    batches: [[event(1), event(1), event(2), event(2), terminal(3)]],
  });
  const seen = [];
  const result = await watchTask({
    client,
    taskId: "task_1",
    onEvent: async (entry) => seen.push(entry.seq),
    sleep: async () => {},
  });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(result.lastSeq, 3);
});

test("a stream that ends without a terminal event reconnects from the cursor", async () => {
  const client = makeClient({
    batches: [[event(1)], [event(2), terminal(3)]],
    statuses: [{ state: "running", taskId: "task_1" }],
  });
  const reconnects = [];
  const result = await watchTask({
    client,
    taskId: "task_1",
    onReconnect: (info) => reconnects.push(info),
    sleep: async () => {},
  });
  assert.equal(result.lastSeq, 3);
  assert.equal(reconnects.length, 1);
  assert.equal(reconnects[0].reason, "stream-ended");
});

test("a stream that never opens retries and then gives up with the cursor", async () => {
  const client = makeClient({
    batches: [],
    statuses: [{ state: "running", taskId: "task_1" }],
    errors: [new CoderaxError("REQUEST_FAILED", "down", { retryable: true })],
  });
  await assert.rejects(
    () => watchTask({
      client,
      taskId: "task_1",
      after: 4,
      maxReconnects: 2,
      sleep: async () => {},
    }),
    (error) => {
      assert.equal(error.code, "STREAM_INTERRUPTED");
      assert.equal(error.details.lastSeq, 4);
      assert.match(error.hint, /work attach task_1/);
      return true;
    },
  );
});

test("a gap is retried and then reported explicitly", async () => {
  const client = makeClient({
    batches: [[event(2)], [event(2)], [event(2)], [event(2)]],
  });
  await assert.rejects(
    () => watchTask({ client, taskId: "task_1", sleep: async () => {} }),
    (error) => error.code === "EVENT_GAP",
  );
});

test("task status is authoritative when a replay is empty or truncated", async () => {
  const client = makeClient({
    batches: [[]],
    statuses: [{
      taskId: "task_1",
      state: "completed",
      generation: 0,
      conversationId: "conv_1",
      agent: "coderax",
      mode: "cloud",
      cancelRequested: false,
      steps: [],
      result: { summary: "from status" },
    }],
  });
  const result = await watchTask({ client, taskId: "task_1", sleep: async () => {} });
  assert.equal(result.terminalEvent, null);
  assert.equal(result.status.state, "completed");
});

test("a missing task becomes TASK_NOT_FOUND", async () => {
  const client = makeClient({
    batches: [[]],
    statuses: [new CoderaxError("HTTP_404", "missing", { status: 404 })],
  });
  await assert.rejects(
    () => watchTask({ client, taskId: "task_1", sleep: async () => {} }),
    (error) => error.code === "TASK_NOT_FOUND",
  );
});

test("a contract mismatch is never retried", async () => {
  const client = makeClient({
    batches: [],
    errors: [new CoderaxError("CONTRACT_MISMATCH", "drift")],
  });
  await assert.rejects(
    () => watchTask({ client, taskId: "task_1", sleep: async () => {} }),
    (error) => error.code === "CONTRACT_MISMATCH",
  );
});

test("caller cancellation stops the stream", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = makeClient({ batches: [[event(1)]] });
  await assert.rejects(
    () => watchTask({ client, taskId: "task_1", signal: controller.signal, sleep: async () => {} }),
    CancelledError,
  );
});

test("a checkpoint write failure is reported but does not lose the event", async () => {
  const client = makeClient({ batches: [[event(1), terminal(2)]] });
  const notices = [];
  const result = await watchTask({
    client,
    taskId: "task_1",
    onCheckpoint: async () => { throw new Error("disk full"); },
    onReconnect: (info) => notices.push(info),
    sleep: async () => {},
  });
  assert.equal(result.lastSeq, 2);
  assert.equal(notices[0].reason, "checkpoint-write");
});
