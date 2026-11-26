import { spawn } from "node:child_process";
import { CoderaxError, request, streamRequest } from "./client.js";
import { discoverOpenApi } from "./discover.js";
import { loadConfig, normalizeBaseUrl, readLegacyToken, saveConfig, stripLegacyToken } from "./config.js";
import { childEnvironment, credentialAccount } from "./credentials.js";

/**
 * Authentication contract implemented by this CLI. The deployment owns token
 * issuance, refresh, revocation and scope enforcement; see docs/CONTRACT.md.
 */
export const CLIENT_ID = "coderax-cli";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const HEALTH_CANDIDATES = Object.freeze(["/health", "/api/health", "/healthz"]);
export const DEFAULT_AUTH_ENDPOINTS = Object.freeze({
  deviceCode: "/api/auth/device/code",
  deviceToken: "/api/auth/device/token",
  refresh: "/api/auth/token/refresh",
  revoke: "/api/auth/token/revoke",
  userinfo: "/api/user",
});

/** Client-side scope mapping, enforced only when the token reports scopes. */
export const COMMAND_SCOPES = Object.freeze({
  chat: "coderax:chat",
  work: "coderax:work",
  agents: "coderax:agents:read",
  models: "coderax:models:read",
  call: "coderax:call",
});

export const REQUESTED_SCOPES = Object.freeze([
  COMMAND_SCOPES.chat,
  COMMAND_SCOPES.work,
  COMMAND_SCOPES.agents,
  COMMAND_SCOPES.models,
  COMMAND_SCOPES.call,
]);

