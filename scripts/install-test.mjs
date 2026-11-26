#!/usr/bin/env node
/**
 * Automated installation test.
 *
 * Runs against the real release artifacts, not a source checkout:
 *   1. verifies the artifacts and checksums,
 *   2. installs the standalone build with the platform installer,
 *   3. runs the installed launcher (version, help, doctor),
 *   4. authenticates against a stub Coderax WorkflowEngine and makes
 *      authenticated calls (login, status, health, compat, agents, doctor),
 *   5. checks the compatibility boundaries with stub engines below, inside,
 *      and above the supported range,
 *   6. installs the npm tarball into a scratch project and imports the public
 *      SDK surface through the package exports map,
 *   7. uninstalls and verifies that program and user data are gone.
 *
 * The stub server implements the documented contract (OpenAPI document,
 * bearer auth, /api/user, /api/agents, Work SSE). It is not a live Coderax
 * deployment; see docs/COMPATIBILITY.md for exactly what that evidence covers.
 */
import assert from "node:assert/strict";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const IS_WINDOWS = process.platform === "win32";
const TOKEN = "install-test-token-9f3a";

const manifest = JSON.parse(await readFile(join(DIST, "release-manifest.json"), "utf8"));
const VERSION = manifest.version;
const NPM_TARBALL = join(DIST, `coderax-cli-${VERSION}.tgz`);
const TARBALL = join(DIST, `coderax-cli-${VERSION}-standalone.tar.gz`);
const tarballRecord = manifest.artifacts.find((artifact) => artifact.name.endsWith("-standalone.tar.gz"));
assert.ok(tarballRecord, "the manifest must list the standalone tarball");

const results = [];
const transcript = [];

function take(result) {
  transcript.push(result.stdout ?? "", result.stderr ?? "");
  return result;
}

function tail(result) {
  return `${(result.stderr ?? "").trim()}\n${(result.stdout ?? "").trim()}`.trim().slice(-1200);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "", ms: Date.now() - started });
    console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
    return true;
  } catch (error) {
    results.push({ name, ok: false, detail: error.message, ms: Date.now() - started });
    console.error(`  x   ${name}\n      ${error.message.split("\n").join("\n      ")}`);
    throw error;
  }
}

function spawn(command, args, options) {
  return take(spawnSync(command, args, { encoding: "utf8", ...options }));
}

const sandbox = await mkdtemp(join(tmpdir(), "coderax-install-test-"));
const prefix = join(sandbox, "prefix");
const binDir = join(sandbox, "bin");
const home = join(sandbox, "home");
const configPath = join(sandbox, "coderax", "config.json");
await mkdir(home, { recursive: true });

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CODERAX_CONFIG: configPath,
  CODERAX_PREFIX: prefix,
  CODERAX_BIN_DIR: binDir,
  CI: "1",
  NO_COLOR: "1",
};

const launcher = join(binDir, IS_WINDOWS ? "coderax.cmd" : "coderax");

// With shell: true, cmd.exe needs the executable quoted if the temp path
// contains spaces (a Windows user profile can).
const commandPath = (path) => (IS_WINDOWS ? `"${path}"` : path);

/**
 * Run the installed launcher without blocking the event loop: the stub engine
 * lives in this process, so a synchronous spawn would deadlock it.
 */
