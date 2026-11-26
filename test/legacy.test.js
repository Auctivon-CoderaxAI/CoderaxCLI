import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { runCli } from "../src/cli.js";
import { capture, optionsFor, tempDir } from "./helpers.js";

const TOKEN = "owner-token-0123456789";

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Coderax", version: "1.0.0" },
  paths: {
    "/api/agents": { get: { operationId: "listAgents", summary: "List agents" } },
    "/api/models": { get: { operationId: "listModels", summary: "List models" } },
  },
};

async function withDeployment(run) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/health") return json(200, { status: "ok", service: "coderax" });
    if (url.pathname === "/openapi.json") return json(200, OPENAPI);
    if (url.pathname === "/api/agents") {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: "unauthorized" });
      return json(200, { agents: [{ id: "agent-1" }] });
    }
    if (url.pathname === "/api/models") return json(200, { models: ["free"] });
    if (url.pathname === "/api/whoami" || /^\/api\/[^/]+\/whoami$/.test(url.pathname)) {
      return json(200, { token: req.headers.authorization?.replace("Bearer ", "") });
    }
    if (url.pathname === "/api/null") return json(200, null);
    return json(404, { message: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function env(baseUrl) {
  return {
    CODERAX_CONFIG_DIR: await tempDir(),
    CODERAX_BASE_URL: baseUrl,
    CODERAX_TOKEN: TOKEN,
    CODERAX_CREDENTIAL_STORE: "file",
  };
}

async function cli(environment, argv) {
  const io = capture();
  const code = await runCli(argv, optionsFor(environment, io));
  return { code, io, json: () => JSON.parse(io.out()) };
}

test("products lists the five products and their real launch states", async () => {
  const { code, json } = await cli({ CODERAX_CONFIG_DIR: await tempDir() }, ["products", "--json"]);
  assert.equal(code, 0);
  assert.deepEqual(json().data.products.map((product) => product.id), ["desktop", "cli", "web", "cloud", "chat"]);
});

test("cloud and projects are explicitly unavailable without executing anything", async () => {
  const environment = { CODERAX_CONFIG_DIR: await tempDir() };
  const cloud = await cli(environment, ["cloud", "--json"]);
  assert.equal(cloud.code, 6);
  assert.match(cloud.json().data.message, /nothing is billed/i);
  const projects = await cli(environment, ["projects", "--json"]);
  assert.equal(projects.code, 6);
  assert.equal(projects.json().data.unavailable, true);
});

test("update explains archive delivery without a registry", async () => {
  const { code, json } = await cli({ CODERAX_CONFIG_DIR: await tempDir() }, ["update", "--json"]);
  assert.equal(code, 0);
  assert.match(json().data.message, /GitHub release archives/);
});

test("deployment health, openapi and discovered resources work", async () => {
  await withDeployment(async (baseUrl) => {
    const environment = await env(baseUrl);
    const health = await cli(environment, ["deploy", "health", "--json"]);
    assert.equal(health.code, 0);
    assert.equal(health.json().data.endpoint, "/health");
    assert.equal(health.json().data.body.service, "coderax");

    const openapi = await cli(environment, ["deploy", "openapi", "--json"]);
    assert.equal(openapi.code, 0);
    assert.equal(openapi.json().data.operationCount, 2);

    const agents = await cli(environment, ["deploy", "agents", "--json"]);
    assert.equal(agents.code, 0);
    assert.equal(agents.json().data.body.agents.length, 1);
    assert.equal(agents.json().data.path, "/api/agents");
  });
});

test("the deployment call surface is redacted and preserves JSON null", async () => {
  await withDeployment(async (baseUrl) => {
    const environment = await env(baseUrl);
    const who = await cli(environment, ["call", "GET", "/api/whoami", "--json"]);
    assert.equal(who.code, 0);
    assert.equal(who.io.out().includes(TOKEN), false);
    assert.equal(who.json().data.body.token, "[REDACTED]");

    const nullBody = await cli(environment, ["call", "GET", "/api/null", "--json"]);
    assert.equal(nullBody.code, 0);
    assert.equal(nullBody.json().data.body, null);
  });
});

test("a deployment token in a route path never reaches output", async () => {
  await withDeployment(async (baseUrl) => {
    const environment = await env(baseUrl);
    const { code, io, json } = await cli(environment, ["call", "GET", `/api/${TOKEN}/whoami`, "--json"]);
    assert.equal(code, 0);
    assert.equal(io.out().includes(TOKEN), false);
    assert.match(json().data.path, /REDACTED/);
  });
});

test("missing deployment configuration is a usage error", async () => {
  const { code, json } = await cli({ CODERAX_CONFIG_DIR: await tempDir() }, ["deploy", "health", "--json"]);
  assert.equal(code, 2);
  assert.equal(json().error.code, "BASE_URL_REQUIRED");
});
