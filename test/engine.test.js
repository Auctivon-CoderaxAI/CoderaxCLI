import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import {
  ENGINE_COMMANDS,
  ENGINE_OPERATIONS,
  completionScript,
} from "../src/command-registry.js";
import { assertContractVersion } from "../src/engine-client.js";

const TOKEN = "engine-test-owner-token";
const BASE = "https://engine.example";

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

async function env(extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "coderax-engine-test-"));
  return {
    CODERAX_CONFIG: join(directory, "config.json"),
    CODERAX_BASE_URL: BASE,
    CODERAX_TOKEN: TOKEN,
    ...extra,
  };
}

function health(contractVersion = "1.0.0") {
  return {
    status: "ok",
    contractVersion,
    startedAt: "2026-01-01T00:00:00.000Z",
    uptimeMs: 10,
    checks: [],
    engines: [],
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Deterministic fetch double. Every call is recorded so a test can prove that
 * a blocked or malformed command sent no request at all.
 */
function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    const call = {
      path: target.pathname,
      query: target.search,
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    calls.push(call);
    return handler(call, calls);
  };
  return { calls, fetchImpl };
}

function healthyEngine(extra = {}) {
  return stubFetch((call) => {
    if (call.path === "/v1/health") return json(200, health());
    if (extra[call.path]) return extra[call.path](call);
    if (call.path === "/v1/agents") {
      if (call.headers.authorization !== `Bearer ${TOKEN}`) {
        return json(401, { code: "unauthorized", detail: "A valid owner token is required." });
      }
      return json(200, { agents: [] });
    }
    return json(404, { code: "not_found" });
  });
}

test("health validates the served contract before anything else", async () => {
  const io = capture();
  const stub = healthyEngine();
  const code = await runCli(["engine", "health", "--json"], {
    env: await env(),
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].path, "/v1/health");
  assert.equal(stub.calls[0].headers.authorization, undefined);
  assert.equal(JSON.parse(io.out()).contractVersion, "1.0.0");
});

test("a different contract line fails closed before the owner token is sent", async () => {
  const io = capture();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url).pathname);
    return json(200, health("2.0.0"));
  };
  const code = await runCli(["engine", "agents", "--json"], {
    env: await env(),
    fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 6);
  assert.match(io.err(), /API_VERSION_UNSUPPORTED/);
  assert.deepEqual(calls, ["/v1/health"]);
});

test("assertContractVersion accepts the same minor line only", () => {
  assert.equal(assertContractVersion("1.0.9").version, "1.0.9");
  assert.throws(() => assertContractVersion("1.1.0"), /this CLI implements 1\.0\.0/);
  assert.throws(() => assertContractVersion("not-a-version"), /did not report/);
});

test("engine agents requires an owner token and never sends one when absent", async () => {
  const io = capture();
  const stub = healthyEngine();
  const code = await runCli(["engine", "agents", "--json"], {
    env: await env({ CODERAX_TOKEN: "" }),
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 3);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].path, "/v1/health");
  assert.match(io.err(), /no owner token configured/);
});

test("a rejected owner token maps to the authentication exit code", async () => {
  const io = capture();
  const stub = healthyEngine();
  const code = await runCli(["engine", "agents", "--json"], {
    env: await env({ CODERAX_TOKEN: "wrong-token" }),
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 3);
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[1].path, "/v1/agents");
  assert.match(io.err(), /UNAUTHENTICATED/);
});

