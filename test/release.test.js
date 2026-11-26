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
  SUPPORTED_API_VERSION,
  SUPPORTED_DEPLOYMENT_RANGE,
  compareSemver,
  isSupportedDeploymentVersion,
  normalizeVersion,
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
    return await run(baseUrl);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/**
 * A deployment stub with independently controllable API version, OpenAPI
 * version and authentication, because those are separate compatibility axes.
 */
function deployment({ apiVersion = "1", deploymentVersion = "0.8.8", status = 200 } = {}) {
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return (req, res) => {
    if (status === 401) return json(res, 401, { message: "unauthorized" });
    if (req.url === "/api/meta") {
      if (apiVersion === null) return json(res, 404, { message: "not found" });
      return json(res, 200, { apiVersion, capabilities: [] });
    }
    if (req.url === "/openapi.json") {
      if (deploymentVersion === null) return json(res, 404, { message: "not found" });
      return json(res, 200, {
        openapi: "3.1.0",
        info: { title: "Coderax", version: deploymentVersion },
        paths: { "/api/agents": { get: { operationId: "listAgents" } } },
      });
    }
    return json(res, 404, { message: "not found" });
  };
}

async function compatRun(t, baseUrl) {
  const io = capture();
  const code = await runCli(["compat", "--base-url", baseUrl, "--json"], {
    env: { CODERAX_CREDENTIAL_STORE: "file" },
    stdout: io.stdout,
    stderr: io.stderr,
  });
  const text = io.out().trim();
  return { code, verdict: text === "" ? null : JSON.parse(text), io };
}

test("semantic versions order correctly, including prereleases", () => {
  assert.ok(compareSemver(parseSemver("0.8.8"), parseSemver("0.8.9")) < 0);
  assert.ok(compareSemver(parseSemver("0.9.0"), parseSemver("0.8.9")) > 0);
  assert.ok(compareSemver(parseSemver("1.0.0-rc.1"), parseSemver("1.0.0")) < 0);
  assert.equal(parseSemver("v0.8.8").raw, "v0.8.8");
  assert.equal(normalizeVersion("v0.8.8"), "0.8.8");
  assert.equal(parseSemver("0.8"), null);
});

test("the deployment range is derived, evidenced and exact at its boundaries", () => {
  assert.equal(SUPPORTED_DEPLOYMENT_RANGE, ">=0.8.8 <1.0.0");
  assert.equal(SUPPORTED_API_VERSION, "1");
  const cases = [
    ["0.8.7", false],
    ["0.8.8", true],
    ["0.9.9", true],
    ["1.0.0", false],
    ["v0.8.8", true],
    ["1.0.0-rc.1", false],
  ];
  for (const [version, expected] of cases) {
    assert.equal(isSupportedDeploymentVersion(version).supported, expected, version);
  }
  assert.equal(isSupportedDeploymentVersion("not-a-version").supported, null);
});

