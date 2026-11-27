import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv, runCli } from "../src/legacy-cli.js";

async function tempConfig() {
  const dir = await mkdtemp(join(tmpdir(), "coderax-interactive-cli-"));
  return join(dir, "config.json");
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

test("boolean interactive flags do not consume the following option", () => {
  const { flags, positionals } = parseArgv([
    "chat",
    "--interactive",
    "--accessible",
    "--no-history",
    "--agent",
    "reviewer",
    "--resume",
    "--json",
  ]);
  assert.deepEqual(positionals, ["chat"]);
  assert.equal(flags.get("interactive"), true);
  assert.equal(flags.get("accessible"), true);
  assert.equal(flags.get("no-history"), true);
  assert.equal(flags.get("agent"), "reviewer");
  assert.equal(flags.get("resume"), true);
  assert.equal(flags.get("json"), true);
});

test("the interactive runner receives settings, mode and accessibility", async () => {
  let received = null;
  const env = {
    CODERAX_CONFIG: await tempConfig(),
    CODERAX_BASE_URL: "https://coderax.test",
    CODERAX_TOKEN: "token",
  };
  const code = await runCli(["work", "--accessible", "--resume", "c1", "--no-history"], {
    env,
    stdout: () => {},
    stderr: () => {},
    stdinIsTTY: true,
    interactiveRunner: async (options) => {
      received = options;
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(received.mode, "work");
  assert.equal(received.accessible, true);
  assert.equal(received.noHistory, true);
  assert.equal(received.resume, "c1");
  assert.equal(received.settings.baseUrl, "https://coderax.test");
});

test("interactive mode rejects prompts, --json and non-TTY stdin", async () => {
  const env = { CODERAX_CONFIG: await tempConfig(), CODERAX_BASE_URL: "https://coderax.test", CODERAX_TOKEN: "t" };
  for (const invocation of [
    ["chat", "--interactive", "hello"],
    ["chat", "--interactive", "--json"],
  ]) {
    const io = capture();
    const code = await runCli(invocation, {
      env,
      stdout: io.stdout,
      stderr: io.stderr,
      stdinIsTTY: true,
      interactiveRunner: async () => 0,
    });
    assert.equal(code, 2, invocation.join(" "));
    assert.match(io.err(), /start a terminal session/);
  }

  const io = capture();
  const code = await runCli(["chat", "--interactive"], {
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: false,
    interactiveRunner: async () => 0,
  });
  assert.equal(code, 2);
});

test("--resume is rejected outside interactive mode", async () => {
  const io = capture();
  const code = await runCli(["chat", "hello", "--resume", "c1"], {
    env: { CODERAX_CONFIG: await tempConfig(), CODERAX_BASE_URL: "https://coderax.test", CODERAX_TOKEN: "t" },
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: true,
  });
  assert.equal(code, 2);
});

test("config stores the agent and history preferences", async () => {
  const file = await tempConfig();
  const io = capture();
  assert.equal(
    await runCli(["config", "set", "--agent", "reviewer"], {
      env: { CODERAX_CONFIG: file },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
    0,
  );
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.agent, "reviewer");

  const getIo = capture();
  assert.equal(
    await runCli(["config", "get", "agent"], {
      env: { CODERAX_CONFIG: file },
      stdout: getIo.stdout,
      stderr: getIo.stderr,
    }),
    0,
  );
  assert.match(getIo.out(), /reviewer/);
});

test("history can be listed, disabled, re-enabled and given a retention", async () => {
  const file = await tempConfig();
  const env = { CODERAX_CONFIG: file };

  const list = capture();
  assert.equal(await runCli(["history", "list", "--json"], { env, stdout: list.stdout, stderr: list.stderr }), 0);
  assert.equal(JSON.parse(list.out()).history.enabled, true);

  const off = capture();
  assert.equal(await runCli(["history", "off", "--json"], { env, stdout: off.stdout, stderr: off.stderr }), 0);
  assert.equal(JSON.parse(await readFile(file, "utf8")).history.enabled, false);

  const retention = capture();
  assert.equal(
    await runCli(["history", "retention", "7", "--json"], { env, stdout: retention.stdout, stderr: retention.stderr }),
    0,
  );
  assert.equal(JSON.parse(await readFile(file, "utf8")).history.retentionDays, 7);

  const on = capture();
  assert.equal(await runCli(["history", "on", "--json"], { env, stdout: on.stdout, stderr: on.stderr }), 0);
  assert.equal(JSON.parse(await readFile(file, "utf8")).history.enabled, true);

  const clear = capture();
  assert.equal(await runCli(["history", "clear", "--json"], { env, stdout: clear.stdout, stderr: clear.stderr }), 0);
  assert.equal(JSON.parse(clear.out()).cleared, true);
});

test("history usage errors are caught before any local write", async () => {
  const io = capture();
  const code = await runCli(["history", "retention", "nope"], {
    env: { CODERAX_CONFIG: await tempConfig() },
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 2);
  assert.match(io.err(), /number of days/);
});

test("doctor reports history and terminal checks", async () => {
  const file = await tempConfig();
  const io = capture();
  assert.equal(
    await runCli(["doctor", "--json"], {
      env: { CODERAX_CONFIG: file },
      stdout: io.stdout,
      stderr: io.stderr,
    }),
    1,
  );
  const checks = JSON.parse(io.out()).checks;
  assert.ok(checks.some((check) => check.name === "history"));
  assert.ok(checks.some((check) => check.name === "terminal"));
});
