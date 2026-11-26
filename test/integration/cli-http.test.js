import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NON_OWNER_TOKEN, OWNER_TOKEN, startHarness } from "../harness/workflow-engine.mjs";

const CLI_PATH = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
const IS_WINDOWS = process.platform === "win32";

/** Do not inherit a developer or CI deployment configuration. */
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("CODERAX_")),
  );
  return { ...env, ...extra };
}

async function tempConfig() {
  const directory = await mkdtemp(join(tmpdir(), "coderax-http-"));
  return join(directory, "config.json");
}

function runCli(args, { env = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: cleanEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function json(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`expected JSON output, got:\n${result.stdout}\n${result.stderr}`);
  }
}

test("[capability:owner-auth] owner-only authentication rejects other tokens with exit 3", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const owner = await runCli(["call", "GET", "/api/models", "--json"], {
    env: { CODERAX_CONFIG: await tempConfig(), CODERAX_BASE_URL: harness.baseUrl, CODERAX_TOKEN: OWNER_TOKEN },
  });
  assert.equal(owner.code, 0, owner.stderr);
  assert.equal(json(owner).body.models[0], "gpt-4.1");

  const intruder = await runCli(["call", "GET", "/api/models"], {
    env: {
      CODERAX_CONFIG: await tempConfig(),
      CODERAX_BASE_URL: harness.baseUrl,
      CODERAX_TOKEN: NON_OWNER_TOKEN,
    },
  });
  assert.equal(intruder.code, 3);
  assert.match(intruder.stderr, /HTTP_403/);
  assert.match(intruder.stderr, /owner-only/i);
  assert.equal(intruder.stderr.includes(NON_OWNER_TOKEN), false);

  const anonymous = await runCli(["call", "GET", "/api/models"], {
    env: { CODERAX_CONFIG: await tempConfig(), CODERAX_BASE_URL: harness.baseUrl },
  });
  assert.equal(anonymous.code, 3);
  assert.match(anonymous.stderr, /HTTP_401/);
});

test("[capability:credential-storage] login stores credentials with 0600 permissions and masks them", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const configPath = await tempConfig();

  const login = await runCli(
    ["login", "--base-url", harness.baseUrl, "--token", OWNER_TOKEN, "--json"],
    { env: { CODERAX_CONFIG: configPath } },
  );
  assert.equal(login.code, 0, login.stderr);
  assert.equal(login.stdout.includes(OWNER_TOKEN), false);
  assert.equal(json(login).account, "owner@coderax.test");

  const stored = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(stored.token, OWNER_TOKEN);
  assert.equal(stored.baseUrl, harness.baseUrl);

  if (!IS_WINDOWS) {
    assert.equal((await stat(configPath)).mode & 0o777, 0o600, "config must be 0600");
    assert.equal((await stat(join(configPath, ".."))).mode & 0o777, 0o700, "config dir must be 0700");
  }

  const shown = await runCli(["config", "show", "--json"], { env: { CODERAX_CONFIG: configPath } });
  assert.equal(shown.code, 0);
  assert.equal(json(shown).tokenConfigured, true);
  assert.equal(shown.stdout.includes(OWNER_TOKEN), false);

  const status = await runCli(["status", "--json"], { env: { CODERAX_CONFIG: configPath } });
  assert.equal(status.code, 0);
  assert.equal(status.stdout.includes(OWNER_TOKEN), false);
  assert.equal(json(status).account, "owner@coderax.test");

  const logout = await runCli(["logout", "--json"], { env: { CODERAX_CONFIG: configPath } });
  assert.equal(logout.code, 0);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).token, null);
});

test("[capability:chat-streaming] chat streams over a real socket and redacts an echoed token", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const result = await runCli(["chat", "hello", "--json"], {
    env: { CODERAX_CONFIG: await tempConfig(), CODERAX_BASE_URL: harness.baseUrl, CODERAX_TOKEN: OWNER_TOKEN },
  });
  assert.equal(result.code, 0, result.stderr);
  const payload = json(result);
  assert.equal(payload.mode, "chat");
  assert.equal(payload.text, "hello from the owner [REDACTED]");
  assert.equal(payload.events, 2);
  assert.equal(result.stdout.includes(OWNER_TOKEN), false);
  assert.equal(result.stderr.includes(OWNER_TOKEN), false);
});

