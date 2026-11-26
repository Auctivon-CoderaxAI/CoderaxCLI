import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyTransport } from "../src/sdk-legacy.js";
import {
  createTransport,
  normalizeCapabilities,
  SDK_CONTRACT_VERSION,
  SUPPORTED_SDK_CONTRACTS,
} from "../src/sdk.js";

function legacyOptions(overrides = {}) {
  return {
    baseUrl: "https://coderax.test",
    token: "test-token",
    timeoutMs: 1000,
    chatPath: "/api/ask/agents",
    endpoint: "agents",
    ...overrides,
  };
}

test("legacy transport keeps the existing chat and Work contracts", async () => {
  const calls = [];
  const transport = createLegacyTransport({
    ...legacyOptions(),
    streamImpl: async (options) => {
      calls.push(options);
      options.onEvent({ type: "delta", text: "answer" });
      return "answer";
    },
  });
  assert.equal(transport.kind, "legacy");
  assert.equal(transport.capabilities.permissions, false);

  await transport.stream({ mode: "chat", text: "hello" });
  assert.equal(calls[0].path, "/api/ask/agents");
  assert.deepEqual(calls[0].body, { text: "hello", mode: "chat", endpoint: "agents" });

  await transport.stream({
    mode: "work",
    text: "fix it",
    model: "gpt-4.1",
    agent: "reviewer",
    conversationId: "c1",
    attachments: [{ name: "a.txt", content: "x" }],
  });
  assert.equal(calls[1].path, "/api/work/chat");
  assert.deepEqual(calls[1].body, {
    text: "fix it",
    mode: "work",
    endpoint: "agents",
    model: "gpt-4.1",
    agent: "reviewer",
    conversationId: "c1",
    attachments: [{ name: "a.txt", content: "x" }],
  });
});

test("legacy transport maps tools, progress and unverified permission requests", async () => {
  const events = [];
  const transport = createLegacyTransport({
    ...legacyOptions(),
    streamImpl: async (options) => {
      options.onEvent({ type: "event", payload: { type: "tool", name: "read_file", status: "ok" } });
      options.onEvent({ type: "event", payload: { type: "progress", message: "halfway" } });
      options.onEvent({
        type: "event",
        payload: { type: "permission_request", requestId: "srv_req_1", action: "read_file" },
      });
      options.onEvent({ type: "event", payload: { conversationId: "srv-conversation" } });
      return "done";
    },
  });
  const result = await transport.stream({ mode: "chat", text: "hi", onEvent: (event) => events.push(event) });
  assert.equal(events.some((event) => event.type === "tool" && event.name === "read_file"), true);
  assert.equal(events.some((event) => event.type === "progress" && event.message === "halfway"), true);
  const permission = events.find((event) => event.type === "permission");
  assert.equal(permission.channelVerified, false);
  assert.equal(permission.request.serverIssued, false);
  assert.equal(result.conversationId, "srv-conversation");
});

test("legacy transport refuses to answer permissions", async () => {
  const transport = createLegacyTransport(legacyOptions());
  await assert.rejects(
    () => transport.respondPermission({}),
    (error) => error.code === "PERMISSION_CHANNEL_UNAVAILABLE",
  );
});

test("legacy model and agent lists come from OpenAPI discovery", async () => {
  const transport = createLegacyTransport({
    ...legacyOptions(),
    discoverImpl: async () => ({
      operations: [
        { method: "GET", path: "/api/models" },
        { method: "GET", path: "/api/agents" },
      ],
    }),
    requestImpl: async ({ path }) => ({
      json: path === "/api/models" ? { models: ["a", { id: "b" }] } : { agents: [{ id: "agent-1" }] },
    }),
  });
  assert.deepEqual(await transport.listModels(), ["a", "b"]);
  assert.deepEqual(await transport.listAgents(), ["agent-1"]);
});

