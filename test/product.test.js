import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { credentialAccount } from "../src/credentials.js";

const TOKEN = "secret-token-value-1234";

function memoryStore() {
  const map = new Map();
  return {
    name: "memory-test",
    available: true,
    secure: true,
    detail: "in-memory test store",
    async get(account) {
      return map.has(account) ? map.get(account) : null;
    },
    async set(account, secret) {
      map.set(account, secret);
    },
    async delete(account) {
      return map.delete(account);
    },
    async describe() {
      return { name: "memory-test", available: true, secure: true, detail: "in-memory test store" };
    },
    map,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function tempConfig() {
  const directory = await mkdtemp(join(tmpdir(), "coderax-product-"));
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

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("products exposes the five-product registry", async () => {
  const io = capture();
  const code = await runCli(["products", "--json"], {
    env: {},
    stdout: io.stdout,
    stderr: io.stderr,
  });

  assert.equal(code, 0);
  assert.deepEqual(
    JSON.parse(io.out()).products.map((product) => product.id),
    ["desktop", "cli", "web", "cloud", "chat"],
  );
});

test("headless login stores the token in the OS store, status masks it, and logout removes it", async () => {
  const file = await tempConfig();
  const env = { CODERAX_CONFIG: file };
  const store = memoryStore();
  const revoked = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/health") return jsonResponse({ status: "ok", service: "coderax" });
    if (path === "/openapi.json") {
      return jsonResponse({ openapi: "3.1.0", info: { title: "Coderax" }, paths: { "/api/user": { get: {} } } });
    }
    if (path === "/api/user") {
      assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
      return jsonResponse({ email: "dev@coderax.test", sub: "user-1", role: "ADMIN" });
    }
    if (path === "/api/auth/token/revoke") {
      revoked.push(new URLSearchParams(init.body).get("token_type_hint"));
      return new Response("", { status: 200 });
    }
    assert.fail(`unexpected request to ${path}`);
  };

  const loginIo = capture();
  const loginCode = await runCli(
    ["login", "--base-url", "https://coderax.test", "--with-token", "--json"],
    {
      env,
      fetchImpl,
      credentialStore: store,
      stdout: loginIo.stdout,
      stderr: loginIo.stderr,
      stdinIsTTY: false,
      readSecret: async () => TOKEN,
    },
  );
  assert.equal(loginCode, 0);
  assert.equal(loginIo.out().includes(TOKEN), false);
  assert.equal(JSON.parse(loginIo.out()).account, "dev@coderax.test");

  const storedConfig = JSON.parse(await readFile(file, "utf8"));
  assert.equal(storedConfig.baseUrl, "https://coderax.test");
  assert.equal(Object.hasOwn(storedConfig, "token"), false);
  assert.equal(store.map.size, 1);
  const credential = JSON.parse([...store.map.values()][0]);
  assert.equal(credential.accessToken, TOKEN);
  assert.equal(credential.baseUrl, "https://coderax.test");

  const statusIo = capture();
  assert.equal(
    await runCli(["status", "--json"], {
      env,
      credentialStore: store,
      stdout: statusIo.stdout,
      stderr: statusIo.stderr,
    }),
    0,
  );
  const status = JSON.parse(statusIo.out());
  assert.equal(status.authenticated, true);
  assert.equal(status.source, "credential-store");
  assert.equal(status.token.includes(TOKEN), false);

  const logoutIo = capture();
  assert.equal(
    await runCli(["logout", "--json"], {
      env,
      credentialStore: store,
      fetchImpl,
      stdout: logoutIo.stdout,
      stderr: logoutIo.stderr,
    }),
    0,
  );
  const logout = JSON.parse(logoutIo.out());
  assert.equal(logout.removed, true);
  assert.deepEqual(revoked, ["access_token"]);
  assert.equal(store.map.size, 0);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(file, "utf8")), "token"), false);
});

test("changing the base URL while signed in requires logout first", async () => {
  const file = await tempConfig();
  const env = { CODERAX_CONFIG: file };
  const store = memoryStore();
  const oldBase = "https://old.coderax.test";
  const io = capture();

  assert.equal(
    await runCli(["config", "set", "--base-url", oldBase], {
      env,
      credentialStore: store,
      stdout: io.stdout,
      stderr: io.stderr,
    }),
    0,
  );
  store.map.set(credentialAccount(oldBase), JSON.stringify({ version: 1 }));

  const changeIo = capture();
  const code = await runCli(["config", "set", "--base-url", "https://new.coderax.test"], {
    env,
    credentialStore: store,
    stdout: changeIo.stdout,
    stderr: changeIo.stderr,
  });
  assert.equal(code, 3);
  assert.match(changeIo.err(), /logout/);
});

