import test from "node:test";
import assert from "node:assert/strict";
import {
  LegacyChatAdapter,
  SdkError,
  TaskClient,
  TaskState,
  approvalFor,
  assertRunSnapshot,
  classifyChatPayload,
  cursorFromFrame,
  runFingerprint,
  settlementKey,
  terminalOutcome,
  workflowFrameEvent,
} from "../packages/workflow-sdk/src/index.js";

const RUN = (id, status, extra = {}) => ({
  id,
  workflowId: "wf-1",
  workflowName: "Task workflow",
  agentId: "agent-1",
  status,
  steps: [],
  events: [],
  createdAt: new Date(0).toISOString(),
  ...extra,
});

function memoryState() {
  const saves = [];
  const state = new TaskState({
    persist: async (snapshot) => {
      saves.push(structuredClone(snapshot));
    },
  });
  return { state, saves };
}

function clientStub(overrides = {}) {
  return {
    watchRun: async () => {
      throw new Error("watchRun was not stubbed");
    },
    submitBuild: async () => {
      throw new Error("submitBuild was not stubbed");
    },
    approveStep: async () => {
      throw new Error("approveStep was not stubbed");
    },
    getRun: async () => {
      throw new Error("getRun was not stubbed");
    },
    cancelRun: async () => {
      throw new Error("cancelRun was not stubbed");
    },
    cancelTask: async () => {
      throw new Error("cancelTask was not stubbed");
    },
    retryRun: async () => {
      throw new Error("retryRun was not stubbed");
    },
    requireCapability: async () => ({}),
    ...overrides,
  };
}

test("a run snapshot is validated once for the SDK and the task layer", () => {
  const run = RUN("run-1", "running");
  assert.equal(assertRunSnapshot(run, "test"), run);
  assert.throws(
    () => assertRunSnapshot({ ...run, status: "invented" }, "test"),
    (error) => error instanceof SdkError && error.code === "UNKNOWN_RUN_STATUS",
  );
  assert.throws(
    () => assertRunSnapshot({ ...run, id: "" }, "test"),
    (error) => error.code === "CONTRACT_VIOLATION",
  );
});

test("snapshots never produce a synthetic cursor", async () => {
  assert.equal(cursorFromFrame({ id: null, data: RUN("run-1", "running") }), null);
  assert.equal(
    cursorFromFrame({ id: null, data: { run: RUN("run-1", "running"), eventId: "server-event" } }),
    null,
  );
  assert.deepEqual(cursorFromFrame({ id: "7", data: {} }), { kind: "event-id", value: "7" });
  assert.deepEqual(cursorFromFrame({ data: { seq: 3 } }), { kind: "sequence", value: 3 });

  const { state, saves } = memoryState();
  await state.recordApplied(RUN("run-1", "running"), null);
  assert.equal(state.cursor, null);
  assert.equal(saves.at(-1).cursor, null);
});

test("a handler failure does not commit the applied fingerprint or cursor", async () => {
  const { state, saves } = memoryState();
  let handled = 0;
  const client = clientStub({
    watchRun: async (_id, { onRun, onHandled }) => {
      const run = RUN("run-1", "running");
      await onRun(run);
      handled += 1;
      await onHandled(run, { kind: "event-id", value: "1" });
      return { run };
    },
  });
  const tasks = new TaskClient({ client, state });
  await assert.rejects(
    () =>
      tasks.follow("run-1", {
        onRun: async () => {
          throw new Error("renderer failed before commit");
        },
      }),
    /renderer failed/,
  );
  assert.equal(handled, 0, "onHandled must not run after a handler failure");
  assert.equal(state.appliedFingerprint, null);
  assert.equal(state.cursor, null);
  assert.equal(saves.length, 0);
});

test("a persisted snapshot is restored with its cursor and terminal latch", async () => {
  const { state, saves } = memoryState();
  await state.recordApplied(RUN("run-1", "running"), { kind: "event-id", value: "4" });
  await state.recordApplied(RUN("run-1", "failed", { error: "tests failed" }), {
    kind: "event-id",
    value: "5",
  });
  const restored = new TaskState({ persist: async () => {} });
  restored.restore(saves.at(-1));
  assert.equal(restored.cursor.value, "5");
  assert.equal(restored.terminal.status, "failed");
  assert.equal(restored.terminal.kind, "failed");
  assert.equal(restored.accepts(RUN("run-1", "running")), false);
  assert.equal(restored.accepts(RUN("run-1", "completed")), true);
});