function canonicalModule(capabilities = {}, overrides = {}) {
  const calls = [];
  const client = {
    getCapabilities: async () => ({
      contractVersion: SDK_CONTRACT_VERSION,
      contractVerified: true,
      stream: true,
      work: true,
      tools: true,
      permissions: true,
      verifiedPermissions: true,
      models: true,
      agents: true,
      ...capabilities,
    }),
    streamMessage: async (options) => {
      calls.push({ kind: "stream", options });
      options.onEvent({ type: "delta", text: "canonical" });
      options.onEvent({
        type: "permission",
        request: {
          serverIssued: true,
          requestId: "srv_req_1",
          executionId: "exec_1",
          action: "read_file",
          resource: "/tmp/x",
        },
      });
      return { text: "canonical", conversationId: "srv-c" };
    },
    respondPermission: async (payload) => calls.push({ kind: "permission", payload }),
    listModels: async () => ["m1"],
    listAgents: async () => ["a1"],
    close: async () => calls.push({ kind: "close" }),
    ...overrides,
  };
  return { module: { createClient: async () => client }, calls };
}

test("canonical mode accepts only a verified contract and maps its events", async () => {
  const { module, calls } = canonicalModule();
  const { transport, description } = await createTransport({
    settings: legacyOptions(),
    env: { CODERAX_SDK: "canonical" },
    loadModule: async () => module,
  });
  assert.equal(transport.kind, "canonical");
  assert.equal(description.contractVerified, true);
  assert.equal(transport.capabilities.verifiedPermissions, true);

  const events = [];
  const result = await transport.stream({ mode: "chat", text: "hi", onEvent: (event) => events.push(event) });
  assert.equal(result.text, "canonical");
  assert.equal(result.conversationId, "srv-c");
  const permission = events.find((event) => event.type === "permission");
  assert.equal(permission.channelVerified, true);
  assert.equal(permission.request.serverIssued, true);
  await transport.respondPermission({ requestId: "srv_req_1" });
  assert.equal(calls.some((call) => call.kind === "permission"), true);
  await transport.close();
  assert.equal(calls.some((call) => call.kind === "close"), true);
});

test("an unverified contract is refused in canonical mode and not silently accepted", async () => {
  const { module } = canonicalModule({ contractVerified: false });
  await assert.rejects(
    () =>
      createTransport({
        settings: legacyOptions(),
        env: { CODERAX_SDK: "canonical" },
        loadModule: async () => module,
      }),
    (error) => error.code === "SDK_CONTRACT_MISMATCH",
  );
});

test("auto mode falls back to legacy when the canonical contract is unavailable", async () => {
  const { module } = canonicalModule({ contractVerified: false });
  const verified = await createTransport({
    settings: legacyOptions(),
    env: { CODERAX_SDK: "auto" },
    loadModule: async () => module,
  });
  assert.equal(verified.transport.kind, "legacy");
  assert.match(verified.description.reason, /verified/);

  const missing = await createTransport({
    settings: legacyOptions(),
    env: { CODERAX_SDK: "auto" },
    loadModule: async () => {
      throw Object.assign(new Error("not installed"), { code: "ERR_MODULE_NOT_FOUND" });
    },
  });
  assert.equal(missing.transport.kind, "legacy");
  assert.match(missing.description.reason, /unavailable/);
});

test("canonical mode fails clearly when the SDK is missing", async () => {
  await assert.rejects(
    () =>
      createTransport({
        settings: legacyOptions(),
        env: { CODERAX_SDK: "canonical" },
        loadModule: async () => {
          throw Object.assign(new Error("not installed"), { code: "ERR_MODULE_NOT_FOUND" });
        },
      }),
    (error) => error.code === "SDK_UNAVAILABLE",
  );
});

test("legacy is the default and an invalid mode is rejected", async () => {
  const legacy = await createTransport({ settings: legacyOptions(), env: {} });
  assert.equal(legacy.transport.kind, "legacy");
  await assert.rejects(
    () => createTransport({ settings: legacyOptions(), env: { CODERAX_SDK: "magic" } }),
    (error) => error.code === "SDK_MODE_INVALID",
  );
});

test("capability normalisation is explicit about permissions", () => {
  assert.equal(normalizeCapabilities({}).stream, false);
  assert.deepEqual(normalizeCapabilities({ permissions: ["read_file"] }).permissions, ["read_file"]);
  assert.equal(normalizeCapabilities({ permissions: ["read_file"] }).verifiedPermissions, false);
  assert.equal(
    normalizeCapabilities({ permissions: true, verifiedPermissions: true }).verifiedPermissions,
    true,
  );
  assert.deepEqual(SUPPORTED_SDK_CONTRACTS, [SDK_CONTRACT_VERSION]);
});
