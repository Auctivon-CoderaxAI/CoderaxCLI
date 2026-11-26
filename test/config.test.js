import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  describeConfig,
  loadConfig,
  normalizeBaseUrl,
  readLegacyToken,
  saveConfig,
  stripLegacyToken,
} from "../src/config.js";

async function tempConfigPath() {
  const directory = await mkdtemp(join(tmpdir(), "coderax-config-"));
  return join(directory, "config.json");
}

test("https URLs are accepted and normalized", () => {
  assert.equal(normalizeBaseUrl("https://Coderax.Example.com/").baseUrl, "https://coderax.example.com");
  assert.equal(normalizeBaseUrl("https://example.com/coderax/").baseUrl, "https://example.com/coderax");
});

test("plain HTTP is rejected for remote hosts", () => {
  assert.throws(
    () => normalizeBaseUrl("http://coderax.example.com"),
    (error) => error instanceof ConfigError && error.code === "BASE_URL_INSECURE",
  );
});

test("plain HTTP is allowed only on loopback", () => {
  assert.equal(normalizeBaseUrl("http://localhost:3080").baseUrl, "http://localhost:3080");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:3080/").baseUrl, "http://127.0.0.1:3080");
  assert.equal(normalizeBaseUrl("http://[::1]:3080").baseUrl, "http://[::1]:3080");
});

test("embedded credentials and fragments are rejected", () => {
  assert.throws(
    () => normalizeBaseUrl("https://user:pass@example.com"),
    (error) => error instanceof ConfigError && error.code === "BASE_URL_CREDENTIALS",
  );
  assert.throws(
    () => normalizeBaseUrl("https://example.com/#frag"),
    (error) => error instanceof ConfigError && error.code === "BASE_URL_INVALID",
  );
});

test("explicit overrides bypass invalid lower-priority settings", async () => {
  const path = await tempConfigPath();
  const loaded = await loadConfig({
    env: { CODERAX_BASE_URL: "http://remote.example.com", CODERAX_TIMEOUT_MS: "bad" },
    filePath: path,
    overrides: { baseUrl: "https://coderax.test", timeoutMs: "1000" },
  });

  assert.equal(loaded.baseUrl, "https://coderax.test");
  assert.equal(loaded.timeoutMs, 1000);
});

test("environment overrides the stored file and is the only token source", async () => {
  const path = await tempConfigPath();
  await saveConfig({ baseUrl: "https://stored.example.com" }, { filePath: path });

  const loaded = await loadConfig({
    env: { CODERAX_BASE_URL: "https://env.example.com", CODERAX_TOKEN: "env-token" },
    filePath: path,
  });

  assert.equal(loaded.baseUrl, "https://env.example.com");
  assert.equal(loaded.token, "env-token");
  assert.equal(loaded.hasLegacyPlaintextToken, false);
});

test("empty environment values do not mask stored settings", async () => {
  const path = await tempConfigPath();
  await saveConfig({ baseUrl: "https://stored.example.com", timeoutMs: 2500 }, { filePath: path });

  const loaded = await loadConfig({
    env: { CODERAX_BASE_URL: "", CODERAX_TIMEOUT_MS: "" },
    filePath: path,
  });

  assert.equal(loaded.baseUrl, "https://stored.example.com");
  assert.equal(loaded.timeoutMs, 2500);
});

test("a missing config file is not an error", async () => {
  const loaded = await loadConfig({ env: {}, filePath: await tempConfigPath() });
  assert.equal(loaded.baseUrl, null);
  assert.equal(loaded.token, null);
  assert.equal(loaded.timeoutMs, 15000);
});

test("saveConfig refuses to write credentials into the plaintext config", async () => {
  const path = await tempConfigPath();
  for (const patch of [
    { token: "super-secret-token" },
    { accessToken: "super-secret-token" },
    { refreshToken: "super-secret-token" },
    { apiKey: "super-secret-token" },
  ]) {
    await assert.rejects(
      () => saveConfig(patch, { filePath: path }),
      (error) => error instanceof ConfigError && error.code === "CONFIG_SECRET_REJECTED",
    );
  }
});

