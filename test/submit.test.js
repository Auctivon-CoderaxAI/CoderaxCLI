import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { StateStore } from "../src/state.js";
import {
  buildWorkRequest,
  newSubmissionKey,
  objectiveHash,
  parseModelRef,
  resolveSubmission,
  submitWork,
} from "../src/engine/submit.js";
import { CoderaxError, CancelledError } from "../src/errors.js";
import { tempDir } from "./helpers.js";

const accepted = {
  taskId: "task_1",
  conversationId: "conv_1",
  state: "queued",
  generation: 0,
  eventsPath: "/v1/work/task_1/events",
};

async function makeState() {
  const dir = await tempDir();
  return new StateStore({ filePath: join(dir, "state.json") });
}

function clientFor(submitImpl) {
  const calls = [];
  return {
    calls,
    async submitWork(request, options) {
      calls.push({ request, options });
      return submitImpl(request, options);
    },
    async task() {
      return {
        taskId: "task_1",
        conversationId: "conv_1",
        state: "running",
        agent: "coderax",
        mode: "cloud",
        generation: 0,
        createdAt: "",
        updatedAt: "",
        cancelRequested: false,
        steps: [],
      };
    },
  };
}

test("objective hashes are stable, bounded and keyed", () => {
  assert.equal(objectiveHash("same"), objectiveHash("same"));
  assert.equal(objectiveHash("same").length, 16);
  assert.notEqual(objectiveHash("same"), objectiveHash("other"));
  assert.match(newSubmissionKey(), /^[0-9a-f-]{36}$/);
});

test("model refs require provider/model and are passed through structurally", () => {
  assert.deepEqual(parseModelRef("provider/model"), { providerId: "provider", modelId: "model" });
  assert.deepEqual(parseModelRef({ providerId: "p", modelId: "m" }), { providerId: "p", modelId: "m" });
  assert.equal(parseModelRef(undefined), undefined);
  assert.throws(() => parseModelRef("model-only"), (error) => error.code === "USAGE");
});

test("a work request carries only the fields the contract publishes", () => {
  assert.deepEqual(
    buildWorkRequest({
      objective: "fix it",
      conversationId: "conv_1",
      agent: "coderax",
      model: "p/m",
      budget: { maxRequests: 1, maxInputTokens: 2, maxOutputTokens: 3 },
    }),
    {
      objective: "fix it",
      mode: "cloud",
      requireApproval: true,
      conversationId: "conv_1",
      agent: "coderax",
      model: { providerId: "p", modelId: "m" },
      budget: { maxRequests: 1, maxInputTokens: 2, maxOutputTokens: 3 },
    },
  );
});

test("submit records the task and its idempotency key", async () => {
  const state = await makeState();
  const client = clientFor(async () => accepted);
  const result = await submitWork({
    client,
    state,
    request: { objective: "do it", mode: "cloud" },
    idempotencyKey: "key-1",
  });
  assert.equal(result.accepted.taskId, "task_1");
  assert.equal(result.submissionKey, "key-1");
  assert.equal(client.calls[0].options.idempotencyKey, "key-1");
  assert.equal((await state.submission("key-1")).status, "accepted");
  assert.equal((await state.task("task_1")).objective, "do it");
});

test("a known key is reused without submitting a second task", async () => {
  const state = await makeState();
  const client = clientFor(async () => accepted);
  await submitWork({ client, state, request: { objective: "do it" }, idempotencyKey: "key-1" });
  const second = await submitWork({ client, state, request: { objective: "do it" }, idempotencyKey: "key-1" });
  assert.equal(second.reused, true);
  assert.equal(second.accepted, null);
  assert.equal(client.calls.length, 1);
});

test("a lost response becomes SUBMISSION_UNCERTAIN and is never retried automatically", async () => {
  const state = await makeState();
  const client = clientFor(async () => {
    throw new CoderaxError("REQUEST_TIMEOUT", "lost", { retryable: true, transmitted: true });
  });
  await assert.rejects(
    () => submitWork({ client, state, request: { objective: "do it" }, idempotencyKey: "key-1" }),
    (error) => {
      assert.equal(error.code, "SUBMISSION_UNCERTAIN");
      assert.equal(error.exitCode, undefined);
      assert.match(error.hint, /work resolve key-1/);
      return true;
    },
  );
  assert.equal((await state.submission("key-1")).status, "uncertain");
  await assert.rejects(
    () => submitWork({ client, state, request: { objective: "do it" }, idempotencyKey: "key-1" }),
    (error) => error.code === "SUBMISSION_UNCERTAIN",
  );
  assert.equal(client.calls.length, 1);
});

test("an explicit retry of an uncertain submission is allowed", async () => {
  const state = await makeState();
  let count = 0;
  const client = clientFor(async () => {
    count += 1;
    if (count === 1) throw new CoderaxError("REQUEST_FAILED", "lost", { retryable: true, transmitted: true });
    return accepted;
  });
  await assert.rejects(() => submitWork({ client, state, request: { objective: "do it" }, idempotencyKey: "key-1" }), /did not confirm/);
  const result = await submitWork({
    client,
    state,
    request: { objective: "do it" },
    idempotencyKey: "key-1",
    retryUncertain: true,
  });
  assert.equal(result.accepted.taskId, "task_1");
  assert.equal(client.calls.length, 2);
});

test("a definite 4xx rejection is failed, not uncertain", async () => {
  const state = await makeState();
  const client = clientFor(async () => {
    throw new CoderaxError("validation_failed", "bad request", { status: 400 });
  });
  await assert.rejects(
    () => submitWork({ client, state, request: { objective: "do it" }, idempotencyKey: "key-1" }),
    (error) => error.code === "validation_failed",
  );
  assert.equal((await state.submission("key-1")).status, "failed");
});

test("a pre-transmit failure is retryable and leaves an explicit failed record", async () => {
  const state = await makeState();
  const client = clientFor(async () => {
    throw new CoderaxError("REQUEST_FAILED", "refused", { retryable: true, transmitted: false });
  });
  await assert.rejects(
    () => submitWork({ client, state, request: { objective: "do it" }, idempotencyKey: "key-1" }),
    (error) => error.code === "REQUEST_FAILED",
  );
  assert.equal((await state.submission("key-1")).status, "failed");
});

test("caller cancellation is not rewritten as an uncertain submission", async () => {
  const state = await makeState();
  const client = clientFor(async () => { throw new CancelledError(); });
  await assert.rejects(
    () => submitWork({ client, state, request: { objective: "do it" }, idempotencyKey: "key-1" }),
    CancelledError,
  );
  assert.equal((await state.submission("key-1")).status, "failed");
});

test("resolveSubmission binds an ambiguous key to an existing task", async () => {
  const state = await makeState();
  await state.upsertSubmission("key-1", { status: "uncertain", objective: "do it" });
  const client = clientFor(async () => accepted);
  const result = await resolveSubmission({ client, state, key: "key-1", taskId: "task_1" });
  assert.equal(result.status.taskId, "task_1");
  assert.equal((await state.submission("key-1")).status, "accepted");
  assert.equal((await state.submission("key-1")).resolvedManually, true);
  assert.equal((await state.task("task_1")).objective, "do it");
});