const EXPIRY_SKEW_MS = 60_000;
const OPAQUE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function envText(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function nowFrom(ctx) {
  const injected = ctx?.authDeps?.now;
  return typeof injected === "function" ? injected() : Date.now();
}

export function scopeForCommand(command) {
  return COMMAND_SCOPES[command] ?? null;
}

/**
 * TLS verification is part of the credential boundary. A caller that disables
 * certificate verification would make every other control cosmetic, so the CLI
 * refuses to send credentials in that mode.
 */
export function assertSecureTransport(env = process.env) {
  if (String(env.NODE_TLS_REJECT_UNAUTHORIZED ?? "").trim() === "0") {
    throw new CoderaxError(
      "TLS_VERIFICATION_DISABLED",
      "refusing to send credentials while NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate verification",
    );
  }
}

/** Decode JWT claims for expiry, issuer and scope checks (never for trust). */
export function parseJwtClaims(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function scopeInfoFromClaims(claims) {
  const raw = claims?.scope ?? claims?.scp;
  if (Array.isArray(raw)) {
    const scopes = raw.filter((scope) => typeof scope === "string" && scope.trim() !== "").map((scope) => scope.trim());
    return { scopes, scopesKnown: true };
  }
  if (typeof raw === "string") {
    return { scopes: raw.split(/\s+/).filter(Boolean), scopesKnown: true };
  }
  return { scopes: [], scopesKnown: false };
}

function scopeInfoFromResponse(body, claims, previous) {
  if (Array.isArray(body?.scopes)) {
    const scopes = body.scopes.filter((scope) => typeof scope === "string" && scope.trim() !== "").map((scope) => scope.trim());
    return { scopes, scopesKnown: true };
  }
  if (typeof body?.scope === "string") {
    return { scopes: body.scope.split(/\s+/).filter(Boolean), scopesKnown: true };
  }
  const fromClaims = scopeInfoFromClaims(claims);
  if (fromClaims.scopesKnown) return fromClaims;
  if (previous?.scopesKnown) return { scopes: [...previous.scopes], scopesKnown: true };
  return { scopes: [], scopesKnown: false };
}

function assertScopesNotEscalated(previous, next) {
  if (!previous?.scopesKnown || !next.scopesKnown) return;
  const allowed = new Set(previous.scopes);
  if (allowed.has("coderax:*")) return;
  for (const scope of next.scopes) {
    if (!allowed.has(scope)) {
      throw new CoderaxError(
        "CREDENTIAL_SCOPE_ESCALATION",
        `the deployment granted a new scope (${scope}) while refreshing; run \`coderax login\` again to approve it`,
      );
    }
  }
}

/** Enforce a client-side scope only when the deployment publishes scopes. */
export function assertScope(session, requiredScope) {
  if (!requiredScope || !session) return;
  if (!session.scopesKnown) return;
  const scopes = Array.isArray(session.scopes) ? session.scopes : [];
  if (scopes.includes(requiredScope) || scopes.includes("coderax:*")) return;
  throw new CoderaxError(
    "INSUFFICIENT_SCOPE",
    `this session lacks the ${requiredScope} scope; run \`coderax login\` again and approve it (granted: ${scopes.join(" ") || "none"})`,
    { status: 403 },
  );
}

/** Only same-origin, relative endpoint paths from the OpenAPI document are used. */
export function safeEndpointPath(value) {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (path === "" || path.length > 512) return null;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (path.includes("://") || path.includes("\\") || path.includes("?") || path.includes("#")) return null;
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  if (path.split("/").includes("..")) return null;
  try {
    if (new URL(path, "https://endpoint.invalid").origin !== "https://endpoint.invalid") return null;
  } catch {
    return null;
  }
  return path;
}

function normalizeEndpoints(endpoints) {
  const result = {};
  for (const key of Object.keys(DEFAULT_AUTH_ENDPOINTS)) {
    result[key] = safeEndpointPath(endpoints?.[key]) ?? DEFAULT_AUTH_ENDPOINTS[key];
  }
  return result;
}

function findEndpoint(operations, { method, ids, paths }) {
  const candidates = operations.filter((operation) => operation.method === method);
  const byId = candidates.find(
    (operation) => typeof operation.operationId === "string" && ids.some((pattern) => pattern.test(operation.operationId)),
  );
  if (byId) return byId.path;
  const byPath = candidates
    .filter((operation) => paths.some((pattern) => pattern.test(operation.path)))
    .sort((a, b) => a.path.length - b.path.length);
  return byPath[0]?.path ?? null;
}

/**
 * Resolve auth routes from the deployment's OpenAPI document, falling back to
 * the documented contract paths. A missing document is not an error: private
 * deployments may not expose one before login.
 */
export async function resolveAuthEndpoints({ baseUrl, token, timeoutMs, fetchImpl } = {}) {
  let operations = [];
  let source = "contract";
  try {
    const discovery = await discoverOpenApi({ baseUrl, token, timeoutMs, fetchImpl });
    operations = discovery.operations;
    source = discovery.sourcePath;
  } catch {
    operations = [];
  }

  const endpoints = {
    deviceCode: findEndpoint(operations, {
      method: "POST",
      ids: [/device.*(authoriz|code)/i, /start.*device/i],
      paths: [/\/device\/(code|authorization)$/i, /\/device_authorization$/i],
    }),
    deviceToken: findEndpoint(operations, {
      method: "POST",
      ids: [/device.*(token|access)/i, /poll.*device/i],
      paths: [/\/device\/(token|access_token)$/i],
    }),
    refresh: findEndpoint(operations, {
      method: "POST",
      ids: [/refresh/i],
      paths: [/\/token\/refresh$/i, /\/refresh$/i],
    }),
    revoke: findEndpoint(operations, {
      method: "POST",
      ids: [/revoke/i],
      paths: [/\/token\/revoke$/i, /\/revoke$/i],
    }),
    userinfo: findEndpoint(operations, {
      method: "GET",
      ids: [/userinfo/i, /currentuser/i, /^getuser$/i],
      paths: [/\/user\/?$/i, /\/userinfo$/i],
    }),
  };

  for (const key of Object.keys(endpoints)) {
    endpoints[key] = safeEndpointPath(endpoints[key]) ?? DEFAULT_AUTH_ENDPOINTS[key];
  }
  return { ...endpoints, source };
}

/**
 * Confirm that the URL really is a Coderax deployment before a user is asked to
 * approve access. Health metadata or the OpenAPI document must name Coderax.
 */
export async function verifyEndpointIdentity({ baseUrl, timeoutMs, fetchImpl } = {}) {
  const evidence = [];
  for (const path of HEALTH_CANDIDATES) {
    try {
      const response = await request({ baseUrl, path, timeoutMs, fetchImpl });
      const marker = [response.json?.service, response.json?.name, response.json?.product, response.json?.application]
        .find((value) => typeof value === "string");
      if (marker && /coderax/i.test(marker)) {
        return { verified: true, evidence: [`${path} identifies ${marker}`] };
      }
      evidence.push(`${path}: no Coderax service marker`);
    } catch (error) {
      evidence.push(`${path}: ${error.code ?? "ERROR"}`);
    }
  }

  try {
    const discovery = await discoverOpenApi({ baseUrl, timeoutMs, fetchImpl });
    const info = discovery.document?.info ?? {};
    const identity = `${info.title ?? ""} ${info.description ?? ""}`;
    if (/coderax/i.test(identity)) {
      return { verified: true, evidence: [`${discovery.sourcePath} is titled Coderax`] };
    }
    evidence.push(`${discovery.sourcePath}: document does not name Coderax`);
  } catch (error) {
    evidence.push(`OpenAPI: ${error.code ?? "ERROR"}`);
  }

  return { verified: false, evidence };
}

function assertVerificationUri(baseUrl, raw) {
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new CoderaxError("AUTH_PROTOCOL_ERROR", "the deployment returned a verification URL with control characters");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CoderaxError("AUTH_PROTOCOL_ERROR", "the deployment returned an invalid verification URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new CoderaxError("AUTH_PROTOCOL_ERROR", "the verification URL must not embed credentials");
  }
  const base = new URL(baseUrl);
  if (url.origin !== base.origin) {
    throw new CoderaxError(
      "ENDPOINT_UNVERIFIED",
      "the device authorization URL is not on the configured deployment origin; refusing to continue",
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(host))) {
    throw new CoderaxError("BASE_URL_INSECURE", "device authorization requires HTTPS (HTTP is allowed only on loopback)");
  }
}

export function parseBearerChallenge(header) {
  if (typeof header !== "string") return null;
  const index = header.toLowerCase().indexOf("bearer");
  if (index === -1) return null;
  const section = header.slice(index + "bearer".length);
  const params = {};
  const pattern = /([a-zA-Z_][\w-]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pattern.exec(section)) !== null) {
    params[match[1].toLowerCase()] = match[2].replace(/\\(.)/g, "$1");
  }
  if (Object.keys(params).length === 0) {
    const bare = /error\s*=\s*([^\s,]+)/i.exec(section);
    if (bare) params.error = bare[1].replace(/"/g, "");
  }
  return params;
}

function oauthErrorCode(error) {
  // Prefer the unredacted internal body: a redaction marker for a short secret
  // must not be able to change which OAuth error is being reported.
  const body = error?.rawJson ?? error?.body;
  const value = typeof body?.error === "string"
    ? body.error
    : typeof body?.code === "string"
      ? body.code
      : null;
  return value ? value.toLowerCase() : null;
}

/** Translate raw HTTP auth failures into actionable CLI errors. */
export function toAuthError(error, { session } = {}) {
  if (!(error instanceof CoderaxError)) return error;
  if (error.status === 401) {
    return new CoderaxError(
      "SESSION_EXPIRED",
      "the deployment rejected the session (HTTP 401); run `coderax login` again",
      { status: 401 },
    );
  }
  if (error.status === 403) {
    const challenge = parseBearerChallenge(error.wwwAuthenticate);
    const code = oauthErrorCode(error);
    if (challenge?.error === "insufficient_scope" || code === "insufficient_scope" || code === "insufficient_scope_error") {
      const granted = session?.scopesKnown ? session.scopes.join(" ") || "none" : "not reported";
      return new CoderaxError(
        "INSUFFICIENT_SCOPE",
        `the deployment refused the request for insufficient scope (granted: ${granted})`,
        { status: 403 },
      );
    }
    return new CoderaxError(
      "FORBIDDEN",
      "the deployment refused the request (HTTP 403); this account may not perform that operation",
      { status: 403 },
    );
  }
  return error;
}

function assertTokenClaims(claims, { baseUrl, now, previousSubject, label = "token" } = {}) {
  if (!claims) return;
  const exp = Number(claims.exp);
  if (claims.exp !== undefined && !Number.isFinite(exp)) {
    throw new CoderaxError("TOKEN_INVALID", `the ${label} has an invalid expiry`);
  }
  if (Number.isFinite(exp) && exp * 1000 <= now) {
    throw new CoderaxError("SESSION_EXPIRED", `the ${label} has expired; run \`coderax login\` again`);
  }
  const nbf = Number(claims.nbf);
  if (claims.nbf !== undefined && !Number.isFinite(nbf)) {
    throw new CoderaxError("TOKEN_INVALID", `the ${label} has an invalid not-before time`);
  }
  if (claims.nbf !== undefined && nbf * 1000 > now + EXPIRY_SKEW_MS) {
    throw new CoderaxError("TOKEN_NOT_YET_VALID", `the ${label} is not valid yet; check the system clock`);
  }
  if (claims.iss !== undefined && claims.iss !== null && typeof claims.iss !== "string") {
    throw new CoderaxError("TOKEN_ISSUER_MISMATCH", `the ${label} has an invalid issuer`);
  }
  if (typeof claims.iss === "string" && claims.iss !== "") {
    let issuer;
    try {
      issuer = new URL(claims.iss);
    } catch {
      throw new CoderaxError("TOKEN_ISSUER_MISMATCH", `the ${label} has an invalid issuer`);
    }
    if (issuer.origin !== new URL(baseUrl).origin) {
      throw new CoderaxError(
        "TOKEN_ISSUER_MISMATCH",
        `the ${label} was issued by a different deployment; refusing to use it here`,
      );
    }
  }
  if (previousSubject && typeof claims.sub === "string" && claims.sub !== previousSubject) {
    throw new CoderaxError("TOKEN_SUBJECT_MISMATCH", `the ${label} belongs to a different account; run \`coderax login\` again`);
  }
}

function resolveExpiry({ expiresIn, claims, now }) {
  if (expiresIn !== undefined && expiresIn !== null) {
    const seconds = Number(expiresIn);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new CoderaxError("AUTH_PROTOCOL_ERROR", "the deployment returned an invalid token expiry");
    }
    const serverExpiresAt = now + seconds * 1000;
    const exp = Number(claims?.exp);
    // `expires_in` can narrow a JWT's lifetime, but it must never make the CLI
    // treat an already-expired JWT as valid.
    return {
      expiresAt: Number.isFinite(exp) ? Math.min(serverExpiresAt, exp * 1000) : serverExpiresAt,
      expirySource: "server",
    };
  }
  const exp = Number(claims?.exp);
  if (Number.isFinite(exp)) return { expiresAt: exp * 1000, expirySource: "token" };
  // Opaque tokens without expiry data still expire locally. The deployment can
  // shorten this by returning expires_in; it cannot extend it from the client.
  return { expiresAt: now + OPAQUE_SESSION_TTL_MS, expirySource: "cli-policy" };
}

function readTokenResponse(body, { baseUrl, now, previous = null }) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new CoderaxError("AUTH_PROTOCOL_ERROR", "the deployment returned an unexpected token response");
  }
  const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
  if (accessToken === "") {
    throw new CoderaxError("AUTH_PROTOCOL_ERROR", "the deployment returned no access token");
  }
  if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer") {
    throw new CoderaxError("TOKEN_TYPE_UNSUPPORTED", "the deployment returned an unsupported token type");
  }
  const claims = parseJwtClaims(accessToken);
  assertTokenClaims(claims, { baseUrl, now, previousSubject: previous?.subject ?? null });
  const scopeInfo = scopeInfoFromResponse(body, claims, previous);
  if (previous) assertScopesNotEscalated(previous, scopeInfo);
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token.trim() !== ""
    ? body.refresh_token.trim()
    : previous?.refreshToken ?? null;
  const { expiresAt, expirySource } = resolveExpiry({ expiresIn: body.expires_in, claims, now });
  const subject = typeof claims?.sub === "string" && claims.sub !== "" ? claims.sub : previous?.subject ?? null;
  return { accessToken, refreshToken, claims, scopeInfo, expiresAt, expirySource, subject };
}

