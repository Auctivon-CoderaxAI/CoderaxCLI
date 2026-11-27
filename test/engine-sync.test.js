import test from "node:test";
import assert from "node:assert/strict";
import { CoderaxError } from "../src/client.js";
import {
  EngineTaskSynchronizer,
  enginePartition,
  partitionKey,
} from "../src/engine-sync.js";

const TASK = "task-1";

function event(seq, type, payload = undefined, overrides = {}) {
  return {
    v: 1,
    eventId: `evt-${seq}`,
    taskId: TASK,
    seq,
    at: new Date(seq * 1000).toISOString(),
    agent: "coderax",
    generation: 1,
    type,
    ...(payload === undefined ? {} : { payload }),
    ...overrides,
  };
}

function delta(seq, text, overrides) {
  return event(seq, "text.delta", { text }, overrides);
}

function completed(seq, overrides) {
  return event(seq, "task.completed", { summary: "done" }, overrides);
}

function truncated(seq, oldestSeq) {
  return event(seq, "stream.truncated", { after: 0, oldestSeq }, { eventId: "truncated-1" });
}

function memoryStore(initial = null) {
  let snapshot = initial === null ? null : structuredClone(initial);
  const store = {
    path: "memory",
    snapshot: () => snapshot,
    load: async () => (snapshot === null ? null : structuredClone(snapshot)),
    persist: async (value) => {
      snapshot = structuredClone(value);
    },
  };
  return store;
}

const RUNNING = {
  taskId: TASK,
  conversationId: "conv-1",
  state: "running",
  agent: "coderax",
  mode: "cloud",
  generation: 1,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  cancelRequested: false,
  steps: [],
};

const DONE = {
  ...RUNNING,
  state: "completed",
  updatedAt: new Date(5000).toISOString(),
  result: { summary: "done", artifacts: [] },
};

class FakeClient {
  constructor({ plans = [], task = DONE, submitImpl } = {}) {
    this.plans = plans.map((plan) => ({ events: [...plan.events], throw: plan.throw ?? null }));
    this.taskValue = task;
    this.submitImpl = submitImpl;
    this.calls = {
      events: [],
      task: 0,
      submitWork: [],
      resume: [],
      retry: [],
      cancel: [],
      markNotificationRead: 0,
    };
  }

  async *events(taskId, { after } = {}) {
    this.calls.events.push(after);
    const plan = this.plans.shift() ?? { events: [], throw: null };
    for (const item of plan.events) {
      if (after === undefined || item.seq > after) yield structuredClone(item);
    }
    if (plan.throw) throw plan.throw;
  }

  async task() {
    this.calls.task += 1;
    return structuredClone(this.taskValue);
  }

  async submitWork(body) {
    this.calls.submitWork.push(structuredClone(body));
    if (this.submitImpl) return this.submitImpl(body, this.calls.submitWork.length);
    return {
      taskId: TASK,
      conversationId: "conv-1",
      state: "queued",
      generation: 1,
      eventsPath: `/v1/work/${TASK}/events`,
    };
  }

  async resume(taskId, generation) {
    this.calls.resume.push({ taskId, generation });
    return { taskId, state: "running", generation: 3, outcome: "superseded" };
  }

  async retry(taskId, generation) {
    this.calls.retry.push({ taskId, generation });
    return { taskId, state: "queued", generation: 4, outcome: "accepted" };
  }

  async cancel(taskId, reason) {
    this.calls.cancel.push({ taskId, reason });
    return { taskId, state: "cancelled", generation: 1, outcome: "accepted" };
  }

  async markNotificationRead(taskId) {
    this.calls.markNotificationRead += 1;
    return { notifications: [{ taskId, read: true }], unread: 0 };
  }
}

async function syncFor(client, options = {}) {
  const partition = enginePartition({
    baseUrl: "https://engine.example.test",
    token: "owner-token-value",
    env: {},
  });
  const store = options.store ?? memoryStore();
  const sync = new EngineTaskSynchronizer({
    client,
    store,
    partition,
    sleep: async () => {},
    onDiagnostic: options.onDiagnostic,
  });
  await sync.load();
  return { sync, store, partition };
}

