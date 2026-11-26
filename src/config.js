import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureSecureDirectory, ensureSecureFile } from "./secure-store.js";

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SECRET_FIELDS = Object.freeze([
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "password",
  "clientSecret",
  "apiKey",
]);
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_CHAT_PATH = "/api/work/chat";
export const DEFAULT_ENDPOINT = "agents";

function envText(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

export function configDir(env = process.env) {
  const override = env.CODERAX_CONFIG_DIR?.trim();
  return override ? override : join(homedir(), ".coderax");
}

export function configPath(env = process.env) {
  const override = env.CODERAX_CONFIG?.trim();
  return override ? override : join(configDir(env), "config.json");
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
    throw new ConfigError("BASE_URL_CREDENTIALS", "base URL must not embed credentials; use `coderax login` or CODERAX_TOKEN");
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

async function assertRegularFile(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new ConfigError(
        "CONFIG_SYMLINK",
        `${path} is a symbolic link; refusing to read or write credentials through it`,
      );
    }
    if (!info.isFile()) {
      throw new ConfigError("CONFIG_INVALID", `${path} is not a regular file`);
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (error?.code !== "ENOENT") {
      throw new ConfigError("CONFIG_UNREADABLE", `could not inspect ${path}`);
    }
  }
}

async function readStoredConfig(path, readFileImpl) {
  await assertRegularFile(path);
  // Windows ignores POSIX modes. Repair and verify the ACL before trusting a
  // config that another process (or an older CLI) may have created with
  // inherited BUILTIN\Users access.
  if (process.platform === "win32") {
    try {
      await ensureSecureFile(path);
    } catch (error) {
      if (error?.reason !== "MISSING") {
        throw new ConfigError(
          "CONFIG_PERMISSIONS",
          `could not restrict permissions on ${path}: ${error.message}`,
        );
      }
    }
  }
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
 * Precedence: environment over stored file. No token is ever loaded from the
 * config file. A legacy token is surfaced only so it can be migrated and
 * removed; credentials belong in the OS credential store.
 */
export async function loadConfig({ env = process.env, filePath, readFileImpl = readFile, overrides = {} } = {}) {
  const path = filePath ?? configPath(env);
  const stored = await readStoredConfig(path, readFileImpl);

  const baseUrlRaw = overrides.baseUrl ?? envText(env.CODERAX_BASE_URL) ?? stored.baseUrl;
  const token = envText(env.CODERAX_TOKEN) ?? null;
  const timeoutRaw = overrides.timeoutMs ?? envText(env.CODERAX_TIMEOUT_MS) ?? stored.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number(timeoutRaw);

  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new ConfigError("TIMEOUT_INVALID", "timeout must be an integer between 100 and 120000 milliseconds");
  }

  return {
    configPath: path,
    baseUrl: baseUrlRaw ? normalizeBaseUrl(baseUrlRaw).baseUrl : null,
    token: typeof token === "string" && token !== "" ? token : null,
    timeoutMs,
    chatPath: env.CODERAX_CHAT_PATH?.trim() || stored.chatPath || DEFAULT_CHAT_PATH,
    endpoint: env.CODERAX_ENDPOINT?.trim() || stored.endpoint || DEFAULT_ENDPOINT,
    model: env.CODERAX_MODEL?.trim() || stored.model || "",
    agent: env.CODERAX_AGENT?.trim() || stored.agent || "",
    output: stored.output || "text",
    // A non-secret trust anchor recorded on first login. It pins future logins
    // and token issuers to the deployment the owner originally approved.
    trustedIssuer: envText(env.CODERAX_ISSUER) ?? (typeof stored.issuer === "string" ? stored.issuer : null),
    // Display-only hints from older builds. Never use these for authorization;
    // every owner check is made against the authenticated deployment.
    account: typeof stored.account === "string" ? stored.account : null,
    role: typeof stored.role === "string" ? stored.role : null,
    sessions:
      stored.sessions !== null && typeof stored.sessions === "object" && !Array.isArray(stored.sessions)
        ? stored.sessions
        : {},
    hasLegacyPlaintextToken: SECRET_FIELDS.some(
      (field) => typeof stored[field] === "string" && stored[field] !== "",
    ),
  };
}

/** Read a legacy plaintext token only so it can be migrated and removed. */
export async function readLegacyToken({ filePath, readFileImpl = readFile } = {}) {
  const path = filePath ?? configPath();
  const stored = await readStoredConfig(path, readFileImpl);
  // Older builds used `accessToken`; both are migrated as an access token. A
  // lone refresh token is not usable as a session and is only reported/removed.
  const token = [stored.token, stored.accessToken]
    .find((value) => typeof value === "string" && value.trim() !== "");
  return typeof token === "string" ? token.trim() : null;
}

async function writeStoredConfig(
  path,
  next,
  {
    writeFileImpl = writeFile,
    renameImpl = rename,
    unlinkImpl = unlink,
    mkdirImpl = mkdir,
    chmodImpl = chmod,
  } = {},
) {
  await mkdirImpl(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    try {
      await ensureSecureDirectory(dirname(path));
    } catch (error) {
      throw new ConfigError(
        "CONFIG_PERMISSIONS",
        `could not restrict permissions on ${dirname(path)}: ${error.message}`,
      );
    }
  }

  // Write a fresh 0600 file and atomically replace the config, so an existing
  // world-readable file never receives secret material even for an instant.
  const tempPath = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFileImpl(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await chmodImpl(tempPath, 0o600);
    } catch (error) {
      if (process.platform !== "win32") {
        throw new ConfigError("CONFIG_PERMISSIONS", `could not restrict permissions on ${tempPath}`);
      }
    }
    if (process.platform === "win32") {
      await ensureSecureFile(tempPath);
    }
    await renameImpl(tempPath, path);
    if (process.platform === "win32") {
      await ensureSecureFile(path);
    }
  } catch (error) {
    try {
      await unlinkImpl(tempPath);
    } catch {
      // Nothing to clean up.
    }
    if (error instanceof ConfigError) throw error;
    if (error?.code === "STORE_PERMISSIONS") {
      throw new ConfigError("CONFIG_PERMISSIONS", error.message);
    }
    throw new ConfigError("CONFIG_WRITE_FAILED", `could not write ${path} atomically`);
  }
}