function buildCredential({ baseUrl, token, endpoints, account, now }) {
  const claims = token.claims;
  const issuer = typeof claims?.iss === "string" && claims.iss !== "" ? claims.iss : new URL(baseUrl).origin;
  return {
    version: 1,
    baseUrl,
    issuer,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    tokenType: "Bearer",
    expiresAt: token.expiresAt,
    expirySource: token.expirySource,
    scopes: token.scopeInfo.scopes,
    scopesKnown: token.scopeInfo.scopesKnown,
    subject: token.subject,
    account: typeof account === "string" && account !== "" ? account : null,
    endpoints: normalizeEndpoints(endpoints),
    clientId: CLIENT_ID,
    createdAt: now,
    refreshedAt: now,
  };
}

function sessionFromCredential(credential) {
  return {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken ?? null,
    credential,
    source: "credential-store",
    baseUrl: credential.baseUrl,
    expiresAt: credential.expiresAt ?? null,
    expirySource: credential.expirySource ?? "unknown",
    scopes: Array.isArray(credential.scopes) ? credential.scopes : [],
    scopesKnown: Boolean(credential.scopesKnown),
    subject: credential.subject ?? null,
    account: credential.account ?? null,
    refreshable: Boolean(credential.refreshToken && safeEndpointPath(credential.endpoints?.refresh)),
  };
}

function sessionSecrets(session) {
  return [session?.accessToken, session?.refreshToken, session?.credential?.refreshToken]
    .filter((value) => typeof value === "string" && value !== "");
}

function asCoderaxError(error, fallbackCode) {
  if (error instanceof CoderaxError) return error;
  const code = typeof error?.code === "string" && error.code.startsWith("CREDENTIAL_")
    ? error.code
    : fallbackCode;
  return new CoderaxError(code, error?.message ?? "credential operation failed");
}

function assertCredentialStore(ctx) {
  if (ctx.credentialStore && ctx.credentialStore.available !== false) return;
  const detail = ctx.credentialStore?.detail
    ? `: ${ctx.credentialStore.detail}`
    : "";
  throw new CoderaxError(
    "CREDENTIAL_STORE_UNAVAILABLE",
    `no OS credential store is available${detail}; install an OS keyring or use CODERAX_TOKEN for automation`,
  );
}

