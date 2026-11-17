import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
export const DEFAULT_TIMEOUT_MS = 15000;

export function configPath(env = process.env) {
  const override = env.CODERAX_CONFIG?.trim();
  return override ? override : join(homedir(), ".coderax", "config.json");
}

/**
 * Validate a deployment URL. Remote deployments must use HTTPS; plain HTTP is
 * accepted only for loopback development, mirroring the Coderax client policy.
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ConfigError("BASE_URL_REQUIRED", "a base URL is required");
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError("BASE_URL_INVALID", "base URL must be an absolute URL, for example https://coderax.example.com");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("BASE_URL_CREDENTIALS", "base URL must not embed credentials; use --token or CODERAX_TOKEN");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = LOOPBACK_HOSTS.has(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConfigError(
      "BASE_URL_INSECURE",
      "remote deployments require HTTPS; HTTP is accepted only for localhost, 127.0.0.1, or ::1",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError("BASE_URL_INVALID", "base URL must not contain a query string or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { baseUrl: `${url.origin}${path}`, loopback };
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

/**
 * Precedence: environment over stored file. A token is never required at load
 * time so that `coderax config show` works before the first login.
 */
export async function loadConfig({ env = process.env, filePath, readFileImpl = readFile } = {}) {
  const path = filePath ?? configPath(env);
  const stored = await readStoredConfig(path, readFileImpl);

  const baseUrlRaw = env.CODERAX_BASE_URL?.trim() || stored.baseUrl;
  const token = env.CODERAX_TOKEN?.trim() || stored.token || null;
  const timeoutRaw = env.CODERAX_TIMEOUT_MS ?? stored.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number(timeoutRaw);

  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new ConfigError("TIMEOUT_INVALID", "timeout must be an integer between 100 and 120000 milliseconds");
  }

  return {
    configPath: path,
    baseUrl: baseUrlRaw ? normalizeBaseUrl(baseUrlRaw).baseUrl : null,
    token: typeof token === "string" && token !== "" ? token : null,
    timeoutMs,
  };
}

export async function saveConfig(
  patch,
  { filePath, readFileImpl = readFile, writeFileImpl = writeFile, mkdirImpl = mkdir, chmodImpl = chmod } = {},
) {
  const path = filePath ?? configPath();
  const stored = await readStoredConfig(path, readFileImpl);
  const next = { ...stored };

  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(patch.baseUrl).baseUrl;
  if (patch.token !== undefined) next.token = String(patch.token);
  if (patch.timeoutMs !== undefined) next.timeoutMs = Number(patch.timeoutMs);

  await mkdirImpl(dirname(path), { recursive: true });
  await writeFileImpl(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmodImpl(path, 0o600);
  } catch {
    // Windows has no POSIX mode bits; the file remains in the user profile.
  }
  return { path, config: next };
}

export function describeConfig(config) {
  return {
    configPath: config.configPath,
    baseUrl: config.baseUrl ?? null,
    tokenConfigured: config.token !== null,
    timeoutMs: config.timeoutMs,
  };
}
