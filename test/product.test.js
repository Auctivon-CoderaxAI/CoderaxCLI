import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

const TOKEN = "secret-token-value-1234";

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

test("login verifies and stores a token, then status masks it and logout removes it", async () => {
  const file = await tempConfig();
  const env = { CODERAX_CONFIG: file };
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/api\/user$/);
    return new Response(JSON.stringify({ email: "dev@coderax.test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const loginIo = capture();
  const loginCode = await runCli(
    ["login", "--base-url", "https://coderax.test", "--token", TOKEN, "--json"],
    { env, fetchImpl, stdout: loginIo.stdout, stderr: loginIo.stderr, stdinIsTTY: true },
  );
  assert.equal(loginCode, 0);
  assert.equal(loginIo.out().includes(TOKEN), false);
  assert.equal(JSON.parse(loginIo.out()).account, "dev@coderax.test");

  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.token, TOKEN);

  const statusIo = capture();
  assert.equal(
    await runCli(["status", "--json"], { env, stdout: statusIo.stdout, stderr: statusIo.stderr }),
    0,
  );
  const status = JSON.parse(statusIo.out());
  assert.equal(status.authenticated, true);
  assert.equal(status.token.includes(TOKEN), false);

  const logoutIo = capture();
  assert.equal(
    await runCli(["logout", "--json"], { env, stdout: logoutIo.stdout, stderr: logoutIo.stderr }),
    0,
  );
  assert.equal(JSON.parse(logoutIo.out()).removed, true);
  assert.equal(JSON.parse(await readFile(file, "utf8")).token, null);
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

test("logout reports an environment token that remains active", async () => {
  const file = await tempConfig();
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
  assert.equal(result.environmentTokenActive, true);
  assert.match(result.message, /unset/i);
  assert.equal(JSON.parse(await readFile(file, "utf8")).token, null);
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
