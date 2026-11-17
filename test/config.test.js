import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  describeConfig,
  loadConfig,
  normalizeBaseUrl,
  saveConfig,
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

test("environment overrides the stored file", async () => {
  const path = await tempConfigPath();
  await saveConfig(
    { baseUrl: "https://stored.example.com", token: "stored-token" },
    { filePath: path },
  );

  const loaded = await loadConfig({
    env: { CODERAX_BASE_URL: "https://env.example.com", CODERAX_TOKEN: "env-token" },
    filePath: path,
  });

  assert.equal(loaded.baseUrl, "https://env.example.com");
  assert.equal(loaded.token, "env-token");
});

test("a missing config file is not an error", async () => {
  const loaded = await loadConfig({ env: {}, filePath: await tempConfigPath() });
  assert.equal(loaded.baseUrl, null);
  assert.equal(loaded.token, null);
  assert.equal(loaded.timeoutMs, 15000);
});

test("saved config is written as JSON and describeConfig never exposes the token", async () => {
  const path = await tempConfigPath();
  await saveConfig(
    { baseUrl: "https://coderax.example.com", token: "super-secret-token" },
    { filePath: path },
  );

  const raw = await readFile(path, "utf8");
  assert.match(raw, /super-secret-token/);

  const loaded = await loadConfig({ env: {}, filePath: path });
  const described = describeConfig(loaded);
  assert.equal(described.tokenConfigured, true);
  assert.equal(JSON.stringify(described).includes("super-secret-token"), false);
  assert.equal(JSON.stringify(described).includes("secret"), false);
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

  await saveConfig({ baseUrl: "https://one.example.com", token: "first-token" }, { filePath: path });
  await saveConfig({ token: "second-token" }, { filePath: path });

  const parsed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(parsed.token, "second-token");
  assert.equal(parsed.baseUrl, "https://one.example.com");
  assert.deepEqual(await readdir(directory), ["config.json"]);
});

test("a failed atomic replace does not report success", async () => {
  const path = await tempConfigPath();
  await assert.rejects(
    () =>
      saveConfig(
        { token: "x" },
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
