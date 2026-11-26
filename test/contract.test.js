import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_VERSION,
  EVENT_SCHEMA_VERSION,
  agentCapability,
  assertAgentList,
  assertChatReply,
  assertConversation,
  assertConversationList,
  assertExecutionEvent,
  assertHealth,
  assertMemoryList,
  assertModelList,
  assertNotificationList,
  assertPermissionList,
  assertReadiness,
  assertTaskAccepted,
  assertTaskControl,
  assertTaskStatus,
  isTerminalEventType,
  isTerminalTaskState,
} from "../src/engine/contract.js";
import { ContractError } from "../src/errors.js";
import { validAgents, validEvent, validHealth, validTaskStatus } from "./helpers.js";

const now = new Date().toISOString();

test("contract constants are pinned", () => {
  assert.equal(CONTRACT_VERSION, "1.0.0");
  assert.equal(EVENT_SCHEMA_VERSION, 1);
});

test("a health report validates and reports its engines", () => {
  const health = assertHealth(validHealth());
  assert.equal(health.status, "ok");
  assert.equal(health.engines[0].id, "native");
});

test("health rejects unknown fields and invalid status", () => {
  assert.throws(() => assertHealth({ ...validHealth(), extra: true }), ContractError);
  assert.throws(() => assertHealth(validHealth({ status: "unknown" })), ContractError);
  assert.throws(() => assertHealth(validHealth({ uptimeMs: -1 })), ContractError);
});

test("readiness validates missing capabilities", () => {
  assert.equal(assertReadiness({
    ready: false,
    missing: ["tools"],
    checks: [{ name: "tools", status: "failed", required: true, detail: "disabled" }],
  }).ready, false);
  assert.throws(() => assertReadiness({ ready: true, missing: "tools", checks: [] }), ContractError);
  assert.throws(() => assertReadiness({ ready: true, missing: [], checks: ["tools"] }), ContractError);
});

test("agent lists validate capabilities, availability and isolation", () => {
  const agents = assertAgentList(validAgents());
  assert.equal(agents.agents[0].id, "coderax");
  assert.throws(
    () => assertAgentList(validAgents({ agents: [{ ...validAgents().agents[0], engine: "other" }] })),
    ContractError,
  );
  assert.throws(
    () => assertAgentList(validAgents({ agents: [{ ...validAgents().agents[0], extra: true }] })),
    ContractError,
  );
});

test("agentCapability refuses unavailable and unsupported agents without substitution", () => {
  const agents = validAgents();
  assert.equal(agentCapability(agents, "coderax", "tools").supported, true);
  const unavailable = validAgents({
    agents: [{
      ...agents.agents[0],
      availability: { available: false, reason: "not_configured", detail: "no key" },
    }],
  });
  const result = agentCapability(unavailable, "coderax", null);
  assert.equal(result.supported, false);
  assert.match(result.reason, /unavailable/);
  assert.equal(agentCapability(agents, "missing", null).supported, false);
  const noTools = validAgents({
    agents: [{ ...agents.agents[0], capabilities: { ...agents.agents[0].capabilities, tools: false } }],
  });
  assert.equal(agentCapability(noTools, "coderax", "tools").supported, false);
});

test("model lists require a valid route and alternates", () => {
  const models = {
    models: [
      {
        ref: { providerId: "p", modelId: "m" },
        label: "Free",
        costClass: "free",
        contextTokens: 1000,
        toolCalling: true,
        streaming: true,
        availability: { available: true, reason: "ready", detail: "" },
      },
    ],
    route: [{ providerId: "p", modelId: "m" }],
    allowPaid: false,
  };
  assert.equal(assertModelList(models).models[0].costClass, "free");
  assert.throws(() => assertModelList({ ...models, allowPaid: "no" }), ContractError);
  assert.deepEqual(assertModelList({ ...models, models: [] }).models, []);
});

test("task accepted and task status validate the durable shape", () => {
  const accepted = assertTaskAccepted({
    taskId: "task_1",
    conversationId: "conv_1",
    state: "queued",
    generation: 0,
    eventsPath: "/v1/work/task_1/events",
  });
  assert.equal(accepted.taskId, "task_1");
  assert.equal(assertTaskStatus(validTaskStatus()).state, "running");
  assert.throws(() => assertTaskStatus(validTaskStatus({ state: "pending" })), ContractError);
  assert.throws(() => assertTaskStatus(validTaskStatus({ cancelRequested: "no" })), ContractError);
});

test("task control results validate outcome and generation", () => {
  assert.equal(
    assertTaskControl({ taskId: "task_1", state: "cancelled", generation: 1, outcome: "accepted" }).outcome,
    "accepted",
  );
  assert.throws(
    () => assertTaskControl({ taskId: "task_1", state: "cancelled", generation: 1, outcome: "maybe" }),
    ContractError,
  );
});

