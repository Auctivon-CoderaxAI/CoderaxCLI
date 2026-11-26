import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertScope,
  assertSecureTransport,
  authorizedRequest,
  deviceLogin,
  localAuthStatus,
  loginWithToken,
  logoutSession,
  parseBearerChallenge,
  parseJwtClaims,
  resolveAuthEndpoints,
  resolveSession,
  safeEndpointPath,
  verifyEndpointIdentity,
  whoamiIdentity,
} from "../src/auth.js";
import { credentialAccount } from "../src/credentials.js";

const BASE = "https://coderax.test";

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function futureSeconds(offset = 3600) {
  return Math.floor(Date.now() / 1000) + offset;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function memoryStore() {
  const map = new Map();
  return {
    name: "memory-test",
    available: true,
    secure: true,
    detail: "in-memory test store",
    async get(account) {
      return map.has(account) ? map.get(account) : null;
    },
    async set(account, secret) {
      map.set(account, secret);
    },
    async delete(account) {
      return map.delete(account);
    },
    async describe() {
      return { name: "memory-test", available: true, secure: true, detail: "in-memory test store" };
    },
    map,
  };
}

async function makeContext({
  baseUrl = BASE,
  store = memoryStore(),
  fetchImpl,
  env = {},
  flags = new Map(),
  configPath,
  authDeps = {},
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "coderax-auth-"));
  const path = configPath ?? join(directory, "config.json");
  return {
    settings: {
      baseUrl,
      timeoutMs: 2000,
      configPath: path,
      hasLegacyPlaintextToken: false,
      chatPath: "/api/ask/agents",
      endpoint: "agents",
      model: "",
      output: "text",
      token: env.CODERAX_TOKEN ?? null,
    },
    env,
    flags,
    credentialStore: store,
    fetchImpl,
    authDeps,
    stdinIsTTY: false,
    signal: undefined,
    json: true,
    out() {},
    err() {},
    raw() {},
    readSecret: async () => "",
  };
}

function storedCredential({
  baseUrl = BASE,
  accessToken,
  refreshToken = "refresh-1",
  expiresAt,
  scopes = ["coderax:chat"],
  scopesKnown = true,
  subject = "user-1",
} = {}) {
  return {
    version: 1,
    baseUrl,
    issuer: baseUrl,
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresAt,
    expirySource: "token",
    scopes,
    scopesKnown,
    subject,
    account: "dev@coderax.test",
    endpoints: {
      deviceCode: "/api/auth/device/code",
      deviceToken: "/api/auth/device/token",
      refresh: "/api/auth/token/refresh",
      revoke: "/api/auth/token/revoke",
      userinfo: "/api/user",
    },
    clientId: "coderax-cli",
    createdAt: Date.now(),
    refreshedAt: Date.now(),
  };
}

test("JWT claims provide expiry, issuer, subject and scopes", async () => {
  const token = jwt({
    exp: futureSeconds(),
    iss: BASE,
    sub: "user-1",
    scope: "coderax:chat coderax:work",
  });
  const claims = parseJwtClaims(token);
  assert.equal(claims.sub, "user-1");
  assert.deepEqual(claims.scope.split(" "), ["coderax:chat", "coderax:work"]);

  const ctx = await makeContext({ env: { CODERAX_TOKEN: token } });
  const session = await resolveSession(ctx, { requiredScope: "coderax:chat" });
  assert.equal(session.source, "environment");
  assert.deepEqual(session.scopes, ["coderax:chat", "coderax:work"]);
  assert.throws(
    () => assertScope(session, "coderax:call"),
    (error) => error.code === "INSUFFICIENT_SCOPE",
  );
});

test("an expired token is rejected locally", async () => {
  const token = jwt({ exp: Math.floor(Date.now() / 1000) - 10, iss: BASE });
  const ctx = await makeContext({ env: { CODERAX_TOKEN: token } });
  await assert.rejects(
    () => resolveSession(ctx),
    (error) => error.code === "SESSION_EXPIRED",
  );
});

