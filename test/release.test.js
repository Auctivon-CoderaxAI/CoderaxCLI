import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import {
  SUPPORTED_ENGINE_RANGE,
  compareSemver,
  engineVersionFrom,
  isSupportedEngineVersion,
  parseSemver,
} from "../src/compat.js";
import { VERSION } from "../src/version.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

function engineServer(version) {
  return (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/health") return json(200, { status: "ok", workflowEngine: { version } });
    return json(404, { message: "not found" });
  };
}

test("semantic version parsing rejects partial and non-versions", () => {
  assert.equal(parseSemver("1.2"), null);
  assert.equal(parseSemver("latest"), null);
  assert.equal(parseSemver("1.2.3.4"), null);
  assert.deepEqual(parseSemver("v0.8.8")?.raw, "v0.8.8");
  assert.equal(parseSemver(" v0.8.8 ")?.minor, 8);
});

test("prerelease versions sort below their release", () => {
  assert.equal(compareSemver(parseSemver("0.8.0-rc.1"), parseSemver("0.8.0")), -1);
  assert.equal(compareSemver(parseSemver("0.8.0"), parseSemver("0.8.0-rc.1")), 1);
  assert.equal(compareSemver(parseSemver("0.8.0"), parseSemver("0.8.0+build.5")), 0);
  assert.equal(compareSemver(parseSemver("0.10.0"), parseSemver("0.9.9")), 1);
});

test("the supported engine range has exact boundaries", () => {
  const cases = [
    ["0.7.9", false],
    ["0.8.0-rc.1", false],
    ["0.8.0", true],
    ["0.8.8", true],
    ["0.9.5", true],
    ["0.99.99", true],
    ["1.0.0", false],
    ["1.0.0-rc.1", false],
  ];
  for (const [version, expected] of cases) {
    assert.equal(isSupportedEngineVersion(version).supported, expected, version);
  }
  assert.equal(isSupportedEngineVersion("not-a-version").supported, null);
  assert.equal(SUPPORTED_ENGINE_RANGE, ">=0.8.0 <1.0.0");
});

test("engine versions are read from explicit contract fields only", () => {
  assert.equal(engineVersionFrom({ workflowEngine: { version: "0.9.1" } }), "0.9.1");
  assert.equal(engineVersionFrom({ info: { version: "0.9.2" } }), "0.9.2");
  // A bare health `version` is the service version and must not be trusted.
  assert.equal(engineVersionFrom({ status: "ok", version: "9.9.9" }), null);
  assert.equal(engineVersionFrom(null), null);
});

test("version --json reports the install and compatibility contract", async () => {
  const io = capture();
  const code = await runCli(["version", "--json"], { env: {}, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 0);
  const info = JSON.parse(io.out());
  assert.equal(info.cliVersion, VERSION);
  assert.equal(info.nodeSupported, true);
  assert.ok(["source", "npm-local", "npm-global", "standalone"].includes(info.installMethod));
  assert.equal(info.supportedWorkflowEngine, SUPPORTED_ENGINE_RANGE);
  assert.match(info.configPath, /config\.json$/);
});

test("version works even when the config file is corrupt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coderax-version-"));
  const file = join(directory, "config.json");
  await writeFile(file, "{ not json");
  const io = capture();
  const code = await runCli(["version"], { env: { CODERAX_CONFIG: file }, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 0);
  assert.match(io.out(), new RegExp(`coderax-cli ${VERSION.replaceAll(".", "\\.")}`));
});

test("compat reports a supported engine", async () => {
  await withServer(engineServer("0.8.8"), async (baseUrl) => {
    const io = capture();
    const code = await runCli(
      ["compat", "--base-url", baseUrl, "--json"],
      { env: {}, stdout: io.stdout, stderr: io.stderr },
    );
    assert.equal(code, 0);
    const verdict = JSON.parse(io.out());
    assert.equal(verdict.supported, true);
    assert.equal(verdict.engineVersion, "0.8.8");
    assert.equal(verdict.range, SUPPORTED_ENGINE_RANGE);
  });
});

test("compat distinguishes an unsupported engine from an unknown one", async () => {
  await withServer(engineServer("1.4.0"), async (baseUrl) => {
    const io = capture();
    const code = await runCli(["compat", "--base-url", baseUrl, "--json"], { env: {}, stdout: io.stdout, stderr: io.stderr });
    assert.equal(code, 1);
    assert.equal(JSON.parse(io.out()).supported, false);
  });

  await withServer(engineServer(undefined), async (baseUrl) => {
    const io = capture();
    const code = await runCli(["compat", "--base-url", baseUrl, "--json"], { env: {}, stdout: io.stdout, stderr: io.stderr });
    assert.equal(code, 1);
    const verdict = JSON.parse(io.out());
    assert.equal(verdict.supported, null);
    assert.match(verdict.reason, /did not report/);
  });
});

test("compat surfaces an authentication failure instead of calling it unknown", async () => {
  await withServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "unauthorized" }));
  }, async (baseUrl) => {
    const io = capture();
    const code = await runCli(["compat", "--base-url", baseUrl, "--json"], {
      env: {},
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(code, 3);
    assert.match(io.err(), /HTTP_401/);
  });
});

test("uninstall is a dry run until --yes and then removes user data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coderax-uninstall-"));
  const file = join(directory, "config.json");
  await writeFile(file, JSON.stringify({ baseUrl: "https://coderax.test" }));

  const dry = capture();
  const dryCode = await runCli(["uninstall", "--json"], {
    env: { CODERAX_CONFIG: file },
    stdout: dry.stdout,
    stderr: dry.stderr,
  });
  assert.equal(dryCode, 0);
  assert.equal(JSON.parse(dry.out()).dryRun, true);
  assert.equal(JSON.parse(dry.out()).exists, true);
  assert.ok((await readFile(file, "utf8")).includes("coderax.test"));

  const purge = capture();
  const purgeCode = await runCli(["uninstall", "--yes", "--json"], {
    env: { CODERAX_CONFIG: file },
    stdout: purge.stdout,
    stderr: purge.stderr,
  });
  assert.equal(purgeCode, 0);
  assert.equal(JSON.parse(purge.out()).removed, true);
  await assert.rejects(readFile(file, "utf8"));
});

test("cleanup is an alias for uninstall", async () => {
  const io = capture();
  const code = await runCli(["cleanup", "--json"], { env: {}, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 0);
  assert.equal(JSON.parse(io.out()).dryRun, true);
});

test("the package stays install-safe and publish-locked", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    assert.equal(pkg.scripts?.[lifecycle], undefined, `${lifecycle} must not be defined`);
  }
  assert.equal(pkg.private, true, "publication must remain an explicit, authorized change");
  assert.equal(pkg.bin.coderax, "src/cli.js");
  assert.equal(pkg.engines.node, ">=24.0.0");

  const entry = await readFile(join(ROOT, "src", "cli.js"), "utf8");
  assert.ok(entry.startsWith("#!/usr/bin/env node"), "the bin entrypoint needs a shebang");

  for (const target of Object.values(pkg.exports)) {
    await readFile(join(ROOT, target), "utf8");
  }
});

test("no shipped module can spawn a runtime or background service", async () => {
  const directory = join(ROOT, "src");
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(join(directory, file), "utf8");
    assert.equal(source.includes("child_process"), false, `${file} must not spawn processes`);
  }
});
