import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { API_MAJOR, API_VERSION } from "../packages/workflow-sdk/src/index.js";
import { compareSemver, parseSemver } from "../src/semver.js";
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

function metaServer({ apiVersion, role = "ADMIN", authenticated = true } = {}) {
  return (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/meta") {
      return json(200, { apiVersion, capabilities: ["work.chat"] });
    }
    if (url.pathname === "/api/user") {
      return authenticated ? json(200, { role, email: "owner@coderax.test" }) : json(401, { message: "unauthorized" });
    }
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

test("the compatibility contract comes from the pinned SDK, not a guessed engine range", () => {
  assert.equal(API_VERSION, "1");
  assert.equal(API_MAJOR, 1);
});

test("version --json reports the install and API contract", async () => {
  const io = capture();
  const code = await runCli(["version", "--json"], { env: {}, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 0);
  const info = JSON.parse(io.out());
  assert.equal(info.cliVersion, VERSION);
  assert.equal(info.nodeSupported, true);
  assert.ok(["source", "npm-local", "npm-global", "standalone"].includes(info.installMethod));
  assert.equal(info.clientApiVersion, API_VERSION);
  assert.equal(info.clientApiMajor, API_MAJOR);
  assert.equal(info.sdkPackage, "@coderax/workflow-sdk");
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
  assert.match(io.out(), /api\s+v1 \(major 1/);
});

test("compat accepts a deployment on the same API major", async () => {
  await withServer(metaServer({ apiVersion: "1.4" }), async (baseUrl) => {
    const io = capture();
    const code = await runCli(
      ["compat", "--base-url", baseUrl, "--token", "test-token", "--json"],
      { env: {}, stdout: io.stdout, stderr: io.stderr },
    );
    assert.equal(code, 0, io.err());
    const verdict = JSON.parse(io.out());
    assert.equal(verdict.supported, true);
    assert.equal(verdict.apiVersion, "1.4");
    assert.equal(verdict.clientApiVersion, "1.x");
    assert.equal(verdict.owner, "ADMIN");
  });
});

test("compat rejects an incompatible API major with the SDK error code", async () => {
  await withServer(metaServer({ apiVersion: "2.0" }), async (baseUrl) => {
    const io = capture();
    const code = await runCli(
      ["compat", "--base-url", baseUrl, "--token", "test-token", "--json"],
      { env: {}, stdout: io.stdout, stderr: io.stderr },
    );
    assert.equal(code, 6);
    const verdict = JSON.parse(io.out());
    assert.equal(verdict.supported, false);
    assert.equal(verdict.apiVersion, "2.0");
  });
});

test("compat reports an unadvertised API version as unknown, not compatible", async () => {
  await withServer((req, res) => {
    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (urlPath(req) === "/api/user") return json(200, { role: "ADMIN" });
    return json(404, { message: "not found" });
  }, async (baseUrl) => {
    const io = capture();
    const code = await runCli(
      ["compat", "--base-url", baseUrl, "--token", "test-token", "--json"],
      { env: {}, stdout: io.stdout, stderr: io.stderr },
    );
    assert.equal(code, 1, io.err());
    const verdict = JSON.parse(io.out());
    assert.equal(verdict.supported, null);
    assert.match(verdict.reason, /did not report/);
  });
});

function urlPath(req) {
  return new URL(req.url, "http://127.0.0.1").pathname;
}

test("compat surfaces an authentication failure instead of calling it unknown", async () => {
  await withServer(metaServer({ apiVersion: "1.0", authenticated: false }), async (baseUrl) => {
    const io = capture();
    const code = await runCli(
      ["compat", "--base-url", baseUrl, "--token", "bad-token", "--json"],
      { env: {}, stdout: io.stdout, stderr: io.stderr },
    );
    assert.equal(code, 3);
    assert.match(io.err(), /UNAUTHENTICATED|HTTP_401/);
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

test("only the operator-requested notification hook may spawn a process", async () => {
  const directory = join(ROOT, "src");
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(join(directory, file), "utf8");
    if (file === "workflow-commands.js") {
      // `--notify-command` is an explicit, per-invocation operator choice. It
      // must stay a detached shell notification, never a runtime launcher.
      assert.match(source, /notify-command/, "the spawn must be the notification hook");
      assert.match(source, /spawn\(expanded/, "the notification hook must spawn the user's command");
      assert.equal(source.includes("execSync"), false, "synchronous execution is not allowed");
      continue;
    }
    assert.equal(source.includes("child_process"), false, `${file} must not spawn processes`);
  }
});
