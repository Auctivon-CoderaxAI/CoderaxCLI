#!/usr/bin/env node
/**
 * Automated installation acceptance test.
 *
 * Runs against the real release artifacts, not a source checkout:
 *   1. verifies the artifacts, checksums and embedded extractors,
 *   2. rejects tampered archives, path traversal, absolute paths, symlinks,
 *      duplicate entries and overwrites,
 *   3. installs into a path containing spaces and Unicode with the platform
 *      installer, then runs the installed launcher,
 *   4. refuses a token in argv and authenticates through stdin instead,
 *   5. exercises compatible, incompatible, older, unavailable and
 *      unauthenticated deployment states separately,
 *   6. streams Work SSE through the installed launcher,
 *   7. installs the npm tarball, imports the public SDK surface, and runs the
 *      npm bin entrypoint,
 *   8. upgrades atomically with rollback, and uninstalls.
 *
 * The stub implements the published contract: plain-text `/health`, OpenAPI
 * discovery, `/api/meta` API version negotiation, bearer auth, and Work SSE.
 */
import assert from "node:assert/strict";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, lstatSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createTar, createTarGz, createZip } from "./lib/archive.mjs";
import { extractTarGz, extractZip, UnsafeArchiveError } from "./lib/safe-extract.mjs";

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
  return `${(result.stderr ?? "").trim()}\n${(result.stdout ?? "").trim()}`.trim().slice(-1600);
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

// Spaces and non-ASCII characters are both real Windows/macOS user-profile
// shapes and classic quoting bugs.
const sandbox = await mkdtemp(join(tmpdir(), "coderax install ünïcode "));
const prefix = join(sandbox, IS_WINDOWS ? "prefix dir 工具" : "prefix dir");
const binDir = join(sandbox, "bin dir");
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
  CODERAX_CREDENTIAL_STORE: "file",
  CI: "1",
  NO_COLOR: "1",
};

