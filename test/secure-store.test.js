import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSecureFile,
  hardenSecurePath,
  readSecureFile,
  removeSecureFile,
  verifySecurePath,
  writeSecureFile,
} from "../src/secure-store.js";

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
  assert.equal(
    calls[1].options.env.PSModulePath,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
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
