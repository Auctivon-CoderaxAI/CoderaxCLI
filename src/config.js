import { chmod, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deleteCredential, readCredential, writeCredential } from "./credentials.js";

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_CHAT_PATH = "/api/ask/agents";
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
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new ConfigError(
        "CONFIG_SYMLINK",
        `${path} is a symbolic link; refusing to read credentials through it. ` +
          "Replace it with a regular file owned by you.",
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
export async function loadConfig({ env = process.env, filePath, readFileImpl = readFile, overrides = {} } = {}) {
  const path = filePath ?? configPath(env);
  const stored = await readStoredConfig(path, readFileImpl);

  // A credential file readable by another account is refused rather than used.
  // Windows has no POSIX mode bits; ACL inheritance is the platform control.
  if (stored.token && process.platform !== "win32") {
    try {
      const info = await stat(path);
      if ((info.mode & 0o077) !== 0) {
        throw new ConfigError(
          "CONFIG_INSECURE_PERMISSIONS",
          `${path} is readable by group or others (mode ${(info.mode & 0o777).toString(8)}); run \`chmod 600 ${path}\``,
        );
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError("CONFIG_UNREADABLE", `could not check permissions on ${path}`);
    }
  }

  const baseUrlRaw = overrides.baseUrl ?? envText(env.CODERAX_BASE_URL) ?? stored.baseUrl;
  // A token kept outside the file (OS credential store) is read here so callers
  // see one resolved setting regardless of where the operator stored it.
  let storedToken = stored.token;
  if (!storedToken && typeof stored.tokenStore === "string") {
    storedToken = await readCredential({ backend: stored.tokenStore, account: stored.account, env });
  }
  const token = env.CODERAX_TOKEN?.trim() || storedToken || null;
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
    account: typeof stored.account === "string" ? stored.account : null,
    role: typeof stored.role === "string" ? stored.role : null,
    tokenStore: typeof stored.tokenStore === "string" ? stored.tokenStore : "file",
    sessions:
      stored.sessions !== null && typeof stored.sessions === "object" && !Array.isArray(stored.sessions)
        ? stored.sessions
        : {},
  };
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
    credentialStore = "file",
    credentialDeps = {},
    env = process.env,
  } = {},
) {
  const path = filePath ?? configPath();
  const stored = await readStoredConfig(path, readFileImpl);
  const next = { ...stored };

  // Never write credentials through a symlink an attacker could have planted.
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new ConfigError("CONFIG_SYMLINK", `${path} is a symbolic link; refusing to write credentials through it`);
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (error?.code !== "ENOENT") {
      throw new ConfigError("CONFIG_UNREADABLE", `could not inspect ${path}`);
    }
  }

  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(patch.baseUrl).baseUrl;
  if (patch.token !== undefined) {
    const account = patch.account ?? stored.account ?? null;
    if (patch.token === null) {
      await deleteCredential({ backend: credentialStore, account, env, deps: credentialDeps });
      next.token = null;
      next.tokenStore = null;
    } else if (credentialStore !== "file") {
      // The token lives in the OS store; the config file keeps only the backend
      // name, so a copied config file cannot leak the credential.
      await writeCredential({ backend: credentialStore, account, token: String(patch.token), env, deps: credentialDeps });
      next.token = null;
      next.tokenStore = credentialStore;
    } else {
      next.token = String(patch.token);
      next.tokenStore = null;
    }
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

  await mkdirImpl(dirname(path), { recursive: true, mode: 0o700 });

  // Write a fresh 0600 file and atomically replace the config, so an existing
  // world-readable file never receives the token even for an instant.
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
    await renameImpl(tempPath, path);
  } catch (error) {
    try {
      await unlinkImpl(tempPath);
    } catch {
      // Nothing to clean up.
    }
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("CONFIG_WRITE_FAILED", `could not write ${path} atomically`);
  }

  return { path, config: next };
}

export function describeConfig(config) {
  return {
    configPath: config.configPath,
    baseUrl: config.baseUrl ?? null,
    tokenConfigured: Boolean(config.token),
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
