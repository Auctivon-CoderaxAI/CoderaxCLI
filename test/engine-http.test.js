import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { EngineClient } from "../src/engine.js";

const ENGINE_DIR = process.env.CODERAX_ENGINE_DIR;
const ENTRY = ENGINE_DIR ? join(ENGINE_DIR, "dist/src/main.js") : null;
const AVAILABLE = ENTRY !== null && existsSync(ENTRY);
const TOKEN = "0123456789abcdef0123456789abcdef";

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

async function invoke(args, env) {
  const io = capture();
  const code = await runCli(args, { env, stdout: io.stdout, stderr: io.stderr });
  let json = null;
  try {
    json = JSON.parse(io.out());
  } catch {
    json = null;
  }
  return { code, out: io.out(), err: io.err(), json };
}

async function startStubInference() {
  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { messages } = JSON.parse(Buffer.concat(chunks));
      let content = "live engine reply";
      if (messages[0]?.content.startsWith("CODERAX_VERIFY_V1")) {
        const cited = [...messages.at(-1).content.matchAll(/^EVIDENCE ([\w.-]+):/gm)].map((match) => match[1]);
        content = JSON.stringify({ passed: true, reason: "evidence covers the test objective", cited });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 4, completion_tokens: 8 },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function startEngine() {
  const root = await mkdtemp(join(tmpdir(), "coderax-engine-http-"));
  const privateRoot = join(root, "private");
  const cloudRoot = join(root, "cloud");
  await mkdir(privateRoot, { recursive: true });
  await mkdir(cloudRoot, { recursive: true });

  const inference = await startStubInference();
  let child;
  function stop() {
    const childClosed = child ? new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    }) : Promise.resolve();
    const inferenceClosed = new Promise((resolve) => inference.close(resolve));
    inference.closeAllConnections();
    return Promise.all([childClosed, inferenceClosed]);
  }

  try {
    const inferencePort = inference.address().port;
    const configPath = join(root, "engine.json");
    await writeFile(
      configPath,
      JSON.stringify({
        server: { host: "127.0.0.1", port: 0 },
        auth: { ownerId: "owner-test" },
        workspaces: { privateRoot, cloudRoot },
        models: { route: [{ providerId: "stub", modelId: "stub-model" }] },
        engines: { default: "native", native: { enabled: true } },
        execution: { maxConcurrentTasks: 2, heartbeatIntervalMs: 5000, leaseTtlMs: 20000 },
      }),
    );

    child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        CODERAX_OWNER_ID: "owner-test",
        CODERAX_OWNER_TOKEN: TOKEN,
        CODERAX_INFERENCE_BASE_URL: `http://127.0.0.1:${inferencePort}/v1`,
        CODERAX_INFERENCE_KEY: "stub-key",
        CODERAX_ENGINE_CONFIG: configPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const url = await new Promise((resolve, reject) => {
      const finish = (error, url) => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("exit", onExit);
        child.off("error", finish);
        if (error) reject(error);
        else resolve(url);
      };
      const onData = (chunk) => {
        stdout += chunk;
        const match = /listening on (http:\/\/[^\s]+)/.exec(stdout);
        if (match) finish(null, match[1]);
      };
      const onExit = (code) => finish(new Error(`engine exited with ${code}. stderr: ${stderr.slice(0, 2000)}`));
      const timer = setTimeout(() => {
        finish(new Error(`engine did not report a listening URL. stderr: ${stderr.slice(0, 2000)}`));
      }, 20_000);
      child.stdout.on("data", onData);
      child.once("exit", onExit);
      child.once("error", finish);
    });
    return { url, root, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test(
  "authoritative WorkflowEngine 1.0.0 over real HTTP",
  { skip: AVAILABLE ? false : "set CODERAX_ENGINE_DIR to a built Coderax-WorkflowEngine checkout" },
  async () => {
    const engine = await startEngine();
    const env = {
      CODERAX_CONFIG: join(engine.root, "cli-config.json"),
      CODERAX_BASE_URL: engine.url,
      CODERAX_TOKEN: TOKEN,
    };
    try {
      const health = await invoke(["engine", "health", "--json"], env);
      assert.equal(health.code, 0, health.err);
      assert.equal(health.json.contractVersion, "1.0.0");
      assert.equal(health.json.status, "ok");

      const unauth = await invoke(["engine", "agents", "--json"], {
        ...env,
        CODERAX_TOKEN: "",
      });
      assert.equal(unauth.code, 3);
      assert.match(unauth.err, /UNAUTHENTICATED/);

      const rejected = await invoke(["engine", "agents", "--json"], {
        ...env,
        CODERAX_TOKEN: "wrong-owner-token",
      });
      assert.equal(rejected.code, 3);

      const agents = await invoke(["engine", "agents", "--json"], env);
      assert.equal(agents.code, 0, agents.err);
      assert.ok(agents.json.agents.some((agent) => agent.id === "coderax"));

      const models = await invoke(["engine", "models", "--json"], env);
      assert.equal(models.code, 0, models.err);
      assert.equal(models.json.route[0].providerId, "stub");

      const chat = await invoke(
        ["engine", "chat", "hello from the live test", "--mode", "cloud", "--json"],
        env,
      );
      assert.equal(chat.code, 0, chat.err);
      assert.equal(chat.json.text, "live engine reply");
      assert.ok(chat.json.conversationId.startsWith("conv_"));

      const work = await invoke(
        ["engine", "work", "submit", "Read the objective; Produce the test reply; Summarize the evidence", "--mode", "cloud", "--follow", "--json"],
        env,
      );
      assert.equal(work.code, 0, work.err || work.out);
      assert.equal(work.json.state, "completed");
      assert.ok(work.json.taskId.startsWith("task_"));
      assert.match(work.json.text, /live engine reply/);

      const task = await invoke(["engine", "tasks", work.json.taskId, "--json"], env);
      assert.equal(task.code, 0, task.err);
      assert.equal(task.json.state, "completed");
      assert.equal(task.json.steps.length, 3);
      assert.equal(task.json.result.verification.passed, true);

      const taskById = await invoke(["engine", "task", work.json.taskId, "--json"], env);
      assert.equal(taskById.code, 0, taskById.err);
      assert.equal(taskById.json.state, "completed");

      const taskDiscovery = await invoke(["engine", "tasks", "--json"], env);
      assert.equal(taskDiscovery.code, 0, taskDiscovery.err);
      assert.ok(
        taskDiscovery.json.notifications.some((item) => item.taskId === work.json.taskId),
      );

      const events = await invoke(
        ["engine", "tasks", "events", work.json.taskId, "--json"],
        env,
      );
      assert.equal(events.code, 0, events.err);
      const eventTypes = events.out
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line).type)
        .filter(Boolean);
      assert.ok(eventTypes.includes("task.started"));
      assert.ok(eventTypes.includes("task.completed"));

      const artifacts = await invoke(["engine", "artifacts", work.json.taskId, "--json"], env);
      assert.equal(artifacts.code, 0, artifacts.err);
      assert.equal(artifacts.json.transferSupported, false);
      assert.deepEqual(artifacts.json.artifacts, []);

      const conversations = await invoke(["engine", "conversations", "--json"], env);
      assert.equal(conversations.code, 0, conversations.err);
      assert.ok(
        conversations.json.conversations.some(
          (conversation) => conversation.conversationId === chat.json.conversationId,
        ),
      );

      const memory = await invoke(["engine", "memory", "--json"], env);
      assert.equal(memory.code, 0, memory.err);
      assert.deepEqual(memory.json.entries, []);

      const permissions = await invoke(
        ["engine", "permissions", work.json.taskId, "--json"],
        env,
      );
      assert.equal(permissions.code, 0, permissions.err);
      assert.deepEqual(permissions.json.requests, []);

      const notifications = await invoke(["engine", "notifications", "--json"], env);
      assert.equal(notifications.code, 0, notifications.err);
      assert.ok(notifications.json.unread >= 1);
      assert.ok(
        notifications.json.notifications.some(
          (notification) => notification.taskId === work.json.taskId,
        ),
      );

      const status = await invoke(["engine", "status", "--json"], env);
      assert.equal(status.code, 0, status.err);
      assert.equal(status.json.authenticated, true);

      const compat = await invoke(["engine", "compat", "--json"], env);
      assert.equal(compat.code, 0, compat.err);
      assert.equal(compat.json.authenticated, true);
      assert.equal(compat.json.owner, true);

      const verify = await invoke(["engine", "verify", "--json"], env);
      assert.equal(verify.code, 0, verify.err);
      assert.equal(verify.json.owner, true);

      const blocked = await invoke(
        ["engine", "schedules", "create", "--json"],
        { ...env, CODERAX_BASE_URL: "http://127.0.0.1:1" },
      );
      assert.equal(blocked.code, 6);
      assert.equal(blocked.json.status, "blocked");
      assert.match(blocked.json.reason, /no schedule operations/);
    } finally {
      await engine.stop();
    }
  },
);

