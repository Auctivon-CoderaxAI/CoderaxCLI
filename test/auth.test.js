import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "../src/cli.js";
import { credentialAccount } from "../src/credentials.js";
import { readStoredCredential } from "../src/auth.js";
import { SecureStoreError } from "../src/secure-store.js";
import { startWorkflowHarness } from "./support/workflow-harness.js";

/**
 * Owner login and the secure credential path.
 *
 * The suite never touches the real OS keychain: every case injects a store so
 * that a locked keyring, a refused ACL and a dropped write are all exercised on
 * every operating system. The assertions hold the two security invariants that
 * matter on failure: nothing is persisted in the config file, and no token
 * reaches stdout, stderr or argv.
 */

async function tempConfig() {
  const directory = await mkdtemp(join(tmpdir(), "coderax-auth-"));
  return join(directory, "config.json");
}

/** An in-memory stand-in for the OS credential store; no plaintext fallback. */
function memoryStore() {
  const items = new Map();
  return {
    name: "memory",
    available: true,
    secure: true,
    detail: "in-memory test store",
    async get(key) {
      return items.has(key) ? items.get(key) : null;
    },
    async set(key, value) {
      items.set(key, value);
    },
    async delete(key) {
      return items.delete(key);
    },
    async describe() {
      return { name: "memory", available: true, secure: true, detail: "in-memory test store" };
    },
    entries: () => [...items.entries()],
  };
}

async function invoke(argv, { env, store, fetchImpl, readSecret } = {}) {
  const out = [];
  const err = [];
  const code = await runCli(argv, {
    env,
    credentialStore: store,
    fetchImpl,
    readSecret,
    stdinIsTTY: true,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, out: out.join(""), err: err.join("") };
}

test("login refuses a token in argv so it cannot leak through process arguments", async () => {
  const file = await tempConfig();
  const store = memoryStore();

  const result = await invoke(["login", "--token", "argv-owner-token"], {
    env: { CODERAX_CONFIG: file, CODERAX_BASE_URL: "https://coderax.test" },
    store,
  });

  assert.equal(result.code, 2, result.err);
  assert.match(result.err, /--token-file/);
  assert.match(result.err, /--with-token/);
  assert.equal(result.err.includes("argv-owner-token"), false);
  assert.equal(result.out.includes("argv-owner-token"), false);
  assert.equal(store.entries().length, 0);
  await assert.rejects(readFile(file, "utf8"), (error) => error.code === "ENOENT");
});

test("login fails closed when no operating-system credential store exists", async () => {
  const file = await tempConfig();
  const store = {
    name: "none",
    available: false,
    secure: false,
    detail: "secret-tool was not found",
    async get() {
      return null;
    },
    async set() {},
    async delete() {
      return false;
    },
  };

  const result = await invoke(["login", "--base-url", "https://coderax.test"], {
    env: { CODERAX_CONFIG: file },
    store,
    readSecret: async () => "stdin-owner-token",
  });

  // A missing store is an authentication failure, not a generic error.
  assert.equal(result.code, 3, result.err);
  assert.match(result.err, /CREDENTIAL_STORE_UNAVAILABLE/);
  assert.match(result.err, /secret-tool was not found/);
  assert.equal(result.out.includes("stdin-owner-token"), false);
  await assert.rejects(readFile(file, "utf8"), (error) => error.code === "ENOENT");
});

test("login reports an ACL failure and keeps the working legacy token", async (t) => {
  const server = await startWorkflowHarness();
  t.after(() => server.close());
  const file = await tempConfig();
  await writeFile(
    file,
    JSON.stringify({ baseUrl: server.url, token: "legacy-owner-token-1234" }),
    { mode: 0o600 },
  );
  const store = memoryStore();
  store.set = async () => {
    throw new SecureStoreError(
      "STORE_PERMISSIONS",
      "refusing to use /home/owner/.coderax: group and other access is not allowed",
    );
  };

  const result = await invoke(["login", "--base-url", server.url], {
    env: { CODERAX_CONFIG: file },
    store,
    readSecret: async () => server.token,
  });

  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /STORE_PERMISSIONS/);
  assert.match(result.err, /group and other access/);
  assert.equal(result.out.includes(server.token), false);
  assert.equal(result.err.includes(server.token), false);
  assert.equal(store.entries().length, 0);
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.token, "legacy-owner-token-1234");
});

