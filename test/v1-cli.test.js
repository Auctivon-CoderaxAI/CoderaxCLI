import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/legacy-cli.js";

const TOKEN = "owner-token-0123456789";

const HEALTH = {
  status: "ok",
  contractVersion: "1.0.0",
  startedAt: "2026-11-27T00:00:00.000Z",
  uptimeMs: 1000,
  checks: [],
  engines: [{
    id: "native",
    capabilities: { streaming: true, tools: true, cancellation: true, resume: true, modelSelection: true, durable: true },
    availability: { available: true, reason: "ready", detail: "" },
  }],
};

const READY = { ready: true, missing: [], checks: [] };

const CHAT_REPLY = {
  conversationId: "conversation_1",
  messageId: "message_1",
  text: "the answer",
  agent: "coderax",
  model: { providerId: "local", modelId: "native" },
  createdAt: "2026-11-27T00:00:01.000Z",
};

function event(seq, type, payload = {}) {
  return {
    v: 1,
    eventId: `evt_${seq}`,
    taskId: "task_1",
    seq,
    at: `2026-11-27T00:00:0${seq}.000Z`,
    agent: "coderax",
    generation: 0,
    type,
    payload,
  };
}

async function withServer(run) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}` && url.pathname !== "/v1/health" && url.pathname !== "/v1/ready") {
      return json(401, { type: "about:blank", title: "unauthorized", status: 401, code: "unauthorized", retryable: false });
    }
    if (url.pathname === "/v1/health") return json(200, HEALTH);
    if (url.pathname === "/v1/ready") return json(200, READY);
    if (url.pathname === "/v1/agents" && req.method === "GET") {
      return json(200, {
        agents: [{
          id: "coderax",
          engine: "native",
          label: "Coderax Native",
          external: false,
          capabilities: {
            streaming: true,
            tools: true,
            cancellation: true,
            resume: true,
            modelSelection: true,
            durable: true,
          },
          availability: { available: true, reason: "ready", detail: "" },
          isolation: { workspace: "isolated", memory: "none", credentials: "none", conversations: "none" },
        }],
      });
    }
    if (url.pathname === "/v1/chat") return json(200, CHAT_REPLY);
    if (url.pathname === "/v1/work" && req.method === "POST") {
      return json(202, {
        taskId: "task_1",
        conversationId: "conversation_1",
        state: "queued",
        generation: 0,
        eventsPath: "/v1/work/task_1/events",
      });
    }
    if (url.pathname === "/v1/work/task_1/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of [
        event(1, "task.started"),
        event(2, "text.delta", { text: "working" }),
        event(3, "task.completed", { summary: "done" }),
      ]) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.end();
      return undefined;
    }
    if (url.pathname === "/v1/work/task_1") {
      return json(200, {
        taskId: "task_1",
        conversationId: "conversation_1",
        state: "completed",
        agent: "coderax",
        mode: "cloud",
        reasoning: "complex",
        generation: 0,
        createdAt: "2026-11-27T00:00:00.000Z",
        updatedAt: "2026-11-27T00:00:03.000Z",
        cancelRequested: false,
        steps: [
          { id: "step_1", title: "Inspect", state: "completed", dependsOn: ["plan"], attempts: 1 },
        ],
        result: {
          artifacts: [],
          summary: "done",
          verification: { passed: true, reason: "tests passed", evidence: ["npm test"] },
        },
      });
    }
    if (url.pathname === "/v1/templates") return json(404, { message: "not found" });
    return json(404, { message: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl, requests);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    deps: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    },
    text: () => out.join(""),
    errors: () => err.join(""),
  };
}

async function env(baseUrl) {
  const dir = await mkdtemp(join(tmpdir(), "coderax-v1-"));
  return {
    CODERAX_BASE_URL: baseUrl,
    CODERAX_TOKEN: TOKEN,
    CODERAX_CONFIG_DIR: dir,
    CODERAX_TIMEOUT_MS: "5000",
  };
}

test("coderax v1 login verifies the owner through /v1/agents and stores the token", async () => {
  await withServer(async (baseUrl, requests) => {
    const dir = await mkdtemp(join(tmpdir(), "coderax-v1-login-"));
    const environment = {
      CODERAX_BASE_URL: baseUrl,
      CODERAX_CONFIG_DIR: dir,
      CODERAX_TIMEOUT_MS: "5000",
      CODERAX_CREDENTIAL_STORE: "file",
    };
    const io = capture();
    const code = await runCli(["v1", "login", "--json"], {
      env: environment,
      readSecret: async () => TOKEN,
      ...io.deps,
    });
    assert.equal(code, 0, io.errors());
    const login = JSON.parse(io.text());
    assert.equal(login.authenticated, true);
    assert.equal(login.owner, true);
    assert.equal(login.authMethod, "v1");
    assert.equal(io.text().includes(TOKEN), false);

    const stored = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    assert.equal(stored.authMethod, "v1");
    assert.equal(stored.token, TOKEN);
    assert.equal(requests.some((entry) => entry.path === "/v1/agents" && entry.auth === `Bearer ${TOKEN}`), true);

    const who = capture();
    const whoami = await runCli(["v1", "whoami", "--json"], {
      env: { ...environment, CODERAX_TOKEN: "" },
      ...who.deps,
    });
    assert.equal(whoami, 0, who.errors());
    const identity = JSON.parse(who.text());
    assert.equal(identity.owner, true);
    assert.equal(identity.method, "/v1/agents");
  });
});

test("coderax v1 health reports the negotiated contract as JSON", async () => {
  await withServer(async (baseUrl) => {
    const io = capture();
    const code = await runCli(["v1", "health", "--json"], { env: await env(baseUrl), ...io.deps });
    assert.equal(code, 0);
    const parsed = JSON.parse(io.text());
    assert.equal(parsed.health.contractVersion, "1.0.0");
    assert.equal(parsed.contract.major, 1);
    assert.equal(parsed.ready.ready, true);
  });
});

test("coderax v1 chat sends the owner token and prints the reply", async () => {
  await withServer(async (baseUrl, requests) => {
    const io = capture();
    const code = await runCli(["v1", "chat", "hello", "engine"], { env: await env(baseUrl), ...io.deps });
    assert.equal(code, 0);
    assert.match(io.text(), /the answer/);
    const chat = requests.find((entry) => entry.path === "/v1/chat");
    assert.equal(chat.auth, `Bearer ${TOKEN}`);
  });
});

test("coderax v1 submit detaches, records the task and never resubmits", async () => {
  await withServer(async (baseUrl, requests) => {
    const io = capture();
    const environment = await env(baseUrl);
    const code = await runCli(
      ["v1", "submit", "change it", "--reasoning", "complex", "--detach", "--json"],
      { env: environment, ...io.deps },
    );
    assert.equal(code, 0);
    const first = JSON.parse(io.text());
    assert.equal(first.taskId, "task_1");
    assert.equal(typeof first.submissionKey, "string");

    const second = capture();
    const again = await runCli(["v1", "tasks", "--json"], { env: environment, ...second.deps });
    assert.equal(again, 0);
    const listed = JSON.parse(second.text());
    assert.equal(listed.tasks[0].taskId, "task_1");
    const posts = requests.filter((entry) => entry.path === "/v1/work" && entry.method === "POST");
    assert.equal(posts.length, 1);
  });
});

test("coderax v1 watch streams NDJSON and exits after the terminal event", async () => {
  await withServer(async (baseUrl) => {
    const io = capture();
    const code = await runCli(["v1", "watch", "task_1", "--json"], { env: await env(baseUrl), ...io.deps });
    assert.equal(code, 0);
    const lines = io.text().trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.some((line) => line.type === "delta" && line.text === "working"), true);
    assert.equal(lines.some((line) => line.type === "final"), true);
    assert.equal(lines.some((line) => line.type === "task"), false);
  });
});

test("coderax v1 task renders an authoritative status", async () => {
  await withServer(async (baseUrl) => {
    const io = capture();
    const code = await runCli(["v1", "task", "task_1"], { env: await env(baseUrl), ...io.deps });
    assert.equal(code, 0);
    assert.match(io.text(), /task_1\s+completed/);
    assert.match(io.text(), /reasoning complex/);
    assert.match(io.text(), /done/);
    assert.match(io.text(), /verification passed: tests passed/);
    assert.match(io.text(), /after plan, attempts 1/);
  });
});
