import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { discoverOpenApi, summarizeOperations } from "../src/discover.js";

const TOKEN = "cli-test-token";

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Coderax", version: "0.8.8" },
  paths: {
    "/api/agents": {
      get: { operationId: "listAgents", summary: "List agents" },
    },
    "/api/models": {
      get: { operationId: "listModels", summary: "List models" },
    },
  },
};

function stubHandler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const json = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === "/health") return json(200, { status: "ok", service: "coderax" });
  if (url.pathname === "/openapi.json") return json(200, OPENAPI);
  if (url.pathname === "/api/agents") {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: "unauthorized" });
    return json(200, { agents: [{ id: "agent-1", name: "Reviewer" }] });
  }
  if (url.pathname === "/api/models") return json(200, { models: ["gpt-4.1"] });
  if (url.pathname === "/api/null") return json(200, null);
  if (url.pathname === "/api/whoami") {
    return json(200, { ok: true, token: (req.headers.authorization ?? "").replace("Bearer ", "") });
  }
  return json(404, { message: "not found" });
}

async function withStub(run, handler = stubHandler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await run(baseUrl);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function tempEnv() {
  const directory = await mkdtemp(join(tmpdir(), "coderax-cli-"));
  return { CODERAX_CONFIG: join(directory, "config.json") };
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

test("help exits 0 and lists commands", async () => {
  const io = capture();
  const code = await runCli(["--help"], { env: {}, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 0);
  assert.match(io.out(), /coderax config set/);
  assert.match(io.out(), /OpenAPI/);
});

test("unknown commands are usage errors", async () => {
  const io = capture();
  const code = await runCli(["deploy"], { env: {}, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 2);
  assert.match(io.err(), /unknown command/);
});

test("missing base URL fails without leaking configuration", async () => {
  const io = capture();
  const env = await tempEnv();
  const code = await runCli(["health"], { env, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 1);
  assert.match(io.err(), /BASE_URL_REQUIRED/i);
});

test("config set persists values and never prints the token", async () => {
  const io = capture();
  const env = await tempEnv();

  const setCode = await runCli(
    ["config", "set", "--base-url", "https://coderax.example.com", "--token", TOKEN],
    { env, stdout: io.stdout, stderr: io.stderr },
  );
  assert.equal(setCode, 0);
  assert.equal(io.out().includes(TOKEN), false);

  const stored = JSON.parse(await readFile(env.CODERAX_CONFIG, "utf8"));
  assert.equal(stored.baseUrl, "https://coderax.example.com");
  assert.equal(stored.token, TOKEN);

  const showIo = capture();
  const showCode = await runCli(["config", "show", "--json"], {
    env,
    stdout: showIo.stdout,
    stderr: showIo.stderr,
  });
  assert.equal(showCode, 0);
  const shown = JSON.parse(showIo.out());
  assert.equal(shown.tokenConfigured, true);
  assert.equal(showIo.out().includes(TOKEN), false);
});

test("config set rejects an insecure remote URL", async () => {
  const io = capture();
  const env = await tempEnv();
  const code = await runCli(["config", "set", "--base-url", "http://coderax.example.com"], {
    env,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 2);
  assert.match(io.err(), /HTTPS/);
});

test("health, openapi, agents, models, and call work against a deployment", async () => {
  await withStub(async (baseUrl) => {
    const env = { CODERAX_CONFIG: join(await mkdtemp(join(tmpdir(), "coderax-cli-")), "c.json"), CODERAX_BASE_URL: baseUrl, CODERAX_TOKEN: TOKEN };

    const healthIo = capture();
    assert.equal(await runCli(["health", "--json"], { env, stdout: healthIo.stdout, stderr: healthIo.stderr }), 0);
    const health = JSON.parse(healthIo.out());
    assert.equal(health.endpoint, "/health");
    assert.equal(health.body.service, "coderax");

    const openapiIo = capture();
    assert.equal(await runCli(["openapi", "--json"], { env, stdout: openapiIo.stdout, stderr: openapiIo.stderr }), 0);
    assert.equal(JSON.parse(openapiIo.out()).operationCount, 2);

    const agentsIo = capture();
    assert.equal(await runCli(["agents", "--json"], { env, stdout: agentsIo.stdout, stderr: agentsIo.stderr }), 0);
    const agents = JSON.parse(agentsIo.out());
    assert.equal(agents.path, "/api/agents");
    assert.equal(agents.body.agents.length, 1);

    const modelsIo = capture();
    assert.equal(await runCli(["models", "--json"], { env, stdout: modelsIo.stdout, stderr: modelsIo.stderr }), 0);
    assert.equal(JSON.parse(modelsIo.out()).body.models[0], "gpt-4.1");

    const callIo = capture();
    assert.equal(
      await runCli(["call", "GET", "/api/models", "--json"], { env, stdout: callIo.stdout, stderr: callIo.stderr }),
      0,
    );
    assert.equal(JSON.parse(callIo.out()).status, 200);
  });
});

test("never prints the token even when the deployment echoes it back", async () => {
  await withStub(async (baseUrl) => {
    const io = capture();
    const env = {
      CODERAX_CONFIG: join(await mkdtemp(join(tmpdir(), "coderax-cli-")), "c.json"),
      CODERAX_BASE_URL: baseUrl,
      CODERAX_TOKEN: TOKEN,
    };

    const code = await runCli(["call", "GET", "/api/whoami", "--json"], {
      env,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    assert.equal(code, 0);
    assert.equal(io.out().includes(TOKEN), false);
    assert.equal(JSON.parse(io.out()).body.token, "[REDACTED]");
  });
});

test("call output redacts a token in the request path", async () => {
  await withStub(async (baseUrl) => {
    const io = capture();
    const env = { ...(await tempEnv()), CODERAX_BASE_URL: baseUrl, CODERAX_TOKEN: TOKEN };
    const path = `/api/whoami?token=${TOKEN}`;

    assert.equal(
      await runCli(["call", "GET", path, "--json"], { env, stdout: io.stdout, stderr: io.stderr }),
      0,
    );
    assert.equal(io.out().includes(TOKEN), false);
    assert.match(JSON.parse(io.out()).path, /REDACTED/);
  });
});

test("discovery keeps route keys unredacted while output stays redacted", async () => {
  const route = `/api/${TOKEN}/agents`;
  const document = {
    openapi: "3.1.0",
    paths: { [route]: { get: { operationId: "listAgents" } } },
  };

  await withStub(
    async (baseUrl) => {
      const env = { ...(await tempEnv()), CODERAX_BASE_URL: baseUrl, CODERAX_TOKEN: TOKEN };
      const openapiIo = capture();
      assert.equal(
        await runCli(["openapi", "--json"], { env, stdout: openapiIo.stdout, stderr: openapiIo.stderr }),
        0,
      );
      assert.equal(openapiIo.out().includes(TOKEN), false);
      assert.equal(JSON.parse(openapiIo.out()).operations[0].path, "/api/[REDACTED]/agents");

      const agentsIo = capture();
      assert.equal(
        await runCli(["agents", "--json"], { env, stdout: agentsIo.stdout, stderr: agentsIo.stderr }),
        0,
      );
      const agents = JSON.parse(agentsIo.out());
      assert.equal(agents.path, "/api/[REDACTED]/agents");
      assert.equal(agents.body.agents.length, 1);
      assert.equal(agentsIo.out().includes(TOKEN), false);
    },
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const json = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === "/openapi.json") return json(200, document);
      if (url.pathname === route) return json(200, { agents: [{ id: "agent-1" }] });
      return json(404, { message: "not found" });
    },
  );
});

test("doctor probes the same health endpoints", async () => {
  await withStub(async (baseUrl) => {
    const io = capture();
    const env = { ...(await tempEnv()), CODERAX_BASE_URL: baseUrl };
    const code = await runCli(["doctor", "--json"], { env, stdout: io.stdout, stderr: io.stderr });
    assert.equal(code, 1);
    const reachability = JSON.parse(io.out()).checks.find((check) => check.name === "reachability");
    assert.equal(reachability.ok, true);
    assert.match(reachability.detail, /GET \/health/);
  });
});

test("call rejects body on GET and invalid JSON", async () => {
  const io = capture();
  const env = await tempEnv();
  const getCode = await runCli(["call", "GET", "/api/models", "--data", "{}"], {
    env,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(getCode, 2);

  const jsonCode = await runCli(["call", "POST", "/api/agents", "--data", "not-json"], {
    env,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(jsonCode, 2);
  assert.match(io.err(), /valid JSON/);
});

test("missing operations are reported, not guessed", async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ openapi: "3.1.0", paths: { "/api/healthz": { get: {} } } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const env = await tempEnv();
  env.CODERAX_BASE_URL = `http://127.0.0.1:${port}`;
  const io = capture();
  try {
    const code = await runCli(["agents"], {
      env,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(code, 1);
    assert.match(io.err(), /OPERATION_NOT_FOUND|no GET agents operation/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("discovery applies relative server prefixes and skips templated paths", async () => {
  const document = {
    openapi: "3.1.0",
    servers: [{ url: "{basePath}/{version}/", variables: { basePath: { default: "/api" }, version: { default: "v1" } } }],
    paths: {
      "/agents": { get: { operationId: "listAgents" } },
      "/admin/{id}/agents": { get: { operationId: "adminAgents" } },
      "/models": { get: { operationId: "listModels" } },
    },
  };
  await withStub(
    async (baseUrl) => {
      const env = { ...(await tempEnv()), CODERAX_BASE_URL: baseUrl, CODERAX_TOKEN: TOKEN };
      const openapiIo = capture();
      assert.equal(
        await runCli(["openapi", "--json"], { env, stdout: openapiIo.stdout, stderr: openapiIo.stderr }),
        0,
      );
      const operations = JSON.parse(openapiIo.out()).operations;
      assert.equal(operations.find((operation) => operation.operationId === "listAgents").path, "/api/v1/agents");

      const agentsIo = capture();
      assert.equal(
        await runCli(["agents", "--json"], { env, stdout: agentsIo.stdout, stderr: agentsIo.stderr }),
        0,
      );
      assert.equal(JSON.parse(agentsIo.out()).path, "/api/v1/agents");
    },
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const json = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === "/openapi.json") return json(200, document);
      if (url.pathname === "/api/v1/agents") return json(200, { agents: [] });
      return json(404, { message: "not found" });
    },
  );
});

test("discovery stops when the document body times out", async () => {
  let documentRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === "/openapi.json") {
      documentRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"openapi":"3.1.0"');
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  try {
    await assert.rejects(
      () => discoverOpenApi({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 80 }),
      (error) => error.code === "REQUEST_TIMEOUT",
    );
    assert.equal(documentRequests, 1);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("discovery surfaces authentication failures", async () => {
  const server = createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "unauthorized" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const io = capture();
  const env = {
    ...(await tempEnv()),
    CODERAX_BASE_URL: `http://127.0.0.1:${port}`,
    CODERAX_TOKEN: TOKEN,
  };
  try {
    const code = await runCli(["openapi"], { env, stdout: io.stdout, stderr: io.stderr });
    assert.equal(code, 3);
    assert.match(io.err(), /HTTP_401/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("discovery reports every candidate when nothing is usable", async () => {
  await assert.rejects(
    () => discoverOpenApi({ baseUrl: "http://127.0.0.1:1", token: TOKEN, timeoutMs: 500 }),
    (error) => error.code === "OPENAPI_NOT_FOUND",
  );
});

test("summarizeOperations ignores non-method keys", () => {
  const operations = summarizeOperations({
    paths: {
      "/api/x": { get: { operationId: "getX" }, parameters: [], post: {} },
    },
  });
  assert.deepEqual(
    operations.map((entry) => `${entry.method} ${entry.path}`),
    ["GET /api/x", "POST /api/x"],
  );
});

test("unknown options are rejected before any request", async () => {
  const io = capture();
  const env = await tempEnv();
  const code = await runCli(["health", "--timeout-ms", "100"], {
    env,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 2);
  assert.match(io.err(), /unknown option: --timeout-ms/);
});

test("config commands work before any deployment is configured", async () => {
  const io = capture();
  const env = await tempEnv();
  const code = await runCli(["config", "show", "--json"], {
    env,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(io.out()).baseUrl, null);
});

test("config rejects inherited object keys", async () => {
  for (const argv of [
    ["config", "set", "constructor", "x"],
    ["config", "get", "toString"],
  ]) {
    const io = capture();
    const code = await runCli(argv, {
      env: await tempEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(code, 2, `${argv.join(" ")} should be a usage error`);
  }
});

test("config set rejects mixing positional and flag forms", async () => {
  const io = capture();
  const code = await runCli(["config", "set", "model", "gpt-6", "--timeout", "1000"], {
    env: await tempEnv(),
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 2);
  assert.match(io.err(), /not both/);
});

test("valid CLI overrides supersede invalid lower-priority settings", async () => {
  const io = capture();
  const env = await tempEnv();
  env.CODERAX_BASE_URL = "http://remote.example.com";
  env.CODERAX_TIMEOUT_MS = "not-a-number";
  const code = await runCli(
    ["config", "show", "--json", "--base-url", "https://coderax.test", "--timeout", "1000"],
    { env, stdout: io.stdout, stderr: io.stderr },
  );
  assert.equal(code, 0);
  const shown = JSON.parse(io.out());
  assert.equal(shown.baseUrl, "https://coderax.test");
  assert.equal(shown.timeoutMs, 1000);
});

test("call preserves a JSON null body", async () => {
  await withStub(async (baseUrl) => {
    const io = capture();
    const env = { ...(await tempEnv()), CODERAX_BASE_URL: baseUrl, CODERAX_TOKEN: TOKEN };
    assert.equal(
      await runCli(["call", "GET", "/api/null", "--json"], { env, stdout: io.stdout, stderr: io.stderr }),
      0,
    );
    assert.equal(JSON.parse(io.out()).body, null);
  });
});

test("[capability:command-registration] every documented command is registered and dispatched", async () => {
  const help = capture();
  assert.equal(
    await runCli(["--help"], { env: {}, stdout: help.stdout, stderr: help.stderr }),
    0,
  );

  const commands = [
    "config", "products", "chat", "work", "models", "agents", "cloud", "projects",
    "login", "logout", "status", "doctor", "update", "health", "openapi", "call",
    "help", "version",
  ];

  for (const command of commands) {
    assert.match(help.out(), new RegExp(`coderax ${command}\\b`), `${command} is missing from --help`);

    const io = capture();
    const code = await runCli([command], {
      env: await tempEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      // Without a TTY, chat/work would wait on stdin for a piped prompt.
      stdinIsTTY: true,
    });
    assert.equal(
      /unknown command/.test(io.err()),
      false,
      `${command} is documented but not dispatched: ${io.err()}`,
    );
    assert.ok(Number.isInteger(code), `${command} must return an exit code`);
  }
});

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("the packaged executable reaches runCli", () => {
  const result = spawnSync(process.execPath, [CLI_PATH, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /coderax-cli 0\.1\.0/);
});

test("a symlinked executable is still detected as the entrypoint", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation requires elevated privileges on Windows");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "coderax-link-"));
  const link = join(directory, "coderax");
  await symlink(CLI_PATH, link);
  const result = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /coderax-cli/);
});