test("a token from a different issuer is refused", async () => {
  const token = jwt({ exp: futureSeconds(), iss: "https://other.example.com" });
  const ctx = await makeContext({ env: { CODERAX_TOKEN: token } });
  await assert.rejects(
    () => resolveSession(ctx),
    (error) => error.code === "TOKEN_ISSUER_MISMATCH",
  );
});

test("CODERAX_TOKEN cannot be redirected to a different base URL", async () => {
  const token = jwt({ exp: futureSeconds(), iss: BASE });
  const ctx = await makeContext({
    baseUrl: "https://evil.example.com",
    env: { CODERAX_TOKEN: token, CODERAX_BASE_URL: BASE },
    flags: new Map([["base-url", "https://evil.example.com"]]),
  });
  await assert.rejects(
    () => resolveSession(ctx),
    (error) => error.code === "TOKEN_ORIGIN_OVERRIDE",
  );
});

test("TLS verification cannot be disabled while credentials are used", () => {
  assert.throws(
    () => assertSecureTransport({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
    (error) => error.code === "TLS_VERIFICATION_DISABLED",
  );
  assert.doesNotThrow(() => assertSecureTransport({}));
});

test("bearer challenges and endpoint paths are parsed defensively", () => {
  assert.deepEqual(
    parseBearerChallenge('Bearer error="insufficient_scope", scope="coderax:chat"'),
    { error: "insufficient_scope", scope: "coderax:chat" },
  );
  assert.equal(parseBearerChallenge("Basic abc"), null);
  assert.equal(safeEndpointPath("/api/user"), "/api/user");
  assert.equal(safeEndpointPath("https://evil.example.com/steal"), null);
  assert.equal(safeEndpointPath("//evil.example.com/steal"), null);
  assert.equal(safeEndpointPath("/api/../secret"), null);
  assert.equal(safeEndpointPath("/api/user?token=x"), null);
});

test("auth endpoints are discovered from the OpenAPI document", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      openapi: "3.1.0",
      info: { title: "Coderax" },
      paths: {
        "/custom/device/authorization": { post: {} },
        "/custom/device/token": { post: {} },
        "/custom/token/refresh": { post: {} },
        "/custom/token/revoke": { post: {} },
        "/custom/me": { get: {} },
      },
    });
  const endpoints = await resolveAuthEndpoints({ baseUrl: BASE, fetchImpl });
  assert.equal(endpoints.deviceCode, "/custom/device/authorization");
  assert.equal(endpoints.deviceToken, "/custom/device/token");
  assert.equal(endpoints.refresh, "/custom/token/refresh");
  assert.equal(endpoints.revoke, "/custom/token/revoke");
});

test("endpoint identity requires a Coderax marker", async () => {
  const verified = await verifyEndpointIdentity({
    baseUrl: BASE,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health") return jsonResponse({ status: "ok", service: "coderax-api" });
      return jsonResponse({ message: "not found" }, 404);
    },
  });
  assert.equal(verified.verified, true);

  const unverified = await verifyEndpointIdentity({
    baseUrl: BASE,
    fetchImpl: async () => jsonResponse({ message: "not found" }, 404),
  });
  assert.equal(unverified.verified, false);
});

test("a legacy plaintext token is migrated into the OS store and removed from config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coderax-migrate-"));
  const configPath = join(directory, "config.json");
  const token = jwt({ exp: futureSeconds(), iss: BASE, sub: "user-1", scope: "coderax:chat" });
  await writeFile(configPath, JSON.stringify({ baseUrl: BASE, token }), "utf8");
  const store = memoryStore();
  const ctx = await makeContext({ store, configPath });

  const session = await resolveSession(ctx);
  assert.equal(session.accessToken, token);
  assert.equal(store.map.size, 1);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(configPath, "utf8")), "token"), false);
});

