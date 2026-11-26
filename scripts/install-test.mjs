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
 *   5. checks API-version negotiation against stub deployments on the same
 *      major, a newer major, and one that advertises no version,
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
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const IS_WINDOWS = process.platform === "win32";
const TOKEN = "install-test-token-9f3a";

/** Windows may report an 8.3 short path for the same directory. Compare
 * canonical paths where possible and fall back to filesystem identity. */
function assertInstallDirectory(actual, expected) {
  const left = statSync(actual);
  const right = statSync(expected);
  assert.ok(left.isDirectory() && right.isDirectory(), `${actual} and ${expected} must be directories`);
  const samePath = realpathSync.native(actual) === realpathSync.native(expected);
  const sameFile = left.ino !== 0 && left.ino === right.ino && left.dev === right.dev;
  assert.ok(samePath || sameFile, `${actual} must be the installed ${expected} directory`);
}

const manifest = JSON.parse(await readFile(join(DIST, "release-manifest.json"), "utf8"));
const VERSION = manifest.version;
const NPM_TARBALL = join(DIST, `coderax-cli-${VERSION}.tgz`);
const STANDALONE_SUFFIX = IS_WINDOWS ? "-standalone.zip" : "-standalone.tar.gz";
const TARBALL = join(DIST, `coderax-cli-${VERSION}${STANDALONE_SUFFIX}`);
const tarballRecord = manifest.artifacts.find((artifact) => artifact.name.endsWith(STANDALONE_SUFFIX));
assert.ok(tarballRecord, `the manifest must list the ${STANDALONE_SUFFIX} archive`);

// A rehearsal of the next release, built from the same source with a bumped
// version, exercises a real side-by-side upgrade and rollback. Nothing is
// downloaded and no release is published.
const [major, minor, patch] = VERSION.split(".").map((part) => Number.parseInt(part, 10));
const NEXT_VERSION = `${major}.${minor}.${patch + 1}`;

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

// A space and a non-ASCII character exercise quoting in every installer,
// launcher, completion path, and uninstaller on the real host.
const sandbox = await mkdtemp(join(tmpdir(), "coderax install-ü-"));
const prefix = join(sandbox, "prefix");
const binDir = join(sandbox, "bin");
const home = join(sandbox, "home");
const configPath = join(sandbox, "coderax", "config.json");
const completionDir = join(sandbox, "completions");
const bashCompletion = join(home, ".local", "share", "bash-completion", "completions", "coderax");
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

function installer(extra = [], options = {}) {
  const runEnv = options.env ?? env;
  const version = options.version ?? VERSION;
  const archive = options.tarball ?? TARBALL;
  const checksum = options.checksum ?? tarballRecord.sha256;
  if (IS_WINDOWS) {
    const local = extra.includes("--rollback")
      ? []
      : ["-FromFile", archive, "-Checksum", checksum];
    return spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts", "install.ps1"),
      "-Version", version,
      ...local,
      "-Prefix", prefix,
      "-BinDir", binDir,
      "-CompletionDir", options.completionDir ?? completionDir,
      ...extra.map((value) => (value === "--force" ? "-Force" : value === "--no-completion" ? "-NoCompletion" : value === "--rollback" ? "-Rollback" : value === "--dry-run" ? "-DryRun" : value)),
    ], { env: runEnv });
  }
  return spawn("sh", [
    join(ROOT, "scripts", "install.sh"),
    "--version", version,
    ...(extra.includes("--rollback") ? [] : ["--from-file", archive, "--checksum", checksum]),
    "--prefix", prefix,
    "--bin-dir", binDir,
    ...extra,
  ], { env: runEnv });
}

async function buildUpgradeArtifact() {
  const upgradeDist = join(sandbox, "upgrade-dist");
  const result = spawn(process.execPath, [
    join(ROOT, "scripts", "build-release.mjs"),
    "--version", NEXT_VERSION,
    "--out", upgradeDist,
  ], { cwd: ROOT, env });
  assert.equal(result.status, 0, tail(result));
  const upgradeManifest = JSON.parse(await readFile(join(upgradeDist, "release-manifest.json"), "utf8"));
  assert.equal(upgradeManifest.version, NEXT_VERSION);
  const record = upgradeManifest.artifacts.find((artifact) => artifact.name.endsWith(STANDALONE_SUFFIX));
  assert.ok(record, `the rehearsal manifest must list the ${STANDALONE_SUFFIX} archive`);
  return {
    tarball: join(upgradeDist, `coderax-cli-${NEXT_VERSION}${STANDALONE_SUFFIX}`),
    checksum: record.sha256,
  };
}