function cli(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(commandPath(launcher), args, {
      env: { ...env, ...extraEnv },
      // Batch files need a shell on Windows; the argument set contains no spaces.
      shell: IS_WINDOWS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      transcript.push(stdout, stderr);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function installer(extra = []) {
  const args = [
    "--version", VERSION,
    "--from-file", TARBALL,
    "--checksum", tarballRecord.sha256,
    "--prefix", prefix,
    "--bin-dir", binDir,
    ...extra,
  ];
  if (IS_WINDOWS) {
    return spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts", "install.ps1"),
      "-Version", VERSION,
      "-FromFile", TARBALL,
      "-Checksum", tarballRecord.sha256,
      "-Prefix", prefix,
      "-BinDir", binDir,
      ...extra.map((value) => (value === "--force" ? "-Force" : value)),
    ], { env });
  }
  return spawn("sh", [join(ROOT, "scripts", "install.sh"), ...args], { env });
}

function uninstaller(extra = []) {
  if (IS_WINDOWS) {
    return spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts", "uninstall.ps1"),
      "-Prefix", prefix,
      "-BinDir", binDir,
      "-Yes",
      "-Purge",
      ...extra,
    ], { env });
  }
  return spawn("sh", [join(ROOT, "scripts", "uninstall.sh"), "--prefix", prefix, "--bin-dir", binDir, "--yes", "--purge", ...extra], { env });
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withEngine(version, run) {
  const authorization = `Bearer ${TOKEN}`;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const authenticated = req.headers.authorization === authorization;
    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === "/health") {
      const payload = { status: "ok", service: "coderax" };
      if (version !== null) payload.workflowEngine = { version };
      return json(200, payload);
    }
    if (url.pathname === "/api/user") {
      return authenticated ? json(200, { email: "release-ci@coderax.test" }) : json(401, { message: "unauthorized" });
    }
    if (url.pathname === "/api/agents") {
      return authenticated ? json(200, { agents: [{ id: "agent-1", name: "Reviewer" }] }) : json(401, { message: "unauthorized" });
    }
    if (url.pathname === "/openapi.json") {
      if (version === null) return json(404, { message: "not found" });
      return json(200, {
        openapi: "3.1.0",
        info: { title: "Coderax WorkflowEngine", version },
        paths: {
          "/api/agents": { get: { operationId: "listAgents", summary: "List agents" } },
          "/api/user": { get: { operationId: "currentUser" } },
        },
      });
    }
    if (url.pathname === "/api/work/chat") {
      if (!authenticated) return json(401, { message: "unauthorized" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write('data: {"created":true,"streamId":"work-1"}\n\n');
      res.write('data: {"message":true,"text":"installed"}\n\n');
      res.write('data: {"message":true,"text":"installed and authenticated"}\n\n');
      res.write('data: {"final":true,"responseMessage":{"text":"installed and authenticated"}}\n\n');
      res.end();
      return undefined;
    }
    return json(404, { message: "not found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

let failure = null;
try {
  await step("release artifacts verify", async () => {
    const result = spawn(process.execPath, [join(ROOT, "scripts", "verify-release.mjs")], { cwd: ROOT });
    assert.equal(result.status, 0, tail(result));
    return "checksums and archive contents match the manifest";
  });

  await step("installer rejects an unknown Node-only flag safely", async () => {
    const result = IS_WINDOWS
      ? spawn("powershell.exe", ["-NoProfile", "-File", join(ROOT, "scripts", "install.ps1"), "-NotAFlag"], { env })
      : spawn("sh", [join(ROOT, "scripts", "install.sh"), "--not-a-flag"], { env });
    assert.notEqual(result.status, 0, "an unknown flag must fail");
    return "exit code is non-zero";
  });

  await step("install from the release artifact (checksum verified)", async () => {
    const result = installer();
    assert.equal(result.status, 0, tail(result));
    assert.ok(existsSync(launcher), `launcher missing at ${launcher}`);
    assert.ok(existsSync(join(prefix, VERSION, "src", "cli.js")), "installed sources are missing");
    assert.ok(existsSync(join(prefix, VERSION, "uninstall.sh")), "the offline uninstaller is missing");
    return `${prefix}/${VERSION}`;
  });

  await step("launcher reports the released version", async () => {
    const result = await cli(["--version"]);
    assert.equal(result.status, 0, tail(result));
    assert.equal(result.stdout.trim(), `coderax-cli ${VERSION}`);
    return result.stdout.trim();
  });

  await step("version diagnostics identify a standalone install", async () => {
    const result = await cli(["version", "--json"]);
    assert.equal(result.status, 0, tail(result));
    const info = JSON.parse(result.stdout);
    assert.equal(info.cliVersion, VERSION);
    assert.equal(info.installMethod, "standalone");
    assert.equal(info.nodeSupported, true);
    assert.match(info.supportedWorkflowEngine, /^>=0\.8\.0 <1\.0\.0$/);
    assert.equal(info.installPath, join(prefix, VERSION));
    return `${info.cliVersion} on node ${info.node} (${info.platform}-${info.arch})`;
  });

  await step("help works without configuration", async () => {
    const result = await cli(["--help"]);
    assert.equal(result.status, 0, tail(result));
    assert.match(result.stdout, /coderax config set/);
    return "usage text rendered";
  });

  await step("doctor is useful before configuration", async () => {
    const result = await cli(["doctor", "--json"]);
    assert.equal(result.status, 1, "doctor must fail while unauthenticated");
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    for (const name of ["node", "install", "config-dir"]) {
      assert.equal(report.checks.find((check) => check.name === name)?.ok, true, `${name} check failed`);
    }
    return "node and install checks pass; auth is correctly reported missing";
  });

  await step("authenticated communication with a compatible WorkflowEngine (0.8.8)", async () => {
    return withEngine("0.8.8", async (baseUrl) => {
      const login = await cli(["login", "--base-url", baseUrl, "--token", TOKEN, "--json"]);
      assert.equal(login.status, 0, tail(login));
      assert.equal(JSON.parse(login.stdout).authenticated, true);

      const status = await cli(["status", "--json"]);
      assert.equal(status.status, 0, tail(status));
      const reported = JSON.parse(status.stdout);
      assert.equal(reported.authenticated, true);
      assert.notEqual(reported.token, TOKEN, "status must never print the raw token");

      const health = await cli(["health", "--json"]);
      assert.equal(health.status, 0, tail(health));
      assert.equal(JSON.parse(health.stdout).status, 200);

      const compat = await cli(["compat", "--json"]);
      assert.equal(compat.status, 0, tail(compat));
      const verdict = JSON.parse(compat.stdout);
      assert.equal(verdict.supported, true);
      assert.equal(verdict.engineVersion, "0.8.8");

      const agents = await cli(["agents", "--json"]);
      assert.equal(agents.status, 0, tail(agents));
      assert.equal(JSON.parse(agents.stdout).body.agents[0].id, "agent-1");

      const doctor = await cli(["doctor", "--json"]);
      assert.equal(doctor.status, 0, tail(doctor));
      assert.equal(JSON.parse(doctor.stdout).ok, true);
      return "login, status, health, compat, agents and doctor all succeeded with bearer auth";
    });
  });

  await step("engine compatibility boundaries (0.7.9 / 0.8.0 / 0.9.5 / 1.0.0)", async () => {
    const expectations = [
      ["0.7.9", 1, false],
      ["0.8.0", 0, true],
      ["0.9.5", 0, true],
      ["1.0.0", 1, false],
    ];
    for (const [engine, code, supported] of expectations) {
      await withEngine(engine, async (baseUrl) => {
        const result = await cli(["compat", "--base-url", baseUrl, "--json"]);
        assert.equal(result.status, code, `engine ${engine}: ${tail(result)}`);
        assert.equal(JSON.parse(result.stdout).supported, supported, `engine ${engine} verdict`);
      });
    }
    return "below, inside, and above the declared range behave as documented";
  });

  await step("an engine that reports no version is reported as unknown", async () => {
    return withEngine(null, async (baseUrl) => {
      const result = await cli(["compat", "--base-url", baseUrl, "--json"]);
      assert.equal(result.status, 1, tail(result));
      const verdict = JSON.parse(result.stdout);
      assert.equal(verdict.supported, null);
      assert.match(verdict.reason, /did not report/);
      return "unknown is distinct from incompatible";
    });
  });

  await step("Work SSE streaming through the installed launcher", async () => {
    return withEngine("0.8.8", async (baseUrl) => {
      const result = await cli(["work", "verify installation", "--base-url", baseUrl, "--json"]);
      assert.equal(result.status, 0, tail(result));
      assert.equal(JSON.parse(result.stdout).text, "installed and authenticated");
      return "cumulative snapshots assembled without duplication";
    });
  });

  await step("npm tarball exposes the SDK surface and the bin entrypoint", async () => {
    const project = join(sandbox, "sdk-project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "sdk-check", private: true, type: "module" }, null, 2)}\n`);
    const npm = IS_WINDOWS ? "npm.cmd" : "npm";
    const install = spawn(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline", NPM_TARBALL], {
      cwd: project,
      env,
      shell: IS_WINDOWS,
    });
    assert.equal(install.status, 0, tail(install));

    const script = join(project, "check.mjs");
    await writeFile(script, `
import assert from "node:assert/strict";
const sdk = await import("coderax-cli");
const compat = await import("coderax-cli/compat");
const version = await import("coderax-cli/version");
const diagnostics = await import("coderax-cli/diagnostics");
assert.equal(typeof sdk.runCli, "function");
assert.equal(typeof compat.isSupportedEngineVersion, "function");
assert.equal(version.VERSION, ${JSON.stringify(VERSION)});
assert.equal(diagnostics.detectInstallMethod(), "npm-local");
console.log(version.VERSION);
`);
    const check = spawn(process.execPath, [script], { cwd: project, env });
    assert.equal(check.status, 0, tail(check));
    assert.equal(check.stdout.trim(), VERSION);

    const bin = join(project, "node_modules", ".bin", IS_WINDOWS ? "coderax.cmd" : "coderax");
    assert.ok(existsSync(bin), "npm did not link the coderax executable");
    const binCheck = spawn(commandPath(bin), ["--version"], { cwd: project, env, shell: IS_WINDOWS });
    assert.equal(binCheck.status, 0, tail(binCheck));
    assert.equal(binCheck.stdout.trim(), `coderax-cli ${VERSION}`);
    return "exports map, version module, install detection and npm bin all work";
  });

  await step("npm global install creates a working launcher", async () => {
    const globalPrefix = join(sandbox, "npm-global");
    const npm = IS_WINDOWS ? "npm.cmd" : "npm";
    const install = spawn(npm, [
      "install", "--global", "--prefix", globalPrefix,
      "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline", NPM_TARBALL,
    ], { cwd: sandbox, env, shell: IS_WINDOWS });
    assert.equal(install.status, 0, tail(install));

    const bin = IS_WINDOWS
      ? join(globalPrefix, "coderax.cmd")
      : join(globalPrefix, "bin", "coderax");
    assert.ok(existsSync(bin), `npm did not create a global launcher at ${bin}`);

    const version = spawn(commandPath(bin), ["--version"], { env, shell: IS_WINDOWS });
    assert.equal(version.status, 0, tail(version));
    assert.equal(version.stdout.trim(), `coderax-cli ${VERSION}`);

    const info = spawn(commandPath(bin), ["version", "--json"], { env, shell: IS_WINDOWS });
    assert.equal(info.status, 0, tail(info));
    assert.equal(JSON.parse(info.stdout).installMethod, "npm-global");
    return "global shim runs and reports the npm-global install method";
  });

  await step("reinstalling the same version is refused; --force upgrades in place", async () => {
    const again = installer();
    assert.equal(again.status, 1, "a second install of the same version must be refused");
    const forced = installer(["--force"]);
    assert.equal(forced.status, 0, tail(forced));
    const version = await cli(["--version"]);
    assert.equal(version.stdout.trim(), `coderax-cli ${VERSION}`);
    return "idempotency guard and in-place replacement both verified";
  });

  await step("no credential leaked into any command output", async () => {
    const combined = transcript.join("\n");
    assert.equal(combined.includes(TOKEN), false, "the bearer token appeared in CLI output");
    return `${transcript.join("\n").length} bytes of output scanned`;
  });

  await step("uninstall removes the program, launcher, and user data", async () => {
    assert.ok(await pathExists(configPath), "login should have written a config file");
    const result = uninstaller();
    assert.equal(result.status, 0, tail(result));
    assert.equal(await pathExists(launcher), false, "launcher still exists");
    assert.equal(await pathExists(join(prefix, VERSION)), false, "program directory still exists");
    assert.equal(await pathExists(configPath), false, "config was not purged");
    return "launcher, program directory, and credentials removed";
  });

  console.log(`\ncoderax install-test: PASS (${results.length} checks on ${process.platform}-${process.arch}, node ${process.versions.node})`);
} catch (error) {
  failure = error;
  console.error(`\ncoderax install-test: FAIL after ${results.length} checks`);
} finally {
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    release: { name: manifest.name, version: manifest.version, commit: manifest.commit },
    workflowEngineRange: manifest.supportedWorkflowEngine,
    checks: results,
  };
  const evidencePath = process.argv.includes("--evidence")
    ? process.argv[process.argv.indexOf("--evidence") + 1]
    : join(DIST, "install-evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`evidence: ${evidencePath}`);
  if (!process.argv.includes("--keep")) await rm(sandbox, { recursive: true, force: true });
  else console.log(`sandbox kept: ${sandbox}`);
}

if (failure) process.exit(1);
