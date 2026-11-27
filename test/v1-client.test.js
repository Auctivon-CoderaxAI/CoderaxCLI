import test from "node:test";
import assert from "node:assert/strict";
import { V1Client } from "../packages/workflow-sdk/src/v1/index.js";

const HEALTH = {
  status: "ok",
  contractVersion: "1.0.0",
  startedAt: "2026-11-27T00:00:00.000Z",
  uptimeMs: 1,
  checks: [],
  engines: [],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames) {
  const text = frames
    .map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`)
    .join("");
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function clientWith(handler, options = {}) {
  const calls = [];
  const client = new V1Client({
    baseUrl: "https://engine.example.test",
    token: "owner-token-0123456789",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    },
    ...options,
  });
  return { client, calls };
}

test("negotiation accepts 1.x and records a diagnostic for a newer minor", async () => {
  const seen = [];
  const { client } = clientWith(
    () => jsonResponse({ ...HEALTH, contractVersion: "1.2.0" }),
    { onDiagnostic: (entry) => seen.push(entry) },
  );
  const result = await client.negotiate();
  assert.equal(result.newerMinor, true);
  assert.equal(seen[0].code, "CONTRACT_MINOR_NEWER");
});

test("negotiation refuses a different major without falling back", async () => {
  const { client } = clientWith(() => jsonResponse({ ...HEALTH, contractVersion: "2.0.0" }));
  await assert.rejects(
    () => client.negotiate(),
    (error) => error.code === "CONTRACT_UNSUPPORTED",
  );
});

test("an SSE chat reply is assembled from deltas and its final ChatReply", async () => {
  const events = [];
  const { client } = clientWith((url) => {
    if (url.endsWith("/v1/health")) return jsonResponse(HEALTH);
    if (url.endsWith("/v1/chat")) {
      return sseResponse([
        { type: "text.delta", text: "hello " },
        { type: "text.delta", text: "world" },
        {
          conversationId: "conversation_1",
          messageId: "message_1",
          text: "hello world",
          agent: "coderax",
          model: { providerId: "local", modelId: "native" },
          createdAt: "2026-11-27T00:00:01.000Z",
        },
      ]);
    }
    throw new Error(`unexpected ${url}`);
  });
  const reply = await client.chat({ message: "hi" }, { onDelta: (delta) => events.push(delta) });
  assert.equal(reply.text, "hello world");
  assert.deepEqual(events, [
    { type: "delta", text: "hello " },
    { type: "delta", text: "world" },
  ]);
});

test("a JSON chat reply is accepted because the engine answers both shapes", async () => {
  const { client } = clientWith((url) => {
    if (url.endsWith("/v1/health")) return jsonResponse(HEALTH);
    return jsonResponse({
      conversationId: "conversation_1",
      messageId: "message_1",
      text: "direct",
      agent: "coderax",
      model: { providerId: "local", modelId: "native" },
      createdAt: "2026-11-27T00:00:01.000Z",
    });
  });
  const reply = await client.chat({ message: "hi" });
  assert.equal(reply.text, "direct");
});

test("work submission sends the idempotency key and validates the acceptance", async () => {
  const { client, calls } = clientWith((url) => {
    if (url.endsWith("/v1/health")) return jsonResponse(HEALTH);
    return jsonResponse(
      {
        taskId: "task_1",
        conversationId: "conversation_1",
        state: "queued",
        generation: 0,
        eventsPath: "/v1/work/task_1/events",
      },
      202,
    );
  });
  const accepted = await client.submitWork(
    { objective: "do the thing", mode: "cloud", requireApproval: true },
    { idempotencyKey: "key-1" },
  );
  assert.equal(accepted.taskId, "task_1");
  const submit = calls.find((call) => call.url.endsWith("/v1/work"));
  assert.equal(submit.init.headers["idempotency-key"], "key-1");
  assert.equal(submit.init.headers["x-coderax-client-request-id"], "key-1");
});

test("an owner 401 refreshes the token once and retries", async () => {
  let attempts = 0;
  const provider = {
    get: () => "stale-token-0123456789",
    refresh: async () => "fresh-token-0123456789",
  };
  const { client, calls } = clientWith(
    () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ code: "unauthorized", message: "expired" }, 401);
      }
      return jsonResponse({ agents: [] });
    },
    { tokenProvider: provider, token: undefined },
  );
  const agents = await client.agents();
  assert.deepEqual(agents.agents, []);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.authorization, "Bearer fresh-token-0123456789");
});

test("events replay from the cursor and drop a duplicated event id", async () => {
  const frames = [
    {
      v: 1,
      eventId: "evt_2",
      taskId: "task_1",
      seq: 2,
      at: "2026-11-27T00:00:02.000Z",
      agent: "coderax",
      generation: 0,
      type: "text.delta",
      payload: { text: "two" },
    },
    {
      v: 1,
      eventId: "evt_2",
      taskId: "task_1",
      seq: 2,
      at: "2026-11-27T00:00:02.000Z",
      agent: "coderax",
      generation: 0,
      type: "text.delta",
      payload: { text: "two" },
    },
  ];
  const { client, calls } = clientWith(() => sseResponse(frames));
  const seen = [];
  for await (const { event } of client.events("task_1", { after: 1 })) seen.push(event.eventId);
  assert.deepEqual(seen, ["evt_2"]);
  assert.match(calls[0].url, /after=1/);
  assert.equal(calls[0].init.headers["last-event-id"], "1");
});