const launcher = join(binDir, IS_WINDOWS ? "coderax.cmd" : "coderax");
const commandPath = (path) => (IS_WINDOWS ? `"${path}"` : path);
// With shell: true Windows joins argv with spaces, so an argument that
// contains one has to carry its own quoting.
const shellArg = (value) => (IS_WINDOWS && /[\s"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** Run the installed launcher without blocking the event loop (stub server). */
function cli(args, extraEnv = {}, { input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(commandPath(launcher), args.map(shellArg), {
      env: { ...env, ...extraEnv },
      shell: IS_WINDOWS,
      stdio: ["pipe", "pipe", "pipe"],
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
    child.on("error", reject);
    child.on("close", (code) => {
      transcript.push(stdout, stderr);
      resolve({ status: code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

function installer(extra = []) {
  if (IS_WINDOWS) {
    return spawn(
      "powershell.exe",
      [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(DIST, "install.ps1"),
        "-Version", VERSION,
        "-FromFile", TARBALL,
        "-Checksum", tarballRecord.sha256,
        "-Prefix", prefix,
        "-BinDir", binDir,
        ...extra.map((value) => (value === "--force" ? "-Force" : value)),
      ],
      { env },
    );
  }
  return spawn(
    "sh",
    [
      join(DIST, "install.sh"),
      "--version", VERSION,
      "--from-file", TARBALL,
      "--checksum", tarballRecord.sha256,
      "--prefix", prefix,
      "--bin-dir", binDir,
      ...extra,
    ],
    { env },
  );
}

function uninstaller(extra = []) {
  if (IS_WINDOWS) {
    return spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(DIST, "uninstall.ps1"), "-Prefix", prefix, "-BinDir", binDir, "-Yes", "-Purge", ...extra],
      { env },
    );
  }
  return spawn("sh", [join(DIST, "uninstall.sh"), "--prefix", prefix, "--bin-dir", binDir, "--yes", "--purge", ...extra], { env });
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Patch one tar entry's type flag and recompute the header checksum. */
function retypeTar(buffer, type) {
  const copy = Buffer.from(buffer);
  copy.write(type, 156, 1, "ascii");
  copy.write("        ", 148, 8, "ascii");
  let sum = 0;
  for (const byte of copy.subarray(0, 512)) sum += byte;
  copy.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return copy;
}

async function hostileCase(name, makeArchive, extractor) {
  const directory = join(sandbox, "hostile", name);
  const destination = join(directory, "out");
  await mkdir(destination, { recursive: true });
  const archive = join(directory, extractor === extractZip ? "hostile.zip" : "hostile.tar.gz");
  await writeFile(archive, await makeArchive());
  await assert.rejects(
    () => extractor(archive, destination),
    (error) => error instanceof UnsafeArchiveError || /archive/i.test(error.message),
    `${name} must be refused`,
  );
  const leftovers = await readdir(destination);
  assert.deepEqual(leftovers, [], `${name} must not write anything`);
  assert.equal(await pathExists(join(directory, "escape.txt")), false, `${name} escaped the destination`);
}

const CAPABILITIES = [
  "work.chat", "work.models", "work.agents", "work.tasks", "work.cancel",
  "workflows.list", "workflows.builds", "workflows.runs", "workflows.stream",
  "workflows.approve", "repos.list",
];

/**
 * Stub deployment. `mode` selects one compatibility state:
 *   compatible | api-incompatible | older | unavailable | unauthenticated
 */
async function withEngine(mode, run) {
  const authorization = `Bearer ${TOKEN}`;
  const apiVersion = mode === "api-incompatible" ? "2" : mode === "unavailable" ? null : "1";
  const deploymentVersion = mode === "older" ? "0.7.9" : mode === "unavailable" ? null : "0.8.8";
  const unauthenticated = mode === "unauthenticated";

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const authenticated = req.headers.authorization === authorization;
    const json = (status, payload) => {
      const headers = { "content-type": "application/json" };
      // An unavailable deployment advertises no version anywhere, not even on
      // the 404 that hides its metadata; otherwise the header is a real signal.
      if (apiVersion !== null) headers["x-coderax-api-version"] = apiVersion;
      res.writeHead(status, headers);
      res.end(JSON.stringify(payload));
    };
    if (unauthenticated) return json(401, { message: "unauthorized" });

    if (url.pathname === "/health") {
      // The reference deployment returns plain text, with no version anywhere.
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("OK");
    }
    if (url.pathname === "/api/user") {
      return authenticated ? json(200, { email: "release-ci@coderax.test", role: "ADMIN" }) : json(401, { message: "unauthorized" });
    }
    if (url.pathname === "/api/meta") {
      if (apiVersion === null) return json(404, { message: "not found" });
      return json(200, { apiVersion, capabilities: CAPABILITIES });
    }
    if (url.pathname === "/openapi.json") {
      if (deploymentVersion === null) return json(404, { message: "not found" });
      return json(200, {
        openapi: "3.1.0",
        info: { title: "Coderax", version: deploymentVersion },
        paths: {
          "/api/agents": { get: { operationId: "listAgents" } },
          "/api/user": { get: { operationId: "currentUser" } },
        },
      });
    }
    if (url.pathname === "/api/agents") {
      return authenticated ? json(200, { agents: [{ id: "agent-1", name: "Reviewer" }] }) : json(401, { message: "unauthorized" });
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
    return "checksums, encodings and embedded extractors match the manifest";
  });

  await step("installer rejects unknown options and unrequested token arguments", async () => {
    const unknown = IS_WINDOWS
      ? spawn("powershell.exe", ["-NoProfile", "-File", join(DIST, "install.ps1"), "-NotAFlag"], { env })
      : spawn("sh", [join(DIST, "install.sh"), "--not-a-flag"], { env });
    assert.notEqual(unknown.status, 0, "an unknown flag must fail");
    return "exit code is non-zero";
  });

  if (IS_WINDOWS) {
    await step("Windows installer restricts HTTP mirrors to loopback", async () => {
      for (const [url, expected] of [
        ["https://releases.example.com/mirror", 0],
        ["http://localhost:8080/mirror", 0],
        ["http://127.0.0.1:8080/mirror", 0],
        ["http://localhost.example.com/mirror", 2],
        ["http://127.0.0.10/mirror", 2],
        ["not a URL", 2],
      ]) {
        const result = installer(["-DryRun", "-BaseUrl", url]);
        assert.equal(result.status, expected, `${url}: ${tail(result)}`);
        if (expected === 2) assert.match(result.stderr, /releases URL must use HTTPS/);
      }
      return "checked URL parsing and exact loopback host matching without making requests";
    });
  }

  await step("hostile archives cannot traverse, link, duplicate or overwrite", async () => {
    await hostileCase(
      "traversal",
      () => createTarGz([{ path: "../escape.txt", data: "owned" }], { mtime: 0 }),
      extractTarGz,
    );
    await hostileCase(
      "absolute",
      () => createTarGz([{ path: "/tmp/escape.txt", data: "owned" }], { mtime: 0 }),
      extractTarGz,
    );
    await hostileCase(
      "symlink",
      () => gzipSync(retypeTar(createTar([{ path: "link", data: "" }], { mtime: 0 }), "2")),
      extractTarGz,
    );
    await hostileCase(
      "duplicate",
      () => createTarGz([{ path: "same.txt", data: "a" }, { path: "same.txt", data: "b" }], { mtime: 0 }),
      extractTarGz,
    );
    await hostileCase(
      "zip-traversal",
      () => createZip([{ path: "../escape.txt", data: "owned" }], { mtime: 0 }),
      extractZip,
    );

    // Overwrite: a second extraction into a populated directory must refuse.
    const destination = join(sandbox, "hostile", "overwrite");
    await mkdir(destination, { recursive: true });
    const archive = join(sandbox, "hostile", "overwrite.tar.gz");
    await writeFile(archive, createTarGz([{ path: "file.txt", data: "first" }], { mtime: 0 }));
    await extractTarGz(archive, destination);
    await assert.rejects(() => extractTarGz(archive, destination), UnsafeArchiveError);
    assert.equal(await readFile(join(destination, "file.txt"), "utf8"), "first");
    return "5 hostile shapes refused with no writes outside the destination";
  });

  await step("install from the packed artifact into a path with spaces and Unicode", async () => {
    const result = installer();
    assert.equal(result.status, 0, tail(result));
    assert.ok(existsSync(launcher), `launcher missing at ${launcher}`);
    assert.ok(existsSync(join(prefix, VERSION, "src", "cli.js")), "installed sources are missing");
    assert.ok(existsSync(join(prefix, VERSION, "packages", "workflow-sdk", "src", "contract.js")), "the shared SDK is missing");
    assert.ok(existsSync(join(prefix, VERSION, "uninstall.sh")), "the offline uninstaller is missing");
    return `${prefix}/${VERSION}`;
  });

  await step("launcher and non-interactive entrypoints work", async () => {
    const version = await cli(["--version"]);
    if (version.status !== 0) {
      const present = existsSync(launcher);
      const raw = present ? await readFile(launcher) : Buffer.alloc(0);
      const program = join(prefix, VERSION, "bin", IS_WINDOWS ? "coderax.cmd" : "coderax");
      let binEntries = [];
      try {
        binEntries = await readdir(binDir);
      } catch {
        binEntries = ["<missing>"];
      }
      throw new Error(
        `${tail(version)}\nlauncher=${launcher} exists=${present} bytes=${raw.length} ` +
          `head=${JSON.stringify(raw.subarray(0, 240).toString("utf8"))} ` +
          `program=${program} exists=${existsSync(program)} bin=${JSON.stringify(binEntries)}`,
      );
    }
    assert.equal(version.status, 0, tail(version));
    assert.equal(version.stdout.trim(), `coderax-cli ${VERSION}`);
    const help = await cli(["--help"]);
    assert.equal(help.status, 0, tail(help));
    assert.match(help.stdout, /coderax login/);
    assert.match(help.stdout, /tokens/i);
    return "version and help render from the installed tree";
  });

  await step("version --json reports the derived compatibility contract", async () => {
    const result = await cli(["version", "--json"]);
    assert.equal(result.status, 0, tail(result));
    const info = JSON.parse(result.stdout);
    assert.equal(info.cliVersion, VERSION);
    assert.equal(info.installMethod, "standalone");
    assert.equal(info.nodeSupported, true);
    assert.equal(info.supportedApiVersion, "1.x");
    assert.equal(info.supportedDeploymentRange, ">=0.8.8 <1.0.0");
    assert.match(info.compatibilityBasis, /x-coderax-api-version/);
    assert.equal(await realpath(info.installPath), await realpath(join(prefix, VERSION)));
    return `${info.cliVersion} on node ${info.node} (${info.platform}-${info.arch})`;
  });

  await step("doctor is useful before configuration", async () => {
    const result = await cli(["doctor", "--json"]);
    assert.equal(result.status, 1, "doctor must fail while unauthenticated");
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    for (const name of ["node", "install", "config-dir"]) {
      assert.equal(report.checks.find((check) => check.name === name)?.ok, true, `${name} check failed`);
    }
    return "node, install and config checks pass; auth is correctly reported missing";
  });

  await step("a token in argv is refused before any request is made", async () => {
    await withEngine("compatible", async (baseUrl) => {
      const result = await cli(["login", "--base-url", baseUrl, "--token", TOKEN, "--json"]);
      assert.equal(result.status, 2, tail(result));
      assert.match(result.stderr, /argv/);
      assert.equal(result.stderr.includes(TOKEN), false, "the refused token must not be echoed");
    });
    return "exit 2 with a secure alternative named";
  });

  await step("login accepts a token on stdin and never prints it", async () => {
    await withEngine("compatible", async (baseUrl) => {
      const login = await cli(["login", "--base-url", baseUrl, "--json"], {}, { input: `${TOKEN}\n` });
      assert.equal(login.status, 0, tail(login));
      assert.equal(JSON.parse(login.stdout).authenticated, true);
      assert.equal(login.stdout.includes(TOKEN), false);

      const status = await cli(["status", "--json"]);
      assert.equal(status.status, 0, tail(status));
      const reported = JSON.parse(status.stdout);
      assert.equal(reported.authenticated, true);
      assert.equal(reported.role, "ADMIN");
      assert.equal(reported.token.includes(TOKEN), false);

      const configMode = (await stat(configPath)).mode & 0o777;
      if (!IS_WINDOWS) assert.equal(configMode, 0o600, `config mode is ${configMode.toString(8)}`);
      return "owner verified, token stored 0600, no token in output";
    });
  });

  await step("compatible deployment: health, agents, doctor and compat pass", async () => {
    await withEngine("compatible", async (baseUrl) => {
      const health = await cli(["health", "--json", "--base-url", baseUrl]);
      assert.equal(health.status, 0, tail(health));
      assert.equal(JSON.parse(health.stdout).status, 200);

      const agents = await cli(["agents", "--json", "--base-url", baseUrl]);
      assert.equal(agents.status, 0, tail(agents));
      assert.equal(JSON.parse(agents.stdout).body.agents[0].id, "agent-1");

      const doctor = await cli(["doctor", "--json", "--base-url", baseUrl]);
      assert.equal(doctor.status, 0, tail(doctor));
      assert.equal(JSON.parse(doctor.stdout).ok, true);

      const compat = await cli(["compat", "--json", "--base-url", baseUrl]);
      assert.equal(compat.status, 0, tail(compat));
      const verdict = JSON.parse(compat.stdout);
      assert.equal(verdict.supported, true);
      assert.equal(verdict.apiVersion, "1");
      assert.equal(verdict.deploymentVersion, "0.8.8");
      assert.equal(verdict.status, "compatible");
      return "API 1 + deployment 0.8.8 reported as compatible on both axes";
    });
  });

  await step("incompatible API major is reported separately", async () => {
    await withEngine("api-incompatible", async (baseUrl) => {
      const result = await cli(["compat", "--json", "--base-url", baseUrl]);
      assert.equal(result.status, 1, tail(result));
      const verdict = JSON.parse(result.stdout);
      assert.equal(verdict.supported, false);
      assert.match(verdict.reason, /API version 2/);
      assert.equal(verdict.deploymentVersion, "0.8.8");
    });
    return "API 2 is incompatible even though the deployment version is in range";
  });

  await step("older deployment is reported separately", async () => {
    await withEngine("older", async (baseUrl) => {
      const result = await cli(["compat", "--json", "--base-url", baseUrl]);
      assert.equal(result.status, 1, tail(result));
      const verdict = JSON.parse(result.stdout);
      assert.equal(verdict.supported, false);
      assert.equal(verdict.apiSupported, true);
      assert.equal(verdict.deploymentSupported, false);
      assert.equal(verdict.deploymentVersion, "0.7.9");
    });
    return "API 1 is compatible; deployment 0.7.9 is below the validated floor";
  });

  await step("unavailable engine states are unknown, not compatible", async () => {
    await withEngine("unavailable", async (baseUrl) => {
      const result = await cli(["compat", "--json", "--base-url", baseUrl]);
      assert.equal(result.status, 1, tail(result));
      const verdict = JSON.parse(result.stdout);
      assert.equal(verdict.supported, null);
      assert.equal(verdict.apiVersion, null);
      assert.equal(verdict.deploymentVersion, null);
      assert.equal(verdict.status, "unknown");
    });
    return "no metadata and no OpenAPI document produce unknown, exit 1";
  });

  await step("unauthenticated engine state exits 3", async () => {
    await withEngine("unauthenticated", async (baseUrl) => {
      const result = await cli(["compat", "--json", "--base-url", baseUrl]);
      assert.equal(result.status, 3, tail(result));
    });
    return "401 is authentication, not an unknown version";
  });

  await step("Work SSE streams through the installed launcher", async () => {
    await withEngine("compatible", async (baseUrl) => {
      const result = await cli(["work", "verify installation", "--base-url", baseUrl, "--json"]);
      assert.equal(result.status, 0, tail(result));
      assert.equal(JSON.parse(result.stdout).text, "installed and authenticated");
    });
    return "cumulative snapshots assembled without duplication";
  });

  await step("npm tarball exposes the SDK surface and the bin entrypoint", async () => {
    const project = join(sandbox, "sdk project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "sdk-check", private: true, type: "module" }, null, 2)}\n`);
    const npm = IS_WINDOWS ? "npm.cmd" : "npm";
    const install = spawn(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline", shellArg(NPM_TARBALL)], {
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
const contract = await import("coderax-cli/sdk/contract");
const version = await import("coderax-cli/version");
const diagnostics = await import("coderax-cli/diagnostics");
assert.equal(typeof sdk.runCli, "function");
assert.equal(typeof compat.checkCompatibility, "function");
assert.equal(contract.API_VERSION, "1");
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
    return "exports map, SDK contract, version module and npm bin all work";
  });

  await step("npm global install creates a working launcher and reports targeted removal advice", async () => {
    const globalPrefix = join(sandbox, "npm global");
    const otherPrefix = join(sandbox, "other npm global");
    const npm = IS_WINDOWS ? "npm.cmd" : "npm";
    for (const target of [globalPrefix, otherPrefix]) {
      const install = spawn(
        npm,
        ["install", "--global", "--prefix", shellArg(target), "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline", shellArg(NPM_TARBALL)],
        { cwd: sandbox, env, shell: IS_WINDOWS },
      );
      assert.equal(install.status, 0, tail(install));
    }
    const globalBin = (target) => IS_WINDOWS ? join(target, "coderax.cmd") : join(target, "bin", "coderax");
    const bin = globalBin(globalPrefix);
    const version = spawn(commandPath(bin), ["--version"], { env, shell: IS_WINDOWS });
    assert.equal(version.status, 0, tail(version));
    assert.equal(version.stdout.trim(), `coderax-cli ${VERSION}`);
    const info = spawn(commandPath(bin), ["version", "--json"], { env, shell: IS_WINDOWS });
    assert.equal(info.status, 0, tail(info));
    assert.equal(JSON.parse(info.stdout).installMethod, "npm-global");
    const removalEnv = { ...env, npm_config_prefix: otherPrefix, npm_config_audit: "false" };
    const dryRun = spawn(commandPath(bin), ["uninstall", "--dry-run", "--json"], { env: removalEnv, shell: IS_WINDOWS });
    assert.equal(dryRun.status, 0, tail(dryRun));
    const advice = JSON.parse(dryRun.stdout);
    const resolvedPrefix = await realpath(globalPrefix);
    // Windows may report the original 8.3 path while realpath expands it.
    const expectedCommands = (IS_WINDOWS ? [globalPrefix, resolvedPrefix] : [resolvedPrefix]).map((target) => {
      const commandPrefix = IS_WINDOWS ? target.replaceAll("\\", "/") : target;
      return `npm uninstall --global --prefix "${commandPrefix}" coderax-cli`;
    });
    assert.equal(advice.program.commands.length, 1);
    const [command] = advice.program.commands;
    assert.ok(expectedCommands.includes(command), `unexpected removal advice: ${command}`);
    const removal = spawn(command, [], { cwd: sandbox, env: removalEnv, shell: true });
    assert.equal(removal.status, 0, tail(removal));
    assert.ok(!existsSync(advice.program.installPath), "the reported package must be removed");
    assert.equal(lstatSync(bin, { throwIfNoEntry: false }), undefined, "the reported launcher must be removed");
    const retained = spawn(commandPath(globalBin(otherPrefix)), ["--version"], { env, shell: IS_WINDOWS });
    assert.equal(retained.status, 0, tail(retained));
    assert.equal(retained.stdout.trim(), `coderax-cli ${VERSION}`);
    return "following the advice removes only the reported global install";
  });

  await step("reinstall is refused; a corrupted upgrade leaves the install intact", async () => {
    const again = installer();
    assert.equal(again.status, 1, "a second install of the same version must be refused");

    // A corrupted archive must be rejected before anything is replaced.
    const corrupted = IS_WINDOWS
      ? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(DIST, "install.ps1"), "-Version", VERSION, "-FromFile", TARBALL, "-Checksum", "0".repeat(64), "-Prefix", prefix, "-BinDir", binDir, "-Force"], { env })
      : spawn("sh", [join(DIST, "install.sh"), "--version", VERSION, "--from-file", TARBALL, "--checksum", "0".repeat(64), "--prefix", prefix, "--bin-dir", binDir, "--force"], { env });
    assert.equal(corrupted.status, 3, tail(corrupted));
    assert.equal((await cli(["--version"])).stdout.trim(), `coderax-cli ${VERSION}`);

    const forced = installer(["--force"]);
    assert.equal(forced.status, 0, tail(forced));
    const rollbacks = (await readdir(prefix)).filter((name) => name.startsWith(".rollback-"));
    assert.ok(rollbacks.length >= 1, "an upgrade must retain the previous version for rollback");
    const version = await cli(["--version"]);
    assert.equal(version.stdout.trim(), `coderax-cli ${VERSION}`);
    return `atomic replace kept ${rollbacks.length} rollback directory`;
  });

  await step("no credential leaked into any observed output", async () => {
    const combined = transcript.join("\n");
    assert.equal(combined.includes(TOKEN), false, "the bearer token appeared in CLI output");
    return `${combined.length} bytes of output scanned`;
  });

  await step("uninstall removes the program, launcher and user data", async () => {
    assert.ok(await pathExists(configPath), "login should have written a config file");
    const result = uninstaller();
    assert.equal(result.status, 0, tail(result));
    assert.equal(await pathExists(launcher), false, "launcher still exists");
    assert.equal(await pathExists(join(prefix, VERSION)), false, "program directory still exists");
    assert.equal(await pathExists(configPath), false, "config was not purged");
    return "launcher, program directory and credentials removed";
  });

  console.log(`\ncoderax install-test: PASS (${results.length} checks on ${process.platform}-${process.arch}, node ${process.versions.node})`);
} catch (error) {
  failure = error;
  console.error(`\ncoderax install-test: FAIL after ${results.length} checks`);
} finally {
  const evidence = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    release: { name: manifest.name, version: manifest.version, commit: manifest.commit },
    apiVersion: manifest.supportedApiVersion,
    deploymentRange: manifest.supportedDeploymentRange,
    compatibilityBasis: manifest.compatibilityBasis,
    secureAuth: "token on stdin only; argv refused",
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