test("version --json reports the install and compatibility contract", async () => {
  const io = capture();
  const code = await runCli(["version", "--json"], { env: {}, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 0);
  const info = JSON.parse(io.out());
  assert.equal(info.cliVersion, VERSION);
  assert.equal(info.nodeSupported, true);
  assert.ok(["source", "npm-local", "npm-global", "standalone"].includes(info.installMethod));
  assert.equal(info.supportedApiVersion, "1.x");
  assert.equal(info.supportedDeploymentRange, SUPPORTED_DEPLOYMENT_RANGE);
  assert.match(info.compatibilityBasis, /x-coderax-api-version/);
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

test("compat requires both the API handshake and the deployment version", async () => {
  await withServer(deployment({}), async (baseUrl) => {
    const { code, verdict } = await compatRun(null, baseUrl);
    assert.equal(code, 0);
    assert.equal(verdict.supported, true);
    assert.equal(verdict.apiVersion, "1");
    assert.equal(verdict.apiSupported, true);
    assert.equal(verdict.deploymentVersion, "0.8.8");
    assert.equal(verdict.deploymentSupported, true);
    assert.equal(verdict.range, SUPPORTED_DEPLOYMENT_RANGE);
  });
});

test("an API major mismatch is incompatible even inside the deployment range", async () => {
  await withServer(deployment({ apiVersion: "2" }), async (baseUrl) => {
    const { code, verdict } = await compatRun(null, baseUrl);
    assert.equal(code, 1);
    assert.equal(verdict.supported, false);
    assert.equal(verdict.deploymentSupported, true);
    assert.match(verdict.reason, /API version 2/);
  });
});

test("a newer deployment line is incompatible even with a matching API version", async () => {
  await withServer(deployment({ deploymentVersion: "1.4.0" }), async (baseUrl) => {
    const { code, verdict } = await compatRun(null, baseUrl);
    assert.equal(code, 1);
    assert.equal(verdict.supported, false);
    assert.equal(verdict.apiSupported, true);
    assert.equal(verdict.deploymentVersion, "1.4.0");
    assert.match(verdict.reason, /newer than the validated range/);
  });
});

test("an unavailable deployment is unknown, never compatible", async () => {
  await withServer(deployment({ apiVersion: null, deploymentVersion: null }), async (baseUrl) => {
    const { code, verdict } = await compatRun(null, baseUrl);
    assert.equal(code, 1);
    assert.equal(verdict.supported, null);
    assert.equal(verdict.apiVersion, null);
    assert.equal(verdict.deploymentVersion, null);
  });
});

test("an unauthenticated deployment exits 3 rather than reporting unknown", async () => {
  await withServer(deployment({ status: 401 }), async (baseUrl) => {
    const { code, io } = await compatRun(null, baseUrl);
    assert.equal(code, 3, io.err());
  });
});

test("a token in argv is refused with a secure alternative", async () => {
  const io = capture();
  const code = await runCli(
    ["login", "--base-url", "https://coderax.test", "--token", "secret-value"],
    { env: {}, stdout: io.stdout, stderr: io.stderr },
  );
  assert.equal(code, 2);
  assert.match(io.err(), /argv/);
  assert.equal(io.err().includes("secret-value"), false);
});

test("uninstall is a dry run until --yes and then removes user data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coderax-uninstall-"));
  const file = join(directory, "config.json");
  await writeFile(file, JSON.stringify({ baseUrl: "https://coderax.test", token: "stored" }), { mode: 0o600 });

  const dry = capture();
  const dryCode = await runCli(["uninstall", "--dry-run", "--json"], {
    env: { CODERAX_CONFIG: file },
    stdout: dry.stdout,
    stderr: dry.stderr,
  });
  assert.equal(dryCode, 0);
  assert.equal(JSON.parse(dry.out()).removed, false);
  assert.ok(await readFile(file, "utf8"));

  const yes = capture();
  const yesCode = await runCli(["uninstall", "--yes", "--json"], {
    env: { CODERAX_CONFIG: file },
    stdout: yes.stdout,
    stderr: yes.stderr,
  });
  assert.equal(yesCode, 0);
  assert.equal(JSON.parse(yes.out()).removed, true);
  await assert.rejects(() => readFile(file, "utf8"));
});

test("cleanup is an alias for uninstall", async () => {
  const io = capture();
  const code = await runCli(["cleanup", "--dry-run", "--json"], {
    env: { CODERAX_CONFIG: join(tmpdir(), "coderax-missing", "config.json") },
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(io.out()).dryRun, true);
});

test("the package stays install-safe and publish-locked", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.private, true, "publication is an explicit owner decision");
  for (const script of ["preinstall", "install", "postinstall"]) {
    assert.equal(pkg.scripts?.[script], undefined, `${script} must not exist`);
  }
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, "runtime dependencies must stay empty");
});

test("only the credential helper and explicit notifications may spawn a process", async () => {
  const directory = join(ROOT, "src");
  // credentials.js runs a fixed OS helper so the token never enters argv.
  // workflow-commands.js runs a command only when --notify-command is passed.
  const allowed = new Map([
    ["auth.js", /"xdg-open"|"rundll32"/],
    ["credentials.js", /"secret-tool"|"powershell\.exe"/],
    ["secure-store.js", /"icacls"/],
    ["workflow-commands.js", /notify-command/],
  ]);
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(join(directory, file), "utf8");
    if (!source.includes("child_process")) continue;
    const guard = allowed.get(file);
    assert.ok(guard, `${file} must not spawn processes`);
    assert.match(source, guard, `${file} spawns without its documented guard`);
  }
});