test("schedule commands are blocked with zero requests", async () => {
  const io = capture();
  const stub = healthyEngine();
  const code = await runCli(["engine", "schedules", "create", "--data", '{"cron":"* * * * *"}'], {
    env: await env(),
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 6);
  assert.equal(stub.calls.length, 0);
  assert.match(io.out(), /blocked/);
  assert.match(io.out(), /no schedule operations/);
});

test("every blocked command is declared with a reason and no operation", () => {
  for (const command of ENGINE_COMMANDS.filter((entry) => entry.status === "blocked")) {
    assert.equal(command.operation, undefined, `${command.name} must not bind an operation`);
    assert.ok(command.reason.length > 20, `${command.name} needs a real reason`);
  }
  for (const command of ENGINE_COMMANDS.filter((entry) => entry.status === "available")) {
    if (command.operation !== null) {
      assert.ok(ENGINE_OPERATIONS[command.operation], `${command.name} binds a real operation`);
    }
  }
});

test("malformed --data and empty Work objectives fail before any request", async () => {
  const io = capture();
  const stub = healthyEngine();
  const badJson = await runCli(["engine", "work", "submit", "--data", "not-json"], {
    env: await env(),
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(badJson, 2);
  assert.match(io.err(), /valid JSON/);

  const empty = await runCli(["engine", "work", "submit", "--data", '{"objective":""}'], {
    env: await env(),
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(empty, 2);
  assert.match(io.err(), /non-empty objective/);

  const badAfter = await runCli(
    ["engine", "work", "submit", "say hello", "--follow", "--after", "nope"],
    {
      env: await env(),
      fetchImpl: stub.fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    },
  );
  assert.equal(badAfter, 2);
  assert.match(io.err(), /--after must be a non-negative integer/);
  assert.equal(stub.calls.length, 0);
});

test("task identifiers reject path traversal before the request", async () => {
  const io = capture();
  const stub = healthyEngine();
  const code = await runCli(["engine", "tasks", "../../etc/passwd", "--json"], {
    env: await env(),
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 2);
  assert.equal(stub.calls.length, 0);
  assert.match(io.err(), /single identifier/);
});

test("chat sends the contracted body and reuses the owner token", async () => {
  const io = capture();
  const stub = healthyEngine({
    "/v1/chat": (call) =>
      json(200, {
        conversationId: "conv_1",
        messageId: "msg_1",
        text: `echo: ${call.body.message}`,
        agent: "coderax",
        model: { providerId: "stub", modelId: "model" },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
  });
  const code = await runCli(
    ["engine", "chat", "hello", "engine", "--agent", "coderax", "--model", "stub/model", "--mode", "cloud", "--json"],
    {
      env: await env(),
      fetchImpl: stub.fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    },
  );
  assert.equal(code, 0);
  assert.equal(stub.calls.length, 3);
  const chat = stub.calls[2];
  assert.equal(chat.path, "/v1/chat");
  assert.equal(chat.method, "POST");
  assert.equal(chat.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(chat.body, {
    message: "hello engine",
    agent: "coderax",
    mode: "cloud",
    model: { providerId: "stub", modelId: "model" },
  });
});

test("Work --data is validated then submitted as one durable task", async () => {
  const io = capture();
  const stub = healthyEngine({
    "/v1/work": (call) =>
      json(202, {
        taskId: "task_1",
        conversationId: "conv_1",
        state: "queued",
        generation: 1,
        eventsPath: "/v1/work/task_1/events",
      }),
  });
  const code = await runCli(
    ["engine", "work", "submit", "--data", '{"objective":"say hello","mode":"cloud"}', "--json"],
    {
      env: await env(),
      fetchImpl: stub.fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    },
  );
  assert.equal(code, 0);
  assert.equal(stub.calls.length, 3);
  const work = stub.calls[2];
  assert.equal(work.path, "/v1/work");
  assert.equal(work.method, "POST");
  assert.deepEqual(work.body, {
    objective: "say hello",
    mode: "cloud",
    requireApproval: true,
  });
  const result = JSON.parse(io.out());
  assert.equal(result.taskId, "task_1");
  assert.equal(result.detached, true);
});

test("task discovery and artifact metadata use the adopted surface", async () => {
  const io = capture();
  const stub = healthyEngine({
    "/v1/notifications": () =>
      json(200, {
        unread: 1,
        notifications: [
          {
            taskId: "task_1",
            state: "completed",
            summary: "done",
            read: false,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    "/v1/work/task_1": () =>
      json(200, {
        taskId: "task_1",
        conversationId: "conv_1",
        state: "completed",
        agent: "coderax",
        mode: "cloud",
        generation: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        cancelRequested: false,
        steps: [],
        result: { artifacts: [{ path: "out.txt", bytes: 3, digest: "sha256:abc" }] },
      }),
  });

  const tasks = await runCli(["engine", "tasks", "--json"], {
    env: await env(),
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(tasks, 0, io.err());
  assert.equal(JSON.parse(io.out()).notifications[0].taskId, "task_1");
  assert.equal(stub.calls.at(-1).path, "/v1/notifications");

  const artifactIo = capture();
  const artifacts = await runCli(["engine", "artifacts", "task_1", "--json"], {
    env: await env(),
    fetchImpl: stub.fetchImpl,
    stdout: artifactIo.stdout,
    stderr: artifactIo.stderr,
  });
  assert.equal(artifacts, 0, artifactIo.err());
  const payload = JSON.parse(artifactIo.out());
  assert.equal(payload.transferSupported, false);
  assert.deepEqual(payload.artifacts, [{ path: "out.txt", bytes: 3, digest: "sha256:abc" }]);
  assert.equal(stub.calls.at(-1).path, "/v1/work/task_1");
});

test("capabilities reports blocked commands and unconfigured deployment without a request", async () => {
  const io = capture();
  const stub = healthyEngine();
  const environment = await env();
  delete environment.CODERAX_BASE_URL;
  delete environment.CODERAX_TOKEN;
  const code = await runCli(["engine", "capabilities", "--json"], {
    env: environment,
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0);
  assert.equal(stub.calls.length, 0);
  const report = JSON.parse(io.out());
  assert.equal(report.deployment.configured, false);
  const schedules = report.commands.find((command) => command.name === "schedules");
  assert.equal(schedules.status, "blocked");
  const healthCommand = report.commands.find((command) => command.name === "health");
  assert.equal(healthCommand.status, "unconfigured");
});

test("engine status is local and needs no request", async () => {
  const io = capture();
  const stub = healthyEngine();
  const code = await runCli(["engine", "status", "--json"], {
    env: await env(),
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0, io.err());
  assert.equal(stub.calls.length, 0);
  assert.equal(JSON.parse(io.out()).authenticated, true);
});

test("completion is generated from the same registry", async () => {
  const io = capture();
  const code = await runCli(["completion", "bash"], {
    env: {},
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0);
  assert.match(io.out(), /engine/);
  assert.match(io.out(), /schedules/);
  assert.match(io.out(), /health/);

  const script = completionScript("fish");
  assert.match(script, /complete -c coderax/);
  assert.match(script, /game-studio/);

  const bad = capture();
  assert.equal(
    await runCli(["completion", "powershell"], { env: {}, stdout: bad.stdout, stderr: bad.stderr }),
    2,
  );
});

test("readiness is gated by the contract before /v1/ready is called", async () => {
  const io = capture();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url).pathname);
    return json(200, health("2.0.0"));
  };
  const code = await runCli(["engine", "ready"], {
    env: await env(),
    fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 6);
  assert.deepEqual(calls, ["/v1/health"]);
});

test("untrusted engine text cannot inject terminal escapes", async () => {
  const io = capture();
  const stub = healthyEngine({
    "/v1/agents": () =>
      json(200, {
        agents: [
          {
            id: "coderax\u001B[31m",
            engine: "native",
            label: "red label",
            external: false,
            capabilities: {},
            availability: { available: true, reason: "ready", detail: "ok" },
            isolation: {},
          },
        ],
      }),
  });
  const code = await runCli(["engine", "agents"], {
    env: await env(),
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0);
  assert.equal(io.out().includes("\u001B"), false);
  assert.match(io.out(), /coderax/);
});

test("unknown Work fields and conversation traversal fail before the request", async () => {
  const io = capture();
  const stub = healthyEngine();
  const unknown = await runCli(
    ["engine", "work", "submit", "--data", '{"objective":"x","shell":"rm -rf"}'],
    { env: await env(), fetchImpl: stub.fetchImpl, stdout: io.stdout, stderr: io.stderr },
  );
  assert.equal(unknown, 2);
  assert.match(io.err(), /unsupported Work field/);

  const traversal = await runCli(["engine", "conversations", "../../etc/passwd"], {
    env: await env(),
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(traversal, 2);
  assert.equal(stub.calls.length, 0);
});

test("engine login proves the owner and stores the token, logout clears it", async () => {
  const io = capture();
  const stub = healthyEngine();
  const environment = await env({ CODERAX_CREDENTIAL_STORE: "file" });
  const code = await runCli(["engine", "login", "--json"], {
    env: environment,
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0, io.err());
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[1].path, "/v1/agents");
  const stored = JSON.parse(await readFile(environment.CODERAX_CONFIG, "utf8"));
  assert.equal(stored.token, TOKEN);
  assert.equal(JSON.parse(io.out()).owner, true);
  assert.equal(io.out().includes(TOKEN), false);

  const out = capture();
  const logout = await runCli(["engine", "logout", "--json"], {
    env: { ...environment, CODERAX_TOKEN: "" },
    fetchImpl: stub.fetchImpl,
    stdout: out.stdout,
    stderr: out.stderr,
  });
  assert.equal(logout, 0, out.err());
  const cleared = JSON.parse(await readFile(environment.CODERAX_CONFIG, "utf8"));
  assert.equal(cleared.token, null);
});

test("engine login never stores a rejected token", async () => {
  const io = capture();
  const stub = healthyEngine();
  const environment = await env({
    CODERAX_TOKEN: "wrong-token",
    CODERAX_CREDENTIAL_STORE: "file",
  });
  const code = await runCli(["engine", "login", "--json"], {
    env: environment,
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 3);
  let stored = null;
  try {
    stored = JSON.parse(await readFile(environment.CODERAX_CONFIG, "utf8"));
  } catch {
    stored = null;
  }
  assert.equal(stored?.token ?? null, null);
});

test("engine help works without a deployment and names blocked work", async () => {
  const io = capture();
  const stub = healthyEngine();
  const code = await runCli(["engine", "help"], {
    env: {},
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0);
  assert.equal(stub.calls.length, 0);
  assert.match(io.out(), /authoritative WorkflowEngine 1\.0\.0/);
  assert.match(io.out(), /Blocked by the 1\.0\.0 contract/);
  assert.match(io.out(), /schedules - WorkflowEngine 1\.0\.0 exposes no schedule/);
  assert.match(io.out(), /transfers - WorkflowEngine 1\.0\.0 exposes no artifact/);
  assert.doesNotMatch(io.out(), /detach - WorkflowEngine/);
});

test("unknown engine commands are usage errors", async () => {
  const io = capture();
  const stub = healthyEngine();
  const code = await runCli(["engine", "deploy"], {
    env: {},
    fetchImpl: stub.fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 2);
  assert.equal(stub.calls.length, 0);
  assert.match(io.err(), /unknown engine command/);
});