test("duplicate event ids and repeated sequences are applied once", async () => {
  const first = delta(1, "hello");
  const client = new FakeClient({
    plans: [{ events: [first, { ...first }, completed(2)] }],
    task: DONE,
  });
  const { sync } = await syncFor(client);
  const handled = [];
  const result = await sync.follow(TASK, { onEvent: (item) => handled.push(item.type) });
  assert.deepEqual(handled, ["text.delta", "task.completed"]);
  assert.equal(result.cursor, 2);
  assert.equal(sync.cursorFor(TASK), 2);
});

test("the persisted cursor advances only after the handler resolves", async () => {
  const client = new FakeClient({
    plans: [{ events: [delta(1, "hello"), completed(2)] }],
    task: DONE,
  });
  const { sync, store } = await syncFor(client);
  await assert.rejects(
    () =>
      sync.follow(TASK, {
        onEvent: () => {
          throw new Error("renderer failed");
        },
      }),
    /renderer failed/,
  );
  assert.equal(store.snapshot()?.cursor?.[TASK] ?? 0, 0);
});

test("a gap reconciles the authoritative snapshot before continuing", async () => {
  const diagnostics = [];
  const client = new FakeClient({
    plans: [{ events: [delta(1, "hello"), completed(3)] }],
    task: DONE,
  });
  const { sync } = await syncFor(client, { onDiagnostic: (entry) => diagnostics.push(entry) });
  const result = await sync.follow(TASK);
  assert.equal(result.terminal.state, "completed");
  // One GET reconciles the gap, one confirms the completion receipt.
  assert.equal(client.calls.task, 2);
  assert.ok(diagnostics.some((entry) => entry.code === "REPLAY_GAP"));
  assert.equal(sync.cursorFor(TASK), 3);
});

test("stream.truncated reconciles the snapshot and resumes at the oldest retained sequence", async () => {
  const diagnostics = [];
  const client = new FakeClient({
    plans: [{ events: [truncated(5, 4), delta(4, "kept"), completed(5)] }],
    task: DONE,
  });
  const { sync } = await syncFor(client, { onDiagnostic: (entry) => diagnostics.push(entry) });
  const handled = [];
  const result = await sync.follow(TASK, { onEvent: (item) => handled.push(item.type) });
  assert.equal(result.truncated, true);
  assert.equal(client.calls.task, 2);
  assert.ok(diagnostics.some((entry) => entry.code === "STREAM_TRUNCATED"));
  assert.deepEqual(handled, ["text.delta", "task.completed"]);
  assert.equal(sync.cursorFor(TASK), 5);
});

test("a dropped stream reconnects from the last applied sequence without duplicating text", async () => {
  const client = new FakeClient({
    plans: [
      { events: [delta(1, "hello ")], throw: new CoderaxError("REQUEST_FAILED", "socket reset", { retryable: true }) },
      { events: [delta(2, "world"), completed(3)] },
    ],
    task: DONE,
  });
  const { sync } = await syncFor(client);
  const text = [];
  const result = await sync.follow(TASK, {
    onEvent: (item, outcome) => {
      if (outcome.kind === "delta") text.push(outcome.text);
    },
  });
  assert.deepEqual(client.calls.events, [undefined, 1]);
  assert.equal(text.join(""), "hello world");
  assert.equal(result.terminal.state, "completed");
});

test("an ambiguous submission is never retried automatically", async () => {
  const client = new FakeClient({
    plans: [],
    submitImpl: () => {
      throw new CoderaxError("NETWORK", "connection reset", { retryable: true });
    },
  });
  const { sync, store } = await syncFor(client);
  const key = "cli-test-key-0001";
  await assert.rejects(
    () => sync.submit({ objective: "super-secret-objective", idempotencyKey: key }),
    (error) => error.code === "SUBMISSION_UNKNOWN" && error.details.submissionKey === key,
  );
  assert.equal(client.calls.submitWork.length, 1);
  assert.equal(store.snapshot().submissions[key].state, "unknown");

  await assert.rejects(
    () => sync.submit({ objective: "super-secret-objective" }),
    (error) => error.code === "SUBMISSION_UNKNOWN",
  );
  assert.equal(client.calls.submitWork.length, 1);
  assert.equal(JSON.stringify(store.snapshot()).includes("super-secret-objective"), false);
});

