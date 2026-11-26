import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ensureSecureFile,
  SecureStoreError,
  verifySecurePath,
  writeSecureFile,
} from "../src/secure-store.js";
import { readTokenFile } from "../src/credentials.js";

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
    runCommand: async () => ({
      stdout:
        "C:\\Users\\owner\\Coderax\\secret OWNER:(F)\n"
        + "  BUILTIN\\Users:(RX)\n"
        + "  NT AUTHORITY\\Authenticated Users:(RX)\n",
    }),
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
    runCommand: async () => ({ stdout: "C:\\secret  BUILTIN\\Administrators:(F)\n" }),
  });
  assert.equal(missingOwner.reason, "ACL_OWNER_UNVERIFIED");

  const restricted = await verifySecurePath("C:\\secret", {
    ...base,
    runCommand: async () => ({ stdout: "C:\\secret OWNER:(F)\n" }),
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
