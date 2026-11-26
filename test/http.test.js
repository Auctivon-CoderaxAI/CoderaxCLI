import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { CoderaxError, CancelledError } from "../src/errors.js";
import {
  httpRequest,
  joinRoute,
  openSseStream,
  parseSseFrame,
  parseSseStream,
  problemError,
} from "../src/http.js";

const TOKEN = "owner-token-that-must-never-leak";

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await run(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonResponse(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

test("joinRoute preserves a path prefix and refuses another origin", () => {
  assert.equal(joinRoute("https://coderax.test/base", "/v1/health").toString(), "https://coderax.test/base/v1/health");
  assert.equal(joinRoute("https://coderax.test", "//evil.test/v1").origin, "https://coderax.test");
  assert.throws(() => joinRoute(undefined, "/v1"), (error) => error.code === "BASE_URL_REQUIRED");
});

test("a request sends the owner token, bounded JSON, and redacts the token", async () => {
  await withServer(
    async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(req.headers["user-agent"].startsWith("coderax-cli/"), true);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { message: "hi" });
      jsonResponse(res, 200, { echo: TOKEN, ok: true });
    },
    async (base) => {
      const response = await httpRequest({
        baseUrl: base,
        token: TOKEN,
        path: "/v1/chat",
        method: "POST",
        body: { message: "hi" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { echo: "[REDACTED]", ok: true });
      assert.equal(response.rawJson.echo, TOKEN);
      assert.equal(response.text.includes(TOKEN), false);
    },
  );
});

test("a Problem response becomes a typed error with retryability", async () => {
  const problem = {
    type: "https://coderax.dev/problems/unauthorized",
    title: "unauthorized",
    status: 401,
    code: "unauthorized",
    detail: "owner token required",
    requestId: "req_1",
    retryable: false,
  };
  await withServer(
    (req, res) => jsonResponse(res, 401, problem),
    async (base) => {
      await assert.rejects(
        () => httpRequest({ baseUrl: base, path: "/v1/agents" }),
        (error) => {
          assert.ok(error instanceof CoderaxError);
          assert.equal(error.code, "unauthorized");
          assert.equal(error.status, 401);
          assert.equal(error.requestId, "req_1");
          assert.equal(error.retryable, false);
          assert.equal(error.details.code, "unauthorized");
          return true;
        },
      );
    },
  );
});

test("a non-Problem error body is bounded and redacted", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`boom ${TOKEN}`);
    },
    async (base) => {
      await assert.rejects(
        () => httpRequest({ baseUrl: base, token: TOKEN, path: "/v1/fail" }),
        (error) => {
          assert.equal(error.code, "HTTP_500");
          assert.equal(error.message.includes(TOKEN), false);
          assert.match(error.message, /REDACTED/);
          return true;
        },
      );
    },
  );
});

test("redirects are refused rather than followed", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example" });
      res.end();
    },
    async (base) => {
      await assert.rejects(
        () => httpRequest({ baseUrl: base, path: "/v1/redirect" }),
        (error) => error.code === "REQUEST_FAILED",
      );
    },
  );
});

test("a response body that stalls times out", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{\"ok\":");
    },
    async (base) => {
      await assert.rejects(
        () => httpRequest({ baseUrl: base, path: "/v1/slow", timeoutMs: 60 }),
        (error) => error.code === "REQUEST_TIMEOUT" && error.retryable === true,
      );
    },
  );
});

test("a response larger than the cap is refused", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(1000));
    },
    async (base) => {
      await assert.rejects(
        () => httpRequest({ baseUrl: base, path: "/v1/large", maxBytes: 100 }),
        (error) => error.code === "RESPONSE_TOO_LARGE",
      );
    },
  );
});

test("a pre-aborted caller signal never starts a request", async () => {
  let requests = 0;
  await withServer(
    (req, res) => {
      requests += 1;
      res.end("{}");
    },
    async (base) => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => httpRequest({ baseUrl: base, path: "/v1/never", signal: controller.signal }),
        CancelledError,
      );
      assert.equal(requests, 0);
    },
  );
});

test("parseSseFrame handles comments, multi-line data, ids and retry hints", () => {
  assert.deepEqual(parseSseFrame(": keepalive\nid: 7\nevent: tick\nretry: 250\ndata: one\ndata: two"), {
    id: "7",
    event: "tick",
    retry: 250,
    data: "one\ntwo",
  });
  assert.equal(parseSseFrame(": only a comment"), null);
  assert.deepEqual(parseSseFrame("data: hello"), { id: undefined, event: undefined, retry: undefined, data: "hello" });
});

test("parseSseStream reassembles frames split across arbitrary chunks and CRLF", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "id: 1\r\ndata: {\"a\":",
    "1}\r\n\r\nid: 2\ndata: hello\n",
    "\ndata: last\n\n",
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of parseSseStream(body)) frames.push(frame);
  assert.deepEqual(frames.map((frame) => frame.data), ['{"a":1}', "hello", "last"]);
  assert.deepEqual(frames.map((frame) => frame.id), ["1", "2", undefined]);
});

test("a CRLF split across reads is one line ending, not a frame boundary", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: one\r"));
      controller.enqueue(encoder.encode("\ndata: two\r\n\r\n"));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of parseSseStream(body)) frames.push(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, "one\ntwo");
});

test("openSseStream sends Last-Event-ID, enforces the content type and redacts data", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.headers["last-event-id"], "5");
      assert.equal(req.headers.accept, "text/event-stream");
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write(`id: 6\ndata: {"text":"${TOKEN}"}\n\n`);
      res.end("id: 7\ndata: [DONE]\n\n");
    },
    async (base) => {
      const stream = await openSseStream({
        baseUrl: base,
        token: TOKEN,
        path: "/v1/work/t/events",
        query: { after: 5 },
        lastEventId: "5",
      });
      const frames = [];
      for await (const frame of stream.frames) frames.push(frame);
      assert.equal(frames[0].id, "6");
      assert.equal(frames[0].data.includes(TOKEN), false);
      assert.match(frames[0].data, /REDACTED/);
      assert.equal(frames[1].data, "[DONE]");
    },
  );
});

test("openSseStream refuses a non-event-stream response", async () => {
  await withServer(
    (req, res) => jsonResponse(res, 200, { ok: true }),
    async (base) => {
      await assert.rejects(
        () => openSseStream({ baseUrl: base, path: "/v1/events" }),
        (error) => error.code === "PROTOCOL_ERROR",
      );
    },
  );
});

test("openSseStream uses an idle deadline for a stalled stream", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": start\n\n");
    },
    async (base) => {
      await assert.rejects(async () => {
        const stream = await openSseStream({
          baseUrl: base,
          path: "/v1/events",
          timeoutMs: 60,
        });
        for await (const frame of stream.frames) void frame;
      }, (error) => error.code === "REQUEST_TIMEOUT" && error.retryable === true);
    },
  );
});

test("problemError redacts details and keeps a machine code", () => {
  const error = problemError({
    status: 403,
    path: "/v1/work",
    redactor: { redact: (text) => text.replace(TOKEN, "[REDACTED]"), redactValue: (value) => value },
    json: {
      type: "https://coderax.dev/problems/forbidden",
      title: "forbidden",
      status: 403,
      code: "forbidden",
      detail: TOKEN,
      retryable: false,
    },
  });
  assert.equal(error.code, "forbidden");
  assert.equal(error.message.includes(TOKEN), false);
});
