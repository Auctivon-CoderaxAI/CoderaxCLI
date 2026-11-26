import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgv, runCli } from "../src/cli.js";
import { completionScript } from "../src/commands/completion.js";
import { COMMANDS } from "../src/commands/registry.js";
import { capture, optionsFor, tempDir, validAgents, validHealth } from "./helpers.js";

const TOKEN = "owner-token-0123456789";
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function env(extra = {}) {
  const dir = await tempDir();
  return {
    CODERAX_CONFIG_DIR: dir,
    CODERAX_CREDENTIAL_STORE: "file",
    ...extra,
  };
}

test("parseArgv accepts values, booleans, equals and a literal separator", () => {
  const parsed = parseArgv([
    "work", "run", "fix it",
    "--json", "--timeout=1000", "--engine-url", "https://engine.test",
    "--", "--not-a-flag",
  ]);
  assert.deepEqual(parsed.positionals, ["work", "run", "fix it", "--not-a-flag"]);
  assert.equal(parsed.flags.get("json"), true);
  assert.equal(parsed.flags.get("timeout"), "1000");
  assert.equal(parsed.flags.get("engine-url"), "https://engine.test");
});

test("parseArgv rejects unknown flags, missing values and short flags", () => {
  assert.throws(() => parseArgv(["--nope"]), /unknown option/);
  assert.throws(() => parseArgv(["--engine-url"]), /requires a value/);
  assert.throws(() => parseArgv(["-x"]), /unknown option/);
  assert.throws(() => parseArgv(["--json=yes"]), /does not take a value/);
});

test("help and version exit zero without a network", async () => {
  const io = capture();
  assert.equal(await runCli(["--help"], { env: {}, stdout: io.stdout, stderr: io.stderr }), 0);
  assert.match(io.out(), /Interactive Chat and Work/);
  assert.match(io.out(), /Exit codes/);
  io.clear();
  assert.equal(await runCli(["--version"], { env: {}, stdout: io.stdout, stderr: io.stderr }), 0);
  assert.match(io.out(), /coderax-cli 1\.0\.0/);
});

test("no arguments outside a terminal prints usage and succeeds", async () => {
  const io = capture();
  const code = await runCli([], { env: {}, stdout: io.stdout, stderr: io.stderr, stdinIsTTY: false });
  assert.equal(code, 0);
  assert.match(io.out(), /Usage:/);
});

