import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigError,
  describeConfig,
  loadConfig,
  loadToken,
  maskToken,
  normalizeBaseUrl,
  normalizeRefreshCommand,
  saveConfig,
  unsetConfig,
} from "../src/config.js";
import { tempDir } from "./helpers.js";

const TOKEN = "owner-token-0123456789";

async function path() {
  const dir = await tempDir();
  return join(dir, "config.json");
}

test("URLs normalize and enforce HTTPS for non-loopback hosts", () => {
  assert.equal(normalizeBaseUrl("https://Coderax.Example.com/").baseUrl, "https://coderax.example.com");
  assert.equal(normalizeBaseUrl("https://example.com/coderax/").baseUrl, "https://example.com/coderax");
  assert.equal(normalizeBaseUrl("http://localhost:3080/").baseUrl, "http://localhost:3080");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:3080/").baseUrl, "http://127.0.0.1:3080");
  assert.equal(normalizeBaseUrl("http://[::1]:3080/").baseUrl, "http://[::1]:3080");
  assert.throws(() => normalizeBaseUrl("http://coderax.example.com"), (error) => error.code === "BASE_URL_INSECURE");
  assert.throws(() => normalizeBaseUrl("https://user:pass@example.com"), (error) => error.code === "BASE_URL_CREDENTIALS");
  assert.throws(() => normalizeBaseUrl("https://example.com/#frag"), (error) => error.code === "BASE_URL_INVALID");
  assert.throws(() => normalizeBaseUrl("ftp://example.com"), (error) => error.code === "BASE_URL_INVALID");
});

test("refresh helpers must be a non-empty JSON argument array", () => {
  assert.deepEqual(normalizeRefreshCommand('["coderax-auth","refresh"]'), ["coderax-auth", "refresh"]);
  assert.equal(normalizeRefreshCommand(""), null);
  assert.throws(() => normalizeRefreshCommand("[]"), ConfigError);
  assert.throws(() => normalizeRefreshCommand('["ok",3]'), ConfigError);
  assert.throws(() => normalizeRefreshCommand('["ok\\u0000"]'), ConfigError);
});

test("missing configuration is valid and has safe defaults", async () => {
  const loaded = await loadConfig({ env: {}, filePath: await path() });
  assert.equal(loaded.baseUrl, null);
  assert.equal(loaded.engineUrl, null);
  assert.equal(loaded.timeoutMs, 30_000);
  assert.equal(loaded.agent, undefined);
  assert.equal(loaded.model, undefined);
  assert.equal(loaded.refreshCommand, null);
});

test("environment overrides stored values and empty values do not mask them", async () => {
  const filePath = await path();
  await saveConfig({ baseUrl: "https://stored.example", timeoutMs: 2500, agent: "opencode" }, { filePath });
  const env = await loadConfig({
    env: { CODERAX_BASE_URL: "https://env.example", CODERAX_TIMEOUT_MS: "", CODERAX_AGENT: "" },
    filePath,
  });
  assert.equal(env.baseUrl, "https://env.example");
  assert.equal(env.timeoutMs, 2500);
  assert.equal(env.agent, "opencode");
});

test("the engine URL falls back to the deployment URL and an explicit env wins", () => {
  const config = { engineUrl: null, baseUrl: "https://deployment.example" };
  assert.equal(new URL("https://deployment.example").origin, "https://deployment.example");
  const loaded = { ...config, configPath: "x", timeoutMs: 1, chatPath: "/", endpoint: "agents", model: undefined, agent: undefined, credentialStore: "auto", refreshCommand: null, theme: "auto", output: "text", account: null, hasLegacyToken: false };
  assert.equal(describeConfig(loaded, { env: {} }).engineUrl, "https://deployment.example");
  assert.equal(describeConfig(loaded, { env: { CODERAX_ENGINE_URL: "https://env.example" } }).engineUrl, "https://env.example");
});

