import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

const TOKEN = "contract-token-that-must-never-leak";

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function sse(res, frames, headers = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...headers,
  });
  for (const frame of frames) res.write(frame);
  res.end();
}

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

async function tempConfig() {
  const directory = await mkdtemp(join(tmpdir(), "coderax-contract-"));
  return join(directory, "config.json");
}

function capture() {
  const out = [];
  const err = [];
  return {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

async function envFor(baseUrl) {
  return {
    CODERAX_CONFIG: await tempConfig(),
    CODERAX_BASE_URL: baseUrl,
    CODERAX_TOKEN: TOKEN,
  };
}

async function cli(args, env, { stdinIsTTY = false, readSecret } = {}) {
  const io = capture();
  const code = await runCli(args, {
    env: { CODERAX_CREDENTIAL_STORE: "file", ...env },
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY,
    readSecret,
    confirm: async () => null,
  });
  return { code, out: io.out(), err: io.err() };
}

const RUN = (id, status, extra = {}) => ({
  id,
  workflowId: "wf-1",
  workflowName: "Contract workflow",
  agentId: "agent-1",
  status,
  steps: [],
  events: [],
  createdAt: new Date(0).toISOString(),
  ...extra,
});

function negotiation(handler) {
  // Shared safe probes: no metadata, no Work history, workflows present.
  return (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/meta") return json(res, 404, { message: "not found" });
    if (url.pathname === "/api/work/tasks") return json(res, 200, { tasks: [] });
    if (url.pathname === "/api/workflows") return json(res, 200, { workflows: [] });
    return handler(req, res);
  };
}

test("chat rejects a JSON 200 where the SSE contract requires text/event-stream", async () => {
  await withStub(
    (req, res) => {
      if (req.url === "/api/work/chat") {
        return json(res, 200, { text: "not a stream" });
      }
      return json(res, 404, { message: "not found" });
    },
    async (baseUrl) => {
      const result = await cli(["chat", "hi", "--json"], await envFor(baseUrl));
      assert.equal(result.code, 7);
      assert.match(result.err, /text\/event-stream/);
      assert.equal(result.out, "");
    },
  );
});

test("chat rejects an incompatible API version response header", async () => {
  await withStub(
    (req, res) => {
      if (req.url === "/api/work/chat") {
        return sse(res, ['data: {"delta":"hello"}\n\n', "data: [DONE]\n\n"], {
          "x-coderax-api-version": "2.0",
        });
      }
      return json(res, 404, { message: "not found" });
    },
    async (baseUrl) => {
      const result = await cli(["chat", "hi", "--json"], await envFor(baseUrl));
      assert.equal(result.code, 6);
      assert.match(result.err, /API_VERSION_UNSUPPORTED|API version/);
    },
  );
});

test("duplicate and out-of-order SSE events render once and in sequence", async () => {
  let calls = 0;
  await withStub(
    (req, res) => {
      if (req.url !== "/api/work/chat") return json(res, 404, { message: "not found" });
      calls += 1;
      return sse(res, [
        'id: 1\ndata: {"delta":"a"}\n\n',
        'id: 3\ndata: {"delta":"c"}\n\n',
        'id: 1\ndata: {"delta":"a"}\n\n',
        'id: 2\ndata: {"delta":"b"}\n\n',
        "data: [DONE]\n\n",
      ]);
    },
    async (baseUrl) => {
      const result = await cli(["chat", "hi", "--json"], await envFor(baseUrl));
      assert.equal(result.code, 0);
      assert.equal(calls, 1);
      assert.equal(JSON.parse(result.out).text, "abc");
      assert.match(result.err, /DUPLICATE_EVENT/);
      assert.match(result.err, /OUT_OF_ORDER_EVENT/);
      assert.equal(result.err.includes(TOKEN), false);
    },
  );
});

test("chat surfaces snapshot-only streams instead of pretending they can replay", async () => {
  await withStub(
    (req, res) => {
      if (req.url !== "/api/work/chat") return json(res, 404, { message: "not found" });
      return sse(res, [
        'data: {"message":true,"text":"accepted"}\n\n',
        'data: {"message":true,"text":"accepted and verified"}\n\n',
        'data: {"final":true,"responseMessage":{"text":"accepted and verified"}}\n\n',
      ]);
    },
    async (baseUrl) => {
      const result = await cli(["chat", "hi", "--json"], await envFor(baseUrl));
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.out).text, "accepted and verified");
      assert.match(result.err, /CURSOR_UNSUPPORTED/);
    },
  );
});

