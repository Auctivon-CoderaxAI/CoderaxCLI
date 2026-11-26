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
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "live engine reply" } }],
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

  const child = spawn(process.execPath, [ENTRY], {
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
    const timer = setTimeout(() => {
      reject(new Error(`engine did not report a listening URL. stderr: ${stderr.slice(0, 2000)}`));
    }, 20_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /listening on (http:\/\/[^\s]+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`engine exited with ${code}. stderr: ${stderr.slice(0, 2000)}`));
    });
  });

  return {
    url,
    root,
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
      inference.closeAllConnections?.();
      inference.close();
    },
  };
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
        ["engine", "work", "submit", "verify durable work", "--mode", "cloud", "--follow", "--json"],
        env,
      );
      assert.equal(work.code, 0, work.err);
      assert.equal(work.json.task.state, "completed");
      assert.ok(work.json.task.taskId.startsWith("task_"));
      assert.match(work.json.task.result.summary, /live engine reply/);

      const task = await invoke(["engine", "tasks", work.json.task.taskId, "--json"], env);
      assert.equal(task.code, 0, task.err);
      assert.equal(task.json.task.state, "completed");
      assert.equal(task.json.task.steps.length, 3);

      const events = await invoke(
        ["engine", "tasks", "events", work.json.task.taskId, "--json"],
        env,
      );
      assert.equal(events.code, 0, events.err);
      const eventTypes = events.out
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line).type);
      assert.ok(eventTypes.includes("task.started"));
      assert.ok(eventTypes.includes("task.completed"));

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
        ["engine", "permissions", work.json.task.taskId, "--json"],
        env,
      );
      assert.equal(permissions.code, 0, permissions.err);
      assert.deepEqual(permissions.json.requests, []);

      const notifications = await invoke(["engine", "notifications", "--json"], env);
      assert.equal(notifications.code, 0, notifications.err);
      assert.ok(notifications.json.unread >= 1);
      assert.ok(
        notifications.json.notifications.some(
          (notification) => notification.taskId === work.json.task.taskId,
        ),
      );

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
