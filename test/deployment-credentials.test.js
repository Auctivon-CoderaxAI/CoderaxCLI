import test from "node:test";
import assert from "node:assert/strict";
import { readCredential, writeCredential } from "../src/legacy-credentials.js";

const ENV = { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" };
const OK_POWERSHELL = async () => ({ status: 0, stdout: "", stderr: "" });

test("a DPAPI credential file is hardened and verified before success", async () => {
  const calls = [];
  const result = await writeCredential({
    backend: "windows-dpapi",
    account: "owner",
    token: "secret-token",
    env: ENV,
    deps: {
      powershell: OK_POWERSHELL,
      hardenAcl: async (path) => calls.push(["harden", path]),
      verifyAcl: async (path) => {
        calls.push(["verify", path]);
        return { ok: true, detail: "owner only" };
      },
    },
  });
  assert.equal(result, "windows-dpapi");
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "harden");
  assert.equal(calls[1][0], "verify");
  assert.match(calls[0][1], /credential\.dpapi$/);
});

test("a credential write fails closed when the ACL cannot be verified", async () => {
  await assert.rejects(
    () =>
      writeCredential({
        backend: "windows-dpapi",
        account: "owner",
        token: "secret-token",
        env: ENV,
        deps: {
          powershell: OK_POWERSHELL,
          hardenAcl: async () => {},
          verifyAcl: async () => ({ ok: false, reason: "ACL_TOO_BROAD", detail: "Users can read" }),
        },
      }),
    /not private: Users can read/,
  );
});

test("a non-private credential file is never read", async () => {
  await assert.rejects(
    () =>
      readCredential({
        backend: "windows-dpapi",
        account: "owner",
        env: ENV,
        deps: {
          powershell: OK_POWERSHELL,
          verifyAcl: async () => ({ ok: false, reason: "ACL_TOO_BROAD", detail: "Users can read" }),
        },
      }),
    /refusing to read a credential file that is not private/,
  );
});

test("a missing credential file is reported as signed out", async () => {
  const value = await readCredential({
    backend: "windows-dpapi",
    account: "owner",
    env: ENV,
    deps: {
      powershell: OK_POWERSHELL,
      verifyAcl: async () => ({ ok: false, reason: "MISSING", detail: "absent" }),
    },
  });
  assert.equal(value, null);
});
