import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CoderaxError, UsageError } from "./errors.js";

export class ConfigError extends CoderaxError {
  constructor(code, message) {
    super(code, message);
    this.name = "ConfigError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_CHAT_PATH = "/api/ask/agents";
export const DEFAULT_ENDPOINT = "agents";
export const CREDENTIAL_STORES = Object.freeze(["auto", "keychain", "file", "memory"]);
export const CONFIG_KEYS = Object.freeze({
  "base-url": "baseUrl",
  "engine-url": "engineUrl",
  "chat-path": "chatPath",
  endpoint: "endpoint",
  model: "model",
  agent: "agent",
  timeout: "timeoutMs",
  "credential-store": "credentialStore",
  "refresh-command": "refreshCommand",
  theme: "theme",
  output: "output",
});

function envText(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

export function configDir(env = process.env) {
  const override = env.CODERAX_CONFIG_DIR?.trim();
  return override || join(homedir(), ".coderax");
}

export function configPath(env = process.env) {
  const override = env.CODERAX_CONFIG?.trim();
  return override || join(configDir(env), "config.json");
}

export function statePath(env = process.env) {
  return join(configDir(env), "state.json");
}

export function credentialDirectory(env = process.env) {
  return configDir(env);
}

/**
 * Remote URLs must be HTTPS. Plain HTTP is accepted only for loopback
 * development, matching the engine's own deployment policy.
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ConfigError("BASE_URL_REQUIRED", "a URL is required");
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError("BASE_URL_INVALID", "the URL must be absolute, for example https://coderax.example.com");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("BASE_URL_INVALID", "the URL must use https, or http on loopback");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("BASE_URL_CREDENTIALS", "the URL must not embed credentials; use the owner token instead");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = LOOPBACK_HOSTS.has(host);
  if (url.protocol === "http:" && !loopback) {
    throw new ConfigError("BASE_URL_INSECURE", "remote URLs require HTTPS; HTTP is accepted only for localhost, 127.0.0.1, or ::1");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError("BASE_URL_INVALID", "the URL must not contain a query string or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { baseUrl: `${url.origin}${path}`, loopback };
}

export function normalizeRefreshCommand(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new ConfigError("CONFIG_INVALID", "refresh-command must be a JSON array of 1-20 arguments");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 4096) {
      throw new ConfigError("CONFIG_INVALID", "every refresh-command argument must be a non-empty string");
    }
    if (/\u0000/.test(entry)) {
      throw new ConfigError("CONFIG_INVALID", "refresh-command arguments must not contain NUL");
    }
    return entry;
  });
}

async function readStoredConfig(path, readFileImpl) {
  try {
    const raw = await readFileImpl(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError("CONFIG_INVALID", `${path} must contain a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (error?.code === "ENOENT") return {};
    throw new ConfigError("CONFIG_UNREADABLE", `could not read ${path}`);
  }
}

function timeoutValue(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > 120_000) {
    throw new ConfigError("TIMEOUT_INVALID", "timeout must be an integer between 100 and 120000 milliseconds");
  }
  return value;
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Environment wins over the stored file. The token is absent on purpose: it is
 * read from the OS credential store by `loadToken`, never from this object.
 */
export async function loadConfig({
  env = process.env,
  filePath,
  readFileImpl = readFile,
  overrides = {},
} = {}) {
  const path = filePath ?? configPath(env);
  const stored = await readStoredConfig(path, readFileImpl);

  const baseUrlRaw = overrides.baseUrl ?? envText(env.CODERAX_BASE_URL) ?? stored.baseUrl;
  const engineUrlRaw = overrides.engineUrl ?? envText(env.CODERAX_ENGINE_URL) ?? stored.engineUrl;
  const timeoutRaw = overrides.timeoutMs ?? envText(env.CODERAX_TIMEOUT_MS) ?? stored.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const credentialStoreRaw = overrides.credentialStore
    ?? envText(env.CODERAX_CREDENTIAL_STORE)
    ?? stored.credentialStore
    ?? "auto";

  if (!CREDENTIAL_STORES.includes(credentialStoreRaw)) {
    throw new ConfigError("CONFIG_INVALID", `credential-store must be one of ${CREDENTIAL_STORES.join(", ")}`);
  }

  let refreshCommand = null;
  if (stored.refreshCommand !== undefined && stored.refreshCommand !== null) {
    try {
      refreshCommand = normalizeRefreshCommand(stored.refreshCommand);
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError("CONFIG_INVALID", "refresh-command must be valid JSON");
    }
  }

  return {
    configPath: path,
    baseUrl: baseUrlRaw ? normalizeBaseUrl(baseUrlRaw).baseUrl : null,
    engineUrl: engineUrlRaw ? normalizeBaseUrl(engineUrlRaw).baseUrl : null,
    timeoutMs: timeoutValue(timeoutRaw),
    chatPath: envText(env.CODERAX_CHAT_PATH) ?? stored.chatPath ?? DEFAULT_CHAT_PATH,
    endpoint: envText(env.CODERAX_ENDPOINT) ?? stored.endpoint ?? DEFAULT_ENDPOINT,
    model: envText(env.CODERAX_MODEL) ?? (textValue(stored.model) || undefined),
    agent: envText(env.CODERAX_AGENT) ?? (textValue(stored.agent) || undefined),
    credentialStore: credentialStoreRaw,
    refreshCommand,
    theme: envText(env.CODERAX_THEME) ?? stored.theme ?? "auto",
    output: envText(env.CODERAX_OUTPUT) ?? stored.output ?? "text",
    account: typeof stored.account === "string" ? stored.account : null,
    hasLegacyToken: typeof stored.token === "string" && stored.token.length > 0,
  };
}

/** The engine is the default target when a deployment URL is the only one set. */
export function resolveEngineUrl(config, env = process.env) {
  return env.CODERAX_ENGINE_URL?.trim() || config.engineUrl || config.baseUrl || null;
}

export async function saveConfig(patch, {
  filePath,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  unlinkImpl = unlink,
  mkdirImpl = mkdir,
  chmodImpl = chmod,
} = {}) {
  if (typeof patch.token === "string") {
    throw new UsageError("the owner token is stored in the OS credential store, not in config.json");
  }
  const path = filePath ?? configPath();
  const stored = await readStoredConfig(path, readFileImpl);
  const next = { ...stored };

  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(patch.baseUrl).baseUrl;
  if (patch.engineUrl !== undefined) next.engineUrl = normalizeBaseUrl(patch.engineUrl).baseUrl;
  if (patch.timeoutMs !== undefined) next.timeoutMs = timeoutValue(patch.timeoutMs);
  if (patch.chatPath !== undefined) next.chatPath = String(patch.chatPath);
  if (patch.endpoint !== undefined) next.endpoint = String(patch.endpoint);
  if (patch.model !== undefined) next.model = String(patch.model);
  if (patch.agent !== undefined) next.agent = String(patch.agent);
  if (patch.credentialStore !== undefined) {
    if (!CREDENTIAL_STORES.includes(patch.credentialStore)) {
      throw new ConfigError("CONFIG_INVALID", `credential-store must be one of ${CREDENTIAL_STORES.join(", ")}`);
    }
    next.credentialStore = patch.credentialStore;
  }
  if (patch.refreshCommand !== undefined) {
    const normalized = normalizeRefreshCommand(patch.refreshCommand);
    if (normalized === null) delete next.refreshCommand;
    else next.refreshCommand = normalized;
  }
  if (patch.theme !== undefined) next.theme = String(patch.theme);
  if (patch.output !== undefined) next.output = String(patch.output);
  if (patch.account !== undefined) next.account = patch.account === null ? null : String(patch.account);
  if (patch.token === null) delete next.token;

  await mkdirImpl(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFileImpl(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await chmodImpl(temp, 0o600);
    } catch (error) {
      if (process.platform !== "win32") {
        throw new ConfigError("CONFIG_PERMISSIONS", `could not restrict permissions on ${temp}`);
      }
    }
    await renameImpl(temp, path);
  } catch (error) {
    try {
      await unlinkImpl(temp);
    } catch {
      // Nothing to clean up.
    }
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("CONFIG_WRITE_FAILED", `could not write ${path} atomically`);
  }

  return { path, config: next };
}

/**
 * Token precedence: explicit flag, engine-specific environment, general
 * environment, OS credential store, legacy config file. A legacy token is
 * returned so `login`/`status` can migrate it and delete it from disk.
 */
export async function loadToken({ config, env = process.env, store, flagToken } = {}) {
  if (typeof flagToken === "string" && flagToken.trim() !== "") {
    return { token: flagToken.trim(), source: "flag" };
  }
  const engineEnv = env.CODERAX_ENGINE_TOKEN?.trim();
  if (engineEnv) return { token: engineEnv, source: "environment" };
  const generalEnv = env.CODERAX_TOKEN?.trim();
  if (generalEnv) return { token: generalEnv, source: "environment" };

  if (store) {
    const stored = await store.read();
    if (stored) return { token: stored, source: store.describe().requested === "memory" ? "memory" : "credential-store" };
  }

  if (config?.hasLegacyToken) {
    const raw = await readFile(config.configPath, "utf8").catch(() => "");
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.token === "string" && parsed.token.length > 0) {
        return { token: parsed.token, source: "legacy-config" };
      }
    } catch {
      // The config loader already validated the file; a race is not fatal.
    }
  }
  return { token: null, source: "none" };
}

export async function unsetConfig(keys, { filePath, readFileImpl = readFile, writeFileImpl = writeFile, renameImpl = rename, unlinkImpl = unlink, mkdirImpl = mkdir, chmodImpl = chmod } = {}) {
  const path = filePath ?? configPath();
  const stored = await readStoredConfig(path, readFileImpl);
  const next = { ...stored };
  for (const key of keys) {
    if (!Object.hasOwn(CONFIG_KEYS, key)) throw new UsageError(`unknown config key: ${key}`);
    delete next[CONFIG_KEYS[key]];
  }
  await mkdirImpl(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFileImpl(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await chmodImpl(temp, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    await renameImpl(temp, path);
  } catch (error) {
    try {
      await unlinkImpl(temp);
    } catch {
      // Ignore.
    }
    throw new ConfigError("CONFIG_WRITE_FAILED", `could not write ${path} atomically`);
  }
  return { path, config: next };
}

export function describeConfig(config, { tokenSource = "none", env = process.env } = {}) {
  return {
    configPath: config.configPath,
    baseUrl: config.baseUrl ?? null,
    engineUrl: resolveEngineUrl(config, env) ?? null,
    engineUrlExplicit: Boolean(config.engineUrl),
    tokenConfigured: tokenSource !== "none",
    tokenSource,
    timeoutMs: config.timeoutMs,
    chatPath: config.chatPath,
    endpoint: config.endpoint,
    model: config.model || null,
    agent: config.agent || null,
    credentialStore: config.credentialStore,
    refreshCommandConfigured: Array.isArray(config.refreshCommand),
    theme: config.theme,
    output: config.output,
    account: config.account ?? null,
  };
}

/** Never print a whole token, not even in `--json` output. */
export function maskToken(token) {
  if (!token) return null;
  if (token.length <= 8) return "*".repeat(token.length);
  return `${token.slice(0, 4)}\u2026${token.slice(-4)}`;
}
