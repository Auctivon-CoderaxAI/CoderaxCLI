import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childEnvironment,
  createCredentialStore,
  credentialAccount,
  CredentialError,
} from "../src/credentials.js";

const SECRET = "credential-secret-value";

async function fakePath(binary) {
  const directory = await mkdtemp(join(tmpdir(), "coderax-bin-"));
  const path = join(directory, binary);
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
  return directory;
}

test("credential account keys are stable and deployment-specific", () => {
  assert.equal(credentialAccount("https://coderax.test"), credentialAccount("https://coderax.test"));
  assert.notEqual(credentialAccount("https://coderax.test"), credentialAccount("https://coderax.example.com"));
  assert.match(credentialAccount("https://coderax.test"), /^[a-f0-9]{40}$/);
});

test("credential helpers never inherit CODERAX_TOKEN", () => {
  const env = childEnvironment({ PATH: "/bin", CODERAX_TOKEN: SECRET, KEEP: "yes" });
  assert.equal(env.CODERAX_TOKEN, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.KEEP, "yes");
});

test("no OS credential store is a hard error, never a plaintext fallback", async () => {
  const store = createCredentialStore({
    platform: "linux",
    env: { PATH: "/nonexistent" },
    run: async () => {
      throw new Error("should not run");
    },
  });
  assert.equal(store.available, false);
  await assert.rejects(
    () => store.get("account"),
    (error) => error instanceof CredentialError && error.code === "CREDENTIAL_STORE_UNAVAILABLE",
  );
  await assert.rejects(
    () => store.set("account", SECRET),
    (error) => error instanceof CredentialError && error.code === "CREDENTIAL_STORE_UNAVAILABLE",
  );
});

test("an explicitly selected provider is unavailable on the wrong platform", async () => {
  const store = createCredentialStore({
    platform: "linux",
    env: { CODERAX_CREDENTIAL_STORE: "keychain" },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(store.available, false);
  assert.match(store.detail, /macOS/);
});

test("libsecret receives the secret on stdin, never in argv", async () => {
  const path = await fakePath("secret-tool");
  const calls = [];
  const run = async (command, args, { input }) => {
    calls.push({ command, args, input });
    if (args[0] === "lookup") return { code: 0, stdout: SECRET, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createCredentialStore({ platform: "linux", env: { PATH: path }, run });

  assert.equal(store.available, true);
  await store.set("account-1", SECRET);
  assert.equal(calls[0].args[0], "store");
  assert.equal(calls[0].input, SECRET);
  assert.equal(calls[0].args.join(" ").includes(SECRET), false);

  assert.equal(await store.get("account-1"), SECRET);
  assert.equal(calls[1].args[0], "lookup");
  assert.equal(calls[1].args.join(" ").includes(SECRET), false);

  assert.equal(await store.delete("account-1"), true);
  assert.equal(calls[2].args[0], "clear");
});

test("a missing libsecret item is null, but a locked keyring is an error", async () => {
  const path = await fakePath("secret-tool");
  const missing = createCredentialStore({
    platform: "linux",
    env: { PATH: path },
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
  });
  assert.equal(await missing.get("account-1"), null);

  const locked = createCredentialStore({
    platform: "linux",
    env: { PATH: path },
    run: async () => ({ code: 1, stdout: "", stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" }),
  });
  await assert.rejects(
    () => locked.get("account-1"),
    (error) => error instanceof CredentialError && error.code === "CREDENTIAL_STORE_FAILED",
  );
});

test("credential helper errors never echo the secret", async () => {
  const path = await fakePath("secret-tool");
  const store = createCredentialStore({
    platform: "linux",
    env: { PATH: path },
    run: async () => ({ code: 1, stdout: "", stderr: `failed while storing ${SECRET}` }),
  });
  await assert.rejects(
    () => store.set("account-1", SECRET),
    (error) => {
      assert.equal(error instanceof CredentialError, true);
      assert.equal(error.message.includes(SECRET), false);
      assert.match(error.message, /REDACTED/);
      return true;
    },
  );
});

test("macOS and Windows providers are selected on their platforms", async () => {
  const mac = createCredentialStore({
    platform: "darwin",
    env: { PATH: "/nonexistent" },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(mac.name, "macos-keychain");

  const windowsPath = await fakePath("powershell.exe");
  const windows = createCredentialStore({
    platform: "win32",
    env: { PATH: windowsPath, APPDATA: windowsPath },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(windows.name, "windows-dpapi");
  assert.equal(windows.available, true);
});

test("Windows DPAPI stores ciphertext, not the token", async () => {
  const path = await fakePath("powershell.exe");
  const directory = await mkdtemp(join(tmpdir(), "coderax-dpapi-"));
  const run = async (command, args, { input }) => {
    if (args.includes("-Command") && args[args.indexOf("-Command") + 1].includes("Unprotect")) {
      const sealed = Buffer.from(input, "base64").toString("utf8");
      const plaintext = sealed.startsWith("sealed:") ? sealed.slice("sealed:".length) : sealed;
      return { code: 0, stdout: Buffer.from(plaintext, "utf8").toString("base64"), stderr: "" };
    }
    const plaintext = Buffer.from(input, "base64").toString("utf8");
    return { code: 0, stdout: Buffer.from(`sealed:${plaintext}`, "utf8").toString("base64"), stderr: "" };
  };
  const store = createCredentialStore({
    platform: "win32",
    env: { PATH: path },
    run,
    directory,
  });

  await store.set("account-1", SECRET);
  const file = join(directory, "credentials", "account-1.dpapi");
  const ciphertext = await readFile(file, "utf8");
  assert.equal(ciphertext.includes(SECRET), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  assert.equal(await store.get("account-1"), SECRET);
  assert.equal(await store.delete("account-1"), true);
  await assert.rejects(
    () => readFile(file, "utf8"),
    (error) => error.code === "ENOENT",
  );
});
