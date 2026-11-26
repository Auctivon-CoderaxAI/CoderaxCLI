/**
 * Cross-platform secure local storage.
 *
 * Unix mode 0600 is necessary but not sufficient: macOS ACLs can grant access
 * beyond the mode bits, and Windows ignores them entirely. Every write is
 * verified with the platform's own ACL mechanism before the CLI reports
 * success. Verification failure is an error, not a warning, because the stored
 * data (prompt history, conversation metadata, deployment token) is private.
 *
 * Windows is verified by security identifier, never by display name. Well-known
 * principals are localized (`BUILTIN\Users` is `VORDEFINIERT\Benutzer` on a
 * German install), so name matching is both incomplete and unsafe. The SID of
 * the current account comes from `whoami /user`; the ACL is read and rewritten
 * through PowerShell's `Get-Acl`/`Set-Acl`, which report SIDs rather than names.
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

function defaultRun(command, args, options = {}) {
  return execFileAsync(command, args, {
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    env: options.env ?? process.env,
  });
}

const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/i;

/** Well-known principals that must never retain access to private CLI data. */
const BROAD_SIDS = new Set([
  "S-1-1-0", // Everyone
  "S-1-5-7", // Anonymous Logon
  "S-1-5-11", // Authenticated Users
  "S-1-5-32-545", // Builtin Users
  "S-1-5-32-546", // Builtin Guests
  "S-1-5-4", // Interactive
  "S-1-5-6", // Service
  "S-1-5-18", // Local System
  "S-1-5-32-544", // Builtin Administrators
]);

/** `Get-Acl` reduced to the SIDs of allow entries, one per line. */
const PS_LIST_ACL = [
  "$ErrorActionPreference='Stop'",
  "$acl=Get-Acl -LiteralPath $env:CODERAX_ACL_PATH",
  "foreach($ace in $acl.Access){",
  "if($ace.AccessControlType -ne 'Allow'){continue}",
  "$sid=''",
  "try{$sid=$ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{$sid=$ace.IdentityReference.Value}",
  "Write-Output $sid",
  "}",
].join("; ");

/**
 * Replace the DACL with a single allow entry for the current account.
 *
 * `SetAccessRuleProtection($true, $false)` removes inheritance without copying
 * inherited entries, and assigning the new ACL drops every explicit entry that
 * was there before. The result is owner-only access; no `/grant` merge can leave
 * an attacker-planted allow ACE behind.
 */
const PS_HARDEN_ACL = [
  "$ErrorActionPreference='Stop'",
  "$path=$env:CODERAX_ACL_PATH",
  "$sid=New-Object System.Security.Principal.SecurityIdentifier($env:CODERAX_ACL_SID)",
  // Start from the real ACL so the owner and group are preserved, then remove
  // inheritance and every explicit allow/deny entry before granting the owner.
  "$acl=Get-Acl -LiteralPath $path",
  "$acl.SetAccessRuleProtection($true,$false)",
  "foreach($ace in @($acl.Access)){ $acl.RemoveAccessRule($ace) | Out-Null }",
  "$inherit=[System.Security.AccessControl.InheritanceFlags]::None",
  "$prop=[System.Security.AccessControl.PropagationFlags]::None",
  "if($env:CODERAX_ACL_KIND -eq 'directory'){",
  "$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'",
  "}",
  "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,$prop,[System.Security.AccessControl.AccessControlType]::Allow)",
  "$acl.AddAccessRule($rule)",
  "Set-Acl -LiteralPath $path -AclObject $acl",
].join("; ");

