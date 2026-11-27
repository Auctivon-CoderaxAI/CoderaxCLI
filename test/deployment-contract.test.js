import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { runCli } from "../src/legacy-cli.js";

const CLI_PATH = fileURLToPath(new URL("../src/legacy-cli.js", import.meta.url));
const execFileAsync = promisify(execFile);

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

test("notification commands inherit ordinary variables without the CLI bearer token", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coderax-notify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resultPath = join(directory, "notification.json");
  let authenticated = false;
  await withStub(
    negotiation((req, res) => {
      if (req.url === "/api/workflows/runs/run-notify") {
        authenticated = req.headers.authorization === `Bearer ${TOKEN}`;
        return json(res, 200, { run: RUN("run-notify", "completed") });
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const command =
        `node -e "const fs=require('node:fs'),p=process.env.CODERAX_NOTIFY_PROBE;fs.writeFileSync(p+'.tmp',JSON.stringify({tokenPresent:process.env.CODERAX_TOKEN!==undefined,run:process.argv[1],status:process.argv[2]}));fs.renameSync(p+'.tmp',p)" {id} {status}`;
      await execFileAsync(
        process.execPath,
        [CLI_PATH, "run", "run-notify", "--no-follow", "--notify-command", command],
        {
          env: {
            ...process.env,
            CODERAX_CONFIG: join(directory, "config.json"),
            CODERAX_BASE_URL: baseUrl,
            CODERAX_TOKEN: TOKEN,
            CODERAX_NOTIFY_PROBE: resultPath,
          },
          timeout: 10000,
        },
      );
    },
  );

  assert.equal(authenticated, true);
  // The notification is detached, so its result can arrive after the CLI exits.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      assert.deepEqual(result, { tokenPresent: false, run: "run-notify", status: "completed" });
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  assert.fail("notification did not write to the inherited probe path");
});

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

test("a disconnected run keeps the reconnect delay alive across attempts", async () => {
  let streams = 0;
  await withStub(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/workflows/runs/run-delay/stream") {
        streams += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (streams === 1) {
          res.write(`id: 1\ndata: ${JSON.stringify({ run: RUN("run-delay", "running") })}\n\n`);
          setTimeout(() => res.destroy(), 10);
          return;
        }
        res.write(`id: 2\ndata: ${JSON.stringify({ run: RUN("run-delay", "completed") })}\n\n`);
        res.end();
        return;
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      // Run in a real child process: an unref'd reconnect timer would let Node
      // exit while watchRun is awaiting the retry, which an in-process test
      // cannot observe.
      const child = spawn(
        process.execPath,
        [CLI_PATH, "run", "run-delay", "--max-retries", "1"],
        {
          env: {
            ...process.env,
            CODERAX_CONFIG: await tempConfig(),
            CODERAX_BASE_URL: baseUrl,
            CODERAX_TOKEN: TOKEN,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`child did not finish reconnecting; stderr: ${stderr}`));
        }, 15000);
        child.once("error", reject);
        child.once("close", (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
      assert.equal(code, 0, stderr);
      assert.equal(streams, 2);
    },
  );
});

test("strict chat negotiates before starting a generation", async () => {
  let chats = 0;
  await withStub(
    (req, res) => {
      if (req.url === "/api/work/chat") {
        chats += 1;
        return sse(res, ['data: {"delta":"started"}\n\n', "data: [DONE]\n\n"]);
      }
      return json(res, 404, { message: "not found" });
    },
    async (baseUrl) => {
      const result = await cli(["chat", "hi", "--strict", "--json"], await envFor(baseUrl));
      assert.equal(result.code, 6);
      assert.equal(chats, 0, "strict chat must not POST a generation");
      assert.match(result.err, /API_VERSION_UNVERIFIED|strict mode/);
    },
  );
});

test("chat drains buffered frames before accepting the completion marker", async () => {
  await withStub(
    (req, res) => {
      if (req.url !== "/api/work/chat") return json(res, 404, { message: "not found" });
      sse(res, [
        'id: 1\ndata: {"delta":"a"}\n\n',
        'id: 3\ndata: {"delta":"c"}\n\n',
        "data: [DONE]\n\n",
      ]);
    },
    async (baseUrl) => {
      const result = await cli(["chat", "hi", "--json"], await envFor(baseUrl));
      assert.equal(result.code, 0, result.err);
      assert.equal(JSON.parse(result.out).text, "ac");
      assert.match(result.err, /OUT_OF_ORDER_EVENT|never delivered in order/);
    },
  );
});

test("chat honours --chat-path and --url overrides", async () => {
  const paths = [];
  await withStub(
    (req, res) => {
      paths.push(req.url);
      if (!["/custom/chat", "/custom/url", "/custom/env"].includes(req.url)) {
        return json(res, 404, { message: "not found" });
      }
      sse(res, ['data: {"delta":"custom"}\n\n', "data: [DONE]\n\n"]);
    },
    async (baseUrl) => {
      const byConfig = await cli(
        ["chat", "hi", "--chat-path", "/custom/chat", "--json"],
        await envFor(baseUrl),
      );
      assert.equal(byConfig.code, 0, byConfig.err);
      assert.equal(JSON.parse(byConfig.out).text, "custom");
      const byUrl = await cli(
        ["chat", "hi", "--url", "/custom/url", "--json"],
        await envFor(baseUrl),
      );
      assert.equal(byUrl.code, 0, byUrl.err);
      assert.equal(JSON.parse(byUrl.out).text, "custom");
      const byEnv = await cli(
        ["chat", "hi", "--json"],
        { ...(await envFor(baseUrl)), CODERAX_CHAT_PATH: "/custom/env" },
      );
      assert.equal(byEnv.code, 0, byEnv.err);
      assert.equal(JSON.parse(byEnv.out).text, "custom");
      assert.deepEqual(paths, ["/custom/chat", "/custom/url", "/custom/env"]);
    },
  );
});

test("an interrupted chat POST is not retried and exposes the conversation for recovery", async () => {
  let chats = 0;
  let followUp = null;
  await withStub(
    (req, res) => {
      if (req.url !== "/api/work/chat") return json(res, 404, { message: "not found" });
      chats += 1;
      if (chats > 1) {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          followUp = JSON.parse(body);
          sse(res, [
            'data: {"final":true,"responseMessage":{"text":"done","conversationId":"conv-interrupted"}}\n\n',
            "data: [DONE]\n\n",
          ]);
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"conversationId":"conv-interrupted"}\n\n');
      res.write('data: {"delta":"partial"}\n\n');
      setTimeout(() => res.destroy(), 10);
    },
    async (baseUrl) => {
      const env = await envFor(baseUrl);
      const result = await cli(["chat", "hi", "--json"], env);
      assert.equal(result.code, 4);
      assert.equal(chats, 1);
      assert.match(result.err, /failed|network/i);
      assert.match(result.err, /conv-interrupted/);
      assert.match(result.err, /coderax tasks/);
      assert.match(result.err, /not resent/);

      // The accepted conversation id is saved on failure, so the next turn
      // continues the existing task rather than starting another generation.
      const resumed = await cli(["chat", "continue", "--json"], env);
      assert.equal(resumed.code, 0, resumed.err);
      assert.equal(JSON.parse(resumed.out).text, "done");
      assert.equal(followUp.conversationId, "conv-interrupted");
      assert.equal(chats, 2);
    },
  );
});

test("failed chat rejects credential-bearing conversation and stream IDs", async (t) => {
  for (const [label, payload, expected] of [
    ["conversation ID", { conversationId: `conv-${TOKEN}` }, null],
    ["stream ID", { conversationId: "conv-safe", streamId: `stream-${TOKEN}` }, "conv-safe"],
    ["ordinary stream ID", { streamId: "stream-safe" }, "stream-safe"],
  ]) {
    await t.test(label, async () => {
      let posts = 0;
      await withStub(
        (req, res) => {
          assert.equal(req.method, "POST");
          posts += 1;
          sse(res, [`data: ${JSON.stringify({ ...payload, error: "turn failed" })}\n\n`]);
        },
        async (baseUrl) => {
          const env = await envFor(baseUrl);
          const result = await cli(["chat", "hi"], env);
          assert.equal(result.code, 1);
          assert.equal(posts, 1);
          assert.ok(!result.err.includes(TOKEN));
          if (expected === null) {
            await assert.rejects(access(env.CODERAX_CONFIG), { code: "ENOENT" });
          } else {
            assert.ok(result.err.includes(expected));
            const stored = JSON.parse(await readFile(env.CODERAX_CONFIG, "utf8"));
            assert.equal(stored.sessions[baseUrl].conversationId, expected);
          }
        },
      );
    });
  }
});

test("chat refreshes its stored session after an empty and a failed turn", { timeout: 15000 }, async () => {
  const requests = [];
  await withStub(
    async (req, res) => {
      assert.equal(req.method, "POST");
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      if (requests.length === 1) {
        return sse(res, ['data: {"final":true,"responseMessage":{"conversationId":"conv-empty"}}\n\n']);
      }
      if (requests.length === 2) {
        return sse(res, ['data: {"error":"turn failed","streamId":"conv-failed"}\n\n']);
      }
      return sse(res, ['data: {"final":true,"responseMessage":{"text":"done"}}\n\n']);
    },
    async (baseUrl) => {
      // One stored session, three invocations: an empty response must not lose
      // the conversation, and a failed turn must persist the id the server
      // accepted so the next invocation continues it instead of resubmitting.
      const env = await envFor(baseUrl);
      const first = await cli(["chat", "first"], env);
      // A one-shot turn that streams no text is a failure, but the accepted
      // conversation must still be recorded so the next turn continues it.
      assert.equal(first.code, 1, first.err);
      assert.match(first.err, /streamed no text/);

      const second = await cli(["chat", "second"], env);
      assert.notEqual(second.code, 0);
      assert.match(second.err, /turn failed/);

      const third = await cli(["chat", "third"], env);
      assert.equal(third.code, 0, third.err);

      assert.deepEqual(requests.map(({ text, conversationId }) => [text, conversationId]), [
        ["first", undefined],
        ["second", "conv-empty"],
        ["third", "conv-failed"],
      ]);
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
          `data: ${JSON.stringify({ run: RUN("run-failed", "failed", { error: `tests failed ${TOKEN}` }) })}\n\n`,
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
      assert.equal(failed.out.includes(TOKEN), false, "run snapshot leaked the bearer token");
      assert.equal(failed.err.includes(TOKEN), false, "run diagnostics leaked the bearer token");

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

test("work submit --follow --json emits one NDJSON record per line", async () => {
  await withStub(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/user") {
        return json(res, 200, { email: "owner@coderax.test", role: "ADMIN" });
      }
      if (url.pathname === "/api/workflows/builds" && req.method === "POST") {
        return json(res, 202, {
          run: RUN("run-ndjson", "queued"),
          workflow: { id: "wf-1", name: "Contract workflow" },
          build: { mode: "autonomous", taskCount: 1, degraded: false },
        });
      }
      if (url.pathname === "/api/workflows/runs/run-ndjson/stream") {
        sse(res, [
          `data: ${JSON.stringify({ run: RUN("run-ndjson", "running") })}\n\n`,
          `data: ${JSON.stringify({ run: RUN("run-ndjson", "completed") })}\n\n`,
        ]);
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
          "--follow",
          "--json",
        ],
        await envFor(baseUrl),
      );
      assert.equal(result.code, 0, result.err);
      const lines = result.out.split("\n").filter((line) => line.trim() !== "");
      assert.ok(lines.length >= 2, `expected submission and run records, got: ${result.out}`);
      const records = lines.map((line) => JSON.parse(line));
      assert.equal(records[0].run.id, "run-ndjson");
      assert.equal(records[0].build.taskCount, 1);
      assert.equal(records[records.length - 1].run.status, "completed");
    },
  );
});

test("retry --follow --json also emits consistent NDJSON", async () => {
  await withStub(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/user") {
        return json(res, 200, { email: "owner@coderax.test", role: "ADMIN" });
      }
      if (url.pathname === "/api/workflows/runs/run-before") {
        return json(res, 200, { run: RUN("run-before", "failed", { input: { fix: true } }) });
      }
      if (url.pathname === "/api/workflows/wf-1/runs" && req.method === "POST") {
        return json(res, 202, { run: RUN("run-after", "queued") });
      }
      if (url.pathname === "/api/workflows/runs/run-after/stream") {
        sse(res, [
          `data: ${JSON.stringify({ run: RUN("run-after", "completed") })}\n\n`,
        ]);
        return;
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const result = await cli(
        ["retry", "run-before", "--follow", "--json"],
        await envFor(baseUrl),
      );
      assert.equal(result.code, 0, result.err);
      const lines = result.out.split("\n").filter((line) => line.trim() !== "");
      assert.ok(lines.length >= 2, `expected retry and run records, got: ${result.out}`);
      const records = lines.map((line) => JSON.parse(line));
      assert.equal(records[0].previous.id, "run-before");
      assert.equal(records[0].run.id, "run-after");
      assert.equal(records[records.length - 1].run.status, "completed");
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