test("run reconnects with Last-Event-ID, deduplicates replay, and reports an ignored cursor", async () => {
  const seenCursors = [];
  let streams = 0;
  await withStub(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/workflows/runs/run-ignored/stream") {
        streams += 1;
        seenCursors.push(req.headers["last-event-id"] ?? null);
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (streams === 1) {
          res.write(`id: 1\ndata: ${JSON.stringify({ run: RUN("run-ignored", "running") })}\n\n`);
          setTimeout(() => res.destroy(), 10);
          return;
        }
        // Simulate a deployment that ignores Last-Event-ID and replays id 1.
        res.write(`id: 1\ndata: ${JSON.stringify({ run: RUN("run-ignored", "running") })}\n\n`);
        res.write(`id: 2\ndata: ${JSON.stringify({ run: RUN("run-ignored", "completed") })}\n\n`);
        res.end();
        return;
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const result = await cli(
        ["run", "run-ignored", "--max-retries", "2"],
        await envFor(baseUrl),
      );
      assert.equal(result.code, 0);
      assert.equal(streams, 2);
      assert.equal(seenCursors[0], null);
      assert.equal(seenCursors[1], "1");
      assert.match(result.err, /CURSOR_IGNORED/);
      assert.match(result.out, /completed/);
      assert.equal(result.err.includes(TOKEN), false);
    },
  );
});

test("run survives a server restart with a snapshot-only stream", async () => {
  let streams = 0;
  const cursors = [];
  await withStub(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/workflows/runs/run-restart/stream") {
        streams += 1;
        cursors.push(req.headers["last-event-id"] ?? null);
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (streams === 1) {
          res.write(`data: ${JSON.stringify({ run: RUN("run-restart", "running") })}\n\n`);
          setTimeout(() => res.destroy(), 10);
          return;
        }
        res.write(`data: ${JSON.stringify({ run: RUN("run-restart", "completed") })}\n\n`);
        res.end();
        return;
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const result = await cli(
        ["run", "run-restart", "--max-retries", "2"],
        await envFor(baseUrl),
      );
      assert.equal(result.code, 0);
      assert.equal(streams, 2);
      assert.deepEqual(cursors, [null, null]);
      assert.match(result.err, /CURSOR_UNSUPPORTED/);
      assert.match(result.out, /completed/);
    },
  );
});

test("expired credentials fail immediately with exit 3 and no retry storm", async () => {
  let taskReads = 0;
  await withStub(
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/meta") return json(res, 404, { message: "not found" });
      if (url.pathname === "/api/work/tasks") {
        taskReads += 1;
        return json(res, 401, { code: "UNAUTHORIZED", message: "token expired" });
      }
      return json(res, 404, { message: "not found" });
    },
    async (baseUrl) => {
      const result = await cli(["tasks"], await envFor(baseUrl));
      assert.equal(result.code, 3);
      assert.equal(taskReads, 1);
      assert.match(result.err, /HTTP 401|expired/);
      assert.equal(result.err.includes(TOKEN), false);
    },
  );
});

test("an interrupted run stream fails closed after bounded reconnect attempts", async () => {
  let streams = 0;
  await withStub(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/workflows/runs/run-cut/stream") {
        streams += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ run: RUN("run-cut", "running") })}\n\n`);
        res.end();
        return;
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const result = await cli(["run", "run-cut", "--max-retries", "1"], await envFor(baseUrl));
      assert.equal(result.code, 7);
      assert.equal(streams, 2);
      assert.match(result.err, /STREAM_INCOMPLETE|could not be monitored/);
    },
  );
});

test("an interrupted chat POST is not retried and cannot start a second generation", async () => {
  let chats = 0;
  await withStub(
    (req, res) => {
      if (req.url !== "/api/work/chat") return json(res, 404, { message: "not found" });
      chats += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"partial"}\n\n');
      setTimeout(() => res.destroy(), 10);
    },
    async (baseUrl) => {
      const result = await cli(["chat", "hi", "--json"], await envFor(baseUrl));
      assert.equal(result.code, 4);
      assert.equal(chats, 1);
      assert.match(result.err, /failed|network/i);
    },
  );
});

test("failed and suspended runs are reported distinctly", async () => {
  await withStub(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/workflows/runs/run-failed/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ run: RUN("run-failed", "failed", { error: "tests failed" }) })}\n\n`,
        );
        res.end();
        return;
      }
      if (url.pathname === "/api/workflows/runs/run-paused") {
        return json(res, 200, { run: RUN("run-paused", "paused") });
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const failed = await cli(["run", "run-failed"], await envFor(baseUrl));
      assert.equal(failed.code, 1);
      assert.match(failed.out, /failed/);
      assert.match(failed.out, /tests failed/);
      assert.match(failed.out, /coderax retry run-failed/);

      const suspended = await cli(
        ["run", "run-paused", "--no-follow"],
        await envFor(baseUrl),
      );
      assert.equal(suspended.code, 0);
      assert.match(suspended.out, /suspended \(paused\)/);
      assert.match(suspended.out, /coderax resume run-paused/);
    },
  );
});

