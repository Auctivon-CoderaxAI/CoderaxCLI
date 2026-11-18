import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { CoderaxError, redact, redactValue, request, streamRequest } from "../src/client.js";

const TOKEN = "token-that-must-never-leak";

async function withStub(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

test("sends a bearer token and parses JSON", async () => {
  await withStub(
    (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "coderax" }));
    },
    async (baseUrl) => {
      const response = await request({ baseUrl, token: TOKEN, path: "/health" });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { ok: true, service: "coderax" });
    },
  );
});

test("surfaces non-2xx responses as typed errors", async () => {
  await withStub(
    (req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => request({ baseUrl, token: TOKEN, path: "/missing" }),
        (error) => error instanceof CoderaxError && error.code === "HTTP_404" && error.status === 404,
      );
    },
  );
});

test("redacts the token even when the server echoes it", async () => {
  await withStub(
    (req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `bad token ${TOKEN}` }));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => request({ baseUrl, token: TOKEN, path: "/api/ask" }),
        (error) => {
          assert.equal(error.message.includes(TOKEN), false);
          assert.match(error.message, /REDACTED/);
          return true;
        },
      );
    },
  );
});

test("refuses redirects instead of following them", async () => {
  await withStub(
    (req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example.com" });
      res.end();
    },
    async (baseUrl) => {
      await assert.rejects(
        () => request({ baseUrl, token: TOKEN, path: "/api/ask" }),
        (error) => error instanceof CoderaxError && error.code === "REQUEST_FAILED",
      );
    },
  );
});

test("times out instead of hanging", async () => {
  await withStub(
    () => {
      // Intentionally never responds.
    },
    async (baseUrl) => {
      await assert.rejects(
        () => request({ baseUrl, token: TOKEN, path: "/slow", timeoutMs: 60 }),
        (error) => error instanceof CoderaxError && error.code === "REQUEST_TIMEOUT",
      );
    },
  );
});

test("maps a response body timeout to REQUEST_TIMEOUT", async () => {
  await withStub(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
    },
    async (baseUrl) => {
      await assert.rejects(
        () => request({ baseUrl, token: TOKEN, path: "/slow-body", timeoutMs: 60 }),
        (error) => error instanceof CoderaxError && error.code === "REQUEST_TIMEOUT",
      );
    },
  );
});

test("renders object-valued error details as text", async () => {
  await withStub(
    (req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key", type: "auth" } }));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => request({ baseUrl, token: TOKEN, path: "/api/ask" }),
        (error) => {
          assert.equal(error.code, "HTTP_401");
          assert.match(error.message, /Invalid API key/);
          assert.equal(error.message.includes("[object Object]"), false);
          return true;
        },
      );
    },
  );
});

test("request errors redact a token in the route path", async () => {
  await withStub(
    (req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "boom" }));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => request({ baseUrl, token: TOKEN, path: `/api/${TOKEN}/missing` }),
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

test("streamRequest errors redact a token in the route path", async () => {
  await assert.rejects(
    () =>
      streamRequest({
        baseUrl: "https://coderax.test",
        token: TOKEN,
        path: `/api/${TOKEN}/ask`,
        fetchImpl: async () =>
          new Response("boom", { status: 500, headers: { "content-type": "text/plain" } }),
      }),
    (error) => {
      assert.equal(error.code, "HTTP_500");
      assert.equal(error.message.includes(TOKEN), false);
      assert.match(error.message, /REDACTED/);
      return true;
    },
  );
});

test("redact leaves non-matching text untouched", () => {
  assert.equal(redact("nothing to hide", TOKEN), "nothing to hide");
  assert.equal(redact("", TOKEN), "");
  assert.equal(redact("abc", null), "abc");
});

test("redact never reintroduces a token contained in the marker", () => {
  const token = "E";
  const redacted = redact(`before${token}after`, token);
  assert.equal(redacted.includes(token), false);
});

test("redact does not create the token across a replacement boundary", () => {
  const token = "]A";
  const redacted = redact(`${token}A`, token);
  assert.equal(redacted.includes(token), false);
});

test("redactValue keeps structure while replacing nested tokens", () => {
  assert.deepEqual(redactValue({ a: [TOKEN, 1, null] }, TOKEN), { a: ["[REDACTED]", 1, null] });
  assert.deepEqual(redactValue({ a: 1 }, null), { a: 1 });
});

test("redactValue redacts tokens used as object keys", () => {
  assert.deepEqual(redactValue({ [TOKEN]: { value: TOKEN } }, TOKEN), {
    "[REDACTED]": { value: "[REDACTED]" },
  });
});

test("redactValue keeps keys and values free of a token contained in the marker", () => {
  const redacted = redactValue({ xE: "E" }, "E");
  assert.equal(Object.keys(redacted).length, 1);
  assert.equal(JSON.stringify(redacted).includes("E"), false);
});


test("redactValue keeps a __proto__ field as an own property", () => {
  const parsed = JSON.parse('{"__proto__":{"x":1},"ok":true}');
  const redacted = redactValue(parsed, TOKEN);
  assert.deepEqual(Object.keys(redacted), ["__proto__", "ok"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(redacted, "__proto__").value, { x: 1 });
  assert.equal(redacted.ok, true);
});

test("redactValue keeps both fields when redacted keys collide", () => {
  assert.deepEqual(redactValue({ [TOKEN]: 1, "[REDACTED]": 2 }, TOKEN), {
    "[REDACTED]": 1,
    "[REDACTED]#2": 2,
  });
});

test("redactValue does not bring the token back through a collision suffix", () => {
  const redacted = redactValue({ x2: "one", "x[REDACTED]": "two" }, "2");
  assert.deepEqual(redacted, {
    "x[REDACTED]": "one",
    "x[REDACTED]#[REDACTED]": "two",
  });
  assert.equal(JSON.stringify(redacted).includes("2"), false);
});

test("redactValue skips suffixes already taken by another key", () => {
  const unit = "[REDACTED]";
  const base = `${unit}${unit}`;
  const redacted = redactValue(
    {
      [`${base}#2`]: "occupied",
      [`${TOKEN}${TOKEN}`]: 1,
      [`${TOKEN}${unit}`]: 2,
      [`${unit}${TOKEN}`]: 3,
      [base]: 4,
    },
    TOKEN,
  );
  assert.deepEqual(redacted, {
    [`${base}#2`]: "occupied",
    [base]: 1,
    [`${base}#3`]: 2,
    [`${base}#4`]: 3,
    [`${base}#5`]: 4,
  });
});

test("a missing base URL is a configuration error", async () => {
  await assert.rejects(
    () => request({ token: TOKEN, path: "/health" }),
    (error) => error instanceof CoderaxError && error.code === "BASE_URL_REQUIRED",
  );
});

test("preserves the deployment pathname prefix", async () => {
  await withStub(
    (req, res) => {
      if (req.url === "/coderax/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    },
    async (baseUrl) => {
      const response = await request({ baseUrl: `${baseUrl}/coderax`, token: TOKEN, path: "/health" });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { status: "ok" });
    },
  );
});

test("does not truncate long successful text responses", async () => {
  const long = "x".repeat(2500);
  await withStub(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(long);
    },
    async (baseUrl) => {
      const response = await request({ baseUrl, token: TOKEN, path: "/log" });
      assert.equal(response.text.length, 2500);
    },
  );
});

test("redacts the token inside successful JSON without breaking its shape", async () => {
  await withStub(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: TOKEN, nested: { echo: TOKEN, count: 3 } }));
    },
    async (baseUrl) => {
      const response = await request({ baseUrl, token: TOKEN, path: "/whoami" });
      assert.deepEqual(response.json, {
        token: "[REDACTED]",
        nested: { echo: "[REDACTED]", count: 3 },
      });
    },
  );
});