test("a scoped session cannot use a command outside its grant", async () => {
  const token = jwt({ exp: futureSeconds(), iss: BASE, sub: "user-1", scope: "coderax:models:read" });
  const ctx = await makeContext({
    env: { CODERAX_TOKEN: token },
    fetchImpl: async () => {
      throw new Error("a scope denial must not reach the network");
    },
  });
  await assert.rejects(
    () => resolveSession(ctx, { requiredScope: "coderax:chat" }),
    (error) => error.code === "INSUFFICIENT_SCOPE",
  );
});

test("stored credentials are bound to their deployment", async () => {
  const store = memoryStore();
  const accessToken = jwt({ exp: futureSeconds(), iss: BASE, sub: "user-1", scope: "coderax:chat" });
  store.map.set(
    credentialAccount(BASE),
    JSON.stringify(storedCredential({ accessToken, expiresAt: futureSeconds() * 1000 })),
  );

  const ctx = await makeContext({ store });
  const session = await resolveSession(ctx, { requiredScope: "coderax:chat" });
  assert.equal(session.accessToken, accessToken);
  assert.equal(session.source, "credential-store");

  store.map.set(
    credentialAccount(BASE),
    JSON.stringify(storedCredential({ accessToken, baseUrl: "https://other.example.com", expiresAt: futureSeconds() * 1000 })),
  );
  await assert.rejects(
    () => resolveSession(ctx),
    (error) => error.code === "CREDENTIAL_ORIGIN_MISMATCH",
  );
});

test("an expiring session refreshes and rotates its refresh token", async () => {
  const now = Date.now();
  const store = memoryStore();
  const oldToken = jwt({ exp: Math.floor(now / 1000) + 30, iss: BASE, sub: "user-1", scope: "coderax:chat" });
  const newToken = jwt({ exp: Math.floor(now / 1000) + 3600, iss: BASE, sub: "user-1", scope: "coderax:chat" });
  store.map.set(
    credentialAccount(BASE),
    JSON.stringify(storedCredential({ accessToken: oldToken, expiresAt: now + 30_000 })),
  );

  let refreshBody;
  const ctx = await makeContext({
    store,
    authDeps: { now: () => now },
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).pathname, "/api/auth/token/refresh");
      refreshBody = new URLSearchParams(init.body);
      return jsonResponse({
        access_token: newToken,
        refresh_token: "refresh-2",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "coderax:chat",
      });
    },
  });

  const session = await resolveSession(ctx, { requiredScope: "coderax:chat" });
  assert.equal(session.accessToken, newToken);
  assert.equal(refreshBody.get("grant_type"), "refresh_token");
  assert.equal(refreshBody.get("refresh_token"), "refresh-1");
  assert.equal(refreshBody.get("client_id"), "coderax-cli");

  const saved = JSON.parse(store.map.get(credentialAccount(BASE)));
  assert.equal(saved.accessToken, newToken);
  assert.equal(saved.refreshToken, "refresh-2");
  assert.equal(saved.expiresAt, Math.min(now + 3600 * 1000, (Math.floor(now / 1000) + 3600) * 1000));
});

test("refresh cannot escalate scopes", async () => {
  const now = Date.now();
  const store = memoryStore();
  const oldToken = jwt({ exp: Math.floor(now / 1000) + 30, iss: BASE, sub: "user-1", scope: "coderax:chat" });
  const newToken = jwt({ exp: Math.floor(now / 1000) + 3600, iss: BASE, sub: "user-1", scope: "coderax:chat coderax:admin" });
  store.map.set(
    credentialAccount(BASE),
    JSON.stringify(storedCredential({ accessToken: oldToken, expiresAt: now + 30_000 })),
  );
  const ctx = await makeContext({
    store,
    authDeps: { now: () => now },
    fetchImpl: async () =>
      jsonResponse({ access_token: newToken, expires_in: 3600, scope: "coderax:chat coderax:admin" }),
  });

  await assert.rejects(
    () => resolveSession(ctx),
    (error) => error.code === "CREDENTIAL_SCOPE_ESCALATION",
  );
  const saved = JSON.parse(store.map.get(credentialAccount(BASE)));
  assert.equal(saved.accessToken, oldToken);
});