test("a legacy plaintext token is detected, never loaded, and can be stripped", async () => {
  const path = await tempConfigPath();
  await writeFile(path, JSON.stringify({ baseUrl: "https://coderax.example.com", token: "legacy-secret" }), "utf8");

  const loaded = await loadConfig({ env: {}, filePath: path });
  const described = describeConfig(loaded);
  assert.equal(loaded.token, null);
  assert.equal(described.tokenConfigured, false);
  assert.equal(described.legacyPlaintextToken, true);
  assert.equal(JSON.stringify(described).includes("legacy-secret"), false);

  assert.equal(await readLegacyToken({ filePath: path }), "legacy-secret");
  assert.equal(await stripLegacyToken({ filePath: path }), true);
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(Object.hasOwn(stored, "token"), false);
  assert.equal(await readLegacyToken({ filePath: path }), null);
});

test("a legacy accessToken is detected as a plaintext credential and migrated as a token", async () => {
  const path = await tempConfigPath();
  await writeFile(path, JSON.stringify({ baseUrl: "https://coderax.example.com", accessToken: "legacy-access" }), "utf8");

  const loaded = await loadConfig({ env: {}, filePath: path });
  assert.equal(loaded.token, null);
  assert.equal(loaded.hasLegacyPlaintextToken, true);
  assert.equal(await readLegacyToken({ filePath: path }), "legacy-access");
  assert.equal(await stripLegacyToken({ filePath: path }), true);
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(Object.hasOwn(stored, "accessToken"), false);
});

test("an unrelated write removes every legacy secret field", async () => {
  const path = await tempConfigPath();
  await writeFile(
    path,
    JSON.stringify({
      baseUrl: "https://coderax.example.com",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      clientSecret: "old-client-secret",
    }),
    "utf8",
  );

  await saveConfig({ model: "next-model" }, { filePath: path });
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.model, "next-model");
  for (const field of ["token", "accessToken", "refreshToken", "clientSecret"]) {
    assert.equal(Object.hasOwn(stored, field), false);
  }
});

test("invalid stored timeout is rejected", async () => {
  const path = await tempConfigPath();
  await writeFile(path, JSON.stringify({ timeoutMs: 5 }), "utf8");
  await assert.rejects(
    () => loadConfig({ env: {}, filePath: path }),
    (error) => error instanceof ConfigError && error.code === "TIMEOUT_INVALID",
  );
});

test("a non-object config file is rejected", async () => {
  const path = await tempConfigPath();
  await writeFile(path, "[]", "utf8");
  await assert.rejects(
    () => loadConfig({ env: {}, filePath: path }),
    (error) => error instanceof ConfigError && error.code === "CONFIG_INVALID",
  );
});

test("rewriting an existing config replaces it atomically and leaves no temp files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coderax-config-"));
  const path = join(directory, "config.json");

  await saveConfig({ baseUrl: "https://one.example.com", model: "first-model" }, { filePath: path });
  await saveConfig({ model: "second-model" }, { filePath: path });

  const parsed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(parsed.model, "second-model");
  assert.equal(parsed.baseUrl, "https://one.example.com");
  assert.equal(Object.hasOwn(parsed, "token"), false);
  assert.deepEqual(await readdir(directory), ["config.json"]);
});

test("creates the config directory with mode 0700", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coderax-config-"));
  const path = join(directory, "nested", "config.json");
  let received;

  await saveConfig(
    { baseUrl: "https://coderax.example.com" },
    {
      filePath: path,
      mkdirImpl: async (target, options) => {
        received = options;
        await mkdir(target, options);
      },
    },
  );

  assert.equal(received.mode, 0o700);
  assert.equal(received.recursive, true);
});

test("a failed atomic replace does not report success", async () => {
  const path = await tempConfigPath();
  await assert.rejects(
    () =>
      saveConfig(
        { baseUrl: "https://coderax.example.com" },
        {
          filePath: path,
          renameImpl: async () => {
            const error = new Error("rename denied");
            error.code = "EPERM";
            throw error;
          },
        },
      ),
    (error) => error instanceof ConfigError && error.code === "CONFIG_WRITE_FAILED",
  );
});