test("a token can never be written into config.json", async () => {
  const filePath = await path();
  await assert.rejects(() => saveConfig({ token: TOKEN }, { filePath }), (error) => error.code === "USAGE");
});

test("save writes 0600 JSON atomically and token:null removes a legacy token", async () => {
  const filePath = await path();
  await saveConfig({ engineUrl: "https://engine.example", model: "p/m" }, { filePath });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(parsed.engineUrl, "https://engine.example");
  assert.equal(parsed.model, "p/m");

  await saveConfig({ token: null }, { filePath });
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).token, undefined);
});

test("legacy tokens are detected but never loaded into the config object", async () => {
  const filePath = await path();
  await writeFile(filePath, JSON.stringify({ token: TOKEN }), "utf8");
  const loaded = await loadConfig({ env: {}, filePath });
  assert.equal(loaded.hasLegacyToken, true);
  assert.equal(JSON.stringify(loaded).includes(TOKEN), false);
  const token = await loadToken({ config: loaded, env: {} });
  assert.equal(token.token, TOKEN);
  assert.equal(token.source, "legacy-config");
});

test("token precedence is flag, engine env, general env, store", async () => {
  const config = { hasLegacyToken: false, configPath: "/nonexistent" };
  assert.deepEqual(
    await loadToken({ config, env: {}, flagToken: "flag-token" }),
    { token: "flag-token", source: "flag" },
  );
  assert.deepEqual(
    await loadToken({ config, env: { CODERAX_ENGINE_TOKEN: "engine-token", CODERAX_TOKEN: "general-token" } }),
    { token: "engine-token", source: "environment" },
  );
  assert.deepEqual(
    await loadToken({ config, env: { CODERAX_TOKEN: "general-token" } }),
    { token: "general-token", source: "environment" },
  );
  const store = { read: async () => "stored-token", describe: () => ({ requested: "file" }) };
  assert.deepEqual(await loadToken({ config, env: {}, store }), { token: "stored-token", source: "credential-store" });
});

test("describeConfig never includes the token and reports its source", () => {
  const config = {
    configPath: "/tmp/c.json",
    baseUrl: null,
    engineUrl: null,
    timeoutMs: 1000,
    chatPath: "/api/ask",
    endpoint: "agents",
    model: undefined,
    agent: undefined,
    credentialStore: "auto",
    refreshCommand: null,
    theme: "auto",
    output: "text",
    account: null,
    hasLegacyToken: false,
  };
  const described = describeConfig(config, { tokenSource: "credential-store" });
  assert.equal(described.tokenConfigured, true);
  assert.equal(JSON.stringify(described).includes(TOKEN), false);
  assert.equal(maskToken(TOKEN).includes(TOKEN), false);
  assert.equal(maskToken("short"), "*****");
});

test("unsetConfig removes only known keys and rejects inherited names", async () => {
  const filePath = await path();
  await saveConfig({ engineUrl: "https://engine.example", model: "p/m" }, { filePath });
  await unsetConfig(["model"], { filePath });
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).model, undefined);
  await assert.rejects(() => unsetConfig(["constructor"], { filePath }), /unknown config key/);
});

test("invalid stored values fail loudly", async () => {
  const filePath = await path();
  await writeFile(filePath, JSON.stringify({ timeoutMs: 5 }), "utf8");
  await assert.rejects(() => loadConfig({ env: {}, filePath }), (error) => error.code === "TIMEOUT_INVALID");
  await writeFile(filePath, JSON.stringify([]), "utf8");
  await assert.rejects(() => loadConfig({ env: {}, filePath }), (error) => error.code === "CONFIG_INVALID");
});

test("credential store values are validated before use", async () => {
  const filePath = await path();
  await writeFile(filePath, JSON.stringify({ credentialStore: "vault" }), "utf8");
  await assert.rejects(() => loadConfig({ env: {}, filePath }), (error) => error.code === "CONFIG_INVALID");
});