test("an unknown command is a usage error and honors --json", async () => {
  const io = capture();
  const code = await runCli(["nope", "--json"], { env: {}, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 2);
  const doc = JSON.parse(io.out());
  assert.equal(doc.ok, false);
  assert.equal(doc.error.code, "USAGE");
  assert.equal(doc.error.exitCode, 2);
  assert.equal(io.err(), "");
});

test("a usage error before runtime still honors --json", async () => {
  const io = capture();
  const code = await runCli(["--json", "--unknown"], { env: {}, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 2);
  assert.equal(JSON.parse(io.out()).error.code, "USAGE");
});

test("config show works before any URL is configured", async () => {
  const io = capture();
  const code = await runCli(["config", "show", "--json"], optionsFor(await env(), io));
  assert.equal(code, 0);
  const data = JSON.parse(io.out()).data;
  assert.equal(data.baseUrl, null);
  assert.equal(data.engineUrl, null);
  assert.equal(data.tokenConfigured, false);
});

test("config set and get use the key/value and flag forms", async () => {
  const environment = await env();
  const io = capture();
  assert.equal(await runCli(["config", "set", "engine-url", "https://engine.test"], optionsFor(environment, io)), 0);
  assert.equal(await runCli(["config", "set", "--model", "p/m"], optionsFor(environment, io)), 0);
  io.clear();
  assert.equal(await runCli(["config", "get", "model", "--json"], optionsFor(environment, io)), 0);
  assert.equal(JSON.parse(io.out()).data.value, "p/m");
  const stored = JSON.parse(await readFile(join(environment.CODERAX_CONFIG_DIR, "config.json"), "utf8"));
  assert.equal(stored.engineUrl, "https://engine.test");
  assert.equal(stored.model, "p/m");
});

test("config rejects an owner token, inherited keys and insecure remote URLs", async () => {
  for (const argv of [
    ["config", "set", "--token", TOKEN],
    ["config", "set", "constructor", "x"],
    ["config", "get", "toString"],
    ["config", "set", "engine-url", "http://remote.example"],
  ]) {
    const io = capture();
    const code = await runCli(argv, optionsFor(await env(), io));
    assert.equal(code, 2, argv.join(" "));
  }
});

test("completion scripts cover every top-level command", () => {
  const bash = completionScript("bash");
  const zsh = completionScript("zsh");
  const fish = completionScript("fish");
  for (const script of [bash, zsh, fish]) {
    for (const command of COMMANDS) {
      assert.ok(script.includes(command), `${command} missing from completion`);
    }
  }
  assert.throws(() => completionScript("powershell"), /completion requires/);
});

test("login verifies the owner against the engine and never prints the token", async () => {
  const io = capture();
  const environment = await env();
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/health") {
      return new Response(JSON.stringify(validHealth()), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/agents") {
      return new Response(JSON.stringify(validAgents()), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
  const code = await runCli(
    ["login", "--engine-url", "https://engine.test", "--token", TOKEN, "--json"],
    {
      ...optionsFor(environment, io),
      fetchImpl,
      stdinIsTTY: true,
      credentialStore: {
        async read() { return null; },
        async write() { return { kind: "memory" }; },
        async delete() { return { backendRemoved: false, fileRemoved: false }; },
        describe() { return { requested: "memory", backend: "memory", path: null, warning: null }; },
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(io.out().includes(TOKEN), false);
  const data = JSON.parse(io.out()).data;
  assert.equal(data.authenticated, true);
  assert.deepEqual(data.agents, ["coderax"]);
  assert.equal(data.contractVersion, "1.0.0");
  const stored = JSON.parse(await readFile(join(environment.CODERAX_CONFIG_DIR, "config.json"), "utf8"));
  assert.equal(stored.engineUrl, "https://engine.test");
  assert.equal(JSON.stringify(stored).includes(TOKEN), false);
});

test("status masks an environment token and reports no engine as unauthenticated-safe", async () => {
  const io = capture();
  const code = await runCli(["status", "--json"], optionsFor(await env({ CODERAX_ENGINE_TOKEN: TOKEN }), io));
  assert.equal(code, 0);
  const data = JSON.parse(io.out()).data;
  assert.equal(data.authenticated, true);
  assert.equal(data.token.masked.includes(TOKEN), false);
  assert.equal(io.out().includes(TOKEN), false);
});

test("a command that needs the engine exits 2 without a URL", async () => {
  const io = capture();
  const code = await runCli(["agents", "--json"], optionsFor(await env(), io));
  assert.equal(code, 2);
  assert.equal(JSON.parse(io.out()).error.code, "ENGINE_URL_REQUIRED");
});

test("call validates method and JSON before making a request", async () => {
  const environment = await env();
  for (const argv of [
    ["call", "TRACE", "/v1/x"],
    ["call", "GET", "/v1/x", "--data", "{}"],
    ["call", "POST", "/v1/x", "--data", "not-json"],
    ["call", "GET"],
  ]) {
    const io = capture();
    const code = await runCli(argv, optionsFor(environment, io));
    assert.equal(code, 2, argv.join(" "));
  }
});

test("the packaged entrypoint reaches runCli", () => {
  const result = spawnSync(process.execPath, [CLI_PATH, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /coderax-cli 1\.0\.0/);
});

test("doctor reports missing configuration without crashing", async () => {
  const io = capture();
  const code = await runCli(["doctor", "--json"], optionsFor(await env(), io));
  assert.equal(code, 1);
  const data = JSON.parse(io.out()).data;
  assert.equal(data.ok, false);
  assert.ok(data.checks.some((check) => check.name === "engine"));
});
