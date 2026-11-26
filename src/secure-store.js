/**
 * Cross-platform secure local storage.
 *
 * Unix mode 0600 is necessary but not sufficient: macOS ACLs can grant access
 * beyond the mode bits, and Windows ignores them entirely. Every write is
 * verified with the platform's own ACL tool before the CLI reports success.
 * Verification failure is an error, not a warning, because the stored data
 * (prompt history, conversation metadata, deployment token) is private.
 */

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class SecureStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SecureStoreError";
    this.code = code;
  }
}

function defaultRun(command, args) {
  return execFileAsync(command, args, { windowsHide: true, timeout: 5000 });
}

const BROAD_WINDOWS_PRINCIPALS = /(everyone|authenticated users|builtin\\users|^users$|^users@)/i;

function modeString(mode) {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * Verify that a path is a regular file (or directory) that only this account
 * can access.
 *
 * @returns {Promise<{ok:boolean, reason?:string, detail:string}>}
 */
export async function verifySecurePath(path, options = {}) {
  const {
    kind = "file",
    platform = process.platform,
    statImpl = stat,
    runCommand = defaultRun,
    getuid = typeof process.getuid === "function" ? process.getuid.bind(process) : null,
    env = process.env,
  } = options;

  let info;
  try {
    info = await statImpl(path);
  } catch (error) {
    return { ok: false, reason: "MISSING", detail: `cannot stat ${path}: ${error?.code ?? "error"}` };
  }

  if (kind === "file" && !info.isFile()) {
    return { ok: false, reason: "NOT_A_FILE", detail: `${path} is not a regular file` };
  }
  if (kind === "directory" && !info.isDirectory()) {
    return { ok: false, reason: "NOT_A_DIRECTORY", detail: `${path} is not a directory` };
  }

  if (platform === "win32") {
    let output;
    try {
      const result = await runCommand("icacls", [path]);
      output = String(result?.stdout ?? result ?? "");
    } catch (error) {
      return {
        ok: false,
        reason: "ACL_UNVERIFIABLE",
        detail: `could not verify Windows ACL for ${path}: ${error?.code ?? "icacls failed"}`,
      };
    }
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !/^successfully processed/i.test(line));
    // Each ACE looks like `PRINCIPAL:(RIGHTS)`. Parsing principals is fragile
    // (paths and names contain colons and spaces), so match the ACE suffix on
    // the whole line and check the principals we must never see.
    const aces = lines.filter((line) => /:\([^)]*\)/.test(line));
    if (aces.length === 0) {
      return { ok: false, reason: "ACL_UNVERIFIABLE", detail: `no ACL entries found for ${path}` };
    }
    const broad = aces.filter((line) => BROAD_WINDOWS_PRINCIPALS.test(line));
    if (broad.length > 0) {
      return {
        ok: false,
        reason: "ACL_TOO_BROAD",
        detail: `${path} grants access to Everyone, Users or Authenticated Users`,
      };
    }
    const account = (env.USERNAME ?? env.USER ?? "").toLowerCase();
    const hasOwner = account !== "" && aces.some((line) => line.toLowerCase().includes(account));
    if (!hasOwner) {
      return {
        ok: false,
        reason: "ACL_OWNER_UNVERIFIED",
        detail: `no explicit access entry for the current account on ${path}`,
      };
    }
    return { ok: true, detail: `Windows ACL restricted to the current account (${aces.length} entries)` };
  }

  if ((info.mode & 0o077) !== 0) {
    return {
      ok: false,
      reason: "PERMISSIONS_TOO_BROAD",
      detail: `${path} has mode ${modeString(info.mode)}; group and other access is not allowed`,
    };
  }
  if (typeof getuid === "function" && typeof info.uid === "number" && info.uid !== getuid()) {
    return {
      ok: false,
      reason: "OWNER_MISMATCH",
      detail: `${path} is owned by uid ${info.uid}, not the current uid ${getuid()}`,
    };
  }

  if (platform === "darwin") {
    let output;
    try {
      const result = await runCommand("ls", ["-le", path]);
      output = String(result?.stdout ?? result ?? "");
    } catch (error) {
      return {
        ok: false,
        reason: "ACL_UNVERIFIABLE",
        detail: `could not verify macOS ACL for ${path}: ${error?.code ?? "ls -le failed"}`,
      };
    }
    // `ls -le` prints ACL lines as " 0: user:name allow ..." beneath the entry.
    const aclLines = output.split(/\r?\n/).filter((line) => /^\s+\d+:\s/.test(line));
    if (aclLines.length > 0) {
      return {
        ok: false,
        reason: "ACL_PRESENT",
        detail: `${path} has explicit macOS ACL entries; restrict them before storing private data`,
      };
    }
  }

  return { ok: true, detail: `${path} is ${kind === "directory" ? "0700" : "0600"} and owned by the current account` };
}

