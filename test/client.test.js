import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { CoderaxError, redact, request } from "../src/client.js";

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

test("redact leaves non-matching text untouched", () => {
  assert.equal(redact("nothing to hide", TOKEN), "nothing to hide");
  assert.equal(redact("", TOKEN), "");
  assert.equal(redact("abc", null), "abc");
});

test("a missing base URL is a configuration error", async () => {
  await assert.rejects(
    () => request({ token: TOKEN, path: "/health" }),
    (error) => error instanceof CoderaxError && error.code === "BASE_URL_REQUIRED",
  );
});