function modeString(mode) {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

function encodePowerShell(script) {
  // -EncodedCommand avoids all cmd/PowerShell quoting rules. The script is
  // UTF-16LE by definition of the interface; the path never enters the script.
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Absolute path to a Windows system binary.
 *
 * Resolving by bare name is not safe here. Git for Windows, Cygwin, MSYS2 and
 * Strawberry Perl all ship a `whoami` of their own and put their own directory
 * first on PATH, so `whoami /user` reached the GNU tool on a hosted runner and
 * exited with "extra operand '/user'". The same hazard would let an unrelated
 * `powershell.exe` earlier on PATH read the DPAPI payload. Use the system
 * directory when Windows reports it, and only fall back to PATH when it does
 * not.
 */
function systemBinary(name, env) {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  if (typeof root !== "string" || root.trim() === "") return name;
  return `${root.trim().replace(/[\\/]+$/, "")}\\System32\\${name}`;
}

function powershellCandidates(env) {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  const candidates = [];
  if (typeof root === "string" && root.trim() !== "") {
    candidates.push(`${root.trim().replace(/[\\/]+$/, "")}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
  }
  // Windows PowerShell is present on every supported Windows release; pwsh is
  // a fallback for stripped server images that removed it.
  candidates.push("powershell.exe", "pwsh");
  return candidates;
}

async function runPowerShell(runCommand, script, env) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShell(script),
  ];
  let missing = null;
  for (const command of powershellCandidates(env)) {
    try {
      return await runCommand(command, args, { env });
    } catch (error) {
      if (error?.code === "ENOENT") {
        missing = error;
        continue;
      }
      const stderr = String(error?.stderr ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .slice(-3)
        .join(" | ");
      if (stderr !== "") error.powershellDetail = stderr;
      throw error;
    }
  }
  throw Object.assign(new Error("no PowerShell interpreter is available"), {
    code: missing?.code ?? "ENOENT",
    powershellDetail: "no PowerShell interpreter is available in System32, on PATH, or as pwsh",
  });
}

/**
 * One sentence for a failed PowerShell call. A kill from the timeout budget is
 * reported as a timeout, not as an ACL failure: the two need different fixes,
 * and "Set-Acl failed" for a process that never ran hides that distinction.
 */
function describePowerShellFailure(error) {
  if (error?.killed === true) {
    return `PowerShell did not finish within the 5s budget (${error?.signal ?? "killed"})`;
  }
  const detail = String(error?.powershellDetail ?? "").trim();
  if (detail !== "") return detail;
  return error?.code ?? "PowerShell failed";
}

/** The SID of the account running this process. */
async function currentWindowsSid(runCommand, env) {
  const result = await runCommand(systemBinary("whoami.exe", env), ["/user", "/fo", "csv", "/nh"], { env });
  const output = String(result?.stdout ?? result ?? "");
  const match = output.match(/S-1-\d+(?:-\d+)+/i);
  if (match === null) {
    throw new SecureStoreError("ACL_UNVERIFIABLE", "whoami did not report the current Windows SID");
  }
  return match[0].toUpperCase();
}

async function verifyWindowsPath(path, options) {
  const { runCommand = defaultRun, env = process.env } = options;

  let sid;
  try {
    sid = await currentWindowsSid(runCommand, env);
  } catch (error) {
    return {
      ok: false,
      reason: "ACL_UNVERIFIABLE",
      detail: `could not determine the current Windows SID: ${error?.code ?? "whoami failed"}`,
    };
  }

  let output;
  try {
    const result = await runPowerShell(
      runCommand,
      PS_LIST_ACL,
      { ...env, CODERAX_ACL_PATH: path },
    );
    output = String(result?.stdout ?? result ?? "");
  } catch (error) {
    return {
      ok: false,
      reason: "ACL_UNVERIFIABLE",
      detail: `could not verify Windows ACL for ${path}: ${describePowerShellFailure(error)}`,
    };
  }

  const entries = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const allowed = entries.filter((entry) => SID_PATTERN.test(entry)).map((entry) => entry.toUpperCase());
  if (allowed.length === 0) {
    return { ok: false, reason: "ACL_UNVERIFIABLE", detail: `no allow entries found for ${path}` };
  }

  const foreign = allowed.filter((entry) => entry !== sid);
  if (foreign.length > 0) {
    const broad = foreign.filter((entry) => BROAD_SIDS.has(entry));
    return {
      ok: false,
      reason: broad.length > 0 ? "ACL_TOO_BROAD" : "ACL_NOT_OWNER_ONLY",
      detail:
        broad.length > 0
          ? `${path} grants access to Everyone, Users, Authenticated Users or another broad principal`
          : `${path} grants access to a principal other than the current account`,
    };
  }

  return { ok: true, detail: `Windows ACL restricted to the current account SID (${allowed.length} entries)` };
}

/**
 * Remove inherited Windows ACEs and replace the DACL with one entry for the
 * current account. Windows files created in a shared temporary directory
 * inherit `BUILTIN\Users:(RX)`, so writing a private file is not enough; the
 * ACL must be replaced before it can pass verification.
 */
export async function hardenSecurePath(path, options = {}) {
  const {
    kind = "file",
    platform = process.platform,
    runCommand = defaultRun,
    env = process.env,
  } = options;
  if (platform !== "win32") return { ok: true, skipped: true };

  let sid;
  try {
    sid = await currentWindowsSid(runCommand, env);
  } catch (error) {
    throw new SecureStoreError(
      error?.code === "ACL_UNVERIFIABLE"
        ? error.code
        : "ACL_UNVERIFIABLE",
      `cannot determine the current Windows account: ${error?.message ?? "whoami failed"}`,
    );
  }

  try {
    await runPowerShell(runCommand, PS_HARDEN_ACL, {
      ...env,
      CODERAX_ACL_PATH: path,
      CODERAX_ACL_SID: sid,
      CODERAX_ACL_KIND: kind,
    });
  } catch (error) {
    throw new SecureStoreError(
      "STORE_PERMISSIONS",
      `could not restrict the Windows ACL on ${path}: ${describePowerShellFailure(error)}`,
    );
  }
  return { ok: true, sid };
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
    return verifyWindowsPath(path, { runCommand, env });
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

  return {
    ok: true,
    detail: `${path} is ${kind === "directory" ? "0700" : "0600"} and owned by the current account`,
  };
}

const REPAIRABLE_WINDOWS_REASONS = new Set([
  "ACL_TOO_BROAD",
  "ACL_NOT_OWNER_ONLY",
  "ACL_OWNER_UNVERIFIED",
]);

export async function ensureSecureFile(path, deps = {}) {
  const { chmodImpl = chmod, platform = process.platform } = deps;
  let verification = await verifySecurePath(path, deps);
  if (!verification.ok && verification.reason === "PERMISSIONS_TOO_BROAD" && platform !== "win32") {
    try {
      await chmodImpl(path, 0o600);
      verification = await verifySecurePath(path, deps);
    } catch {
      // Fall through with the original failure.
    }
  }
  if (!verification.ok && platform === "win32" && REPAIRABLE_WINDOWS_REASONS.has(verification.reason)) {
    try {
      await hardenSecurePath(path, deps);
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
  } else {
    await hardenSecurePath(path, { ...deps, kind: "directory" });
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
    // `wx` refuses a pre-existing entry, so a planted symlink or file cannot be
    // opened instead of a fresh private temporary file.
    await writeFileImpl(tempPath, contents, { mode: 0o600, flag: "wx" });
    if (platform !== "win32") {
      await chmodImpl(tempPath, 0o600);
    } else {
      await hardenSecurePath(tempPath, deps);
    }
    const tempVerification = await verifySecurePath(tempPath, deps);
    if (!tempVerification.ok) {
      throw new SecureStoreError("STORE_PERMISSIONS", `temporary file is not private: ${tempVerification.detail}`);
    }
    await renameImpl(tempPath, path);
  } catch (error) {
    try {
      await unlinkImpl(tempPath, { force: true });
    } catch {
      // Best effort cleanup; the original failure is more useful.
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
