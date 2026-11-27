/**
 * Credential storage.
 *
 * A bearer token must never appear in `argv`: process arguments are readable by
 * other local users (and by every process on some systems), are recorded by
 * shell history, and are copied into CI logs. This module therefore accepts a
 * secret only through standard input, and prefers an operating-system credential
 * store that can be driven without putting the secret on a command line:
 *
 *   Windows  DPAPI through PowerShell, secret supplied on stdin.
 *   Linux    Secret Service through `secret-tool`, secret supplied on stdin.
 *   macOS    No non-argv Keychain interface is available (`security
 *            add-generic-password` requires the password as an argument), so the
 *            0600 config file is used instead of leaking the token into argv.
 *
 * Every backend is injectable so tests never need a real keyring.
 */
import { runCommand } from "./credentials.js";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { hardenSecurePath, verifySecurePath } from "./secure-store.js";

export const CREDENTIAL_SERVICE = "coderax-cli";

/** Backend chosen for this platform, honouring an explicit override. */
export function credentialBackend(env = process.env, platform = process.platform) {
  const override = env.CODERAX_CREDENTIAL_STORE?.trim();
  if (override === "file") return "file";
  if (override === "os") return osBackend(platform);
  return osBackend(platform);
}

function osBackend(platform) {
  if (platform === "win32") return "windows-dpapi";
  if (platform === "linux") return "secret-service";
  // macOS Keychain is deliberately not used; see the module comment.
  return "file";
}

async function run(command, args, options) {
  const { code, error, stdout, stderr } = await runCommand(command, args, options);
  if (error) throw error;
  return { status: code, stdout, stderr };
}

async function which(command, env) {
  const finder = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const result = await run(shell, process.platform === "win32" ? ["/d", "/c", finder, command] : ["-c", `${finder} ${command}`], { env });
  return result.status === 0 && result.stdout.trim() !== "";
}

function dpapiPath(env) {
  const base = env.APPDATA?.trim() || join(env.USERPROFILE?.trim() || tmpdir(), "AppData", "Roaming");
  return join(base, "Coderax", "credential.dpapi");
}

const PS_STORE = [
  "$ErrorActionPreference='Stop'",
  "$secret=[Console]::In.ReadToEnd().TrimEnd()",
  "$secure=ConvertTo-SecureString -String $secret -AsPlainText -Force",
  "$parent=Split-Path -Parent $env:CODERAX_DPAPI_PATH",
  "New-Item -ItemType Directory -Force -Path $parent | Out-Null",
  "$encrypted=ConvertFrom-SecureString -SecureString $secure",
  "Set-Content -LiteralPath $env:CODERAX_DPAPI_PATH -Value $encrypted -Encoding ascii -NoNewline",
].join("; ");

const PS_LOAD = [
  "$ErrorActionPreference='Stop'",
  "$encrypted=Get-Content -Raw -LiteralPath $env:CODERAX_DPAPI_PATH",
  "$secure=ConvertTo-SecureString -String $encrypted",
  "$bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
  "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }",
].join("; ");

const PS_DELETE = [
  "$ErrorActionPreference='SilentlyContinue'",
  "Remove-Item -LiteralPath $env:CODERAX_DPAPI_PATH -Force",
].join("; ");

async function powershell(script, { env, input = "" }) {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { env, input },
  );
}

/**
 * DPAPI already binds the ciphertext to this Windows account, but the file's
 * DACL is still replaced and verified: a second account must not be able to
 * read, replace or hold the credential file open.
 */
async function protectDpapiFile(path, { env, deps }) {
  await (deps.hardenAcl ?? ((target) => hardenSecurePath(target, { env })))(path);
  const verification = await (deps.verifyAcl ?? ((target) => verifySecurePath(target, { env })))(path);
  if (!verification?.ok) {
    throw new Error(`credential file is not private: ${verification?.detail ?? "ACL verification failed"}`);
  }
}

/**
 * Read the stored token for an account.
 * Returns null when no credential exists. A broken store is an error, never a
 * silent fallback, so an operator is not told they are signed in when they are not.
 */
export async function readCredential({ backend, account, env = process.env, deps = {} }) {
  const kind = backend ?? credentialBackend(env);
  if (kind === "file") return null;
  if (kind === "secret-service") {
    if (!(await (deps.which ?? which)("secret-tool", env))) return null;
    const result = await (deps.run ?? run)(
      "secret-tool",
      ["lookup", "service", CREDENTIAL_SERVICE, "account", account || "default"],
      { env },
    );
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  }
  if (kind === "windows-dpapi") {
    const path = dpapiPath(env);
    const verification = await (deps.verifyAcl ?? ((target) => verifySecurePath(target, { env })))(path);
    if (verification.reason === "MISSING") return null;
    if (!verification.ok) {
      throw new Error(`refusing to read a credential file that is not private: ${verification.detail}`);
    }
    const result = await (deps.powershell ?? powershell)(PS_LOAD, {
      env: { ...env, CODERAX_DPAPI_PATH: path },
    });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  }
  throw new Error(`unknown credential backend: ${kind}`);
}

/** Store a token. The secret is written to the helper's stdin, never argv. */
export async function writeCredential({ backend, account, token, env = process.env, deps = {} }) {
  const kind = backend ?? credentialBackend(env);
  if (kind === "file") return "file";
  if (kind === "secret-service") {
    if (!(await (deps.which ?? which)("secret-tool", env))) {
      throw new Error("secret-tool is not installed; set CODERAX_CREDENTIAL_STORE=file to use the 0600 file");
    }
    const result = await (deps.run ?? run)(
      "secret-tool",
      ["store", "--label", "Coderax CLI token", "service", CREDENTIAL_SERVICE, "account", account || "default"],
      { env, input: `${token}\n` },
    );
    if (result.status !== 0) throw new Error(`secret-tool store failed: ${result.stderr.trim()}`);
    return kind;
  }
  if (kind === "windows-dpapi") {
    const path = dpapiPath(env);
    const result = await (deps.powershell ?? powershell)(PS_STORE, {
      env: { ...env, CODERAX_DPAPI_PATH: path },
      input: token,
    });
    if (result.status !== 0) throw new Error(`DPAPI store failed: ${result.stderr.trim()}`);
    await protectDpapiFile(path, { env, deps });
    return kind;
  }
  throw new Error(`unknown credential backend: ${kind}`);
}

export async function deleteCredential({ backend, account, env = process.env, deps = {} }) {
  const kind = backend ?? credentialBackend(env);
  if (kind === "file") return;
  if (kind === "secret-service") {
    if (!(await (deps.which ?? which)("secret-tool", env))) return;
    await (deps.run ?? run)(
      "secret-tool",
      ["clear", "service", CREDENTIAL_SERVICE, "account", account || "default"],
      { env },
    );
    return;
  }
  if (kind === "windows-dpapi") {
    await (deps.powershell ?? powershell)(PS_DELETE, {
      env: { ...env, CODERAX_DPAPI_PATH: dpapiPath(env) },
    });
  }
}

/**
 * Read a token from a file without ever echoing it. The file must not be
 * readable by group or others on POSIX, because the token is the whole secret.
 */
export async function readTokenFile(path, { platform = process.platform } = {}) {
  const { stat } = await import("node:fs/promises");
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  if (platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(
      `${path} is readable by group or others (mode ${(info.mode & 0o777).toString(8)}); run \`chmod 600 ${path}\``,
    );
  }
  const token = (await readFile(path, "utf8")).trim();
  if (!token) throw new Error(`${path} is empty`);
  return token;
}
