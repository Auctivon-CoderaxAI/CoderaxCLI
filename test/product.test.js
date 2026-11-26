import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { streamRequest } from "../src/client.js";

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

function baseUrl() {
  return "https://coderax.test";
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

test("the corrected Work SSE fixtures parse real frame boundaries", async () => {
  // These are the fixtures from the SSE correction: each data record ends with
  // an actual blank line, not the two literal characters `\n\n`. The parser is
  // unchanged; only the fixture now describes a valid SSE frame.
  const chunks = [
    'data: {"message":true,"text":"accepted"}\n\n',
    'data: {"message":true,"text":"accepted and verified"}\n\n',
    'data: {"final":true,"responseMessage":{"text":"accepted and verified"}}\n\n',
  ];

  const text = await streamRequest({
    baseUrl: baseUrl(),
    token: TOKEN,
    path: "/api/work/chat",
    fetchImpl: async () => sseResponse(chunks),
  });

  assert.equal(text, "accepted and verified");
});

test("a genuine snapshot replacement reports corrected text, not stale text", async () => {
  const replacements = [];
  const chunks = [
    'data: {"message":true,"text":"old draft"}\n\n',
    'data: {"message":true,"text":"corrected answer"}\n\n',
    'data: {"final":true,"responseMessage":{"text":"corrected answer"}}\n\n',
  ];

  const text = await streamRequest({
    baseUrl: baseUrl(),
    token: TOKEN,
    path: "/api/work/chat",
    fetchImpl: async () => sseResponse(chunks),
    onEvent: (event) => {
      if (event.type === "replace") replacements.push(event.text);
    },
  });

  assert.equal(text, "corrected answer");
  assert.deepEqual(replacements, ["corrected answer"]);
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
    await runCli(["config", "set", "--model", "free/coderax-small"], {
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
  assert.match(getIo.out(), /free\/coderax-small/);
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.baseUrl, "https://coderax.test");
  assert.equal(stored.model, "free/coderax-small");
});