test("every known execution event validates; an unknown type is ignored", () => {
  const events = [
    validEvent({ type: "task.queued" }),
    validEvent({ type: "task.started", payload: { sessionId: "s" } }),
    validEvent({ type: "step.started", payload: { stepId: "s1", title: "Inspect" } }),
    validEvent({ type: "step.completed", payload: { stepId: "s1", title: "Inspect" } }),
    validEvent({ type: "text.delta", payload: { text: "hello" } }),
    validEvent({ type: "text.replace", payload: { text: "" } }),
    validEvent({ type: "tool.call", payload: { callId: "c1", tool: "read", input: { path: "README.md" } } }),
    validEvent({ type: "tool.result", payload: { callId: "c1", tool: "read", ok: true, output: "ok" } }),
    validEvent({ type: "file.edit", payload: { path: "src/a.js" } }),
    validEvent({ type: "approval.required", payload: { requestId: "r1", tool: "command", description: "Run tests" } }),
    validEvent({ type: "usage", payload: { inputTokens: 1, outputTokens: 2 } }),
    validEvent({ type: "task.completed", payload: { summary: "done", usage: { inputTokens: 1, outputTokens: 2 } } }),
    validEvent({ type: "task.failed", payload: { code: "provider_error", detail: "upstream", retryable: false } }),
    validEvent({ type: "task.cancelled", payload: { reason: "owner" } }),
    validEvent({ type: "task.interrupted", payload: { detail: "restart" } }),
    validEvent({ type: "future.event", payload: { anything: true } }),
  ];
  for (const event of events) {
    if (event.type === "future.event") {
      assert.equal(assertExecutionEvent(event), null);
    } else {
      assert.equal(assertExecutionEvent(event).type, event.type);
    }
  }
  assert.equal(isTerminalEventType("task.completed"), true);
  assert.equal(isTerminalEventType("text.delta"), false);
  assert.equal(isTerminalTaskState("cancelled"), true);
  assert.equal(isTerminalTaskState("running"), false);
});

test("malformed known events are contract errors", () => {
  assert.throws(
    () => assertExecutionEvent(validEvent({ type: "text.delta", payload: { text: 3 } })),
    ContractError,
  );
  assert.throws(
    () => assertExecutionEvent(validEvent({ type: "text.delta", payload: { text: "x", extra: 1 } })),
    ContractError,
  );
  assert.throws(() => assertExecutionEvent(validEvent({ v: 2 })), ContractError);
  assert.throws(() => assertExecutionEvent(validEvent({ seq: 0 })), ContractError);
  assert.throws(() => assertExecutionEvent(validEvent({ generation: -1 })), ContractError);
});

test("chat, conversations, memory, permissions and notifications validate", () => {
  const reply = {
    conversationId: "conv_1",
    messageId: "msg_1",
    text: "hi",
    agent: "coderax",
    model: { providerId: "p", modelId: "m" },
    usage: { inputTokens: 1, outputTokens: 2 },
    createdAt: now,
  };
  assert.equal(assertChatReply(reply).text, "hi");
  assert.throws(() => assertChatReply({ ...reply, agent: "other" }), ContractError);

  const summary = { conversationId: "conv_1", title: "T", isWork: true, agent: "coderax", updatedAt: now };
  assert.equal(assertConversationList({ conversations: [summary] }).conversations.length, 1);
  const conversation = {
    ...summary,
    mode: "cloud",
    createdAt: now,
    messages: [{ messageId: "m1", conversationId: "conv_1", role: "user", text: "hello", createdAt: now }],
  };
  assert.equal(assertConversation(conversation).messages[0].role, "user");
  assert.throws(() => assertConversation({ ...conversation, messages: [{ ...conversation.messages[0], role: "system" }] }), ContractError);
  assert.deepEqual(assertMemoryList({ entries: [] }).entries, []);

  const permission = {
    requestId: "r1",
    taskId: "task_1",
    agent: "coderax",
    scope: "command.execute",
    description: "Run tests",
    resource: "npm test",
    requestedAt: now,
    expiresAt: now,
    decision: "pending",
  };
  assert.equal(assertPermissionList({ requests: [permission] }).requests[0].decision, "pending");
  assert.throws(() => assertPermissionList({ requests: [{ ...permission, scope: "root" }] }), ContractError);

  const notification = {
    taskId: "task_1",
    conversationId: "conv_1",
    agent: "coderax",
    mode: "cloud",
    state: "completed",
    createdAt: now,
    read: false,
  };
  assert.equal(assertNotificationList({ notifications: [notification], unread: 1 }).unread, 1);
  assert.throws(() => assertNotificationList({ notifications: [notification], unread: -1 }), ContractError);
});