export async function ensureSecureFile(path, deps = {}) {
  const { chmodImpl = chmod } = deps;
  let verification = await verifySecurePath(path, deps);
  if (!verification.ok && verification.reason === "PERMISSIONS_TOO_BROAD" && deps.platform !== "win32") {
    try {
      await chmodImpl(path, 0o600);
      verification = await verifySecurePath(path, deps);
    } catch {
      // Fall through with the original failure.
    }
  }
  if (!verification.ok) {
    throw new SecureStoreError(
      "STORE_PERMISSIONS",
      `refusing to use ${path}: ${verification.detail}`,
    );
  }
  return verification;
}

export async function ensureSecureDirectory(path, deps = {}) {
  const { mkdirImpl = mkdir, chmodImpl = chmod, platform = process.platform } = deps;
  await mkdirImpl(path, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    try {
      await chmodImpl(path, 0o700);
    } catch (error) {
      throw new SecureStoreError("STORE_PERMISSIONS", `could not restrict permissions on ${path}`);
    }
  }
  const verification = await verifySecurePath(path, { ...deps, kind: "directory" });
  if (!verification.ok) {
    throw new SecureStoreError("STORE_PERMISSIONS", `insecure storage directory ${path}: ${verification.detail}`);
  }
  return verification;
}

/**
 * Atomically write private JSON (or text) with a fresh 0600 file, then verify
 * the result with POSIX ownership/mode and the platform ACL.
 */
export async function writeSecureFile(path, contents, deps = {}) {
  const {
    platform = process.platform,
    writeFileImpl = writeFile,
    renameImpl = rename,
    unlinkImpl = rm,
    chmodImpl = chmod,
    mkdirImpl = mkdir,
  } = deps;

  await ensureSecureDirectory(dirname(path), { ...deps, mkdirImpl, chmodImpl, platform });

  const tempPath = `${path}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFileImpl(tempPath, contents, { mode: 0o600, flag: "wx" });
    if (platform !== "win32") await chmodImpl(tempPath, 0o600);
    const tempVerification = await verifySecurePath(tempPath, deps);
    if (!tempVerification.ok) {
      throw new SecureStoreError("STORE_PERMISSIONS", `temporary file is not private: ${tempVerification.detail}`);
    }
    await renameImpl(tempPath, path);
  } catch (error) {
    try {
      await unlinkImpl(tempPath, { force: true });
    } catch {
      // Best effort cleanup.
    }
    if (error instanceof SecureStoreError) throw error;
    throw new SecureStoreError("STORE_WRITE_FAILED", `could not write ${path} securely`);
  }

  const verification = await verifySecurePath(path, deps);
  if (!verification.ok) {
    throw new SecureStoreError("STORE_PERMISSIONS", `stored file failed verification: ${verification.detail}`);
  }
  return { path, verification };
}

export async function readSecureFile(path, deps = {}) {
  await ensureSecureFile(path, deps);
  const { readFileImpl = readFile } = deps;
  return readFileImpl(path, "utf8");
}

export async function removeSecureFile(path, deps = {}) {
  const { unlinkImpl = rm } = deps;
  await unlinkImpl(path, { force: true });
}
