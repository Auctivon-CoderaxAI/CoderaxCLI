/**
 * Owner authentication.
 *
 * This is the secure half of `feat/secure-owner-auth`, rewired to the one
 * canonical engine adapter. It keeps the branch's rules:
 *
 * - a token is never written to the plaintext configuration file;
 * - a token argument is never required, and `--token` is a one-shot override;
 * - every store write is verified by the operating-system credential store;
 * - a login proves the token against the deployment before it is stored.
 *
 * The branch's second SDK and `workflow-commands.js` are deliberately not
 * imported: owner identity is verified through `src/engine.js`.
 */

import { CoderaxError, request } from "./client.js";
import { saveConfig } from "./config.js";
import { credentialAccount, readTokenFile } from "./credentials.js";
import { createEngineClient, negotiate, verifyOwner } from "./engine.js";

export const CREDENTIAL_VERSION = 1;

/** Decode JWT claims without verifying them; the engine verifies the token. */
export function parseJwtClaims(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === "") return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function identityFrom(token, claims) {
  if (claims && typeof claims === "object") {
    const value = claims.email ?? claims.preferred_username ?? claims.sub;
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function corrupt(message) {
  return new CoderaxError("CREDENTIAL_CORRUPT", message);
}

/**
 * Surface a credential-store failure with the store's own code. A locked
 * keyring or a refused ACL is a known failure, not an "unexpected" crash, and
 * its diagnostic (already scrubbed by the store helper) must reach the owner.
 */
function storeFailure(action, error) {
  if (error instanceof CoderaxError) return error;
  const code = typeof error?.code === "string" && error.code !== ""
    ? error.code
    : "CREDENTIAL_STORE_FAILED";
  return new CoderaxError(code, `${action}: ${error?.message ?? String(error)}`);
}

function parseCredential(raw, baseUrl) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupt("the stored credential is not valid JSON; run `coderax login` again");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw corrupt("the stored credential has an unsupported format; run `coderax login` again");
  }
  if (parsed.version !== CREDENTIAL_VERSION) {
    throw corrupt("the stored credential has an unsupported version; run `coderax login` again");
  }
  if (parsed.baseUrl !== baseUrl) {
    throw corrupt("the stored credential belongs to a different deployment; run `coderax login` again");
  }
  if (typeof parsed.token !== "string" || parsed.token === "") {
    throw corrupt("the stored credential has no access token; run `coderax login` again");
  }
  return {
    baseUrl: parsed.baseUrl,
    token: parsed.token,
    account: typeof parsed.account === "string" ? parsed.account : null,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
  };
}

export function requireCredentialStore(store) {
  if (!store || store.available !== true) {
    const detail = store?.detail ? `: ${store.detail}` : "";
    throw new CoderaxError(
      "CREDENTIAL_STORE_UNAVAILABLE",
      `no operating-system credential store is available${detail}. `
        + "The CLI never writes a token to a plaintext file; install an OS credential store "
        + "(macOS Keychain, Linux libsecret, or Windows DPAPI) or set CODERAX_TOKEN for automation.",
    );
  }
  return store;
}

/** Read the credential for one deployment, or null when none is stored. */
export async function readStoredCredential({ store, baseUrl }) {
  if (!store?.available || !baseUrl) return null;
  let raw;
  try {
    raw = await store.get(credentialAccount(baseUrl));
  } catch (error) {
    throw storeFailure("could not read the stored credential", error);
  }
  if (raw === null || raw === undefined || raw === "") return null;
  return parseCredential(raw, baseUrl);
}

/**
 * Store the token in the OS credential store and read it back. A store that
 * silently drops the item is reported as a failure, never as success.
 */
export async function storeCredential({ store, baseUrl, token, account = null }) {
  requireCredentialStore(store);
  const record = JSON.stringify({
    version: CREDENTIAL_VERSION,
    baseUrl,
    token,
    account,
    createdAt: new Date().toISOString(),
  });
  const key = credentialAccount(baseUrl);
  try {
    await store.set(key, record);
  } catch (error) {
    throw storeFailure("could not write the credential", error);
  }
  let stored;
  try {
    stored = await store.get(key);
  } catch (error) {
    throw storeFailure("could not verify the stored credential", error);
  }
  if (stored !== record) {
    throw new CoderaxError(
      "CREDENTIAL_WRITE_FAILED",
      "the operating-system credential store did not retain the session; run `coderax login` again",
    );
  }
  return { baseUrl, account, store: store.name };
}

/**
 * Resolve the token for one invocation.
 *
 * Precedence: an explicit flag, the environment, the OS store, then a legacy
 * plaintext token that has not been migrated yet. The last one is reported so
 * the caller can warn; `coderax login` removes it.
 */
