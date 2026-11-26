import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redact } from "./client.js";
import { configDir } from "./config.js";
import { ensureSecureDirectory, ensureSecureFile } from "./secure-store.js";

/**
 * Credentials live in an operating-system credential store, never in the
 * plaintext configuration file. Every provider reads the secret over stdin or
 * writes it through the OS API; no provider puts a token in argv.
 */
export const CREDENTIAL_SERVICE = "coderax-cli";
const COMMAND_TIMEOUT_MS = 15000;

export class CredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
  }
}

function credentialError(code, message) {
  return new CredentialError(code, message);
}

/** Helpers never need the CLI's session token in their environment. */
export function childEnvironment(env = process.env) {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (key.toLowerCase() === "coderax_token") delete copy[key];
  }
  return copy;
}

/** Stable, non-reversible key so a URL never becomes a keychain account name. */
export function credentialAccount(baseUrl) {
  return createHash("sha256").update(String(baseUrl)).digest("hex").slice(0, 40);
}

function clean(value, secret) {
  const text = typeof value === "string" ? value : "";
  return redact(text, secret).replace(/\s+/g, " ").trim().slice(0, 300);
}

function storeFailure(result, action, secret) {
  // Never use stdout for an error excerpt: on a failed read it may contain the
  // very secret we are trying to keep out of diagnostics.
  const detail = clean(result.stderr, secret);
  const locked = result.code === 36 || /interaction is not allowed|locked|keyring/i.test(detail);
  return credentialError(
    locked ? "CREDENTIAL_STORE_LOCKED" : "CREDENTIAL_STORE_FAILED",
    `could not ${action} the Coderax credential${detail ? `: ${detail}` : ""}`,
  );
}

/**
 * Run a credential helper without a shell. `input` carries the secret and is
 * never put into argv. Helper output is treated as untrusted and is scrubbed of
 * the input before it can reach an error message.
 */
