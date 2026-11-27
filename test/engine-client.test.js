import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  CONTRACT_FINGERPRINT,
  CONTRACT_VERSION,
  ROUTES,
} from "../src/engine-contract.js";
import { EngineClient } from "../src/engine-client.js";

function handshake(overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    contractMajor: 1,
    eventSchemaVersion: 1,
    chatStreamVersion: 1,
    apiPrefix: "/v1",
    contractFingerprint: CONTRACT_FINGERPRINT,
    supportedContractVersions: ["1.0.0", "1.1.0", "1.2.0"],
    compatible: true,
    negotiatedContractVersion: CONTRACT_VERSION,
    negotiation: "exact",
    server: { name: "Coderax WorkflowEngine", version: "0.1.0", startedAt: new Date(0).toISOString() },
    operations: ROUTES.map((route) => ({
      operationId: route.operationId,
      method: route.method,
      path: route.path,
      tags: [],
      auth: route.auth,
      stream: route.stream,
    })),
    capabilities: {
      health: true,
      discovery: true,
      chat: true,
      chatStreaming: true,
      work: true,
      workStreaming: true,
      cursorReplay: true,
      cancellation: true,
      resume: true,
      retry: true,
      permissions: true,
      notifications: true,
      notificationRead: true,
      schedules: true,
      artifacts: true,
      memory: true,
      memorySearch: true,
      conversations: true,
      taskList: true,
      idempotentSubmission: true,
      externalAgents: false,
      paidModels: false,
    },
    limits: {
      maxBodyBytes: 1_000_000,
      eventBufferSize: 1000,
      maxConcurrentTasks: 4,
      scheduleMinIntervalMs: 60_000,
      artifactMaxBytes: 1_000_000,
      memoryMaxValueLength: 20_000,
    },
    ...overrides,
  };
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
  });
}

test("negotiates the 1.2.0 contract and validates the published catalogue", async () => {
  await withServer(
    async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      assert.equal(url.pathname, "/v1/handshake");
      assert.equal(url.searchParams.get("contract"), CONTRACT_VERSION);
      assert.equal(url.searchParams.get("fingerprint"), CONTRACT_FINGERPRINT);
      assert.equal(request.headers.authorization, "Bearer owner-token-value");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(handshake()));
    },
    async (url) => {
      const client = new EngineClient({ baseUrl: url, token: "owner-token-value" });
      const report = await client.compatibility();
      assert.equal(report.compatible, true);
      assert.deepEqual(report.problems, []);
      assert.equal(report.contractVersion, CONTRACT_VERSION);
      assert.equal(report.caps.idempotentSubmission, true);
    },
  );
});

test("a same-version catalogue with a different fingerprint is refused", async () => {
  await withServer(
    async (request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(handshake({ contractFingerprint: "sha256:" + "0".repeat(64) })));
    },
    async (url) => {
      const client = new EngineClient({ baseUrl: url, token: "owner-token-value" });
      const report = await client.compatibility();
      assert.equal(report.compatible, false);
      assert.ok(report.problems.some((problem) => problem.includes("fingerprint")));
    },
  );
});

test("a different major is reported as a hard incompatibility", async () => {
  await withServer(
    async (request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(handshake({ contractMajor: 2, contractVersion: "2.0.0" })));
    },
    async (url) => {
      const client = new EngineClient({ baseUrl: url, token: "owner-token-value" });
      const report = await client.compatibility();
      assert.equal(report.compatible, false);
      assert.ok(report.problems.some((problem) => problem.includes("major 2")));
    },
  );
});

test("a Problem body keeps its stable code and never echoes the token", async () => {
  const token = "very-secret-owner-token-0123456789";
  await withServer(
    async (request, response) => {
      response.statusCode = 401;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          type: "about:blank",
          title: "Unauthorized",
          status: 401,
          code: "unauthorized",
          detail: "the bearer token was rejected",
        }),
      );
    },
    async (url) => {
      const client = new EngineClient({ baseUrl: url, token });
      await assert.rejects(
        () => client.agents(),
        (error) => {
          assert.equal(error.code, "unauthorized");
          assert.equal(error.status, 401);
          assert.equal(error.message.includes(token), false);
          return true;
        },
      );
    },
  );
});

test("Work submission sends the idempotency key and reads the replay flag", async () => {
  let calls = 0;
  await withServer(
    async (request, response) => {
      const body = JSON.parse(await readBody(request));
      calls += 1;
      assert.equal(body.idempotencyKey, "cli-test-key-0001");
      assert.equal(body.objective, "ship the release");
      response.statusCode = 202;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          taskId: "task-1",
          conversationId: "conv-1",
          state: "queued",
          generation: 0,
          eventsPath: "/v1/work/task-1/events",
          replayed: calls > 1,
        }),
      );
    },
    async (url) => {
      const client = new EngineClient({ baseUrl: url, token: "owner-token-value" });
      const accepted = await client.submitWork({
        objective: "ship the release",
        idempotencyKey: "cli-test-key-0001",
      });
      assert.equal(accepted.taskId, "task-1");
      assert.equal(accepted.replayed, false);
      const replay = await client.submitWork({
        objective: "ship the release",
        idempotencyKey: "cli-test-key-0001",
      });
      assert.equal(replay.replayed, true);
    },
  );
});

test("execution events stream from an after cursor with truncation signalling", async () => {
  const seen = [];
  await withServer(
    async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      assert.equal(url.pathname, "/v1/work/task-1/events");
      assert.equal(url.searchParams.get("after"), "2");
      assert.match(request.headers.accept, /text\/event-stream/);
      assert.match(request.headers.accept, /truncation=signal/);
      seen.push("requested");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          v: 1,
          eventId: "evt-3",
          taskId: "task-1",
          seq: 3,
          at: new Date(0).toISOString(),
          agent: "coderax",
          generation: 1,
          type: "text.delta",
          payload: { text: "hello" },
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          v: 1,
          eventId: "evt-4",
          taskId: "task-1",
          seq: 4,
          at: new Date(0).toISOString(),
          agent: "coderax",
          generation: 1,
          type: "task.completed",
          payload: { summary: "done" },
        })}\n\n`,
      );
      response.end();
    },
    async (url) => {
      const client = new EngineClient({ baseUrl: url, token: "owner-token-value" });
      const events = [];
      for await (const event of client.events("task-1", { after: 2 })) events.push(event);
      assert.equal(events.length, 2);
      assert.equal(events[0].seq, 3);
      assert.equal(events[1].type, "task.completed");
      assert.deepEqual(seen, ["requested"]);
    },
  );
});

test("a malformed stream frame is a protocol failure, not silent text", async () => {
  await withServer(
    async (request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: not-json\n\n");
    },
    async (url) => {
      const client = new EngineClient({ baseUrl: url, token: "owner-token-value" });
      await assert.rejects(
        async () => {
          for await (const event of client.events("task-1")) void event;
        },
        (error) => error.code === "STREAM_PROTOCOL",
      );
    },
  );
});
