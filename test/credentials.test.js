import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  childEnvironment,
  createCredentialStore,
  CredentialError,
  runCommand,
  validateSecret,
} from "../src/credentials.js";
import { tempDir } from "./helpers.js";

const TOKEN = "owner-token-0123456789";

test("validateSecret enforces length, control characters and bounds", () => {
  assert.equal(validateSecret(`  ${TOKEN}  `), TOKEN);
  assert.throws(() => validateSecret("short"), CredentialError);
  assert.throws(() => validateSecret(`${TOKEN}\u0000`), CredentialError);
  assert.throws(() => validateSecret("x".repeat(17 * 1024)), CredentialError);
});

test("childEnvironment is an allowlist, not the caller's environment", () => {
  const env = childEnvironment({
    PATH: "/bin",
    HOME: "/home/me",
    CODERAX_TOKEN: TOKEN,
    OPENAI_API_KEY: "sk-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/me" });
});

test("runCommand does not inherit a token and bounds output", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write(process.env.CODERAX_TOKEN ?? 'missing')"],
    { env: { ...process.env, CODERAX_TOKEN: TOKEN }, timeoutMs: 5_000 },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "missing");
});

test("a file store writes a 0600 credential atomically and reads it back", async () => {
  const dir = await tempDir();
  const store = createCredentialStore({ platform: "linux", directory: dir, mode: "file" });
  const written = await store.write(TOKEN);
  assert.equal(written.kind, "file");
  assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(store.filePath, "utf8")).token, TOKEN);
  assert.equal(await store.read(), TOKEN);
  await store.delete();
  assert.equal(await store.read(), null);
});

test("the memory store never touches disk", async () => {
  const dir = await tempDir();
  const store = createCredentialStore({ platform: "linux", directory: dir, mode: "memory" });
  assert.equal(await store.read(), null);
  await store.write(TOKEN);
  assert.equal(await store.read(), null);
  assert.equal(store.describe().backend, "memory");
});

test("a missing OS backend falls back to the 0600 file and says so", async () => {
  const dir = await tempDir();
  const calls = [];
  const store = createCredentialStore({
    platform: "linux",
    directory: dir,
    mode: "auto",
    runner: async (file, args) => {
      calls.push([file, ...args]);
      return { code: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }), stdout: "", stderr: "" };
    },
  });
  const written = await store.write(TOKEN);
  assert.equal(written.kind, "file");
  assert.match(written.warning, /CREDENTIAL_BACKEND_MISSING/);
  assert.equal(await store.read(), TOKEN);
  assert.ok(calls.some((call) => call[0] === "secret-tool"));
});

test("mode keychain refuses to silently fall back", async () => {
  const dir = await tempDir();
  const store = createCredentialStore({
    platform: "linux",
    directory: dir,
    mode: "keychain",
    runner: async () => ({ code: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }), stdout: "", stderr: "" }),
  });
  await assert.rejects(() => store.write(TOKEN), CredentialError);
});

test("Linux stores the token on stdin, never in argv", async () => {
  const dir = await tempDir();
  let seen;
  const store = createCredentialStore({
    platform: "linux",
    directory: dir,
    mode: "keychain",
    runner: async (file, args, options) => {
      seen = { file, args, input: options.input };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await store.write(TOKEN);
  assert.equal(seen.file, "secret-tool");
  assert.equal(seen.input, TOKEN);
  assert.equal(seen.args.join(" ").includes(TOKEN), false);
});

test("macOS uses security -i with the token on stdin", async () => {
  const dir = await tempDir();
  let seen;
  const store = createCredentialStore({
    platform: "darwin",
    directory: dir,
    mode: "keychain",
    runner: async (file, args, options) => {
      seen = { file, args, input: options.input };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await store.write(TOKEN);
  assert.equal(seen.file, "security");
  assert.deepEqual(seen.args, ["-i"]);
  assert.match(seen.input, /add-generic-password/);
  assert.equal(seen.args.join(" ").includes(TOKEN), false);
});

test("Windows DPAPI receives the token on stdin and writes a protected file", async () => {
  const dir = await tempDir();
  let seen;
  const store = createCredentialStore({
    platform: "win32",
    directory: dir,
    mode: "keychain",
    runner: async (file, args, options) => {
      seen = { file, args, input: options.input };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await store.write(TOKEN);
  assert.equal(seen.file, "powershell.exe");
  assert.equal(seen.input, TOKEN);
  assert.equal(seen.args.join(" ").includes(TOKEN), false);
  assert.match(seen.args.join(" "), /ProtectedData/);
});

test("the store description never contains the token", async () => {
  const dir = await tempDir();
  const store = createCredentialStore({ platform: "linux", directory: dir, mode: "file" });
  await store.write(TOKEN);
  assert.equal(JSON.stringify(store.describe()).includes(TOKEN), false);
});
