import test from "node:test";
import assert from "node:assert/strict";
import { mapExecutionEvent, createV1Transport } from "../src/v1-transport.js";
import { createMemoryLedger } from "../packages/workflow-sdk/src/v1/index.js";

function executionEvent(seq, type, payload = {}) {
  return {
    v: 1,
    eventId: `evt_${seq}`,
    taskId: "task_1",
    seq,
    at: "2026-11-27T00:00:00.000Z",
    agent: "coderax",
    generation: 0,
    type,
    payload,
  };
}

function clientDouble(events = []) {
  const calls = [];
  return {
    calls,
    async negotiate() {
      return { serverContract: "1.0.0", newerMinor: false };
    },
    async chat(request) {
      calls.push({ kind: "chat", request });
      return {
        conversationId: "conversation_1",
        messageId: "message_1",
        text: "answer",
        agent: "coderax",
        model: { providerId: "local", modelId: "native" },
        createdAt: "2026-11-27T00:00:00.000Z",
      };
    },
    async submitWork(request, options) {
      calls.push({ kind: "submit", request, options });
      return {
        taskId: "task_1",
        conversationId: "conversation_1",
        state: "queued",
        generation: 0,
        eventsPath: "/v1/work/task_1/events",
      };
    },
    async *events() {
      for (const item of events) yield { event: item, id: item.eventId };
    },
    async task() {
      return {
        taskId: "task_1",
        conversationId: "conversation_1",
        state: "completed",
        agent: "coderax",
        mode: "cloud",
        generation: 0,
        createdAt: "2026-11-27T00:00:00.000Z",
        updatedAt: "2026-11-27T00:00:05.000Z",
        cancelRequested: false,
        steps: [],
      };
    },
    async decidePermission(taskId, decision) {
      calls.push({ kind: "permission", taskId, decision });
      return { requests: [] };
    },
    async models() {
      return {
        models: [{
          ref: { providerId: "local", modelId: "native" },
          label: "Native",
          costClass: "free",
          toolCalling: true,
          streaming: true,
          availability: { available: true, reason: "ready", detail: "" },
        }],
        route: [{ providerId: "local", modelId: "native" }],
        allowPaid: false,
      };
    },
    async agents() {
      return {
        agents: [{
          id: "coderax",
          engine: "native",
          label: "Coderax Native",
          external: false,
          capabilities: {
            streaming: true, tools: true, cancellation: true, resume: true, modelSelection: true, durable: true,
          },
          availability: { available: true, reason: "ready", detail: "" },
          isolation: { workspace: "isolated", memory: "granted", credentials: "none", conversations: "granted" },
        }],
      };
    },
    async conversations() {
      return { conversations: [] };
    },
  };
}

test("execution events map onto the terminal vocabulary with verified approvals", () => {
  assert.deepEqual(mapExecutionEvent(executionEvent(1, "text.delta", { text: "hi" })), [
    { type: "delta", text: "hi" },
  ]);
  const tool = mapExecutionEvent(executionEvent(2, "tool.call", { callId: "c1", tool: "read_file" }));
  assert.equal(tool[0].type, "tool");
  assert.equal(tool[0].status, "start");
  const approval = mapExecutionEvent(executionEvent(3, "approval.required", {
    requestId: "req_1",
    tool: "run_command",
    description: "run the test suite",
  }));
  assert.equal(approval[0].type, "permission");
  assert.equal(approval[0].channelVerified, true);
  assert.equal(approval[0].request.serverIssued, true);
  assert.equal(approval[0].request.requestId, "req_1");
});

test("unknown event types map to nothing rather than to a guessed shape", () => {
  assert.deepEqual(mapExecutionEvent(executionEvent(9, "future.event", {})), []);
});

test("a chat turn uses the /v1 client and reports the conversation", async () => {
  const client = clientDouble();
  const transport = createV1Transport({ settings: { baseUrl: "https://engine.test", token: "t" }, client });
  const seen = [];
  const result = await transport.stream({
    mode: "chat",
    text: "hello",
    model: "local/native",
    onEvent: (event) => seen.push(event),
  });
  assert.equal(result.text, "answer");
  assert.equal(result.conversationId, "conversation_1");
  const chat = client.calls.find((call) => call.kind === "chat");
  assert.deepEqual(chat.request.model, { providerId: "local", modelId: "native" });
  assert.equal(chat.request.mode, "cloud");
  assert.equal(seen.some((event) => event.type === "conversation"), true);
});

test("a Work turn submits once, streams deltas and checkpoints the cursor", async () => {
  const client = clientDouble([
    executionEvent(1, "task.started"),
    executionEvent(2, "text.delta", { text: "done " }),
    executionEvent(3, "task.completed", { summary: "done well" }),
  ]);
  const ledger = createMemoryLedger();
  const transport = createV1Transport({
    settings: { baseUrl: "https://engine.test", token: "t" },
    client,
    ledger,
  });
  const seen = [];
  const result = await transport.stream({
    mode: "work",
    text: "change the thing",
    onEvent: (event) => seen.push(event),
  });
  assert.equal(result.taskId, "task_1");
  assert.equal(result.text, "done well");
  const submit = client.calls.find((call) => call.kind === "submit");
  assert.equal(typeof submit.options.idempotencyKey, "string");
  const record = await ledger.task("task_1");
  assert.equal(record.lastSeq, 3);
  assert.equal(seen.some((event) => event.type === "task"), true);
  assert.equal(seen.some((event) => event.type === "final"), true);
});

test("attachments are refused explicitly because /v1 publishes no upload", async () => {
  const transport = createV1Transport({
    settings: { baseUrl: "https://engine.test", token: "t" },
    client: clientDouble(),
  });
  await assert.rejects(
    () => transport.stream({ mode: "chat", text: "hi", attachments: [{ path: "a.txt" }] }),
    (error) => error.code === "CAPABILITY_UNAVAILABLE",
  );
  assert.equal(transport.capabilities.attachments, false);
});

test("a permission decision is sent with the server-issued request id", async () => {
  const client = clientDouble();
  const transport = createV1Transport({
    settings: { baseUrl: "https://engine.test", token: "t" },
    client,
  });
  await transport.respondPermission({ requestId: "req_1", taskId: "task_1", decision: "denied", reason: "no" });
  const call = client.calls.find((entry) => entry.kind === "permission");
  assert.deepEqual(call.decision, { requestId: "req_1", decision: "denied", reason: "no" });
  await assert.rejects(
    () => transport.respondPermission({ decision: "approved" }),
    (error) => error.code === "PERMISSION_CHANNEL_UNAVAILABLE",
  );
});