test("engine chat reads a chunked SSE reply over HTTP and redacts the complete answer", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, accept: req.headers.accept });
    req.resume();
    if (req.url === "/v1/health" || req.url === "/v1/agents") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url.endsWith("health") ? {
        status: "ok", contractVersion: "1.0.0", startedAt: "2026-01-01T00:00:00Z",
        uptimeMs: 0, checks: [], engines: [],
      } : { agents: [] }));
      return;
    }
    const reply = {
      conversationId: "conv_test", messageId: "msg_test", text: `reply ${TOKEN}`,
      agent: "coderax", model: { providerId: "stub", modelId: "stub-model" },
    };
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write('data: {"type":"text.delta","text":"reply "}\r\n\r\n');
    const payload = JSON.stringify(reply);
    const split = payload.indexOf(TOKEN) + 8;
    res.write(`data: ${payload.slice(0, split)}`);
    setImmediate(() => res.end(`${payload.slice(split)}\r\n\r\ndata: [DONE]\r\n\r\n`));
  });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const env = {
    CODERAX_BASE_URL: `http://127.0.0.1:${server.address().port}`, CODERAX_TOKEN: TOKEN,
    CODERAX_CONFIG: join(await mkdtemp(join(tmpdir(), "coderax-sse-")), "config.json"),
  };
  const json = await invoke(["engine", "chat", "hello", "--json"], env);
  assert.equal(json.code, 0, json.err);
  assert.equal(json.json.text, "reply [REDACTED]");
  const human = await invoke(["engine", "chat", "hello"], env);
  assert.equal(human.code, 0, human.err);
  assert.equal(human.out.trim(), "reply [REDACTED]");
  assert.ok(requests.filter(({ path }) => path === "/v1/chat").every(({ accept }) => accept.includes("text/event-stream")));
});

test("an active event body outlives the header deadline and still times out when idle", async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let seq = 0;
    const send = () => res.write(`data: {"seq":${++seq}}\n\n`);
    send();
    const timer = setInterval(() => {
      send();
      if (seq === 5) clearInterval(timer);
    }, 300);
    res.on("close", () => clearInterval(timer));
  });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const client = new EngineClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, eventTimeoutMs: 1000 });
  const events = [];
  await assert.rejects(async () => {
    for await (const event of client.events("task_test")) events.push(event.seq);
  }, { code: "REQUEST_TIMEOUT", message: /idle/ });
  assert.deepEqual(events, [1, 2, 3, 4, 5]);
});