function requireBaseUrl(settings) {
  if (!settings?.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no deployment configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  return settings.baseUrl;
}

function parseStoredCredential(raw, baseUrl) {
  let credential;
  try {
    credential = JSON.parse(raw);
  } catch {
    throw new CoderaxError("CREDENTIAL_CORRUPT", "the stored credential is unreadable; run `coderax login` again");
  }
  if (credential === null || typeof credential !== "object" || Array.isArray(credential) || credential.version !== 1) {
    throw new CoderaxError("CREDENTIAL_CORRUPT", "the stored credential has an unsupported format; run `coderax login` again");
  }
  if (typeof credential.accessToken !== "string" || credential.accessToken === "") {
    throw new CoderaxError("CREDENTIAL_CORRUPT", "the stored credential has no access token; run `coderax login` again");
  }
  if (credential.refreshToken !== null && credential.refreshToken !== undefined && typeof credential.refreshToken !== "string") {
    throw new CoderaxError("CREDENTIAL_CORRUPT", "the stored credential has an invalid refresh token; run `coderax login` again");
  }
  if (credential.baseUrl !== baseUrl) {
    throw new CoderaxError(
      "CREDENTIAL_ORIGIN_MISMATCH",
      "stored credentials belong to a different deployment; run `coderax login` for this one",
    );
  }
  if (credential.issuer) {
    let issuer;
    try {
      issuer = new URL(credential.issuer);
    } catch {
      throw new CoderaxError("TOKEN_ISSUER_MISMATCH", "the stored credential has an invalid issuer; run `coderax login` again");
    }
    if (issuer.origin !== new URL(baseUrl).origin) {
      throw new CoderaxError(
        "CREDENTIAL_ORIGIN_MISMATCH",
        "the stored credential was issued by a different deployment; run `coderax login` again",
      );
    }
  }
  if (credential.expiresAt !== null && credential.expiresAt !== undefined && !Number.isFinite(credential.expiresAt)) {
    throw new CoderaxError("CREDENTIAL_CORRUPT", "the stored credential has an invalid expiry; run `coderax login` again");
  }
  credential.refreshToken = credential.refreshToken ?? null;
  credential.expiresAt = credential.expiresAt ?? null;
  credential.scopes = Array.isArray(credential.scopes) ? credential.scopes.filter((scope) => typeof scope === "string") : [];
  credential.scopesKnown = Boolean(credential.scopesKnown);
  credential.endpoints = normalizeEndpoints(credential.endpoints);
  return credential;
}

async function saveCredential(ctx, credential) {
  if (!ctx.credentialStore) {
    throw new CoderaxError("CREDENTIAL_STORE_UNAVAILABLE", "no OS credential store is configured");
  }
  try {
    await ctx.credentialStore.set(credentialAccount(credential.baseUrl), JSON.stringify(credential));
  } catch (error) {
    throw asCoderaxError(error, "CREDENTIAL_WRITE_FAILED");
  }
}

async function readStoredCredential(ctx, baseUrl) {
  if (!ctx.credentialStore) {
    throw new CoderaxError("CREDENTIAL_STORE_UNAVAILABLE", "no OS credential store is configured");
  }
  let raw;
  try {
    raw = await ctx.credentialStore.get(credentialAccount(baseUrl));
  } catch (error) {
    throw asCoderaxError(error, "CREDENTIAL_READ_FAILED");
  }
  if (raw === null || raw === undefined || raw === "") return null;
  return parseStoredCredential(raw, baseUrl);
}

async function deleteStoredCredential(ctx, baseUrl) {
  try {
    return await ctx.credentialStore.delete(credentialAccount(baseUrl));
  } catch (error) {
    throw asCoderaxError(error, "CREDENTIAL_DELETE_FAILED");
  }
}

async function migrateLegacyCredential(ctx, legacyToken, baseUrl, now) {
  const claims = parseJwtClaims(legacyToken);
  assertTokenClaims(claims, { baseUrl, now, label: "legacy token" });
  const scopeInfo = scopeInfoFromClaims(claims);
  const { expiresAt, expirySource } = resolveExpiry({ claims, now });
  const credential = {
    version: 1,
    baseUrl,
    issuer: typeof claims?.iss === "string" && claims.iss !== "" ? claims.iss : new URL(baseUrl).origin,
    accessToken: legacyToken,
    refreshToken: null,
    tokenType: "Bearer",
    expiresAt,
    expirySource,
    scopes: scopeInfo.scopes,
    scopesKnown: scopeInfo.scopesKnown,
    subject: typeof claims?.sub === "string" ? claims.sub : null,
    account: null,
    endpoints: normalizeEndpoints(null),
    clientId: CLIENT_ID,
    createdAt: now,
    refreshedAt: now,
  };
  try {
    await saveCredential(ctx, credential);
  } catch (error) {
    throw new CoderaxError(
      "CREDENTIAL_STORE_UNAVAILABLE",
      `a plaintext token is present in ${ctx.settings.configPath}; move it into an OS credential store with \`coderax login --with-token\` or set CODERAX_TOKEN and delete the token field (${error.message})`,
    );
  }
  let removed;
  try {
    removed = await stripLegacyToken({ filePath: ctx.settings.configPath });
  } catch {
    throw new CoderaxError(
      "CONFIG_WRITE_FAILED",
      `the credential is stored securely, but the plaintext token could not be removed from ${ctx.settings.configPath}; delete the "token" field manually`,
    );
  }
  if (!removed) {
    throw new CoderaxError(
      "CONFIG_WRITE_FAILED",
      `the credential is stored securely, but the plaintext token could not be removed from ${ctx.settings.configPath}; delete the "token" field manually`,
    );
  }
  return credential;
}

async function loadUsableCredential(ctx, baseUrl, { migrate = true } = {}) {
  let credential = null;
  let storeError = null;
  try {
    credential = await readStoredCredential(ctx, baseUrl);
  } catch (error) {
    // Keep the store failure so it can be reported, but first give a legacy
    // plaintext token a chance to migrate with a precise explanation.
    storeError = error;
  }
  if (credential) {
    // Clean up a legacy plaintext copy even when a secure credential already
    // exists, so a one-time failed cleanup cannot leave it behind forever.
    if (ctx.settings.hasLegacyPlaintextToken) {
      try {
        await stripLegacyToken({ filePath: ctx.settings.configPath });
      } catch {
        // Reported by `coderax auth status`; never block a valid session.
      }
    }
    return credential;
  }
  if (migrate) {
    const legacy = await readLegacyToken({ filePath: ctx.settings.configPath });
    if (legacy) return migrateLegacyCredential(ctx, legacy, baseUrl, nowFrom(ctx));
  }
  if (storeError) throw storeError;
  return null;
}

async function assertNoOtherDeploymentCredential(ctx, baseUrl) {
  if (!ctx.credentialStore?.available) return;
  let storedBase = null;
  try {
    storedBase = (await loadConfig({ env: {}, filePath: ctx.settings.configPath })).baseUrl;
  } catch {
    return;
  }
  if (!storedBase || storedBase === baseUrl) return;
  let existing = null;
  try {
    existing = await ctx.credentialStore.get(credentialAccount(storedBase));
  } catch (error) {
    throw asCoderaxError(error, "CREDENTIAL_READ_FAILED");
  }
  if (existing) {
    throw new CoderaxError(
      "SIGN_OUT_FIRST",
      "credentials are stored for a different deployment; run `coderax logout` before signing in to another one",
    );
  }
}

async function assertNoTokenOverride(ctx, baseUrl, envToken) {
  if (!envToken || !ctx.flags?.has?.("base-url")) return;
  const configured = envText(ctx.env?.CODERAX_BASE_URL);
  let normalized = null;
  if (configured) {
    try {
      normalized = normalizeBaseUrl(configured).baseUrl;
    } catch {
      normalized = null;
    }
  }
  if (!normalized) {
    // A --base-url that matches the stored deployment does not move the token
    // to a new origin, so it is safe for CI to combine both.
    try {
      normalized = (await loadConfig({ env: {}, filePath: ctx.settings.configPath })).baseUrl;
    } catch {
      normalized = null;
    }
  }
  if (normalized !== baseUrl) {
    throw new CoderaxError(
      "TOKEN_ORIGIN_OVERRIDE",
      "refusing to send CODERAX_TOKEN to a different base URL; set CODERAX_BASE_URL to that deployment or store credentials with `coderax login`",
    );
  }
}

/**
 * Resolve a usable session, refreshing an expiring credential once. Tokens from
 * CODERAX_TOKEN are caller-managed and are never persisted.
 */
export async function resolveSession(
  ctx,
  { requiredScope = null, allowRefresh = true, forceRefresh = false, migrate = true } = {},
) {
  assertSecureTransport(ctx.env);
  const baseUrl = requireBaseUrl(ctx.settings);
  const envToken = envText(ctx.env?.CODERAX_TOKEN);

  if (envToken) {
    await assertNoTokenOverride(ctx, baseUrl, envToken);
    const claims = parseJwtClaims(envToken);
    const now = nowFrom(ctx);
    assertTokenClaims(claims, { baseUrl, now, label: "CODERAX_TOKEN" });
    const scopeInfo = scopeInfoFromClaims(claims);
    const session = {
      accessToken: envToken,
      refreshToken: null,
      credential: null,
      source: "environment",
      baseUrl,
      expiresAt: Number.isFinite(Number(claims?.exp)) ? Number(claims.exp) * 1000 : null,
      expirySource: Number.isFinite(Number(claims?.exp)) ? "token" : "unknown",
      scopes: scopeInfo.scopes,
      scopesKnown: scopeInfo.scopesKnown,
      subject: typeof claims?.sub === "string" ? claims.sub : null,
      account: null,
      refreshable: false,
    };
    assertScope(session, requiredScope);
    return session;
  }

  let credential = await loadUsableCredential(ctx, baseUrl, { migrate });
  if (!credential) {
    throw new CoderaxError("UNAUTHENTICATED", "not signed in; run `coderax login` first");
  }

  let session = sessionFromCredential(credential);
  const now = nowFrom(ctx);
  const expiring = session.expiresAt !== null && session.expiresAt - now <= EXPIRY_SKEW_MS;
  if (forceRefresh || expiring) {
    if (session.refreshable && allowRefresh) {
      credential = await refreshCredential(ctx, credential, { now, force: forceRefresh });
      session = sessionFromCredential(credential);
    } else if (session.expiresAt !== null && session.expiresAt <= now) {
      throw new CoderaxError("SESSION_EXPIRED", "your session has expired; run `coderax login` again");
    }
  }

  assertScope(session, requiredScope);
  return session;
}

async function refreshCredential(ctx, credential, { now = nowFrom(ctx), force = false } = {}) {
  const endpoint = safeEndpointPath(credential.endpoints?.refresh);
  if (!endpoint) {
    throw new CoderaxError("REFRESH_UNSUPPORTED", "this deployment did not advertise token refresh; run `coderax login` again");
  }
  if (!credential.refreshToken) {
    throw new CoderaxError("SESSION_EXPIRED", "your session cannot be refreshed; run `coderax login` again");
  }

  const secrets = [credential.refreshToken, credential.accessToken].filter(Boolean);
  let response;
  try {
    response = await request({
      baseUrl: credential.baseUrl,
      path: endpoint,
      method: "POST",
      form: {
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: CLIENT_ID,
      },
      timeoutMs: ctx.settings.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      secrets,
      includeRaw: true,
    });
  } catch (error) {
    const code = oauthErrorCode(error);
    const terminal = error?.status === 401
      || code === "invalid_grant"
      || code === "invalid_token"
      || code === "expired_token"
      || code === "access_denied";
    if (terminal) {
      try {
        await deleteStoredCredential(ctx, credential.baseUrl);
      } catch {
        // The session is already unusable; deletion is best effort.
      }
      throw new CoderaxError(
        "SESSION_EXPIRED",
        "your session can no longer be refreshed; run `coderax login` again",
        { status: 401 },
      );
    }
    if (error?.status === 404 || error?.status === 405) {
      throw new CoderaxError("REFRESH_UNSUPPORTED", "this deployment does not expose token refresh; run `coderax login` again");
    }
    throw toAuthError(error);
  }

  let token;
  try {
    token = readTokenResponse(response.rawJson, { baseUrl: credential.baseUrl, now, previous: credential });
  } catch (error) {
    if (error instanceof CoderaxError) throw error;
    throw new CoderaxError("AUTH_PROTOCOL_ERROR", "the deployment returned an unusable refreshed token");
  }

  const next = {
    ...credential,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    expirySource: token.expirySource,
    scopes: token.scopeInfo.scopes,
    scopesKnown: token.scopeInfo.scopesKnown,
    subject: token.subject,
    refreshedAt: now,
  };
  if (force) next.forcedRefreshAt = now;

  try {
    await saveCredential(ctx, next);
  } catch (error) {
    throw new CoderaxError(
      "CREDENTIAL_WRITE_FAILED",
      `the session was refreshed but could not be stored securely; run \`coderax login\` again (${error.message})`,
    );
  }
  return next;
}

async function withSessionRetry(ctx, requiredScope, execute) {
  let session = await resolveSession(ctx, { requiredScope });
  try {
    return await execute(session);
  } catch (error) {
    if (error?.status === 401 && session.refreshable) {
      let credential;
      try {
        credential = await refreshCredential(ctx, session.credential, { force: true });
      } catch (refreshError) {
        throw toAuthError(refreshError, { session });
      }
      session = sessionFromCredential(credential);
      assertScope(session, requiredScope);
      try {
        return await execute(session);
      } catch (retryError) {
        throw toAuthError(retryError, { session });
      }
    }
    throw toAuthError(error, { session });
  }
}

/** Authenticated single request with one refresh-and-retry on HTTP 401. */
export async function authorizedRequest(ctx, options = {}, { requiredScope = null } = {}) {
  return withSessionRetry(ctx, requiredScope, (session) =>
    request({
      ...options,
      // These are applied last so a caller cannot override the pinned origin
      // or replace the session token with one for another deployment.
      baseUrl: ctx.settings.baseUrl,
      timeoutMs: ctx.settings.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      token: session.accessToken,
      secrets: sessionSecrets(session),
    }),
  );
}

/** Authenticated SSE request; a 401 before the stream starts can be retried. */
export async function authorizedStream(ctx, options = {}, { requiredScope = null } = {}) {
  return withSessionRetry(ctx, requiredScope, (session) =>
    streamRequest({
      ...options,
      baseUrl: ctx.settings.baseUrl,
      timeoutMs: ctx.settings.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      token: session.accessToken,
      secrets: sessionSecrets(session),
    }),
  );
}

/**
 * Token for commands that work unauthenticated (health, OpenAPI discovery).
 * Authentication failures degrade to anonymous; other failures still surface.
 */
export async function optionalSession(ctx) {
  try {
    return await resolveSession(ctx);
  } catch (error) {
    if (error instanceof CoderaxError) return null;
    throw error;
  }
}

function identityFrom(body, claims) {
  const root = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
  const user = root.user !== null && typeof root.user === "object" && !Array.isArray(root.user) ? root.user : root;
  const account = [user.email, user.username, user.preferred_username, user.name]
    .find((value) => typeof value === "string" && value.trim() !== "");
  const subject = [user.sub, user.id, claims?.sub]
    .find((value) => typeof value === "string" && value.trim() !== "");
  return {
    account: account ? account.trim() : null,
    subject: subject ? subject.trim() : null,
  };
}

async function fetchUserinfo(ctx, { token, path, secrets }) {
  const endpoint = safeEndpointPath(path) ?? DEFAULT_AUTH_ENDPOINTS.userinfo;
  try {
    const response = await request({
      baseUrl: requireBaseUrl(ctx.settings),
      path: endpoint,
      timeoutMs: ctx.settings.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      token,
      secrets,
    });
    return { available: true, body: response.json };
  } catch (error) {
    if (error?.status === 404) return { available: false, body: null };
    throw toAuthError(error);
  }
}

function persistLogin(ctx, baseUrl, warnings) {
  return saveConfig({ baseUrl }, { filePath: ctx.settings.configPath }).catch((error) => {
    warnings.push(`could not persist the deployment URL: ${error.message}`);
  });
}

async function finishLogin(ctx, { baseUrl, token, endpoints, identity, warnings, now }) {
  const credential = buildCredential({
    baseUrl,
    token,
    endpoints,
    account: identity.account,
    now,
  });
  try {
    await persistLogin(ctx, baseUrl, warnings);
    await saveCredential(ctx, credential);
  } catch (error) {
    throw error;
  }
  try {
    await stripLegacyToken({ filePath: ctx.settings.configPath });
  } catch {
    warnings.push(`a legacy plaintext token may remain in ${ctx.settings.configPath}; delete the "token" field`);
  }
  return {
    credential,
    session: sessionFromCredential(credential),
    account: identity.account,
    subject: identity.subject ?? credential.subject,
    warnings,
  };
}

/**
 * RFC 8628 device authorization. The user approves in a browser on the verified
 * deployment origin; the CLI never asks for a provider key and never puts a
 * token in argv.
 */
export async function deviceLogin(ctx, deps = {}) {
  assertSecureTransport(ctx.env);
  const baseUrl = requireBaseUrl(ctx.settings);
  const envToken = envText(ctx.env?.CODERAX_TOKEN);
  if (envToken) await assertNoTokenOverride(ctx, baseUrl, envToken);
  assertCredentialStore(ctx);
  await assertNoOtherDeploymentCredential(ctx, baseUrl);
  const now = typeof deps.now === "function"
    ? deps.now
    : typeof ctx.authDeps?.now === "function"
      ? ctx.authDeps.now
      : () => Date.now();
  const sleep = typeof deps.sleep === "function"
    ? deps.sleep
    : typeof ctx.authDeps?.sleep === "function"
      ? ctx.authDeps.sleep
      : sleepWithSignal;
  const openBrowser = typeof deps.openBrowser === "function"
    ? deps.openBrowser
    : typeof ctx.authDeps?.openBrowser === "function"
      ? ctx.authDeps.openBrowser
      : openUrlInBrowser;
  const notify = typeof deps.notify === "function" ? deps.notify : () => {};
  const timeoutMs = ctx.settings.timeoutMs;
  const fetchImpl = ctx.fetchImpl;

  const identityCheck = await verifyEndpointIdentity({ baseUrl, timeoutMs, fetchImpl });
  if (!identityCheck.verified) {
    throw new CoderaxError(
      "ENDPOINT_UNVERIFIED",
      `the deployment at ${baseUrl} did not identify itself as Coderax; refusing to start sign-in (${identityCheck.evidence.join("; ")})`,
    );
  }

  const endpoints = await resolveAuthEndpoints({ baseUrl, timeoutMs, fetchImpl });
  let challenge;
  try {
    challenge = await request({
      baseUrl,
      path: endpoints.deviceCode,
      method: "POST",
      form: { client_id: CLIENT_ID, scope: REQUESTED_SCOPES.join(" ") },
      timeoutMs,
      fetchImpl,
    });
  } catch (error) {
    if (error?.status === 404 || error?.status === 405 || oauthErrorCode(error) === "unsupported_grant_type") {
      throw new CoderaxError(
        "DEVICE_AUTH_UNSUPPORTED",
        "this deployment does not advertise device authorization; use `coderax login --with-token` with a deployment-issued session token, or set CODERAX_TOKEN",
      );
    }
    throw toAuthError(error);
  }

  const body = challenge.json;
  const deviceCode = typeof body?.device_code === "string" ? body.device_code : "";
  const userCode = typeof body?.user_code === "string" ? body.user_code : "";
  const verificationUri = typeof body?.verification_uri === "string" ? body.verification_uri : "";
  if (deviceCode === "" || userCode === "" || verificationUri === "") {
    throw new CoderaxError("AUTH_PROTOCOL_ERROR", "the deployment returned an incomplete device authorization response");
  }
  if (/[\u0000-\u001f\u007f]/.test(userCode)) {
    throw new CoderaxError("AUTH_PROTOCOL_ERROR", "the deployment returned a user code with control characters");
  }
  const completeUri = typeof body?.verification_uri_complete === "string" && body.verification_uri_complete !== ""
    ? body.verification_uri_complete
    : null;
  assertVerificationUri(baseUrl, verificationUri);
  if (completeUri) assertVerificationUri(baseUrl, completeUri);

  const intervalSeconds = clampInteger(body?.interval, 5, 1, 60);
  const lifetimeSeconds = clampInteger(body?.expires_in, 600, 1, 3600);
  const deadline = now() + lifetimeSeconds * 1000;
  const browserUrl = completeUri ?? verificationUri;

  notify(`To sign in, open ${browserUrl}${completeUri ? "" : ` and enter code ${userCode}`}`);
  notify(`Waiting for approval (code expires in ${Math.max(1, Math.round(lifetimeSeconds / 60))} min)...`);

  if (!deps.noBrowser && ctx.stdinIsTTY !== false) {
    // Failure to launch a browser is not fatal: the URL is already printed.
    try {
      openBrowser(browserUrl);
    } catch {
      // Ignore; the user can open the printed URL.
    }
  }

  let waitMs = intervalSeconds * 1000;
  while (now() < deadline) {
    let result;
    try {
      result = await request({
        baseUrl,
        path: endpoints.deviceToken,
        method: "POST",
        form: {
          grant_type: DEVICE_GRANT_TYPE,
          device_code: deviceCode,
          client_id: CLIENT_ID,
        },
        timeoutMs,
        fetchImpl,
        secrets: [deviceCode],
        includeRaw: true,
      });
    } catch (error) {
      const code = oauthErrorCode(error);
      if (code === "authorization_pending") {
        await sleep(waitMs, ctx.signal);
        continue;
      }
      if (code === "slow_down" || error?.status === 429) {
        waitMs = Math.min(waitMs + 5000, 60000);
        await sleep(waitMs, ctx.signal);
        continue;
      }
      if (code === "access_denied") {
        throw new CoderaxError("DEVICE_ACCESS_DENIED", "sign-in was denied; no credentials were stored");
      }
      if (code === "expired_token" || code === "invalid_grant") {
        throw new CoderaxError("DEVICE_CODE_EXPIRED", "the device code expired; run `coderax login` again");
      }
      if (code === "unsupported_grant_type") {
        throw new CoderaxError(
          "DEVICE_AUTH_UNSUPPORTED",
          "this deployment does not support device authorization; use `coderax login --with-token`",
        );
      }
      throw toAuthError(error);
    }

    const issuedAt = now();
    const token = readTokenResponse(result.rawJson, { baseUrl, now: issuedAt });
    const userinfo = await fetchUserinfo(ctx, {
      token: token.accessToken,
      path: endpoints.userinfo,
      secrets: [token.accessToken],
    });
    const identity = identityFrom(userinfo.body, token.claims);
    return finishLogin(ctx, {
      baseUrl,
      token,
      endpoints,
      identity,
      warnings: ctx.settings.token
        ? ["CODERAX_TOKEN is still set; unset it after login to avoid two active copies"]
        : [],
      now: issuedAt,
    });
  }

  throw new CoderaxError("DEVICE_CODE_EXPIRED", "the device code expired before approval; run `coderax login` again");
}

/**
 * Headless login with a deployment-issued session token read from stdin. This
 * is for deployments without device authorization and for CI; provider API
 * keys are never accepted or stored by this CLI.
 */
export async function loginWithToken(ctx, rawToken, { source = "stdin" } = {}) {
  assertSecureTransport(ctx.env);
  const baseUrl = requireBaseUrl(ctx.settings);
  const envToken = envText(ctx.env?.CODERAX_TOKEN);
  if (envToken) await assertNoTokenOverride(ctx, baseUrl, envToken);
  assertCredentialStore(ctx);
  await assertNoOtherDeploymentCredential(ctx, baseUrl);
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (token === "") {
    throw new CoderaxError("USAGE", "no token provided on stdin; pipe a deployment-issued session token");
  }
  const timeoutMs = ctx.settings.timeoutMs;
  const fetchImpl = ctx.fetchImpl;
  const now = nowFrom(ctx);

  const identityCheck = await verifyEndpointIdentity({ baseUrl, timeoutMs, fetchImpl });
  if (!identityCheck.verified) {
    throw new CoderaxError(
      "ENDPOINT_UNVERIFIED",
      `the deployment at ${baseUrl} did not identify itself as Coderax; refusing to store a token (${identityCheck.evidence.join("; ")})`,
    );
  }

  const claims = parseJwtClaims(token);
  assertTokenClaims(claims, { baseUrl, now, label: "session token" });
  const endpoints = await resolveAuthEndpoints({ baseUrl, token, timeoutMs, fetchImpl });
  const userinfo = await fetchUserinfo(ctx, {
    token,
    path: endpoints.userinfo,
    secrets: [token],
  });
  const identity = identityFrom(userinfo.body, claims);
  const scopeInfo = scopeInfoFromClaims(claims);
  const { expiresAt, expirySource } = resolveExpiry({ claims, now });
  const issued = {
    accessToken: token,
    refreshToken: null,
    claims,
    scopeInfo,
    expiresAt,
    expirySource,
    subject: identity.subject ?? (typeof claims?.sub === "string" ? claims.sub : null),
  };
  return finishLogin(ctx, {
    baseUrl,
    token: issued,
    endpoints,
    identity,
    warnings: source === "environment" ? ["credentials copied from CODERAX_TOKEN; unset it after login to avoid two active copies"] : [],
    now,
  });
}

/** Remote identity check for `whoami`, with subject continuity verification. */
export async function whoamiIdentity(ctx) {
  const session = await resolveSession(ctx);
  const endpoint = session.credential?.endpoints?.userinfo ?? DEFAULT_AUTH_ENDPOINTS.userinfo;
  const userinfo = await fetchUserinfo(ctx, {
    token: session.accessToken,
    path: endpoint,
    secrets: sessionSecrets(session),
  });
  const identity = identityFrom(userinfo.body, parseJwtClaims(session.accessToken));
  if (session.subject && identity.subject && session.subject !== identity.subject) {
    throw new CoderaxError(
      "IDENTITY_MISMATCH",
      "the deployment reported a different account than the stored session; run `coderax login` again",
    );
  }
  return {
    session,
    account: identity.account ?? session.account ?? null,
    subject: identity.subject ?? session.subject ?? null,
    remote: { available: userinfo.available },
  };
}

/** Local, non-network auth report used by `auth status`, `status` and `doctor`. */
export async function localAuthStatus(ctx) {
  const baseUrl = ctx.settings.baseUrl ?? null;
  let store;
  try {
    store = await ctx.credentialStore.describe();
  } catch {
    store = { name: "unavailable", available: false, secure: false, detail: "credential store could not be described" };
  }

  const envToken = envText(ctx.env?.CODERAX_TOKEN);
  let legacy = null;
  try {
    legacy = await readLegacyToken({ filePath: ctx.settings.configPath });
  } catch {
    legacy = null;
  }

  let credential = null;
  let credentialError = null;
  if (baseUrl) {
    try {
      credential = await readStoredCredential(ctx, baseUrl);
    } catch (error) {
      credentialError = { code: error.code ?? "CREDENTIAL_READ_FAILED", message: error.message };
    }
  }

  const source = envToken
    ? "environment"
    : credential
      ? "credential-store"
      : legacy
        ? "legacy-plaintext"
        : "none";
  const token = envToken ?? credential?.accessToken ?? legacy ?? null;
  const claims = parseJwtClaims(token);
  const now = nowFrom(ctx);
  const expiresAt = envToken
    ? (Number.isFinite(Number(claims?.exp)) ? Number(claims.exp) * 1000 : null)
    : credential?.expiresAt
      ?? (Number.isFinite(Number(claims?.exp)) ? Number(claims.exp) * 1000 : null);
  const expired = expiresAt !== null && expiresAt <= now;
  const scopeInfo = credential
    ? { scopes: credential.scopes, scopesKnown: credential.scopesKnown }
    : scopeInfoFromClaims(claims);

  return {
    authenticated: Boolean(token) && !expired,
    session: !token ? "anonymous" : expired ? "expired" : "active",
    source,
    baseUrl,
    account: credential?.account ?? (typeof claims?.email === "string" ? claims.email : null),
    subject: credential?.subject ?? (typeof claims?.sub === "string" ? claims.sub : null),
    expiresAt,
    expiresInSeconds: expiresAt === null ? null : Math.max(0, Math.floor((expiresAt - now) / 1000)),
    expirySource: envToken
      ? (Number.isFinite(Number(claims?.exp)) ? "token" : "unknown")
      : credential?.expirySource ?? "unknown",
    refreshable: Boolean(credential?.refreshToken),
    scopes: scopeInfo.scopes,
    scopesKnown: scopeInfo.scopesKnown,
    tokenMask: token ? maskCredentialToken(token) : null,
    originBound: credential ? credential.baseUrl === baseUrl : null,
    credentialStore: store,
    legacyPlaintextToken: Boolean(legacy) || Boolean(ctx.settings.hasLegacyPlaintextToken),
    credentialError,
    configPath: ctx.settings.configPath,
  };
}

function maskCredentialToken(token) {
  if (typeof token !== "string" || token === "") return null;
  if (token.length <= 8) return "*".repeat(token.length);
  return `${token.slice(0, 4)}\u2026${token.slice(-4)}`;
}

/**
 * Revoke both token kinds when the deployment advertises revocation, then delete
 * the local credential. Revocation failures never keep a local copy.
 */
export async function logoutSession(ctx) {
  assertSecureTransport(ctx.env);
  const baseUrl = ctx.settings.baseUrl ?? null;
  const envToken = envText(ctx.env?.CODERAX_TOKEN);
  if (envToken) await assertNoTokenOverride(ctx, baseUrl, envToken);
  const warnings = [];
  let credential = null;
  let credentialRemovalFailed = false;

  if (baseUrl) {
    try {
      credential = await readStoredCredential(ctx, baseUrl);
    } catch (error) {
      warnings.push(error.message);
      // If the store is present but unreadable (locked or failed), the
      // credential may still exist. Logout must not report success.
      if (ctx.credentialStore?.available) credentialRemovalFailed = true;
    }
  }

  const revocation = { attempted: false, ok: false, results: [] };
  if (baseUrl) {
    const accessToken = credential?.accessToken ?? envToken ?? null;
    let endpoints = credential?.endpoints ?? null;
    if (!endpoints) {
      endpoints = await resolveAuthEndpoints({
        baseUrl,
        token: accessToken,
        timeoutMs: ctx.settings.timeoutMs,
        fetchImpl: ctx.fetchImpl,
      });
    }
    if (accessToken && endpoints.revoke) {
      revocation.attempted = true;
      for (const [value, hint] of [
        [credential?.refreshToken, "refresh_token"],
        [accessToken, "access_token"],
      ]) {
        if (!value) continue;
        try {
          await request({
            baseUrl,
            path: endpoints.revoke,
            method: "POST",
            form: { token: value, token_type_hint: hint, client_id: CLIENT_ID },
            token: accessToken,
            timeoutMs: ctx.settings.timeoutMs,
            fetchImpl: ctx.fetchImpl,
            secrets: [value, accessToken],
          });
          revocation.results.push({ tokenType: hint, ok: true });
        } catch (error) {
          revocation.results.push({
            tokenType: hint,
            ok: false,
            code: error?.status === 404 || error?.status === 405 ? "UNSUPPORTED" : error.code ?? "ERROR",
          });
        }
      }
      revocation.ok = revocation.results.length > 0 && revocation.results.every((entry) => entry.ok);
      if (!revocation.ok) {
        warnings.push(
          "the deployment did not confirm token revocation; the token may stay valid until it expires. Revoke it from your Coderax account if needed.",
        );
      }
    }
  }

  let removed = false;
  if (baseUrl && ctx.credentialStore?.available) {
    try {
      removed = await ctx.credentialStore.delete(credentialAccount(baseUrl));
    } catch (error) {
      credentialRemovalFailed = true;
      warnings.push(`could not remove the stored credential: ${error.message}`);
    }
  }

  let legacyRemoved = false;
  try {
    legacyRemoved = await stripLegacyToken({ filePath: ctx.settings.configPath });
  } catch (error) {
    warnings.push(`could not remove a legacy plaintext token: ${error.message}`);
  }

  return {
    removed,
    legacyRemoved,
    credentialRemovalFailed,
    environmentTokenActive: Boolean(envToken),
    revocation,
    warnings,
    baseUrl,
  };
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CoderaxError("CANCELLED", "cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CoderaxError("CANCELLED", "cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function openUrlInBrowser(url) {
  const candidates = process.platform === "darwin"
    ? [["open", [url]]]
    : process.platform === "win32"
      // Avoid `cmd /c start`: cmd parses metacharacters that can appear in a
      // server-provided URL. rundll32 receives the URL as a plain argument.
      ? [["rundll32", ["url.dll,FileProtocolHandler", url]]]
      : [["xdg-open", [url]], ["gio", ["open", url]]];
  for (const [command, args] of candidates) {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: childEnvironment(),
      });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      // Try the next opener.
    }
  }
  return false;
}