test("a rejected refresh token clears the unusable credential", async () => {
  const now = Date.now();
  const store = memoryStore();
  const oldToken = jwt({ exp: Math.floor(now / 1000) + 30, iss: BASE, sub: "user-1", scope: "coderax:chat" });
  store.map.set(
    credentialAccount(BASE),
    JSON.stringify(storedCredential({ accessToken: oldToken, expiresAt: now + 30_000 })),
  );
  const ctx = await makeContext({
    store,
    authDeps: { now: () => now },
    fetchImpl: async () => jsonResponse({ error: "invalid_grant" }, 400),
  });

  await assert.rejects(
    () => resolveSession(ctx),
    (error) => error.code === "SESSION_EXPIRED",
  );
  assert.equal(store.map.has(credentialAccount(BASE)), false);
});

test("a 401 triggers one refresh and retry", async () => {
  const now = Date.now();
  const store = memoryStore();
  const oldToken = jwt({ exp: Math.floor(now / 1000) + 3600, iss: BASE, sub: "user-1", scope: "coderax:agents:read" });
  const newToken = jwt({ exp: Math.floor(now / 1000) + 7200, iss: BASE, sub: "user-1", scope: "coderax:agents:read" });
  store.map.set(
    credentialAccount(BASE),
    JSON.stringify(storedCredential({
      accessToken: oldToken,
      expiresAt: (now + 3600_000),
      scopes: ["coderax:agents:read"],
    })),
  );

  const calls = [];
  const ctx = await makeContext({
    store,
    authDeps: { now: () => now },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, authorization: init.headers.authorization });
      if (path === "/api/agents") {
        if (init.headers.authorization === `Bearer ${oldToken}`) {
          return jsonResponse({ error: "invalid_token" }, 401, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
        }
        return jsonResponse({ agents: [] });
      }
      if (path === "/api/auth/token/refresh") {
        return jsonResponse({ access_token: newToken, expires_in: 3600, scope: "coderax:agents:read" });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  const response = await authorizedRequest(
    ctx,
    { path: "/api/agents" },
    { requiredScope: "coderax:agents:read" },
  );
  assert.deepEqual(response.json, { agents: [] });
  assert.deepEqual(calls.map((call) => call.path), ["/api/agents", "/api/auth/token/refresh", "/api/agents"]);
  assert.equal(calls[2].authorization, `Bearer ${newToken}`);
});

test("device login polls, verifies identity and stores a refreshable session", async () => {
  const now = Date.now();
  const store = memoryStore();
  const accessToken = jwt({ exp: Math.floor(now / 1000) + 3600, iss: BASE, sub: "user-1", scope: "coderax:chat coderax:work" });
  const notices = [];
  let polls = 0;
  let clock = now;

  const ctx = await makeContext({
    store,
    authDeps: { now: () => clock, sleep: async (ms) => { clock += ms; } },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/health") return jsonResponse({ status: "ok", service: "coderax" });
      if (path === "/openapi.json") {
        return jsonResponse({
          openapi: "3.1.0",
          info: { title: "Coderax" },
          paths: {
            "/api/auth/device/code": { post: {} },
            "/api/auth/device/token": { post: {} },
            "/api/user": { get: {} },
          },
        });
      }
      if (path === "/api/auth/device/code") {
        assert.equal(new URLSearchParams(init.body).get("client_id"), "coderax-cli");
        return jsonResponse({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: `${BASE}/device`,
          verification_uri_complete: `${BASE}/device?code=ABCD-EFGH`,
          expires_in: 600,
          interval: 1,
        });
      }
      if (path === "/api/auth/device/token") {
        polls += 1;
        const form = new URLSearchParams(init.body);
        assert.equal(form.get("device_code"), "device-secret");
        if (polls === 1) return jsonResponse({ error: "authorization_pending" }, 400);
        return jsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "coderax:chat coderax:work",
        });
      }
      if (path === "/api/user") {
        assert.equal(init.headers.authorization, `Bearer ${accessToken}`);
        return jsonResponse({ email: "dev@coderax.test", sub: "user-1" });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  const result = await deviceLogin(ctx, {
    noBrowser: true,
    notify: (text) => notices.push(text),
  });

  assert.equal(result.credential.accessToken, accessToken);
  assert.equal(result.credential.refreshToken, "refresh-1");
  assert.equal(result.account, "dev@coderax.test");
  assert.equal(store.map.size, 1);
  assert.equal(notices.join("\n").includes("device-secret"), false);
  assert.match(notices.join("\n"), /ABCD-EFGH|code=ABCD-EFGH/);
  assert.equal(polls, 2);
});

test("device login refuses a verification URL on another origin", async () => {
  const store = memoryStore();
  const ctx = await makeContext({
    store,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health") return jsonResponse({ status: "ok", service: "coderax" });
      if (path === "/openapi.json") {
        return jsonResponse({ openapi: "3.1.0", info: { title: "Coderax" }, paths: {} });
      }
      if (path === "/api/auth/device/code") {
        return jsonResponse({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://evil.example.com/device",
          expires_in: 600,
          interval: 1,
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  await assert.rejects(
    () => deviceLogin(ctx, { noBrowser: true }),
    (error) => error.code === "ENDPOINT_UNVERIFIED",
  );
  assert.equal(store.map.size, 0);
});

test("device login reports denied and unsupported authorization", async () => {
  const deniedContext = await makeContext({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health") return jsonResponse({ service: "coderax" });
      if (path === "/openapi.json") return jsonResponse({ openapi: "3.1.0", info: { title: "Coderax" }, paths: {} });
      if (path === "/api/auth/device/code") {
        return jsonResponse({
          device_code: "d",
          user_code: "u",
          verification_uri: `${BASE}/device`,
          expires_in: 60,
          interval: 1,
        });
      }
      if (path === "/api/auth/device/token") return jsonResponse({ error: "access_denied" }, 400);
      throw new Error(`unexpected ${path}`);
    },
  });
  await assert.rejects(
    () => deviceLogin(deniedContext, { noBrowser: true, sleep: async () => {} }),
    (error) => error.code === "DEVICE_ACCESS_DENIED",
  );

  const unsupportedContext = await makeContext({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health") return jsonResponse({ service: "coderax" });
      if (path === "/openapi.json") return jsonResponse({ openapi: "3.1.0", info: { title: "Coderax" }, paths: {} });
      return jsonResponse({ message: "not found" }, 404);
    },
  });
  await assert.rejects(
    () => deviceLogin(unsupportedContext, { noBrowser: true }),
    (error) => error.code === "DEVICE_AUTH_UNSUPPORTED",
  );
});

test("login refuses to replace credentials for another deployment", async () => {
  const store = memoryStore();
  const oldBase = "https://old.coderax.test";
  store.map.set(credentialAccount(oldBase), JSON.stringify({ version: 1 }));
  const directory = await mkdtemp(join(tmpdir(), "coderax-switch-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ baseUrl: oldBase }), "utf8");
  const ctx = await makeContext({ store, configPath });
  const token = jwt({ exp: futureSeconds(), iss: BASE, sub: "user-1" });

  await assert.rejects(
    () => loginWithToken(ctx, token),
    (error) => error.code === "SIGN_OUT_FIRST",
  );
  assert.equal(store.map.size, 1);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).baseUrl, oldBase);
});

test("headless login verifies the deployment and stores no plaintext", async () => {
  const store = memoryStore();
  const directory = await mkdtemp(join(tmpdir(), "coderax-login-"));
  const configPath = join(directory, "config.json");
  const accessToken = jwt({ exp: futureSeconds(), iss: BASE, sub: "user-1", scope: "coderax:chat" });
  const ctx = await makeContext({
    store,
    configPath,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health") return jsonResponse({ status: "ok", service: "coderax" });
      if (path === "/openapi.json") return jsonResponse({ openapi: "3.1.0", info: { title: "Coderax" }, paths: {} });
      if (path === "/api/user") return jsonResponse({ email: "dev@coderax.test", sub: "user-1" });
      throw new Error(`unexpected ${path}`);
    },
  });

  const result = await loginWithToken(ctx, accessToken);
  assert.equal(result.account, "dev@coderax.test");
  assert.equal(store.map.size, 1);
  const storedConfig = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(Object.hasOwn(storedConfig, "token"), false);
  assert.equal(storedConfig.baseUrl, BASE);
});

test("logout revokes both token kinds before deleting the credential", async () => {
  const store = memoryStore();
  const accessToken = jwt({ exp: futureSeconds(), iss: BASE, sub: "user-1", scope: "coderax:chat" });
  store.map.set(
    credentialAccount(BASE),
    JSON.stringify(storedCredential({ accessToken, expiresAt: futureSeconds() * 1000 })),
  );
  const revoked = [];
  const ctx = await makeContext({
    store,
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).pathname, "/api/auth/token/revoke");
      const form = new URLSearchParams(init.body);
      revoked.push({ token: form.get("token"), hint: form.get("token_type_hint") });
      return new Response("", { status: 200 });
    },
  });

  const result = await logoutSession(ctx);
  assert.equal(result.removed, true);
  assert.equal(result.revocation.ok, true);
  assert.deepEqual(revoked, [
    { token: "refresh-1", hint: "refresh_token" },
    { token: accessToken, hint: "access_token" },
  ]);
  assert.equal(store.map.size, 0);
});

test("a failed revocation still removes the local credential", async () => {
  const store = memoryStore();
  const accessToken = jwt({ exp: futureSeconds(), iss: BASE, sub: "user-1", scope: "coderax:chat" });
  store.map.set(
    credentialAccount(BASE),
    JSON.stringify(storedCredential({ accessToken, expiresAt: futureSeconds() * 1000 })),
  );
  const ctx = await makeContext({
    store,
    fetchImpl: async () => jsonResponse({ message: "server down" }, 500),
  });

  const result = await logoutSession(ctx);
  assert.equal(result.removed, true);
  assert.equal(result.revocation.ok, false);
  assert.equal(result.credentialRemovalFailed, false);
  assert.match(result.warnings.join(" "), /may stay valid/i);
  assert.equal(store.map.size, 0);
});

test("auth status reports a legacy plaintext token without exposing it", async () => {
  const store = memoryStore();
  const directory = await mkdtemp(join(tmpdir(), "coderax-status-"));
  const configPath = join(directory, "config.json");
  const token = "legacy-plaintext-token-value";
  await writeFile(configPath, JSON.stringify({ baseUrl: BASE, token }), "utf8");
  const ctx = await makeContext({ store, configPath });
  const status = await localAuthStatus(ctx);

  assert.equal(status.authenticated, true);
  assert.equal(status.source, "legacy-plaintext");
  assert.equal(status.legacyPlaintextToken, true);
  assert.equal(JSON.stringify(status).includes(token), false);
});

test("whoami detects a subject change reported by the deployment", async () => {
  const store = memoryStore();
  const accessToken = jwt({ exp: futureSeconds(), iss: BASE, sub: "user-1", scope: "coderax:chat" });
  store.map.set(
    credentialAccount(BASE),
    JSON.stringify(storedCredential({ accessToken, expiresAt: futureSeconds() * 1000 })),
  );
  const ctx = await makeContext({
    store,
    fetchImpl: async () => jsonResponse({ email: "someone-else@coderax.test", sub: "user-2" }),
  });

  await assert.rejects(
    () => whoamiIdentity(ctx),
    (error) => error.code === "IDENTITY_MISMATCH",
  );
});
