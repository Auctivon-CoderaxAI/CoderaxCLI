import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SERVICE = "coderax-cli";
const ACCOUNT = "owner";
const MAX_SECRET_BYTES = 16 * 1024;

export class CredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
  }
}

/**
 * Run a helper with an explicit environment. The CLI never hands the owner
 * token, a provider key or an unrelated credential to a child process.
 */
export function childEnvironment(env = process.env) {
  const allow = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
    "TMPDIR", "TEMP", "TMP", "SystemRoot", "SystemDrive", "ComSpec", "PATHEXT",
    "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
    "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "DISPLAY",
    "WAYLAND_DISPLAY", "SECURITYSESSIONID",
  ]);
  const output = {};
  for (const [name, value] of Object.entries(env)) {
    if (allow.has(name) && typeof value === "string") output[name] = value;
  }
  return output;
}

/** A minimal, shell-free process runner with a bounded output and a timeout. */
export function runCommand(file, args, {
  input,
  env = process.env,
  timeoutMs = 10_000,
  maxBytes = 1024 * 1024,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawnImpl(file, args, {
        env: childEnvironment(env),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, error, stdout: "", stderr: "" });
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore.
      }
      finish({ code: null, error: Object.assign(new Error("helper timed out"), { code: "ETIMEDOUT" }), stdout, stderr });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ code: null, error, stdout, stderr }));
    child.on("close", (code) => finish({ code, error: null, stdout, stderr }));
    if (input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

export function validateSecret(token) {
  const value = typeof token === "string" ? token.trim() : "";
  if (value.length < 16) {
    throw new CredentialError("CREDENTIAL_INVALID", "the owner token must contain at least 16 characters");
  }
  if (value.length > MAX_SECRET_BYTES) {
    throw new CredentialError("CREDENTIAL_INVALID", "the owner token is too long");
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CredentialError("CREDENTIAL_INVALID", "the owner token contains a control character");
  }
  return value;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function securityEscape(value) {
  // `security -i` parses one command line. Only a quoted backslash and quote
  // need escaping; newlines are rejected before this point.
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The store chooses a backing implementation once, reports it honestly, and
 * falls back to a 0600 file only when the OS backend is genuinely unavailable.
 */
export function createCredentialStore({
  platform = process.platform,
  env = process.env,
  directory,
  mode = "auto",
  runner = runCommand,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  unlinkImpl = unlink,
  mkdirImpl = mkdir,
  chmodImpl = chmod,
} = {}) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new CredentialError("CREDENTIAL_CONFIG", "a credential directory is required");
  }
  const filePath = join(directory, "credentials.json");
  const dpapiPath = join(directory, "credential.dpapi");
  let warning = null;

  const requested = ["auto", "keychain", "file", "memory"].includes(mode) ? mode : "auto";

  async function readFileToken() {
    try {
      const raw = await readFileImpl(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed?.token === "string" && parsed.token.length > 0) return parsed.token;
      return null;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) return null;
      throw new CredentialError("CREDENTIAL_READ_FAILED", "the fallback credential file could not be read");
    }
  }

  async function writeFileToken(token) {
    await mkdirImpl(dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      await writeFileImpl(temp, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      try {
        await chmodImpl(temp, 0o600);
      } catch (error) {
        if (platform !== "win32") {
          throw new CredentialError("CREDENTIAL_PERMISSIONS", "the fallback credential file could not be restricted");
        }
      }
      await renameImpl(temp, filePath);
    } catch (error) {
      try {
        await unlinkImpl(temp);
      } catch {
        // Nothing to clean up.
      }
      if (error instanceof CredentialError) throw error;
      throw new CredentialError("CREDENTIAL_WRITE_FAILED", "the fallback credential file could not be written");
    }
  }

  async function deleteFileToken() {
    try {
      await unlinkImpl(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new CredentialError("CREDENTIAL_WRITE_FAILED", "the fallback credential file could not be removed");
      }
    }
  }

  const keychain = {
    async read() {
      if (platform === "darwin") {
        const result = await runner("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { env });
        if (result.code === 44) return null;
        if (result.error?.code === "ENOENT") throw new CredentialError("CREDENTIAL_BACKEND_MISSING", "the security helper is unavailable");
        if (result.code !== 0) throw new CredentialError("CREDENTIAL_READ_FAILED", "the macOS Keychain item could not be read");
        return result.stdout.replace(/\n$/, "");
      }
      if (platform === "linux") {
        const result = await runner("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], { env });
        if (result.error?.code === "ENOENT") throw new CredentialError("CREDENTIAL_BACKEND_MISSING", "secret-tool is unavailable");
        if (result.code === 1 && result.stdout.trim() === "") return null;
        if (result.code !== 0) throw new CredentialError("CREDENTIAL_READ_FAILED", "the Secret Service item could not be read");
        return result.stdout.replace(/\n$/, "");
      }
      if (platform === "win32") {
        const script = [
          "$ErrorActionPreference='Stop'",
          "Add-Type -AssemblyName System.Security",
          `$p=${psQuote(dpapiPath)}`,
          "if (-not (Test-Path -LiteralPath $p)) { exit 44 }",
          "$b=[IO.File]::ReadAllBytes($p)",
          "$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
          "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))",
        ].join("; ");
        const result = await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env });
        if (result.code === 44) return null;
        if (result.error?.code === "ENOENT") throw new CredentialError("CREDENTIAL_BACKEND_MISSING", "PowerShell is unavailable");
        if (result.code !== 0) throw new CredentialError("CREDENTIAL_READ_FAILED", "the Windows credential could not be read");
        return result.stdout.replace(/\r?\n$/, "");
      }
      throw new CredentialError("CREDENTIAL_BACKEND_MISSING", "no OS credential backend is available on this platform");
    },

    async write(token) {
      if (platform === "darwin") {
        const line = `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w "${securityEscape(token)}"\n`;
        const result = await runner("security", ["-i"], { env, input: line });
        if (result.error?.code === "ENOENT") throw new CredentialError("CREDENTIAL_BACKEND_MISSING", "the security helper is unavailable");
        if (result.code !== 0) throw new CredentialError("CREDENTIAL_WRITE_FAILED", "the macOS Keychain item could not be saved");
        return;
      }
      if (platform === "linux") {
        const result = await runner(
          "secret-tool",
          ["store", "--label", "Coderax CLI owner token", "service", SERVICE, "account", ACCOUNT],
          { env, input: token },
        );
        if (result.error?.code === "ENOENT") throw new CredentialError("CREDENTIAL_BACKEND_MISSING", "secret-tool is unavailable");
        if (result.code !== 0) throw new CredentialError("CREDENTIAL_WRITE_FAILED", "the Secret Service item could not be saved");
        return;
      }
      if (platform === "win32") {
        const script = [
          "$ErrorActionPreference='Stop'",
          "Add-Type -AssemblyName System.Security",
          "$t=[Console]::In.ReadToEnd().TrimEnd(\"`r\",\"`n\")",
          "$b=[Text.Encoding]::UTF8.GetBytes($t)",
          "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser')",
          `$p=${psQuote(dpapiPath)}`,
          "[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)) | Out-Null",
          "[IO.File]::WriteAllBytes($p,$e)",
        ].join("; ");
        const result = await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env, input: token });
        if (result.error?.code === "ENOENT") throw new CredentialError("CREDENTIAL_BACKEND_MISSING", "PowerShell is unavailable");
        if (result.code !== 0) throw new CredentialError("CREDENTIAL_WRITE_FAILED", "the Windows credential could not be saved");
        return;
      }
      throw new CredentialError("CREDENTIAL_BACKEND_MISSING", "no OS credential backend is available on this platform");
    },

    async delete() {
      if (platform === "darwin") {
        const result = await runner("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], { env });
        if (result.code === 44 || result.error?.code === "ENOENT") return;
        if (result.code !== 0) throw new CredentialError("CREDENTIAL_WRITE_FAILED", "the macOS Keychain item could not be removed");
        return;
      }
      if (platform === "linux") {
        const result = await runner("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT], { env });
        if (result.code === 1 || result.error?.code === "ENOENT") return;
        if (result.code !== 0) throw new CredentialError("CREDENTIAL_WRITE_FAILED", "the Secret Service item could not be removed");
        return;
      }
      if (platform === "win32") {
        const script = `$ErrorActionPreference='SilentlyContinue'; Remove-Item -LiteralPath ${psQuote(dpapiPath)} -Force`;
        await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env });
        return;
      }
    },
  };

  async function read() {
    if (requested === "memory") return null;
    if (requested === "file") return readFileToken();
    try {
      const token = await keychain.read();
      if (token) return token;
    } catch (error) {
      if (requested === "keychain") throw error;
      warning = `${error.code}: ${error.message}; using the 0600 fallback file`;
    }
    return readFileToken();
  }

  async function write(token) {
    const value = validateSecret(token);
    if (requested === "memory") return { kind: "memory" };
    if (requested === "file") {
      await writeFileToken(value);
      return { kind: "file" };
    }
    try {
      await keychain.write(value);
      // A stale fallback copy must not resurrect an older token.
      await deleteFileToken().catch(() => {});
      return { kind: "keychain" };
    } catch (error) {
      if (requested === "keychain") throw error;
      warning = `${error.code}: ${error.message}; using the 0600 fallback file`;
      await writeFileToken(value);
      return { kind: "file", warning };
    }
  }

  async function remove() {
    let backendRemoved = false;
    if (requested !== "file" && requested !== "memory") {
      try {
        await keychain.delete();
        backendRemoved = true;
      } catch (error) {
        warning = `${error.code}: ${error.message}`;
      }
    }
    let fileRemoved = false;
    try {
      await deleteFileToken();
      fileRemoved = true;
    } catch (error) {
      warning = `${error.code}: ${error.message}`;
    }
    return { backendRemoved, fileRemoved };
  }

  function describe() {
    const backend = requested === "memory"
      ? "memory"
      : platform === "darwin"
        ? "macOS Keychain"
        : platform === "win32"
          ? "Windows DPAPI"
          : platform === "linux"
            ? "Secret Service (secret-tool)"
            : "0600 file";
    return {
      requested,
      backend,
      path: requested === "file" ? filePath : null,
      warning,
    };
  }

  return { read, write, delete: remove, describe, filePath, dpapiPath };
}
