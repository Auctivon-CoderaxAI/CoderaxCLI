import { readTokenFile } from "../src/credentials.js";
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SecureStoreError, ensureSecureFile, hardenSecurePath, readSecureFile, removeSecureFile, verifySecurePath, writeSecureFile } from "../src/secure-store.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "coderax-store-"));
}

const fakeFileStat = (mode = 0o600, uid = 0) => async () => ({
  isFile: () => true,
  isDirectory: () => false,
  mode,
  uid,
});

test("writes private files atomically and verifies them", async () => {
  const dir = await tempDir();
  const path = join(dir, "private.json");
  await writeSecureFile(path, '{"ok":true}\n');
  assert.equal(await readFile(path, "utf8"), '{"ok":true}\n');
  const verification = await verifySecurePath(path);
  assert.equal(verification.ok, true);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o077, 0);
  }
  assert.equal(await readSecureFile(path), '{"ok":true}\n');
});

test("a world-readable file is rejected, then repaired by ensureSecureFile", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits are not meaningful on Windows");
    return;
  }
  const dir = await tempDir();
  const path = join(dir, "private.json");
  await writeSecureFile(path, "secret");
  await chmod(path, 0o644);
  const rejected = await verifySecurePath(path);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "PERMISSIONS_TOO_BROAD");
  await ensureSecureFile(path);
  assert.equal((await stat(path)).mode & 0o077, 0);
});

test("a directory readable by others is rejected", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits are not meaningful on Windows");
    return;
  }
  const dir = await tempDir();
  await chmod(dir, 0o755);
  const result = await verifySecurePath(dir, { kind: "directory" });
  assert.equal(result.ok, false);
});