test("completion acknowledgement is stable and survives a restart", async () => {
  const terminal = RUN("run-1", "completed", { settledAt: "2026-11-26T00:00:00.000Z" });
  assert.equal(settlementKey(terminal), "run-1|completed|2026-11-26T00:00:00.000Z");

  const { state, saves } = memoryState();
  assert.deepEqual(await state.recordSettlement(terminal), {
    duplicate: false,
    key: settlementKey(terminal),
  });
  assert.equal((await state.recordSettlement(terminal)).duplicate, true);

  const restarted = new TaskState({ persist: async () => {} });
  restarted.restore(saves.at(-1));
  assert.equal((await restarted.recordSettlement(terminal)).duplicate, true);
  assert.equal(restarted.settlement(terminal).at.length > 0, true);
});

test("approval addressing is a derived step index, not a permission request id", () => {
  const run = RUN("run-1", "waiting_approval", {
    steps: [
      { id: "plan", title: "Plan", status: "completed", approvalRequired: false },
      { id: "deploy", title: "Deploy", status: "pending", approvalRequired: true },
    ],
  });
  assert.deepEqual(approvalFor(run), {
    kind: "approval",
    derived: true,
    runId: "run-1",
    stepIndex: 1,
    stepId: "deploy",
    title: "Deploy",
  });
  assert.equal("permissionRequestId" in approvalFor(run), false);
  assert.equal(approvalFor(RUN("run-1", "running")), null);
});

test("terminal outcomes distinguish failure, cancellation and completion", () => {
  assert.equal(terminalOutcome(RUN("r", "failed", { error: "boom" })).kind, "failed");
  assert.equal(terminalOutcome(RUN("r", "cancelled")).kind, "cancelled");
  assert.equal(terminalOutcome(RUN("r", "completed")).kind, "completed");
  assert.equal(terminalOutcome(RUN("r", "running")).terminal, false);
});

test("workflow frames reject an unknown payload instead of inventing an event", () => {
  assert.equal(workflowFrameEvent({ data: { run: RUN("r", "running") } }).kind, "run-snapshot");
  assert.equal(workflowFrameEvent({ data: { type: "error", error: "nope" } }).kind, "stream-error");
  assert.equal(workflowFrameEvent({ done: true }).kind, "done");
  assert.equal(workflowFrameEvent({ data: { unrelated: true } }).kind, "invalid");
  assert.equal(workflowFrameEvent({ data: [] }).kind, "invalid");
});

test("legacy chat adapter keeps cumulative snapshots, rewrites and final frames distinct", () => {
  const events = [];
  const adapter = new LegacyChatAdapter({ onEvent: (event) => events.push(event) });
  assert.deepEqual(adapter.push({ message: true, text: "accepted" }), {
    type: "delta",
    text: "accepted",
  });
  assert.deepEqual(adapter.push({ message: true, text: "accepted and verified" }), {
    type: "delta",
    text: " and verified",
  });
  assert.deepEqual(adapter.push({ message: true, text: "corrected" }), {
    type: "replace",
    text: "corrected",
  });
  assert.deepEqual(
    adapter.push({ final: true, responseMessage: { text: "corrected" } }),
    { type: "final", text: "corrected" },
  );
  assert.equal(events[0].protocol, "legacy-chat-sse");
  assert.equal(classifyChatPayload({ index: 1, type: "text", text: "branch" }).kind, "ignored");
  assert.equal(classifyChatPayload({ raw: true, text: "tail" }).kind, "delta");
});

test("ambiguous submission is never retried and keeps the same recorded key", async () => {
  let calls = 0;
  const client = clientStub({
    submitBuild: async () => {
      calls += 1;
      throw new SdkError("NETWORK", "connection reset after the request body was sent", {
        retryable: true,
      });
    },
  });
  const { state, saves } = memoryState();
  const tasks = new TaskClient({ client, state });

  await assert.rejects(
    () =>
      tasks.submit({
        submissionKey: "cli:test:ambiguous",
        request: "do work",
        agentId: "a",
        repository: { owner: "acme", name: "app" },
        workspace: "ws",
      }),
    (error) =>
      error instanceof SdkError &&
      error.code === "SUBMISSION_UNKNOWN" &&
      error.details.submissionKey === "cli:test:ambiguous" &&
      error.retryable === false,
  );
  assert.equal(calls, 1);
  const recorded = state.submission("cli:test:ambiguous");
  assert.equal(recorded.state, "unknown");
  assert.equal(saves.at(-1).submissions["cli:test:ambiguous"].state, "unknown");
});

test("a recorded submission resolves by read, never by another POST", async () => {
  let posts = 0;
  const client = clientStub({
    submitBuild: async () => {
      posts += 1;
      throw new Error("must not be called");
    },
    getRun: async () => RUN("run-recorded", "queued"),
  });
  const { state } = memoryState();
  await state.beginSubmission("cli:test:recorded", { request: "x" });
  await state.markSubmission("cli:test:recorded", { state: "submitted", runId: "run-recorded" });
  const tasks = new TaskClient({ client, state });
  const result = await tasks.resumeSubmission("cli:test:recorded");
  assert.equal(result.run.id, "run-recorded");
  assert.equal(result.replayed, true);
  assert.equal(posts, 0);
});