test("redacts a token before truncating a network failure", async () => {
  const token = "SECRET-TOKEN";
  const message = `${"x".repeat(295)}${token}`;
  await assert.rejects(
    () =>
      request({
        baseUrl: "https://coderax.test",
        token,
        path: "/health",
        fetchImpl: async () => {
          throw new Error(message);
        },
      }),
    (error) => {
      assert.equal(error.code, "REQUEST_FAILED");
      assert.equal(error.message.includes("SECRE"), false);
      return true;
    },
  );
});

test("streamRequest uses an idle timeout, not a total deadline", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"delta":"one "}\n\n',
    'data: {"delta":"two "}\n\n',
    'data: {"delta":"three"}\n\n',
    "data: [DONE]\n\n",
  ];
  let index = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });

  const text = await streamRequest({
    baseUrl: "https://coderax.test",
    token: TOKEN,
    path: "/api/ask",
    timeoutMs: 150,
    fetchImpl: async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });

  assert.equal(text, "one two three");
});

test("renders object-valued SSE errors as text", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"error":{"message":"bad stream","type":"auth"}}\n\n'));
      controller.close();
    },
  });

  await assert.rejects(
    () =>
      streamRequest({
        baseUrl: "https://coderax.test",
        token: TOKEN,
        path: "/api/ask",
        fetchImpl: async () =>
          new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      }),
    (error) => {
      assert.equal(error.code, "STREAM_ERROR");
      assert.match(error.message, /bad stream/);
      assert.equal(error.message.includes("[object Object]"), false);
      return true;
    },
  );
});

test("streamRequest redacts overlapping token prefixes", async () => {
  const token = "aba";
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"delta":"ab"}\n\n',
    'data: {"delta":"a"}\n\n',
    "data: [DONE]\n\n",
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const text = await streamRequest({
    baseUrl: "https://coderax.test",
    token,
    path: "/api/ask",
    fetchImpl: async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });

  assert.equal(text, "[REDACTED]");
});

test("streamRequest emits raw and top-level string SSE data", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "data: hello\n\n",
    'data: " world"\n\n',
    "data: [DONE]\n\n",
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const text = await streamRequest({
    baseUrl: "https://coderax.test",
    token: TOKEN,
    path: "/api/ask",
    fetchImpl: async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });

  assert.equal(text, "hello world");
});

test("streamRequest redacts a token split across content fields", async () => {
  const token = "secret";
  const events = [];
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"content":"hello sec"}\n\n',
    'data: {"content":"ret world"}\n\n',
    "data: [DONE]\n\n",
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const text = await streamRequest({
    baseUrl: "https://coderax.test",
    token,
    path: "/api/ask",
    fetchImpl: async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    onEvent: (event) => events.push(event),
  });

  assert.equal(text.includes(token), false);
  assert.match(text, /hello \[REDACTED\] world/);
  assert.equal(JSON.stringify(events).includes(token), false);
});

test("streamRequest redacts a token split across SSE events", async () => {
  const token = "split-token";
  const events = [];
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"delta":"hello spl"}\n\n',
    'data: {"delta":"it-token world"}\n\n',
    "data: [DONE]\n\n",
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const text = await streamRequest({
    baseUrl: "https://coderax.test",
    token,
    path: "/api/ask",
    fetchImpl: async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    onEvent: (event) => events.push(event),
  });

  assert.equal(text.includes(token), false);
  assert.match(text, /hello \[REDACTED\] world/);
  assert.equal(JSON.stringify(events).includes(token), false);
});
