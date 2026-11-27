import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startFixtureEngine } from "./fixtures/engine-server.js";
import { runCli } from "../src/cli.js";
import { capture, tempDir } from "./helpers.js";

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${message}`);
}

async function interactive(env, lines) {
  const input = new PassThrough();
  input.isTTY = false;
  const out = capture();
  const options = {
    env,
    stdin: input,
    stdinIsTTY: true,
    stdout: out.stdout,
    stderr: out.stderr,
    stdoutStream: { isTTY: false, columns: 100, write: (text) => out.stdout(text) },
    stderrStream: { isTTY: false, write: (text) => out.stderr(text) },
    handleSignals: false,
  };
  const promise = runCli([], options);
  for (const { line, wait } of lines) {
    input.write(`${line}\n`);
    if (wait) await waitFor(() => out.out().includes(wait), wait);
  }
  const code = await promise;
  return { code, out: out.out(), err: out.err() };
}

test("the interactive terminal starts, completes commands and exits cleanly", async () => {
  const engine = await startFixtureEngine();
  try {
    const env = {
      CODERAX_ENGINE_URL: engine.url,
      CODERAX_ENGINE_TOKEN: engine.token,
      CODERAX_CONFIG_DIR: await tempDir(),
      CODERAX_CREDENTIAL_STORE: "file",
    };
    const { code, out, err } = await interactive(env, [
      { line: "/help", wait: "Chat and Work" },
      { line: "/mode work", wait: "mode: work" },
      { line: "/templates", wait: "TEMPLATE" },
      { line: "/exit" },
    ]);
    assert.equal(code, 0, err);
    assert.match(out, /Coderax CLI 1\.0\.0/);
    assert.match(out, /Chat and Work/);
    assert.match(out, /mode: work/);
    assert.match(out, /TEMPLATE/);
    assert.equal(out.includes("owner-token"), false);
  } finally {
    await engine.close();
  }
});

test("an interactive Work submission streams to completion and updates the session", async () => {
  const engine = await startFixtureEngine();
  try {
    const env = {
      CODERAX_ENGINE_URL: engine.url,
      CODERAX_ENGINE_TOKEN: engine.token,
      CODERAX_CONFIG_DIR: await tempDir(),
      CODERAX_CREDENTIAL_STORE: "file",
    };
    const { code, out, err } = await interactive(env, [
      { line: "/mode work", wait: "mode: work" },
      { line: "Inspect the repository", wait: "completed in" },
      { line: "/exit", wait: "work ›" },
    ]);
    assert.equal(code, 0, err);
    assert.match(out, /completed in/);
    assert.match(out, /Inspect the cloud workspace/);
    assert.equal(engine.tasks.size, 1);
    const [task] = engine.tasks.values();
    const persisted = JSON.parse(await readFile(join(env.CODERAX_CONFIG_DIR, "state.json"), "utf8"));
    assert.equal(persisted.active.workConversationId, task.conversationId);
  } finally {
    await engine.close();
  }
});