test("approval reconciles a 409 when the step is already settled", async () => {
  let posts = 0;
  const settled = RUN("run-1", "running", {
    steps: [{ id: "deploy", status: "running", approvalRequired: true, approvedAt: "now" }],
  });
  const client = clientStub({
    approveStep: async () => {
      posts += 1;
      throw new SdkError("CONFLICT", "That step is not waiting for approval", { status: 409 });
    },
    getRun: async () => settled,
  });
  const { state } = memoryState();
  const tasks = new TaskClient({ client, state });
  const result = await tasks.approve("run-1", 0);
  assert.equal(result.applied, false);
  assert.equal(result.alreadySettled, true);
  assert.equal(result.run.status, "running");
  assert.equal(posts, 1);
  assert.equal(state.approval("run-1", 0).outcome, "already-settled");
});

test("approval still pending after a 409 fails instead of retrying", async () => {
  let posts = 0;
  const waiting = RUN("run-1", "waiting_approval", {
    steps: [{ id: "deploy", status: "pending", approvalRequired: true }],
  });
  const client = clientStub({
    approveStep: async () => {
      posts += 1;
      throw new SdkError("CONFLICT", "That step is not waiting for approval", { status: 409 });
    },
    getRun: async () => waiting,
  });
  const tasks = new TaskClient({ client, state: memoryState().state });
  await assert.rejects(() => tasks.approve("run-1", 0), (error) => error.code === "CONFLICT");
  assert.equal(posts, 1);
});

test("task cancellation distinguishes finished from nothing-to-cancel", async () => {
  const finished = new TaskClient({
    client: clientStub({
      cancelTask: async () => {
        throw new SdkError("CONFLICT", "finished", {
          status: 409,
          details: { serverCode: "WORK_TASK_ALREADY_FINISHED" },
        });
      },
    }),
    state: memoryState().state,
  });
  assert.deepEqual(await finished.cancelTask("conv-1"), {
    result: null,
    canceled: false,
    alreadyFinished: true,
    nothingToCancel: false,
  });

  const idle = new TaskClient({
    client: clientStub({
      cancelTask: async () => {
        throw new SdkError("CONFLICT", "nothing", {
          status: 409,
          details: { serverCode: "WORK_NOTHING_TO_CANCEL" },
        });
      },
    }),
    state: memoryState().state,
  });
  assert.equal((await idle.cancelTask("conv-1")).nothingToCancel, true);
});

test("follow classifies detach and disconnect separately from run failure", async () => {
  const detachedSignal = new AbortController();
  detachedSignal.abort();
  const detached = new TaskClient({
    client: clientStub({
      watchRun: async () => {
        throw new SdkError("CANCELLED", "cancelled");
      },
    }),
    state: memoryState().state,
  });
  const detachedResult = await detached.follow("run-1", { signal: detachedSignal.signal });
  assert.equal(detachedResult.outcome.kind, "detached");

  const disconnected = new TaskClient({
    client: clientStub({
      watchRun: async () => {
        throw new SdkError("STREAM_INCOMPLETE", "stream ended before terminal", {
          retryable: false,
        });
      },
    }),
    state: memoryState().state,
  });
  const disconnectedResult = await disconnected.follow("run-1", {});
  assert.equal(disconnectedResult.outcome.kind, "disconnected");
  assert.match(disconnectedResult.outcome.error, /terminal/);

  const failed = new TaskClient({
    client: clientStub({
      watchRun: async (_id, { onRun }) => {
        const run = RUN("run-1", "failed");
        await onRun(run);
        return { run };
      },
    }),
    state: memoryState().state,
  });
  const failedResult = await failed.follow("run-1", {});
  assert.equal(failedResult.outcome.kind, "failed");
});

test("follow commits the server cursor only after the handler resolves", async () => {
  const { state, saves } = memoryState();
  let commits = 0;
  const client = clientStub({
    watchRun: async (_id, { onRun, onHandled }) => {
      const run = RUN("run-1", "completed");
      await onRun(run);
      commits += 1;
      await onHandled(run, { kind: "event-id", value: "9" });
      return { run };
    },
  });
  const tasks = new TaskClient({ client, state });
  const result = await tasks.follow("run-1", { onRun: async () => {} });
  assert.equal(result.outcome.kind, "completed");
  assert.equal(commits, 1);
  assert.deepEqual(state.cursor, { kind: "event-id", value: "9" });
  assert.equal(saves.at(-1).cursor.value, "9");
  assert.equal(runFingerprint(state.run), runFingerprint(RUN("run-1", "completed")));
});