test("POSIX ownership is verified", async () => {
  const result = await verifySecurePath("/tmp/whatever", {
    platform: "linux",
    statImpl: fakeFileStat(0o600, 1234),
    getuid: () => 999,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "OWNER_MISMATCH");
});

test("macOS ACLs are checked even when the mode is 0600", async () => {
  const clean = await verifySecurePath("/tmp/file", {
    platform: "darwin",
    statImpl: fakeFileStat(),
    getuid: () => 0,
    runCommand: async () => ({ stdout: "-rw------- 1 me staff 1 Jan 1 00:00 /tmp/file\n" }),
  });
  assert.equal(clean.ok, true);

  const acl = await verifySecurePath("/tmp/file", {
    platform: "darwin",
    statImpl: fakeFileStat(),
    getuid: () => 0,
    runCommand: async () => ({ stdout: "-rw------- 1 me staff 1 Jan 1 00:00 /tmp/file\n 0: user:guest allow read\n" }),
  });
  assert.equal(acl.ok, false);
  assert.equal(acl.reason, "ACL_PRESENT");
});

const WHOAMI = { stdout: '"HOST\\tester","S-1-5-21-1111-2222-3333-1001"\r\n' };
const OWNER_SID = "S-1-5-21-1111-2222-3333-1001";

function windowsRun(aclOutput, { whoami = WHOAMI, onCall = () => {} } = {}) {
  return async (command, args, options) => {
    onCall({ command, args, options });
    if (/(^|\\)whoami(\.exe)?$/i.test(command)) return whoami;
    if (/(^|\\)(powershell|pwsh)(\.exe)?$/i.test(command)) return { stdout: aclOutput };
    throw new Error(`unexpected command: ${command}`);
  };
}

test("Windows hardening replaces the DACL by SID, not by display name", async () => {
  const calls = [];
  await hardenSecurePath("C:\\tmp\\file", {
    platform: "win32",
    env: {},
    runCommand: windowsRun("", { onCall: (call) => calls.push(call) }),
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].command, /(^|\\)whoami(\.exe)?$/i);
  assert.deepEqual(calls[0].args, ["/user", "/fo", "csv", "/nh"]);
  assert.match(calls[1].command, /(^|\\)powershell(\.exe)?$/i);
  assert.ok(calls[1].args.includes("-EncodedCommand"));
  assert.equal(calls[1].options.env.CODERAX_ACL_SID, OWNER_SID);
  assert.equal(calls[1].options.env.CODERAX_ACL_PATH, "C:\\tmp\\file");
  assert.equal(calls[1].options.env.CODERAX_ACL_KIND, "file");
  // The account name is not an argv element: a localized or domain-qualified
  // name cannot change which principal is granted.
  assert.equal(calls[1].args.some((arg) => arg.includes("tester")), false);
});

test("Windows reads the account SID and interpreter from the system directory", async () => {
  // A hosted runner put Git for Windows' GNU `whoami` first on PATH, so
  // `whoami /user` failed with "extra operand". The system binary must be
  // addressed by path, and a shadowed powershell must never be preferred.
  const calls = [];
  await hardenSecurePath("C:\\tmp\\file", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    runCommand: windowsRun("", { onCall: (call) => calls.push(call) }),
  });
  assert.equal(calls[0].command, "C:\\Windows\\System32\\whoami.exe");
  assert.equal(
    calls[1].command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(calls[1].args.some((arg) => arg.includes("whoami")), false);
  assert.equal(
    calls[1].options.env.PSModulePath,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
  );

  const trailing = [];
  await hardenSecurePath("C:\\tmp\\file", {
    platform: "win32",
    env: { SYSTEMROOT: "C:\\Windows\\" },
    runCommand: windowsRun("", { onCall: (call) => trailing.push(call) }),
  });
  assert.equal(trailing[0].command, "C:\\Windows\\System32\\whoami.exe");
});

test("Windows pins PowerShell to its system modules instead of a user path", async () => {
  // A redirected USERPROFILE made Microsoft.PowerShell.Security fail to load on
  // a hosted Windows runner. The security module lives under the interpreter's
  // own directory, so a user-writable PSModulePath must not take precedence.
  const calls = [];
  await hardenSecurePath("C:\\tmp\\file", {
    platform: "win32",
    env: {
      SystemRoot: "C:\\Windows",
      PSModulePath: "C:\\Users\\someone\\Documents\\WindowsPowerShell\\Modules",
    },
    runCommand: windowsRun("", { onCall: (call) => calls.push(call) }),
  });
  // Prepend, so the interpreter's own module wins over a user-writable path
  // while the rest of PowerShell's module path remains available.
  assert.equal(
    calls[1].options.env.PSModulePath,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;C:\\Users\\someone\\Documents\\WindowsPowerShell\\Modules",
  );
});

test("a missing PowerShell interpreter is reported, not silently ignored", async () => {
  await assert.rejects(
    () =>
      hardenSecurePath("C:\\tmp\\file", {
        platform: "win32",
        env: {},
        runCommand: async (command) => {
          if (/(^|\\)whoami(\.exe)?$/i.test(command)) return WHOAMI;
          throw Object.assign(new Error(`missing ${command}`), { code: "ENOENT" });
        },
      }),
    (error) => error.code === "STORE_PERMISSIONS" && /no PowerShell interpreter/.test(error.message),
  );
});

test("Windows verifies allow ACEs by SID and fails closed", async () => {
  const secure = await verifySecurePath("C:\\tmp\\file", {
    platform: "win32",
    statImpl: fakeFileStat(),
    runCommand: windowsRun(`${OWNER_SID}\r\n`),
  });
  assert.equal(secure.ok, true);

  // A localized ACL is still rejected because the broad principal is matched
  // by its well-known SID, not its display name.
  const broad = await verifySecurePath("C:\\tmp\\file", {
    platform: "win32",
    statImpl: fakeFileStat(),
    runCommand: windowsRun(`${OWNER_SID}\r\nS-1-5-32-545\r\n`),
  });
  assert.equal(broad.ok, false);
  assert.equal(broad.reason, "ACL_TOO_BROAD");

  const other = await verifySecurePath("C:\\tmp\\file", {
    platform: "win32",
    statImpl: fakeFileStat(),
    runCommand: windowsRun(`${OWNER_SID}\r\nS-1-5-21-9999-9999-9999-1002\r\n`),
  });
  assert.equal(other.ok, false);
  assert.equal(other.reason, "ACL_NOT_OWNER_ONLY");

  const empty = await verifySecurePath("C:\\tmp\\file", {
    platform: "win32",
    statImpl: fakeFileStat(),
    runCommand: windowsRun("Successfully processed 1 files.\r\n"),
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "ACL_UNVERIFIABLE");

  const unavailable = await verifySecurePath("C:\\tmp\\file", {
    platform: "win32",
    statImpl: fakeFileStat(),
    runCommand: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, "ACL_UNVERIFIABLE");
});

test("a failed write removes its temporary file", async () => {
  const dir = await tempDir();
  const path = join(dir, "private.json");
  await assert.rejects(
    writeSecureFile(path, "secret", {
      renameImpl: async () => {
        throw new Error("rename failed");
      },
    }),
    (error) => error.code === "STORE_WRITE_FAILED",
  );
  assert.deepEqual(await readdir(dir), []);
});

test("missing files and wrong kinds are reported, never assumed secure", async () => {
  const result = await verifySecurePath("/does/not/exist/coderax");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "MISSING");
});

test("removeSecureFile is idempotent", async () => {
  const dir = await tempDir();
  const path = join(dir, "gone.json");
  await writeSecureFile(path, "x");
  await removeSecureFile(path);
  await removeSecureFile(path);
  assert.equal(await verifySecurePath(path).then((result) => result.reason), "MISSING");
});



/**
 * The cross-platform ACL layer, exercised deterministically on every runner.
 *
 * Platform-specific commands are injected, so macOS `ls -le` and Windows
 * `icacls` parsing are tested on Linux and Windows alike. The two real-filesystem
 * cases are POSIX-only and skip explicitly on Windows, where mode bits are not
 * the mechanism that protects the file.
 */

const posix = process.platform !== "win32";

function statOf({ mode = 0o600, uid = 1000, kind = "file" } = {}) {
  return async () => ({
    mode,
    uid,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
  });
}

test("verifySecurePath refuses group access, foreign owners and missing files", async () => {
  const broad = await verifySecurePath("/home/owner/.coderax/secret", {
    platform: "linux",
    statImpl: statOf({ mode: 0o644 }),
    getuid: () => 1000,
  });
  assert.equal(broad.ok, false);
  assert.equal(broad.reason, "PERMISSIONS_TOO_BROAD");
  assert.match(broad.detail, /644/);

  const foreign = await verifySecurePath("/home/owner/.coderax/secret", {
    platform: "linux",
    statImpl: statOf({ mode: 0o600, uid: 1001 }),
    getuid: () => 1000,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, "OWNER_MISMATCH");

  const missing = await verifySecurePath("/home/owner/.coderax/missing", {
    platform: "linux",
    statImpl: async () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
    getuid: () => 1000,
  });
  assert.equal(missing.reason, "MISSING");

  const notAFile = await verifySecurePath("/home/owner/.coderax/secret", {
    platform: "linux",
    statImpl: statOf({ kind: "directory" }),
    getuid: () => 1000,
  });
  assert.equal(notAFile.reason, "NOT_A_FILE");
});

test("verifySecurePath refuses explicit macOS ACL entries", async () => {
  const result = await verifySecurePath("/Users/owner/.coderax/config.json", {
    platform: "darwin",
    statImpl: statOf({ mode: 0o600, uid: 501 }),
    getuid: () => 501,
    runCommand: async () => ({
      stdout:
        "total 8\n-rw-------  1 owner  staff  42 Nov 26 10:00 config.json\n"
        + " 0: user:guest allow read\n",
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ACL_PRESENT");
});

test("verifySecurePath refuses inherited Windows ACEs and requires an owner entry", async () => {
  const base = {
    platform: "win32",
    env: { USERNAME: "owner" },
    statImpl: statOf({ mode: 0o666 }),
  };

  const broad = await verifySecurePath("C:\\Users\\owner\\Coderax\\secret", {
    ...base,
    runCommand: windowsRun(`INHERITED_ALLOW\r\n${OWNER_SID}\r\n`),
  });
  assert.equal(broad.ok, false);
  assert.equal(broad.reason, "ACL_TOO_BROAD");

  const unverifiable = await verifySecurePath("C:\\secret", {
    ...base,
    runCommand: async () => {
      throw Object.assign(new Error("icacls failed"), { code: "ENOENT" });
    },
  });
  assert.equal(unverifiable.reason, "ACL_UNVERIFIABLE");

  const missingOwner = await verifySecurePath("C:\\secret", {
    ...base,
    runCommand: windowsRun("S-1-5-21-9999-9999-9999-1002\r\n"),
  });
  assert.equal(missingOwner.ok, false);
  assert.equal(missingOwner.reason, "ACL_NOT_OWNER_ONLY");

  const restricted = await verifySecurePath("C:\\secret", {
    ...base,
    runCommand: windowsRun(`${OWNER_SID}\r\n`),
  });
  assert.equal(restricted.ok, true);
});

test("ensureSecureFile refuses a file whose permissions cannot be restricted", async () => {
  await assert.rejects(
    ensureSecureFile("/home/owner/.coderax/secret", {
      platform: "linux",
      statImpl: statOf({ mode: 0o644 }),
      chmodImpl: async () => {},
      getuid: () => 1000,
    }),
    (error) =>
      error instanceof SecureStoreError
      && error.code === "STORE_PERMISSIONS"
      && error.reason === "PERMISSIONS_TOO_BROAD",
  );
});

test("ensureSecureFile restores 0600 on a group-readable file", async (t) => {
  if (!posix) {
    t.skip("POSIX mode bits only");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "coderax-secure-"));
  const target = join(directory, "secret.json");
  await writeFile(target, "{}\n");
  await chmod(target, 0o644);

  const result = await ensureSecureFile(target);
  assert.equal(result.ok, true);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test("writeSecureFile creates a 0600 file in a 0700 directory and rewrites atomically", async (t) => {
  if (!posix) {
    t.skip("POSIX mode bits only");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "coderax-secure-"));
  const target = join(directory, "nested", "state.json");

  await writeSecureFile(target, "first");
  assert.equal(await readFile(target, "utf8"), "first");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(target))).mode & 0o777, 0o700);

  await writeSecureFile(target, "second");
  assert.equal(await readFile(target, "utf8"), "second");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test("readTokenFile refuses symlinks, broad modes and oversized files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coderax-token-"));

  const broad = join(directory, "broad-token");
  await writeFile(broad, "owner-token\n");
  await chmod(broad, 0o644);
  await assert.rejects(
    readTokenFile(broad, { platform: "linux" }),
    (error) => error.code === "CREDENTIAL_FILE" && /group or others/.test(error.message),
  );

  const huge = join(directory, "huge-token");
  await writeFile(huge, "x".repeat(1024 * 1024 + 1));
  await assert.rejects(
    readTokenFile(huge, { platform: "linux" }),
    (error) => /too large/.test(error.message),
  );

  if (!posix) {
    t.diagnostic("symlink refusal is POSIX-only");
    return;
  }
  const target = join(directory, "real-token");
  await writeFile(target, "owner-token\n", { mode: 0o600 });
  await chmod(target, 0o600);
  const link = join(directory, "linked-token");
  await symlink(target, link);
  await assert.rejects(readTokenFile(link), (error) => /symbolic link/.test(error.message));
});

test("readTokenFile accepts a private regular file and trims it", async (t) => {
  if (!posix) {
    t.skip("POSIX mode bits only");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "coderax-token-"));
  const target = join(directory, "owner-token");
  await writeFile(target, "  owner-token-1234  \n", { mode: 0o600 });
  await chmod(target, 0o600);
  assert.equal(await readTokenFile(target), "owner-token-1234");
});