test("an unauthenticated command fails before making any request", async () => {
  const store = memoryStore();
  const io = capture();
  let requests = 0;
  const env = {
    CODERAX_CONFIG: await tempConfig(),
    CODERAX_BASE_URL: "https://coderax.test",
  };
  const code = await runCli(["chat", "hi", "--json"], {
    env,
    credentialStore: store,
    fetchImpl: async () => {
      requests += 1;
      throw new Error("unauthenticated commands must not reach the deployment");
    },
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: true,
  });

  assert.equal(code, 3);
  assert.equal(requests, 0);
  assert.match(io.err(), /not signed in/i);
});

test("chat streams SSE deltas and redacts an echoed token", async () => {
  const io = capture();
  const env = {
    CODERAX_CONFIG: await tempConfig(),
    CODERAX_BASE_URL: "https://coderax.test",
    CODERAX_TOKEN: TOKEN,
  };
  const fetchImpl = async () =>
    sseResponse([
      `data: {"delta":"hello ${TOKEN}"}\n\n`,
      'data: {"delta":" world"}\n\n',
      "data: [DONE]\n\n",
    ]);

  const code = await runCli(["chat", "hi", "--json"], {
    env,
    fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: true,
  });

  assert.equal(code, 0);
  const result = JSON.parse(io.out());
  assert.equal(result.text.includes(TOKEN), false);
  assert.match(result.text, /hello \[REDACTED\] world/);
  assert.equal(result.events, 2);
});

test("a stored owner session authenticates Chat without an environment token", async () => {
  const file = await tempConfig();
  const store = memoryStore();
  const token = "stored-owner-session-token";
  const baseUrl = "https://coderax.test";
  store.map.set(
    credentialAccount(baseUrl),
    JSON.stringify({
      version: 1,
      baseUrl,
      issuer: baseUrl,
      accessToken: token,
      refreshToken: null,
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
      expirySource: "token",
      scopes: ["coderax:chat"],
      scopesKnown: true,
      subject: "owner-1",
      account: "owner@coderax.test",
      endpoints: {
        deviceCode: "/api/auth/device/code",
        deviceToken: "/api/auth/device/token",
        refresh: "/api/auth/token/refresh",
        revoke: "/api/auth/token/revoke",
        userinfo: "/api/user",
      },
      clientId: "coderax-cli",
      createdAt: Date.now(),
      refreshedAt: Date.now(),
    }),
  );
  let authorized = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(new URL(url).pathname, "/api/work/chat");
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    authorized += 1;
    return sseResponse(['data: {"delta":"from the OS store"}\n\n', "data: [DONE]\n\n"]);
  };
  const io = capture();
  const code = await runCli(["chat", "hello", "--json"], {
    env: { CODERAX_CONFIG: file, CODERAX_BASE_URL: baseUrl },
    credentialStore: store,
    fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: true,
  });
  assert.equal(code, 0);
  assert.equal(authorized, 1);
  assert.equal(JSON.parse(io.out()).text, "from the OS store");
  assert.equal(io.out().includes(token), false);
});

test("work sends prompts to the native Work chat route, not the Chat route", async () => {
  const io = capture();
  const env = {
    CODERAX_CONFIG: await tempConfig(),
    CODERAX_BASE_URL: "https://coderax.test",
    CODERAX_TOKEN: TOKEN,
  };
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(new URL(url).pathname, "/api/work/chat");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(init.body), {
      text: "implement the fix",
      mode: "work",
      endpoint: "agents",
    });
    return sseResponse(['data: {"delta":"accepted"}\n\n', "data: [DONE]\n\n"]);
  };

  const code = await runCli(["work", "implement the fix", "--json"], {
    env,
    fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: true,
  });
  assert.equal(code, 0);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(io.out()).text, "accepted");
  assert.equal(io.out().includes(TOKEN), false);
});