function hasTool(name, args = ["--version"]) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  return result.error === undefined && result.status === 0;
}

function uninstaller(extra = []) {
  if (IS_WINDOWS) {
    return spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts", "uninstall.ps1"),
      "-Prefix", prefix,
      "-BinDir", binDir,
      "-CompletionDir", completionDir,
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
    if (url.pathname === "/api/meta") {
      if (version === null) return json(404, { message: "not found" });
      return json(200, { apiVersion: version, capabilities: ["work.chat", "work.agents"] });
    }
    if (url.pathname === "/api/user") {
      return authenticated
        ? json(200, { email: "release-ci@coderax.test", role: "ADMIN" })
        : json(401, { message: "unauthorized" });
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
    assert.ok(
      existsSync(join(prefix, VERSION, IS_WINDOWS ? "uninstall.ps1" : "uninstall.sh")),
      "the offline uninstaller is missing",
    );
    return `${prefix}/${VERSION}`;
  });

  await step("the launcher is discoverable through PATH", async () => {
    const direct = spawn(commandPath(launcher), ["--version"], { env, shell: IS_WINDOWS });
    assert.equal(direct.status, 0, `launcher failed before PATH lookup: ${tail(direct)}`);
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const result = spawn("coderax", ["--version"], {
      env: { ...env, [pathKey]: `${binDir}${delimiter}${env[pathKey] ?? ""}` },
      shell: IS_WINDOWS,
    });
    assert.equal(result.status, 0, tail(result));
    assert.equal(result.stdout.trim(), `coderax-cli ${VERSION}`);
    return `coderax resolved from ${binDir}`;
  });

  await step("shell completion is generated for every supported shell", async () => {
    const work = join(sandbox, "completion-syntax");
    await mkdir(work, { recursive: true });
    const files = {};
    for (const shell of ["bash", "zsh", "fish", "powershell"]) {
      const result = await cli(["completion", shell]);
      assert.equal(result.status, 0, tail(result));
      assert.match(result.stdout, /coderax-cli shell completion/, `${shell} marker missing`);
      assert.doesNotMatch(result.stdout, /undefined/, `${shell} contains an unresolved value`);
      files[shell] = join(work, shell === "powershell" ? "coderax.ps1" : shell === "fish" ? "coderax.fish" : shell);
      await writeFile(files[shell], result.stdout);
    }

    const checked = [];
    const skipped = [];
    const grammar = [
      ["bash", "bash", [files.bash]],
      ["zsh", "zsh", [files.zsh]],
      ["fish", "fish", ["--no-execute", files.fish]],
    ];
    for (const [shell, tool, args] of grammar) {
      // Git Bash on Windows does not reliably resolve a backslash path in
      // `bash -n`; the POSIX jobs already check bash grammar.
      if (shell === "bash" && IS_WINDOWS) {
        skipped.push(shell);
        continue;
      }
      if (!hasTool(tool, ["--version"])) {
        skipped.push(shell);
        continue;
      }
      const result = shell === "bash"
        ? spawn("bash", ["-n", ...args], { env })
        : spawn(tool, shell === "fish" ? args : ["-n", ...args], { env });
      assert.equal(result.status, 0, `${shell} rejected its completion script:\n${tail(result)}`);
      checked.push(shell);
    }

    const powershell = hasTool("pwsh", ["-NoProfile", "-Command", "exit 0"])
      ? "pwsh"
      : hasTool("powershell", ["-NoProfile", "-Command", "exit 0"])
        ? "powershell"
        : null;
    if (powershell === null) {
      skipped.push("powershell");
    } else {
      const result = spawn(powershell, [
        "-NoProfile",
        "-Command",
        `$null = [scriptblock]::Create((Get-Content -Raw -LiteralPath "${files.powershell}"))`,
      ], { env });
      assert.equal(result.status, 0, `PowerShell rejected its completion script:\n${tail(result)}`);
      checked.push("powershell");
    }

    return `grammar checked: ${checked.join(", ") || "none"}${skipped.length ? `; not installed: ${skipped.join(", ")}` : ""}`;
  });

  await step("the installer wrote completion for the shells it found", async () => {
    if (IS_WINDOWS) {
      const file = join(completionDir, "coderax.ps1");
      assert.ok(existsSync(file), `missing ${file}`);
      const body = await readFile(file, "utf8");
      assert.match(body, /Register-ArgumentCompleter -Native -CommandName coderax/);
      return file;
    }
    if (!hasTool("bash", ["--version"])) {
      return "bash is not installed; generation was verified through the launcher";
    }
    assert.ok(existsSync(bashCompletion), `missing ${bashCompletion}`);
    const generated = await cli(["completion", "bash"]);
    assert.equal((await readFile(bashCompletion, "utf8")).trim(), generated.stdout.trim());
    return bashCompletion;
  });

  await step("the installer keeps completion optional", async () => {
    const quietHome = join(sandbox, "home-no-completion");
    await mkdir(quietHome, { recursive: true });
    const quietDir = join(sandbox, "completions-no-completion");
    const result = installer(["--force", "--no-completion"], {
      env: IS_WINDOWS ? env : { ...env, HOME: quietHome, USERPROFILE: quietHome },
      completionDir: quietDir,
    });
    assert.equal(result.status, 0, tail(result));
    if (IS_WINDOWS) {
      assert.equal(existsSync(join(quietDir, "coderax.ps1")), false, "-NoCompletion wrote a file");
    } else if (hasTool("bash", ["--version"])) {
      assert.equal(
        existsSync(join(quietHome, ".local", "share", "bash-completion", "completions", "coderax")),
        false,
        "--no-completion wrote a file",
      );
    }
    return "no completion file created";
  });

  await step("a newer version installs side by side and takes over the launcher", async () => {
    const upgrade = await buildUpgradeArtifact();
    const result = installer([], {
      version: NEXT_VERSION,
      tarball: upgrade.tarball,
      checksum: upgrade.checksum,
    });
    assert.equal(result.status, 0, tail(result));
    assert.ok(existsSync(join(prefix, VERSION)), "the previous version was removed");
    assert.ok(existsSync(join(prefix, NEXT_VERSION)), "the newer version is missing");
    const reported = await cli(["--version"]);
    assert.equal(reported.stdout.trim(), `coderax-cli ${NEXT_VERSION}`);
    const info = await cli(["version", "--json"]);
    assertInstallDirectory(JSON.parse(info.stdout).installPath, join(prefix, NEXT_VERSION));
    return `${VERSION} -> ${NEXT_VERSION}`;
  });

  await step("an older version cannot silently replace a newer install", async () => {
    const result = installer(["--force"], { version: VERSION });
    assert.equal(result.status, 2, tail(result));
    assert.match(result.stderr, /refusing to downgrade/);
    return "downgrade refused; --rollback remains the supported path";
  });

  await step("rollback repoints the launcher to the installed previous version", async () => {
    const result = installer(["--rollback"], { version: VERSION });
    assert.equal(result.status, 0, tail(result));
    const reported = await cli(["--version"]);
    assert.equal(reported.stdout.trim(), `coderax-cli ${VERSION}`);
    const info = await cli(["version", "--json"]);
    assertInstallDirectory(JSON.parse(info.stdout).installPath, join(prefix, VERSION));
    assert.ok(existsSync(join(prefix, NEXT_VERSION)), "rollback removed the newer version");

    const dryRun = installer(["--rollback", "--dry-run"], { version: VERSION });
    assert.equal(dryRun.status, 0, tail(dryRun));
    assert.match(dryRun.stdout, /rollback plan/);
    return `${NEXT_VERSION} -> ${VERSION}; newer version retained`;
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
    assert.equal(info.clientApiVersion, "1");
    assert.equal(info.clientApiMajor, 1);
    assert.equal(info.sdkPackage, "@coderax/workflow-sdk");
    assertInstallDirectory(info.installPath, join(prefix, VERSION));
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

  await step("authenticated communication with a compatible API (1.1)", async () => {
    return withEngine("1.1", async (baseUrl) => {
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
      assert.equal(verdict.apiVersion, "1.1");
      assert.equal(verdict.clientApiVersion, "1.x");

      const agents = await cli(["agents", "--json"]);
      assert.equal(agents.status, 0, tail(agents));
      assert.equal(JSON.parse(agents.stdout).body.agents[0].id, "agent-1");

      const doctor = await cli(["doctor", "--json"]);
      assert.equal(doctor.status, 0, tail(doctor));
      assert.equal(JSON.parse(doctor.stdout).ok, true);
      return "login, status, health, compat, agents and doctor all succeeded with bearer auth";
    });
  });

  await step("API version boundaries (1.0 / 1.9 / 2.0)", async () => {
    const expectations = [
      ["1.0", 0, true],
      ["1.9", 0, true],
      ["2.0", 6, false],
    ];
    for (const [apiVersion, code, supported] of expectations) {
      await withEngine(apiVersion, async (baseUrl) => {
        const result = await cli(["compat", "--base-url", baseUrl, "--json"]);
        assert.equal(result.status, code, `API ${apiVersion}: ${tail(result)}`);
        assert.equal(JSON.parse(result.stdout).supported, supported, `API ${apiVersion} verdict`);
      });
    }
    return "same-major versions pass and a new major fails with API_VERSION_UNSUPPORTED";
  });

  await step("a deployment that advertises no API version is reported as unknown", async () => {
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
    return withEngine("1.1", async (baseUrl) => {
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
const registry = await import("coderax-cli/command-registry");
const version = await import("coderax-cli/version");
const diagnostics = await import("coderax-cli/diagnostics");
assert.equal(typeof sdk.runCli, "function");
assert.equal(registry.COMMAND_NAMES.has("completion"), true);
assert.equal(registry.COMMAND_NAMES.has("uninstall"), true);
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

  await step("reinstalling the same version is refused; --force replaces it in place", async () => {
    const upgrade = await buildUpgradeArtifact();
    const options = { version: NEXT_VERSION, tarball: upgrade.tarball, checksum: upgrade.checksum };
    const again = installer([], options);
    assert.equal(again.status, 1, "a second install of the same version must be refused");
    const forced = installer(["--force"], options);
    assert.equal(forced.status, 0, tail(forced));
    const version = await cli(["--version"]);
    assert.equal(version.stdout.trim(), `coderax-cli ${NEXT_VERSION}`);
    return "idempotency guard and in-place replacement both verified";
  });

  await step("no credential leaked into any command output", async () => {
    const combined = transcript.join("\n");
    assert.equal(combined.includes(TOKEN), false, "the bearer token appeared in CLI output");
    return `${transcript.join("\n").length} bytes of output scanned`;
  });

  await step("uninstall removes the program, launcher, credentials and its completion", async () => {
    assert.ok(await pathExists(configPath), "login should have written a config file");

    // A hand-written file with the same name must survive: the uninstaller only
    // deletes files that carry the generated-file marker.
    const handWritten = join(home, ".local", "share", "zsh", "site-functions", "_coderax");
    if (!IS_WINDOWS) {
      await mkdir(join(home, ".local", "share", "zsh", "site-functions"), { recursive: true });
      await writeFile(handWritten, "# hand-written by the user, must survive\n");
    }

    const result = uninstaller();
    assert.equal(result.status, 0, tail(result));
    assert.equal(await pathExists(launcher), false, "launcher still exists");
    assert.equal(await pathExists(join(prefix, VERSION)), false, "program directory still exists");
    assert.equal(await pathExists(configPath), false, "config was not purged");
    if (IS_WINDOWS) {
      assert.equal(await pathExists(join(completionDir, "coderax.ps1")), false, "completion was not removed");
    } else {
      if (hasTool("bash", ["--version"])) {
        assert.equal(await pathExists(bashCompletion), false, "generated bash completion was not removed");
      }
      assert.equal(await pathExists(handWritten), true, "a hand-written completion file was deleted");
    }
    return "launcher, program, credentials and generated completion removed; hand-written file kept";
  });

  console.log(`\ncoderax install-test: PASS (${results.length} checks on ${process.platform}-${process.arch}, node ${process.versions.node})`);
} catch (error) {
  failure = error;
  const failed = results.at(-1);
  const detail = `${failed?.name ?? "setup"}: ${error?.message ?? error}`.replace(/\r?\n/g, " ").slice(0, 1200);
  console.error(`\ncoderax install-test: FAIL after ${results.length} checks`);
  // Public check annotations carry the failing check even when the job log is
  // not downloadable without repository credentials.
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::error title=coderax install-test (${process.platform})::${detail}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      `## coderax install-test: FAIL (${process.platform}-${process.arch})`,
      "",
      `Failing check: ${failed?.name ?? "setup"}`,
      "",
      "```",
      String(error?.stack ?? error).slice(0, 4000),
      "```",
    ].join("\n");
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
} finally {
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    release: { name: manifest.name, version: manifest.version, commit: manifest.commit },
    clientApiVersion: manifest.clientApiVersion,
    clientApiMajor: manifest.clientApiMajor,
    sdkPackage: manifest.sdkPackage,
    sdkVersion: manifest.sdkVersion,
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