test("login fails when the credential store does not retain the record", async (t) => {
  const server = await startWorkflowHarness();
  t.after(() => server.close());
  const file = await tempConfig();
  await writeFile(
    file,
    JSON.stringify({ baseUrl: server.url, token: "legacy-owner-token-1234" }),
    { mode: 0o600 },
  );
  const store = memoryStore();
  const write = store.set;
  // Simulate a store that silently rewrites what it was given; the read-back
  // comparison is the only thing that can catch this.
  store.set = async (key, value) => {
    await write(key, `${value}\n`);
  };

  const result = await invoke(["login", "--base-url", server.url], {
    env: { CODERAX_CONFIG: file },
    store,
    readSecret: async () => server.token,
  });

  assert.equal(result.code, 3, result.out);
  assert.match(result.err, /CREDENTIAL_WRITE_FAILED/);
  assert.match(result.err, /did not retain/);
  assert.equal(result.err.includes(server.token), false);
  assert.equal(JSON.parse(await readFile(file, "utf8")).token, "legacy-owner-token-1234");
});

test("login verifies the owner before storing anything", async (t) => {
  const server = await startWorkflowHarness();
  t.after(() => server.close());
  const file = await tempConfig();
  const store = memoryStore();

  const result = await invoke(["login", "--base-url", server.url], {
    env: { CODERAX_CONFIG: file },
    store,
    readSecret: async () => "not-the-owner-token",
  });

  assert.equal(result.code, 3, result.out);
  assert.match(result.err, /UNAUTHENTICATED/);
  assert.equal(result.err.includes("not-the-owner-token"), false);
  assert.equal(store.entries().length, 0);
  await assert.rejects(readFile(file, "utf8"), (error) => error.code === "ENOENT");
});

test("status reports a corrupt credential without printing it", async () => {
  const file = await tempConfig();
  const baseUrl = "https://coderax.test";
  const store = memoryStore();
  await store.set(credentialAccount(baseUrl), "{not-json");

  const result = await invoke(["status", "--json"], {
    env: { CODERAX_CONFIG: file, CODERAX_BASE_URL: baseUrl },
    store,
  });

  assert.equal(result.code, 0, result.err);
  const payload = JSON.parse(result.out);
  assert.equal(payload.authenticated, false);
  assert.equal(payload.storedCredential, false);
  assert.match(payload.credentialError, /not valid JSON/);
  assert.equal(result.out.includes("{not-json"), false);
});

test("readStoredCredential rejects unknown versions, foreign deployments and empty tokens", async () => {
  const baseUrl = "https://coderax.test";
  const store = memoryStore();
  const key = credentialAccount(baseUrl);

  await store.set(key, JSON.stringify({ version: 99, baseUrl, token: "owner-token" }));
  await assert.rejects(
    readStoredCredential({ store, baseUrl }),
    (error) => error.code === "CREDENTIAL_CORRUPT" && /version/.test(error.message),
  );

  await store.set(key, JSON.stringify({ version: 1, baseUrl: "https://other.test", token: "owner-token" }));
  await assert.rejects(
    readStoredCredential({ store, baseUrl }),
    (error) => error.code === "CREDENTIAL_CORRUPT" && /different deployment/.test(error.message),
  );

  await store.set(key, JSON.stringify({ version: 1, baseUrl, token: "" }));
  await assert.rejects(
    readStoredCredential({ store, baseUrl }),
    (error) => error.code === "CREDENTIAL_CORRUPT" && /no access token/.test(error.message),
  );

  await store.set(key, JSON.stringify({ version: 1, baseUrl, token: "owner-token" }));
  assert.equal((await readStoredCredential({ store, baseUrl })).token, "owner-token");
});

test("login reads a private token file and clears the legacy plaintext token", async (t) => {
  const server = await startWorkflowHarness();
  t.after(() => server.close());
  const file = await tempConfig();
  await writeFile(
    file,
    JSON.stringify({ baseUrl: server.url, token: "legacy-owner-token-1234" }),
    { mode: 0o600 },
  );
  const tokenFile = join(dirname(file), "owner-token");
  await writeFile(tokenFile, `${server.token}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(tokenFile, 0o600);
  const store = memoryStore();

  const result = await invoke(["login", "--token-file", tokenFile, "--json"], {
    env: { CODERAX_CONFIG: file },
    store,
    fetchImpl: fetch,
  });

  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.includes(server.token), false);
  const payload = JSON.parse(result.out);
  assert.equal(payload.authenticated, true);
  assert.equal(payload.store, "memory");
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.token, null);
  assert.equal(stored.baseUrl, server.url);
  assert.equal(store.entries().length, 1);
  assert.equal(store.entries()[0][1].includes(server.token), true);
});

test("login refuses a group-readable token file", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not implement POSIX mode bits");
    return;
  }
  const file = await tempConfig();
  const tokenFile = join(dirname(file), "owner-token");
  await writeFile(tokenFile, "owner-token-from-file\n", { mode: 0o644 });
  await chmod(tokenFile, 0o644);
  const store = memoryStore();

  const result = await invoke(
    ["login", "--token-file", tokenFile, "--base-url", "https://coderax.test"],
    { env: { CODERAX_CONFIG: file }, store },
  );

  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /group or others/);
  assert.equal(result.err.includes("owner-token-from-file"), false);
  assert.equal(store.entries().length, 0);
});