test("[capability:work-submission] work POSTs to the native route and consumes cumulative snapshots", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const result = await runCli(["work", "implement the fix", "--json"], {
    env: { CODERAX_CONFIG: await tempConfig(), CODERAX_BASE_URL: harness.baseUrl, CODERAX_TOKEN: OWNER_TOKEN },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(json(result).text, "accepted and verified");
  assert.equal(json(result).mode, "work");

  const posts = harness.requests.filter((entry) => entry.path === "/api/work/chat");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].method, "POST");
  assert.deepEqual(posts[0].body, { text: "implement the fix", mode: "work", endpoint: "agents" });
});

test("[capability:work-submission] a revised engine snapshot replaces earlier text", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const result = await runCli(["work", "revise the answer", "--json"], {
    env: { CODERAX_CONFIG: await tempConfig(), CODERAX_BASE_URL: harness.baseUrl, CODERAX_TOKEN: OWNER_TOKEN },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(json(result).text, "corrected answer");
});

test("[capability:stream-integrity] a dropped Work stream fails instead of reporting success", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const result = await runCli(["work", "disconnect now", "--json"], {
    env: { CODERAX_CONFIG: await tempConfig(), CODERAX_BASE_URL: harness.baseUrl, CODERAX_TOKEN: OWNER_TOKEN },
  });
  assert.equal(result.code, 4, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /STREAM_INCOMPLETE|REQUEST_FAILED/);
});

test("[capability:error-codes] HTTP and usage failures map to documented exit codes", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const env = {
    CODERAX_CONFIG: await tempConfig(),
    CODERAX_BASE_URL: harness.baseUrl,
    CODERAX_TOKEN: OWNER_TOKEN,
  };

  const notFound = await runCli(["call", "GET", "/api/missing"], { env });
  assert.equal(notFound.code, 5);
  assert.match(notFound.stderr, /HTTP_404/);

  const serverError = await runCli(["call", "GET", "/api/echo-error"], { env });
  assert.equal(serverError.code, 1);
  assert.match(serverError.stderr, /HTTP_500/);
  assert.equal(serverError.stderr.includes(OWNER_TOKEN), false);

  const timeout = await runCli(["call", "GET", "/api/slow", "--timeout", "100"], { env });
  assert.equal(timeout.code, 4);
  assert.match(timeout.stderr, /REQUEST_TIMEOUT/);

  const usage = await runCli(["call", "POST", "/api/agents", "--data", "not-json"], { env });
  assert.equal(usage.code, 2);

  const unavailable = await runCli(["cloud"], { env });
  assert.equal(unavailable.code, 6);
});

test("[capability:cancellation] SIGINT cancels an in-flight Work stream with exit 130", async (t) => {
  if (IS_WINDOWS) {
    t.skip("Windows cannot deliver SIGINT to a child process; the abort path is covered in test/client.test.js");
    return;
  }
  const harness = await startHarness();
  t.after(() => harness.close());

  const child = spawn(process.execPath, [CLI_PATH, "work", "slow run"], {
    env: cleanEnv({
      CODERAX_CONFIG: await tempConfig(),
      CODERAX_BASE_URL: harness.baseUrl,
      CODERAX_TOKEN: OWNER_TOKEN,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the stream never started")), 10000);
    child.stdout.on("data", () => {
      if (stdout.includes("accepted")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  child.kill("SIGINT");
  const [code, signal] = await Promise.race([
    once(child, "close"),
    new Promise((resolve) => setTimeout(() => resolve(["timeout", null]), 10000)),
  ]);
  if (code === "timeout") child.kill("SIGKILL");

  assert.equal(signal, null, "the CLI should exit normally after cancelling, not die by signal");
  assert.equal(code, 130, `stdout: ${stdout}\nstderr: ${stderr}`);
});

test("[harness:event-replay] the engine harness replays frames after Last-Event-ID", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const started = await fetch(`${harness.baseUrl}/api/work/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "replay me", mode: "work" }),
  });
  const text = await started.text();
  assert.equal(started.status, 200);
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.ok(ids.length >= 3, text);

  const replayed = await fetch(`${harness.baseUrl}/api/work/chat/stream-1/events`, {
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, "last-event-id": String(ids[0]) },
  });
  const replayText = await replayed.text();
  const replayIds = [...replayText.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(replayIds, ids.slice(1));
});

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
}
