import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
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

test("Windows hardening removes inheritance and grants only the current account", async () => {
  const calls = [];
  await hardenSecurePath("C:\\tmp\\file", {
    platform: "win32",
    env: { USERNAME: "tester" },
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "" };
    },
  });
  assert.deepEqual(calls, [
    { command: "icacls", args: ["C:\\tmp\\file", "/reset"] },
    { command: "icacls", args: ["C:\\tmp\\file", "/inheritance:r", "/grant:r", "tester:F"] },
  ]);
});

test("Windows verifies real ACL principals and fails closed", async () => {
  const secure = await verifySecurePath("C:\\tmp\\file", {
    platform: "win32",
    statImpl: fakeFileStat(),
    env: { USERNAME: "tester" },
    runCommand: async () => ({
      stdout: "C:\\tmp\\file TESTER:(F)\n NT AUTHORITY\\SYSTEM:(F)\n BUILTIN\\Administrators:(F)\n",
    }),
  });
  assert.equal(secure.ok, true);

  const broad = await verifySecurePath("C:\\tmp\\file", {
    platform: "win32",
    statImpl: fakeFileStat(),
    env: { USERNAME: "tester" },
    runCommand: async () => ({ stdout: "C:\\tmp\\file TESTER:(F)\n BUILTIN\\Users:(RX)\n" }),
  });
  assert.equal(broad.ok, false);
  assert.equal(broad.reason, "ACL_TOO_BROAD");

  const unavailable = await verifySecurePath("C:\\tmp\\file", {
    platform: "win32",
    statImpl: fakeFileStat(),
    env: { USERNAME: "tester" },
    runCommand: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, "ACL_UNVERIFIABLE");
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