test("--resume-key reuses the same server idempotency key and cannot start a second task", async () => {
  let attempt = 0;
  const client = new FakeClient({
    plans: [],
    submitImpl: (body) => {
      attempt += 1;
      if (attempt === 1) throw new CoderaxError("REQUEST_TIMEOUT", "timed out", { retryable: true });
      return {
        taskId: TASK,
        conversationId: "conv-1",
        state: "queued",
        generation: 1,
        eventsPath: `/v1/work/${TASK}/events`,
        replayed: true,
      };
    },
  });
  const { sync } = await syncFor(client);
  const key = "cli-test-key-0002";
  await assert.rejects(
    () => sync.submit({ objective: "same objective", idempotencyKey: key }),
    (error) => error.code === "SUBMISSION_UNKNOWN",
  );
  const resumed = await sync.submit({ objective: "same objective", resumeKey: key });
  assert.equal(resumed.accepted.replayed, true);
  assert.equal(resumed.accepted.taskId, TASK);
  assert.equal(client.calls.submitWork[1].idempotencyKey, key);

  await assert.rejects(
    () => sync.submit({ objective: "different objective", resumeKey: key }),
    (error) => error.code === "SUBMISSION_MISMATCH",
  );
});

test("state is partitioned by origin, owner fingerprint and environment", async () => {
  const a = enginePartition({ baseUrl: "https://engine.example.test", token: "token-a", env: {} });
  const b = enginePartition({ baseUrl: "https://engine.example.test", token: "token-b", env: {} });
  const c = enginePartition({
    baseUrl: "https://engine.example.test",
    token: "token-a",
    environment: "staging",
    env: {},
  });
  assert.notEqual(partitionKey(a), partitionKey(b));
  assert.notEqual(partitionKey(a), partitionKey(c));
  assert.equal(a.owner.includes("token-a"), false);

  const store = memoryStore();
  const first = await syncFor(new FakeClient(), { store });
  await first.sync.persist();
  const other = new EngineTaskSynchronizer({
    client: new FakeClient(),
    store,
    partition: b,
    sleep: async () => {},
  });
  await assert.rejects(() => other.load(), (error) => error.code === "STATE_PARTITION_MISMATCH");
});

test("synchronization files never contain prompts, transcripts or tokens", async () => {
  const client = new FakeClient({
    plans: [{ events: [delta(1, "private transcript"), completed(2)] }],
    task: DONE,
  });
  const { sync, store } = await syncFor(client);
  await sync.submit({ objective: "private objective", idempotencyKey: "cli-test-key-0003" });
  await sync.follow(TASK);
  const serialized = JSON.stringify(store.snapshot());
  assert.equal(serialized.includes("private objective"), false);
  assert.equal(serialized.includes("private transcript"), false);
  assert.equal(serialized.includes("owner-token-value"), false);
  assert.ok(store.snapshot().cursor[TASK] >= 1);
});

test("resume and retry send the recorded generation and never loop on supersession", async () => {
  const client = new FakeClient({ plans: [], task: { ...RUNNING, generation: 2 } });
  const { sync } = await syncFor(client);
  await sync.reconcile(TASK);
  const resumed = await sync.resume(TASK);
  assert.equal(resumed.outcome, "superseded");
  assert.deepEqual(client.calls.resume, [{ taskId: TASK, generation: 2 }]);
  assert.equal(client.calls.task, 2);

  const retried = await sync.retry(TASK);
  assert.equal(retried.outcome, "accepted");
  assert.deepEqual(client.calls.retry, [{ taskId: TASK, generation: 2 }]);
});

test("acknowledgements are recorded locally and delegated to the engine", async () => {
  const client = new FakeClient({ plans: [], task: DONE });
  const { sync, store } = await syncFor(client);
  await sync.acknowledge(TASK);
  assert.equal(client.calls.markNotificationRead, 1);
  assert.ok(store.snapshot().notifications[TASK].ackedAt);
});

test("a detached follow leaves the durable task running", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new FakeClient({ plans: [], task: RUNNING });
  const { sync } = await syncFor(client);
  const result = await sync.follow(TASK, { signal: controller.signal });
  assert.equal(result.detached, true);
  assert.equal(client.calls.events.length, 0);
});