export async function resolveSessionToken({ config, env = process.env, flagToken, store } = {}) {
  if (typeof flagToken === "string" && flagToken.trim() !== "") {
    return { token: flagToken.trim(), source: "command flag", legacy: false, account: null };
  }
  const environment = env.CODERAX_TOKEN?.trim();
  if (environment) {
    return { token: environment, source: "environment", legacy: false, account: null };
  }
  if (store?.available && config?.baseUrl) {
    const credential = await readStoredCredential({ store, baseUrl: config.baseUrl });
    if (credential) {
      return {
        token: credential.token,
        source: "credential store",
        legacy: false,
        account: credential.account,
      };
    }
  }
  if (typeof config?.token === "string" && config.token !== "") {
    return { token: config.token, source: "config file", legacy: true, account: config.account ?? null };
  }
  return { token: null, source: "none", legacy: false, account: config?.account ?? null };
}

/** Best-effort account label; a deployment without /api/user is not an error. */
async function accountLabel({ baseUrl, token, timeoutMs, fetchImpl, claims }) {
  const fromClaims = identityFrom(token, claims);
  if (fromClaims) return fromClaims;
  try {
    const response = await request({
      baseUrl,
      token,
      path: "/api/user",
      timeoutMs,
      fetchImpl,
    });
    const body = response.json ?? {};
    const value = body.email ?? body.username ?? body.name;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Verify an owner token against the deployment, then move it into the OS
 * credential store. Verification is the canonical handshake plus the cheapest
 * owner-only read, so a token for another role is refused before storage.
 */
export async function loginWithToken(
  context,
  rawToken,
  { source = "stdin", account = null, fetchImpl } = {},
) {
  const baseUrl = context.baseUrl;
  if (!baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no deployment configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (token === "") {
    throw new CoderaxError(
      "USAGE",
      "no token provided; use `coderax login --token-file <path>`, pipe it to `coderax login --with-token`, or set CODERAX_TOKEN",
    );
  }
  const store = requireCredentialStore(context.credentialStore);

  const client = createEngineClient({
    baseUrl,
    token,
    timeoutMs: context.timeoutMs,
    fetchImpl: fetchImpl ?? context.fetchImpl ?? fetch,
  });
  await negotiate(client);
  await verifyOwner(client);

  const claims = parseJwtClaims(token);
  const label = account ?? (await accountLabel({
    baseUrl,
    token,
    timeoutMs: context.timeoutMs,
    fetchImpl: fetchImpl ?? context.fetchImpl ?? fetch,
    claims,
  }));

  const stored = await storeCredential({ store, baseUrl, token, account: label });
  // Remove a legacy plaintext token only after the secure store verified the
  // write, so a failed login can never lose the only working credential.
  await saveConfig({ token: null, account: label, baseUrl }, { filePath: context.configPath });
  return {
    authenticated: true,
    account: label,
    source,
    store: stored.store,
    token,
  };
}

/** Remove the stored credential for the configured deployment. */
export async function logoutSession(context) {
  const store = context.credentialStore;
  let removed = false;
  let storeError = null;
  if (store?.available && context.baseUrl) {
    try {
      removed = (await store.delete(credentialAccount(context.baseUrl))) === true;
    } catch (error) {
      storeError = error instanceof CoderaxError ? error.message : String(error?.message ?? error);
    }
  }
  await saveConfig({ token: null, account: null }, { filePath: context.configPath });

  const environmentTokenActive = Boolean(context.env?.CODERAX_TOKEN?.trim());
  const message = storeError
    ? `The local session file was cleared, but the credential store could not be reached: ${storeError}.`
    : environmentTokenActive
      ? "Stored credentials cleared. CODERAX_TOKEN is still set; unset it to sign out of this environment."
      : removed
        ? "Signed out."
        : "No stored credentials.";
  return { removed, environmentTokenActive, message, storeError };
}

/** Local-only authentication report; it never prints a token. */
export async function describeAuth(context) {
  const store = context.credentialStore;
  let storeInfo = { name: store?.name ?? "none", available: false, secure: false, detail: "not initialised" };
  if (store?.describe) storeInfo = await store.describe();
  let credential = null;
  let error = null;
  if (store?.available && context.baseUrl) {
    try {
      credential = await readStoredCredential({ store, baseUrl: context.baseUrl });
    } catch (caught) {
      error = caught instanceof CoderaxError ? caught.message : String(caught?.message ?? caught);
    }
  }
  return {
    store: storeInfo,
    stored: Boolean(credential),
    account: credential?.account ?? null,
    credentialError: error,
  };
}

export { readTokenFile };