test("work consumes native cumulative message snapshots without duplicating text", async () => {
  const io = capture();
  const env = {
    CODERAX_CONFIG: await tempConfig(),
    CODERAX_BASE_URL: "https://coderax.test",
    CODERAX_TOKEN: TOKEN,
  };
  const fetchImpl = async (url) => {
    assert.equal(new URL(url).pathname, "/api/work/chat");
    return sseResponse([
      'data: {"created":true,"streamId":"task-id"}\n\n',
      'data: {"message":true,"text":"accepted"}\n\n',
      'data: {"message":true,"text":"accepted and verified"}\n\n',
      'data: {"final":true,"responseMessage":{"text":"accepted and verified"}}\n\n',
    ]);
  };
  const code = await runCli(["work", "implement", "--json"], {
    env,
    fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: true,
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(io.out()).text, "accepted and verified");
  assert.equal(JSON.parse(io.out()).events, 2);
});

test("work returns the corrected answer when an engine snapshot replaces earlier text", async () => {
  const io = capture();
  const env = {
    CODERAX_CONFIG: await tempConfig(),
    CODERAX_BASE_URL: "https://coderax.test",
    CODERAX_TOKEN: TOKEN,
  };
  const fetchImpl = async () => sseResponse([
    'data: {"message":true,"text":"old draft"}\n\n',
    'data: {"message":true,"text":"corrected answer"}\n\n',
    'data: {"final":true,"responseMessage":{"text":"corrected answer"}}\n\n',
  ]);
  const code = await runCli(["work", "implement", "--json"], {
    env,
    fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: true,
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(io.out()).text, "corrected answer");
  assert.equal(io.out().includes(TOKEN), false);
});

test("login --with-token refuses to send CODERAX_TOKEN to a different base URL", async () => {
  const io = capture();
  let requests = 0;
  const env = {
    CODERAX_CONFIG: await tempConfig(),
    CODERAX_BASE_URL: "https://coderax.test",
    CODERAX_TOKEN: TOKEN,
  };
  const code = await runCli(["login", "--with-token", "--base-url", "https://evil.example.com"], {
    env,
    fetchImpl: async () => {
      requests += 1;
      throw new Error("login must not reach a different origin");
    },
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: false,
  });

  assert.equal(code, 3);
  assert.equal(requests, 0);
  assert.match(io.err(), /refusing to send CODERAX_TOKEN/);
  assert.equal(io.out().includes(TOKEN), false);
  assert.equal(io.err().includes(TOKEN), false);
});

test("logout refuses to send CODERAX_TOKEN to a different base URL", async () => {
  const io = capture();
  let requests = 0;
  const env = {
    CODERAX_CONFIG: await tempConfig(),
    CODERAX_BASE_URL: "https://coderax.test",
    CODERAX_TOKEN: TOKEN,
  };
  const code = await runCli(["logout", "--base-url", "https://evil.example.com"], {
    env,
    fetchImpl: async () => {
      requests += 1;
      throw new Error("logout must not reach a different origin");
    },
    stdout: io.stdout,
    stderr: io.stderr,
  });

  assert.equal(code, 3);
  assert.equal(requests, 0);
  assert.match(io.err(), /refusing to send CODERAX_TOKEN/);
  assert.equal(io.out().includes(TOKEN), false);
  assert.equal(io.err().includes(TOKEN), false);
});

test("logout removes a legacy plaintext token and reports an environment token that remains active", async () => {
  const file = await tempConfig();
  await writeFile(file, JSON.stringify({ token: TOKEN }), "utf8");
  const io = capture();
  const env = { CODERAX_CONFIG: file, CODERAX_TOKEN: TOKEN };
  const code = await runCli(["logout", "--json"], {
    env,
    stdout: io.stdout,
    stderr: io.stderr,
  });

  assert.equal(code, 0);
  const result = JSON.parse(io.out());
  assert.equal(result.removed, false);
  assert.equal(result.legacyRemoved, true);
  assert.equal(result.environmentTokenActive, true);
  assert.match(result.message, /unset/i);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(file, "utf8")), "token"), false);
});

test("an empty stream is an error in JSON mode", async () => {
  const io = capture();
  const env = {
    CODERAX_CONFIG: await tempConfig(),
    CODERAX_BASE_URL: "https://coderax.test",
    CODERAX_TOKEN: TOKEN,
  };
  const fetchImpl = async () => sseResponse(["data: [DONE]\n\n"]);

  const code = await runCli(["chat", "hi", "--json"], {
    env,
    fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: true,
  });

  assert.equal(code, 1);
  assert.equal(JSON.parse(io.out()).text, "");
  assert.match(io.err(), /streamed no text/i);
});

test("doctor checks the active config file's directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coderax-doctor-"));
  const file = join(directory, "config.json");
  const io = capture();

  await runCli(["doctor", "--json"], {
    env: { CODERAX_CONFIG: file },
    stdout: io.stdout,
    stderr: io.stderr,
  });

  const result = JSON.parse(io.out());
  const check = result.checks.find((entry) => entry.name === "config-dir");
  assert.ok(check.detail.includes(directory), check.detail);
});

test("cloud is unavailable without executing anything", async () => {
  const io = capture();
  assert.equal(
    await runCli(["cloud", "--json"], { env: {}, stdout: io.stdout, stderr: io.stderr }),
    6,
  );
  const result = JSON.parse(io.out());
  assert.equal(result.status, "in-development");
  assert.match(result.message, /nothing is billed/i);
});

test("config accepts both key/value and flag forms", async () => {
  const file = await tempConfig();
  const env = { CODERAX_CONFIG: file };

  const keyed = capture();
  assert.equal(
    await runCli(["config", "set", "base-url", "https://coderax.test"], {
      env,
      stdout: keyed.stdout,
      stderr: keyed.stderr,
    }),
    0,
  );
  const flagged = capture();
  assert.equal(
    await runCli(["config", "set", "--model", "gpt-6"], {
      env,
      stdout: flagged.stdout,
      stderr: flagged.stderr,
    }),
    0,
  );

  const getIo = capture();
  assert.equal(
    await runCli(["config", "get", "model"], { env, stdout: getIo.stdout, stderr: getIo.stderr }),
    0,
  );
  assert.match(getIo.out(), /gpt-6/);
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.baseUrl, "https://coderax.test");
  assert.equal(stored.model, "gpt-6");
});