test("a run waiting for approval fails closed without a TTY", async () => {
  const waiting = RUN("run-approval", "waiting_approval", {
    steps: [
      {
        id: "deploy",
        title: "Deploy to production",
        status: "pending",
        approvalRequired: true,
        attempts: 0,
        maxAttempts: 1,
      },
    ],
  });
  await withStub(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/workflows/runs/run-approval/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ run: waiting })}\n\n`);
        res.end();
        return;
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const result = await cli(["run", "run-approval"], await envFor(baseUrl));
      assert.equal(result.code, 6);
      assert.match(result.err, /waiting for approval/);
      assert.match(result.err, /coderax approve run-approval 0/);
    },
  );
});

test("unsupported autonomous Work fails closed before any build POST", async () => {
  let buildPosts = 0;
  let userReads = 0;
  await withStub(
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/user") {
        userReads += 1;
        return json(res, 200, { email: "owner@coderax.test", role: "ADMIN" });
      }
      if (url.pathname === "/api/meta") return json(res, 404, { message: "not found" });
      if (url.pathname === "/api/work/tasks") return json(res, 404, { message: "not found" });
      if (url.pathname === "/api/workflows") return json(res, 404, { message: "not found" });
      if (url.pathname === "/api/workflows/builds" && req.method === "POST") {
        buildPosts += 1;
        return json(res, 202, {});
      }
      return json(res, 404, { message: "not found" });
    },
    async (baseUrl) => {
      const result = await cli(
        ["work", "submit", "implement the fix", "--repo", "acme/app", "--agent", "agent-1"],
        await envFor(baseUrl),
      );
      assert.equal(result.code, 6);
      assert.equal(userReads, 1);
      assert.equal(buildPosts, 0);
      assert.match(result.err, /CAPABILITY_UNAVAILABLE|does not provide workflows\.builds/);
    },
  );
});

test("autonomous Work submits the backend build contract", async () => {
  let submitted = null;
  await withStub(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/user") {
        return json(res, 200, { email: "owner@coderax.test", role: "ADMIN" });
      }
      if (url.pathname === "/api/workflows/builds" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          submitted = JSON.parse(body);
          json(res, 202, {
            run: RUN("run-build", "queued"),
            workflow: { id: "wf-1", name: "Contract workflow" },
            build: { mode: "autonomous", taskCount: 3, degraded: false },
          });
        });
        return;
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const result = await cli(
        [
          "work",
          "submit",
          "implement the fix",
          "--repo",
          "acme/app",
          "--agent",
          "agent-1",
          "--json",
        ],
        await envFor(baseUrl),
      );
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.out).run.id, "run-build");
      assert.equal(submitted.request, "implement the fix");
      assert.equal(submitted.mode, "autonomous");
      assert.equal(submitted.agentId, "agent-1");
      assert.deepEqual(submitted.repository, { owner: "acme", name: "app" });
      assert.match(submitted.workspace, /^coderax-acme-app-/);
    },
  );
});

test("an incompatible API version fails closed", async () => {
  await withStub(
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/meta") {
        return json(res, 200, { apiVersion: "2.0", capabilities: ["work.tasks"] });
      }
      return json(res, 404, { message: "not found" });
    },
    async (baseUrl) => {
      const result = await cli(["tasks"], await envFor(baseUrl));
      assert.equal(result.code, 6);
      assert.match(result.err, /API_VERSION_UNSUPPORTED|API version 2\.0/);
    },
  );
});

test("repositories fail closed when the deployment advertises no inventory", async () => {
  const requested = [];
  await withStub(
    negotiation((req, res) => {
      requested.push(req.url);
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const result = await cli(["repos"], await envFor(baseUrl));
      assert.equal(result.code, 6, `unexpected ${result.code}: ${result.err}`);
      assert.equal(
        requested.includes("/api/repos"),
        false,
        "repos must not call an unadvertised route",
      );
      assert.match(result.err, /repos\.list|--repo/);
    },
  );
});

test("login refuses a non-owner token and stores nothing", async () => {
  const config = await tempConfig();
  await withStub(
    (req, res) => {
      if (req.url === "/api/user") {
        return json(res, 200, { email: "member@coderax.test", role: "USER" });
      }
      return json(res, 404, { message: "not found" });
    },
    async (baseUrl) => {
      const result = await cli(
        ["login", "--base-url", baseUrl, "--json"],
        { CODERAX_CONFIG: config },
        { readSecret: async () => TOKEN },
      );
      assert.equal(result.code, 3);
      assert.match(result.err, /owner|ADMIN/i);
      assert.equal(result.out.includes(TOKEN), false);
      await assert.rejects(() => access(config));
    },
  );
});

test("login fails closed when the deployment cannot report a role", async () => {
  const config = await tempConfig();
  await withStub(
    (req, res) => {
      if (req.url === "/api/user") return json(res, 200, { email: "who@coderax.test" });
      return json(res, 404, { message: "not found" });
    },
    async (baseUrl) => {
      const result = await cli(
        ["login", "--base-url", baseUrl],
        { CODERAX_CONFIG: config },
        { readSecret: async () => TOKEN },
      );
      assert.equal(result.code, 6);
      assert.match(result.err, /OWNER_UNVERIFIABLE|did not report a role/);
      await assert.rejects(() => access(config));
    },
  );
});

test("login stores an owner token with 0600 permissions", async () => {
  const config = await tempConfig();
  await withStub(
    (req, res) => {
      if (req.url === "/api/user") {
        return json(res, 200, { email: "owner@coderax.test", role: "ADMIN" });
      }
      return json(res, 404, { message: "not found" });
    },
    async (baseUrl) => {
      const result = await cli(
        ["login", "--base-url", baseUrl, "--json"],
        { CODERAX_CONFIG: config },
        { readSecret: async () => TOKEN },
      );
      assert.equal(result.code, 0);
      assert.equal(result.out.includes(TOKEN), false);
      const stored = JSON.parse(await readFile(config, "utf8"));
      assert.equal(stored.token, TOKEN);
      assert.equal(stored.role, "ADMIN");
    },
  );
});

test("cancel, resume and retry call only published backend routes", async () => {
  const calls = [];
  await withStub(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/user") {
        return json(res, 200, { email: "owner@coderax.test", role: "ADMIN" });
      }
      if (url.pathname === "/api/workflows/runs/run-a/cancel") {
        calls.push("cancel");
        return json(res, 200, { run: RUN("run-a", "cancelled") });
      }
      if (url.pathname === "/api/workflows/runs/run-b/resume") {
        calls.push("resume");
        return json(res, 200, { run: RUN("run-b", "running") });
      }
      if (url.pathname === "/api/workflows/runs/run-c" && req.method === "GET") {
        return json(res, 200, { run: RUN("run-c", "failed", { input: "do the work" }) });
      }
      if (url.pathname === "/api/workflows/wf-1/runs" && req.method === "POST") {
        calls.push("retry");
        return json(res, 202, { run: RUN("run-d", "queued") });
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const env = await envFor(baseUrl);
      assert.equal((await cli(["cancel", "run-a"], env)).code, 0);
      assert.equal((await cli(["resume", "run-b"], env)).code, 0);
      assert.equal((await cli(["retry", "run-c"], env)).code, 0);
      assert.deepEqual(calls, ["cancel", "resume", "retry"]);
    },
  );
});

test("a deployment with no run stream capability fails closed for run", async () => {
  await withStub(
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/meta") return json(res, 404, { message: "not found" });
      if (url.pathname === "/api/work/tasks") return json(res, 200, { tasks: [] });
      if (url.pathname === "/api/workflows") return json(res, 404, { message: "not found" });
      return json(res, 404, { message: "not found" });
    },
    async (baseUrl) => {
      const result = await cli(["run", "run-x"], await envFor(baseUrl));
      assert.equal(result.code, 6);
      assert.match(result.err, /workflows\.stream|CAPABILITY_UNAVAILABLE/);
    },
  );
});
