import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryLedger,
  resolveSubmission,
  submitWork,
} from "../packages/workflow-sdk/src/v1/index.js";

const REQUEST = { objective: "ship the change", mode: "cloud", requireApproval: true };

function acceptedClient(taskId = "task_1") {
  const calls = [];
  return {
    calls,
    async submitWork(request, options) {
      calls.push({ request, options });
      return {
        taskId,
        conversationId: "conversation_1",
        state: "queued",
        generation: 0,
        eventsPath: `/v1/work/${taskId}/events`,
      };
    },
    async task(id) {
      return {
        taskId: id,
        conversationId: "conversation_1",
        state: "running",
        agent: "coderax",
        mode: "cloud",
        generation: 0,
        createdAt: "2026-11-27T00:00:00.000Z",
        updatedAt: "2026-11-27T00:00:01.000Z",
        cancelRequested: false,
        steps: [],
      };
    },
  };
}

test("one key submits once and is bound to the accepted task", async () => {
  const ledger = createMemoryLedger();
  const client = acceptedClient();
  const first = await submitWork({ client, ledger, request: REQUEST, idempotencyKey: "key-1" });
  assert.equal(first.reused, false);
  assert.equal(first.task.taskId, "task_1");
  const second = await submitWork({ client, ledger, request: REQUEST, idempotencyKey: "key-1" });
  assert.equal(second.reused, true);
  assert.equal(client.calls.length, 1, "a bound key must not transmit again");
  assert.equal((await ledger.submission("key-1")).status, "accepted");
});

test("an ambiguous failure becomes SUBMISSION_UNCERTAIN and blocks a duplicate", async () => {
  const ledger = createMemoryLedger();
  const client = {
    calls: 0,
    async submitWork() {
      this.calls += 1;
      throw Object.assign(new Error("socket closed"), { code: "NETWORK", retryable: true });
    },
  };
  await assert.rejects(
    () => submitWork({ client, ledger, request: REQUEST, idempotencyKey: "key-2" }),
    (error) => error.code === "SUBMISSION_UNCERTAIN" && error.details.submissionKey === "key-2",
  );
  assert.equal((await ledger.submission("key-2")).status, "uncertain");

  await assert.rejects(
    () => submitWork({ client, ledger, request: REQUEST, idempotencyKey: "key-2" }),
    (error) => error.code === "SUBMISSION_UNCERTAIN" && /may already have been accepted/.test(error.message),
  );
  assert.equal(client.calls, 1, "an uncertain key must never be retried automatically");
});

test("an explicit retry is allowed after an uncertain outcome", async () => {
  const ledger = createMemoryLedger({
    submissions: {
      "key-3": { status: "uncertain", objective: REQUEST.objective, createdAt: "2026-11-27T00:00:00.000Z" },
    },
  });
  const client = acceptedClient("task_3");
  const result = await submitWork({
    client,
    ledger,
    request: REQUEST,
    idempotencyKey: "key-3",
    retryUncertain: true,
  });
  assert.equal(result.task.taskId, "task_3");
  assert.equal(client.calls.length, 1);
});

test("a definite rejection is recorded as failed and is not uncertain", async () => {
  const ledger = createMemoryLedger();
  const client = {
    async submitWork() {
      throw Object.assign(new Error("validation"), { code: "HTTP_422", status: 422, retryable: false });
    },
  };
  await assert.rejects(
    () => submitWork({ client, ledger, request: REQUEST, idempotencyKey: "key-4" }),
    (error) => error.status === 422,
  );
  assert.equal((await ledger.submission("key-4")).status, "failed");
});

test("a pre-transmit failure is definite and does not poison the key", async () => {
  const ledger = createMemoryLedger();
  const client = {
    async submitWork() {
      throw Object.assign(new Error("dns"), { code: "NETWORK", transmitted: false });
    },
  };
  await assert.rejects(() => submitWork({ client, ledger, request: REQUEST, idempotencyKey: "key-5" }));
  assert.equal((await ledger.submission("key-5")).status, "failed");
});

test("an owner can bind an uncertain key to the task that actually exists", async () => {
  const ledger = createMemoryLedger({
    submissions: {
      "key-6": { status: "uncertain", objective: "recover me", createdAt: "2026-11-27T00:00:00.000Z" },
    },
  });
  const client = acceptedClient("task_6");
  const result = await resolveSubmission({ client, ledger, key: "key-6", taskId: "task_6" });
  assert.equal(result.status.taskId, "task_6");
  const record = await ledger.submission("key-6");
  assert.equal(record.status, "accepted");
  assert.equal(record.taskId, "task_6");
  assert.equal(record.resolvedManually, true);
});
