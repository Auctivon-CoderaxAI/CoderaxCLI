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
  if (url.pathname === "/api/whoami") {
    return json(200, { ok: true, token: (req.headers.authorization ?? "").replace("Bearer ", "") });
  }
  return json(404, { message: "not found" });
}

async function withStub(run) {
  const server = createServer(stubHandler);
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
  await withStub(async (baseUrl) => {
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
    const io = capture();
    try {
      const code = await runCli(["agents"], {
        env: { CODERAX_BASE_URL: `http://127.0.0.1:${port}` },
        stdout: io.stdout,
        stderr: io.stderr,
      });
      assert.equal(code, 1);
      assert.match(io.err(), /OPERATION_NOT_FOUND|no GET agents operation/);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
    void baseUrl;
  });
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