export async function runProcess(
  command,
  args,
  { input = "", timeoutMs = COMMAND_TIMEOUT_MS, env = process.env } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: childEnvironment(env),
      });
    } catch {
      reject(credentialError("CREDENTIAL_STORE_FAILED", `could not start ${command}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        reject,
        credentialError("CREDENTIAL_STORE_TIMEOUT", `${command} did not respond within ${timeoutMs}ms`),
      );
    }, timeoutMs);

    child.on("error", (cause) => {
      const code = cause?.code === "ENOENT" ? "CREDENTIAL_STORE_MISSING" : "CREDENTIAL_STORE_FAILED";
      finish(
        reject,
        credentialError(
          code,
          `${command} could not be executed${cause?.code ? ` (${cause.code})` : ""}`,
        ),
      );
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => {
      finish(resolve, { code: code ?? (signal ? 1 : 0), signal, stdout, stderr });
    });
    // A helper may exit before reading stdin; that is reported by its exit code.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function findOnPath(binary, env, platform) {
  const path = env.PATH ?? env.Path ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const names = [binary];
  // Do not append .EXE to a name that already carries an extension.
  if (platform === "win32" && !/\.[^\\/]+$/.test(binary)) {
    for (const extension of (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")) {
      if (extension) names.push(`${binary}${extension}`);
    }
  }
  for (const directory of path.split(separator)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
}

/** Quote one argument for `security -i`, whose parser is not a shell. */
function quoteSecurityArgument(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function macKeychainStore({ run, env }) {
  const binary = "/usr/bin/security";
  const available = existsSync(binary);
  const detail = available
    ? "macOS Keychain via /usr/bin/security"
    : "macOS Keychain tool /usr/bin/security was not found";

  async function get(account) {
    if (!available) throw credentialError("CREDENTIAL_STORE_UNAVAILABLE", detail);
    const result = await run(
      binary,
      ["find-generic-password", "-s", CREDENTIAL_SERVICE, "-a", account, "-w"],
      { env },
    );
    if (result.code === 44) return null;
    if (result.code !== 0) throw storeFailure(result, "read", "");
    let secret = result.stdout;
    if (secret.endsWith("\n")) secret = secret.slice(0, -1);
    return secret === "" ? null : secret;
  }

  async function set(account, secret) {
    if (!available) throw credentialError("CREDENTIAL_STORE_UNAVAILABLE", detail);
    // -w with a value would expose the token in the process list. `security -i`
    // reads the command (and therefore the value) from stdin instead.
    const command = [
      "add-generic-password",
      "-U",
      "-s",
      quoteSecurityArgument(CREDENTIAL_SERVICE),
      "-a",
      quoteSecurityArgument(account),
      "-w",
      quoteSecurityArgument(secret),
    ].join(" ");
    const result = await run(binary, ["-i"], { env, input: `${command}\n` });
    if (result.code !== 0) throw storeFailure(result, "write", secret);
    // `security -i` reports command failures inconsistently across versions;
    // read the item back so a silent failure is never reported as success.
    const stored = await get(account);
    if (stored !== secret) {
      throw credentialError("CREDENTIAL_WRITE_FAILED", "macOS Keychain did not retain the credential");
    }
  }

  async function remove(account) {
    if (!available) throw credentialError("CREDENTIAL_STORE_UNAVAILABLE", detail);
    const result = await run(
      binary,
      ["delete-generic-password", "-s", CREDENTIAL_SERVICE, "-a", account],
      { env },
    );
    if (result.code === 44) return false;
    if (result.code !== 0) throw storeFailure(result, "remove", "");
    return true;
  }

  return { name: "macos-keychain", secure: available, available, detail, get, set, delete: remove };
}

function libsecretStore({ run, env, platform }) {
  const binary = findOnPath("secret-tool", env, platform);
  const available = Boolean(binary);
  const detail = available
    ? `${binary} (libsecret Secret Service)`
    : "secret-tool was not found; install libsecret-tools and unlock your keyring";

  const attributes = (account) => ["service", CREDENTIAL_SERVICE, "account", account];

  async function get(account) {
    if (!available) throw credentialError("CREDENTIAL_STORE_UNAVAILABLE", detail);
    const result = await run(binary, ["lookup", ...attributes(account)], { env });
    if (result.code === 0) {
      let secret = result.stdout;
      // secret-tool adds a newline only when stdout is a terminal. A pipe gets
      // the exact stored bytes, so only strip a newline if one is present.
      if (secret.endsWith("\r\n")) secret = secret.slice(0, -2);
      else if (secret.endsWith("\n")) secret = secret.slice(0, -1);
      return secret === "" ? null : secret;
    }
    const detailText = result.stderr.trim();
    if (detailText === "" || /no matching/i.test(detailText)) return null;
    throw storeFailure(result, "read", "");
  }

  async function set(account, secret) {
    if (!available) throw credentialError("CREDENTIAL_STORE_UNAVAILABLE", detail);
    // secret-tool reads the password from stdin until EOF. Do not append a
    // newline: it would become part of the stored value.
    const result = await run(
      binary,
      ["store", "--label", "Coderax CLI", ...attributes(account)],
      { env, input: secret },
    );
    if (result.code !== 0) throw storeFailure(result, "write", secret);
  }

  async function remove(account) {
    if (!available) throw credentialError("CREDENTIAL_STORE_UNAVAILABLE", detail);
    const result = await run(binary, ["clear", ...attributes(account)], { env });
    if (result.code === 0) return true;
    const detailText = result.stderr.trim();
    if (detailText === "" || /no matching/i.test(detailText)) return false;
    throw storeFailure(result, "remove", "");
  }

  return { name: "libsecret", secure: available, available, detail, get, set, delete: remove };
}

const DPAPI_ENCRYPT = [
  "$ErrorActionPreference='Stop'",
  "try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch { }",
  "$raw=[Console]::In.ReadToEnd().Trim()",
  "$bytes=[Convert]::FromBase64String($raw)",
  "$protected=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,'CurrentUser')",
  "[Console]::Out.Write([Convert]::ToBase64String($protected))",
].join("; ");

const DPAPI_DECRYPT = [
  "$ErrorActionPreference='Stop'",
  "try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch { }",
  "$raw=[Console]::In.ReadToEnd().Trim()",
  "$bytes=[Convert]::FromBase64String($raw)",
  "$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,'CurrentUser')",
  "[Console]::Out.Write([Convert]::ToBase64String($plain))",
].join("; ");

function windowsDpapiStore({ run, env, platform, directory }) {
  const binary =
    findOnPath("powershell.exe", env, platform)
    ?? findOnPath("pwsh.exe", env, platform)
    ?? findOnPath("pwsh", env, platform);
  const available = Boolean(binary);
  const detail = available
    ? `Windows DPAPI (CurrentUser) via ${binary}`
    : "PowerShell was not found, so Windows DPAPI is unavailable";
  const credentialDirectory = join(directory, "credentials");
  const fileFor = (account) => join(credentialDirectory, `${account}.dpapi`);

  async function get(account) {
    if (!available) throw credentialError("CREDENTIAL_STORE_UNAVAILABLE", detail);
    const path = fileFor(account);
    try {
      await ensureSecureFile(path);
    } catch (error) {
      if (error?.reason === "MISSING") return null;
      throw credentialError("CREDENTIAL_STORE_FAILED", `could not secure the DPAPI credential file: ${error.message}`);
    }
    let ciphertext;
    try {
      ciphertext = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw credentialError("CREDENTIAL_READ_FAILED", "could not read the DPAPI credential file");
    }
    const result = await run(
      binary,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", DPAPI_DECRYPT],
      { env, input: ciphertext.trim() },
    );
    if (result.code !== 0) {
      throw credentialError("CREDENTIAL_READ_FAILED", "Windows DPAPI could not decrypt the credential");
    }
    try {
      return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
    } catch {
      throw credentialError("CREDENTIAL_READ_FAILED", "Windows DPAPI returned an unreadable credential");
    }
  }

  async function set(account, secret) {
    if (!available) throw credentialError("CREDENTIAL_STORE_UNAVAILABLE", detail);
    const result = await run(
      binary,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", DPAPI_ENCRYPT],
      { env, input: Buffer.from(secret, "utf8").toString("base64") },
    );
    if (result.code !== 0) throw storeFailure(result, "write", secret);
    const ciphertext = result.stdout.trim();
    if (ciphertext === "") throw credentialError("CREDENTIAL_WRITE_FAILED", "Windows DPAPI returned no ciphertext");
    await ensureSecureDirectory(credentialDirectory);
    const path = fileFor(account);
    const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      await writeFile(temporary, `${ciphertext}\n`, { mode: 0o600, flag: "wx" });
      try {
        await chmod(temporary, 0o600);
      } catch {
        // Windows does not implement POSIX modes; the ACL and DPAPI protect it.
      }
      await ensureSecureFile(temporary);
      await rename(temporary, path);
      await ensureSecureFile(path);
    } catch {
      try {
        await unlink(temporary);
      } catch {
        // Nothing to clean up.
      }
      throw credentialError("CREDENTIAL_WRITE_FAILED", "could not write the DPAPI credential file");
    }
  }

  async function remove(account) {
    if (!available) throw credentialError("CREDENTIAL_STORE_UNAVAILABLE", detail);
    try {
      await unlink(fileFor(account));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw credentialError("CREDENTIAL_DELETE_FAILED", "could not delete the DPAPI credential file");
    }
  }

  return { name: "windows-dpapi", secure: available, available, detail, get, set, delete: remove };
}

function unavailableStore(name, detail) {
  const fail = () => {
    throw credentialError(
      "CREDENTIAL_STORE_UNAVAILABLE",
      `${detail}. Credentials are never written to a plaintext file; install an OS credential store or set CODERAX_TOKEN for automation.`,
    );
  };
  return { name, secure: false, available: false, detail, get: fail, set: fail, delete: fail };
}

/**
 * Select the OS credential store. `CODERAX_CREDENTIAL_STORE` may name one
 * explicitly (auto|keychain|libsecret|dpapi). There is deliberately no
 * plaintext-file fallback.
 */
export function createCredentialStore({
  platform = process.platform,
  env = process.env,
  run = runProcess,
  directory = platform === "win32" && env.APPDATA ? join(env.APPDATA, "Coderax") : configDir(env),
} = {}) {
  const requested = (env.CODERAX_CREDENTIAL_STORE ?? "auto").trim().toLowerCase();
  let store;

  const mac = () => macKeychainStore({ run, env });
  const linux = () => libsecretStore({ run, env, platform });
  const windows = () => windowsDpapiStore({ run, env, platform, directory });

  if (requested === "auto") {
    if (platform === "darwin") store = mac();
    else if (platform === "win32") store = windows();
    else store = linux();
  } else if (["keychain", "macos-keychain", "security"].includes(requested)) {
    store = platform === "darwin"
      ? mac()
      : unavailableStore("macos-keychain", "macOS Keychain is only available on macOS");
  } else if (["libsecret", "secret-service", "secret-tool"].includes(requested)) {
    store = platform === "linux"
      ? linux()
      : unavailableStore("libsecret", "secret-tool is only available on Linux");
  } else if (["dpapi", "windows-dpapi"].includes(requested)) {
    store = platform === "win32"
      ? windows()
      : unavailableStore("windows-dpapi", "Windows DPAPI is only available on Windows");
  } else {
    store = unavailableStore("unknown", `CODERAX_CREDENTIAL_STORE=${requested} is not a supported credential store`);
  }

  return {
    ...store,
    accountFor: credentialAccount,
    async describe() {
      return {
        name: store.name,
        available: store.available,
        secure: store.secure,
        detail: store.detail,
      };
    },
  };
}

/**
 * Read a token from an explicitly authorized file without ever putting it in
 * argv. POSIX files must not be group/other readable; symlinks are refused so a
 * planted link cannot redirect the read. Windows ACLs are verified by the
 * shared secure-store helper when the file is used; the token file itself is
 * still bounded and must be a regular file.
 */
export async function readTokenFile(path, { platform = process.platform } = {}) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new CredentialError("CREDENTIAL_FILE", `${path} is a symbolic link; refusing to read a token through it`);
  }
  if (!info.isFile()) throw new CredentialError("CREDENTIAL_FILE", `${path} is not a regular file`);
  if (info.size > 1024 * 1024) {
    throw new CredentialError("CREDENTIAL_FILE", `${path} is too large to be a token file`);
  }
  if (platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new CredentialError(
      "CREDENTIAL_FILE",
      `${path} is readable by group or others (mode ${(info.mode & 0o777).toString(8)}); run \`chmod 600 ${path}\``,
    );
  }
  const token = (await readFile(path, "utf8")).trim();
  if (!token) throw new CredentialError("CREDENTIAL_FILE", `${path} is empty`);
  return token;
}