export async function saveConfig(
  patch,
  {
    filePath,
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    renameImpl = rename,
    unlinkImpl = unlink,
    mkdirImpl = mkdir,
    chmodImpl = chmod,
  } = {},
) {
  const path = filePath ?? configPath();

  for (const field of SECRET_FIELDS) {
    if (Object.hasOwn(patch, field) && patch[field] !== undefined) {
      throw new ConfigError(
        "CONFIG_SECRET_REJECTED",
        `refusing to write ${field} to the plaintext config; credentials belong in the OS credential store`,
      );
    }
  }

  await assertRegularFile(path);
  const stored = await readStoredConfig(path, readFileImpl);
  const next = { ...stored };
  // No credential field may survive an unrelated config write, including
  // fields written by an older CLI that kept tokens in this file.
  for (const field of SECRET_FIELDS) delete next[field];

  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(patch.baseUrl).baseUrl;
  if (patch.issuer !== undefined) {
    const issuer = new URL(String(patch.issuer));
    next.issuer = issuer.origin;
  }
  if (patch.timeoutMs !== undefined) next.timeoutMs = Number(patch.timeoutMs);
  if (patch.chatPath !== undefined) next.chatPath = String(patch.chatPath);
  if (patch.endpoint !== undefined) next.endpoint = String(patch.endpoint);
  if (patch.model !== undefined) next.model = String(patch.model);
  if (patch.agent !== undefined) next.agent = String(patch.agent);
  if (patch.output !== undefined) next.output = String(patch.output);
  if (patch.account !== undefined) next.account = patch.account === null ? null : String(patch.account);
  if (patch.role !== undefined) next.role = patch.role === null ? null : String(patch.role);
  if (patch.sessions !== undefined) {
    next.sessions =
      patch.sessions === null
        ? {}
        : Object.fromEntries(
            Object.entries(patch.sessions).filter(
              ([, entry]) => entry !== null && typeof entry === "object" && !Array.isArray(entry),
            ),
          );
  }

  await writeStoredConfig(path, next, { writeFileImpl, renameImpl, unlinkImpl, mkdirImpl, chmodImpl });
  return { path, config: next };
}

/** Remove a legacy plaintext token in place, without ever rewriting it. */
export async function stripLegacyToken({
  filePath,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  unlinkImpl = unlink,
  mkdirImpl = mkdir,
  chmodImpl = chmod,
} = {}) {
  const path = filePath ?? configPath();
  const stored = await readStoredConfig(path, readFileImpl);
  const hadSecret = SECRET_FIELDS.some(
    (field) => typeof stored[field] === "string" && stored[field] !== "",
  );
  if (!SECRET_FIELDS.some((field) => Object.hasOwn(stored, field))) return false;
  const next = { ...stored };
  for (const field of SECRET_FIELDS) delete next[field];
  await writeStoredConfig(path, next, { writeFileImpl, renameImpl, unlinkImpl, mkdirImpl, chmodImpl });
  return hadSecret;
}

export function describeConfig(config) {
  return {
    configPath: config.configPath,
    baseUrl: config.baseUrl ?? null,
    tokenConfigured: Boolean(config.token),
    legacyPlaintextToken: Boolean(config.hasLegacyPlaintextToken),
    timeoutMs: config.timeoutMs,
    chatPath: config.chatPath,
    endpoint: config.endpoint,
    model: config.model,
    agent: config.agent ?? "",
    account: config.account ?? null,
    role: config.role ?? null,
    conversationCount: Object.keys(config.sessions ?? {}).length,
    output: config.output,
  };
}

/** Never print a whole token, not even in `--json` output. */
export function maskToken(token) {
  if (!token) return null;
  if (token.length <= 8) return "*".repeat(token.length);
  return `${token.slice(0, 4)}\u2026${token.slice(-4)}`;
}
