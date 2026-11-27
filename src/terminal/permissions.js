/**
 * Permission approval security.
 *
 * A model-generated "please allow this" message is not authorisation. An
 * approval is only offered for a request that arrives on the authenticated,
 * server-verified approval channel, carries a server-issued request id, an
 * execution identity, an allowed action and a concrete resource. The approval
 * response echoes those exact bindings so the server can match it; a grant for
 * "the session" is scoped to that exact action, resource and execution and is
 * never a blanket allow.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { sanitizeOneLine } from "./sanitize.js";

export const PERMISSION_ACTIONS = Object.freeze([
  "read_file",
  "write_file",
  "delete_file",
  "list_directory",
  "run_command",
  "network",
  "send_files",
  "use_tool",
]);

const ALLOWED_ACTIONS = new Set(PERMISSION_ACTIONS);
const FILE_ACTIONS = new Set(["read_file", "write_file", "delete_file", "list_directory"]);
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export class PermissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PermissionError";
    this.code = code;
  }
}

/** Canonical binding value for an action/resource pair. */
export function canonicalResource(action, resource, { platform = process.platform } = {}) {
  if (typeof resource !== "string") return { ok: false, reason: "RESOURCE_INVALID" };
  const raw = resource.trim();
  if (raw === "" || raw.length > 4096) return { ok: false, reason: "RESOURCE_INVALID" };
  if (CONTROL_CHARACTERS.test(raw)) return { ok: false, reason: "RESOURCE_CONTROL_CHARACTERS" };

  if (FILE_ACTIONS.has(action)) {
    const impl = platform === "win32" ? path.win32 : path.posix;
    if (!impl.isAbsolute(raw)) return { ok: false, reason: "RESOURCE_NOT_ABSOLUTE" };
    const resolved = impl.resolve(raw);
    if (resolved.includes("\u0000")) return { ok: false, reason: "RESOURCE_INVALID" };
    return {
      ok: true,
      value: platform === "win32" ? resolved.toLowerCase() : resolved,
      display: resolved,
    };
  }

  if (action === "network") {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: "RESOURCE_INVALID_URL" };
    }
    if (!["https:", "http:"].includes(url.protocol)) return { ok: false, reason: "RESOURCE_UNSAFE_URL" };
    if (url.username || url.password) return { ok: false, reason: "RESOURCE_EMBEDDED_CREDENTIALS" };
    return { ok: true, value: `${url.protocol}//${url.host}${url.pathname}${url.search}`, display: raw };
  }

  if (action === "send_files") {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "RESOURCE_INVALID" };
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) {
      return { ok: false, reason: "RESOURCE_INVALID" };
    }
    const values = [];
    for (const item of parsed) {
      const result = canonicalResource("read_file", item, { platform });
      if (!result.ok) return result;
      values.push(result.value);
    }
    values.sort();
    return { ok: true, value: JSON.stringify(values), display: `${values.length} file(s)` };
  }

  // Commands and tool names bind to their exact text: normalising whitespace
  // could make two different commands compare equal.
  return { ok: true, value: raw, display: raw };
}

export function permissionFingerprint(executionId, action, resourceHash) {
  return createHash("sha256").update(`${executionId}\u0000${action}\u0000${resourceHash}`).digest("hex").slice(0, 40);
}

function supportedActionSet(capabilities) {
  const permissions = capabilities?.permissions;
  if (permissions === true) return ALLOWED_ACTIONS;
  if (Array.isArray(permissions)) {
    return new Set(permissions.filter((action) => ALLOWED_ACTIONS.has(action)));
  }
  return new Set();
}

/**
 * Validate an incoming permission request. Every failure is a denial with a
 * machine-readable reason; nothing is ever prompted for on an unverified path.
 */
export function verifyPermissionRequest(request, {
  channelVerified = false,
  capabilities = {},
  now = Date.now(),
  platform = process.platform,
} = {}) {
  const supported = supportedActionSet(capabilities);
  if (!channelVerified || supported.size === 0) {
    return { ok: false, reason: "CHANNEL_UNAVAILABLE", detail: "no verified permission approval channel" };
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return { ok: false, reason: "REQUEST_INVALID", detail: "permission request is not an object" };
  }
  if (request.serverIssued !== true) {
    return { ok: false, reason: "NOT_SERVER_ISSUED", detail: "permission request was not issued by the server" };
  }
  if (typeof request.requestId !== "string" || !REQUEST_ID.test(request.requestId)) {
    return { ok: false, reason: "REQUEST_ID_INVALID", detail: "permission request has no authoritative request id" };
  }
  if (typeof request.executionId !== "string" || !EXECUTION_ID.test(request.executionId)) {
    return { ok: false, reason: "EXECUTION_ID_INVALID", detail: "permission request has no execution identity" };
  }
  const action = typeof request.action === "string" ? request.action.trim().toLowerCase() : "";
  if (!ALLOWED_ACTIONS.has(action)) {
    return { ok: false, reason: "ACTION_INVALID", detail: `unsupported permission action: ${sanitizeOneLine(request.action, 40)}` };
  }
  if (!supported.has(action)) {
    return { ok: false, reason: "ACTION_UNSUPPORTED", detail: `the transport cannot approve ${action}` };
  }
  const scope = request.scope === undefined ? "once" : request.scope;
  if (scope !== "once" && scope !== "session") {
    return { ok: false, reason: "SCOPE_INVALID", detail: "permission scope must be once or session" };
  }

  const canonical = canonicalResource(action, request.resource, { platform });
  if (!canonical.ok) {
    return { ok: false, reason: canonical.reason, detail: "permission resource is not a valid binding" };
  }
  const resourceHash = createHash("sha256").update(canonical.value).digest("hex").slice(0, 32);
  if (request.resourceHash !== undefined && request.resourceHash !== resourceHash) {
    return { ok: false, reason: "RESOURCE_HASH_MISMATCH", detail: "request resource does not match its server hash" };
  }

  if (request.expiresAt !== undefined) {
    const expiresAt = Date.parse(request.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return { ok: false, reason: "EXPIRY_INVALID", detail: "permission expiry is not a timestamp" };
    }
    if (expiresAt <= now) {
      return { ok: false, reason: "EXPIRED", detail: "permission request has expired" };
    }
  }

  return {
    ok: true,
    request: {
      requestId: request.requestId,
      executionId: request.executionId,
      action,
      resource: canonical.value,
      resourceHash,
      scope,
      displayResource: sanitizeOneLine(canonical.display, 200),
      expiresAt: request.expiresAt ?? null,
      serverIssued: true,
      reason: typeof request.reason === "string" ? sanitizeOneLine(request.reason, 300) : "",
    },
  };
}

/** Human-readable options; session coordinates are never offered. */
export function permissionOptions(entry) {
  const options = [{ decision: "once", label: "Allow once", key: "1" }];
  if (entry?.request.scope === "session") {
    options.push({
      decision: "session",
      label: "Allow this exact action and resource for this session",
      key: "2",
    });
    options.push({ decision: "deny", label: "Deny", key: "3" });
  } else {
    options.push({ decision: "deny", label: "Deny", key: "2" });
  }
  return options;
}

export class PermissionBroker {
  constructor({
    capabilities = {},
    respond = null,
    now = () => Date.now(),
    maxPending = 8,
    platform = process.platform,
    channelVerified = false,
  } = {}) {
    this.capabilities = capabilities;
    this.respondImpl = respond;
    this.now = now;
    this.maxPending = maxPending;
    this.platform = platform;
    this.channelVerified = Boolean(channelVerified) && supportedActionSet(capabilities).size > 0;
    this.pending = new Map();
    this.sessionGrants = new Map();
    this.denials = [];
    this.responded = 0;
  }

  get channelAvailable() {
    return this.channelVerified;
  }

  _grantKey(entry) {
    return permissionFingerprint(entry.request.executionId, entry.request.action, entry.request.resourceHash);
  }

  _deny(reason, detail = "", request = null) {
    const denial = {
      status: "denied",
      reason,
      detail,
      requestId: request && typeof request.requestId === "string" ? sanitizeOneLine(request.requestId, 128) : null,
    };
    this.denials.push({ ...denial, at: this.now() });
    if (this.denials.length > 100) this.denials.shift();
    return denial;
  }

  /**
   * Decide whether a request may be shown to the operator.
   */
  consider(request) {
    const verdict = verifyPermissionRequest(request, {
      channelVerified: this.channelVerified,
      capabilities: this.capabilities,
      now: this.now(),
      platform: this.platform,
    });
    if (!verdict.ok) return this._deny(verdict.reason, verdict.detail, request);

    // Expire stale pending requests before applying backpressure.
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt !== null && entry.expiresAt <= this.now()) this.pending.delete(id);
    }
    if (this.pending.has(verdict.request.requestId)) {
      return this._deny("DUPLICATE_REQUEST", "the same request id is already pending", request);
    }
    if (this.pending.size >= this.maxPending) {
      return this._deny("TOO_MANY_PENDING", "too many pending permission requests", request);
    }

    const entry = {
      request: verdict.request,
      expiresAt: verdict.request.expiresAt ? Date.parse(verdict.request.expiresAt) : null,
      receivedAt: this.now(),
    };

    if (this.sessionGrants.has(this._grantKey(entry))) {
      // The server issued a fresh request id; hold it so the exact approval can
      // be echoed back for this request without prompting again.
      this.pending.set(verdict.request.requestId, entry);
      return { status: "session-granted", entry, options: permissionOptions(entry) };
    }

    this.pending.set(verdict.request.requestId, entry);
    return { status: "pending", entry, options: permissionOptions(entry) };
  }

  /**
   * Answer a held request. The response is proof of what the operator saw: the
   * exact request id, execution, action resource hash and decision.
   */
  async respond(requestId, decision) {
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, reason: "UNKNOWN_REQUEST" };
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.pending.delete(requestId);
      return { ok: false, reason: "EXPIRED" };
    }
    if (decision !== "once" && decision !== "session" && decision !== "deny") {
      return { ok: false, reason: "DECISION_INVALID" };
    }
    if (decision === "session" && entry.request.scope !== "session") {
      return { ok: false, reason: "SESSION_SCOPE_NOT_OFFERED" };
    }
    if (typeof this.respondImpl !== "function") {
      return { ok: false, reason: "CHANNEL_UNAVAILABLE" };
    }

    const payload = {
      requestId: entry.request.requestId,
      executionId: entry.request.executionId,
      action: entry.request.action,
      resourceHash: entry.request.resourceHash,
      decision,
      decidedAt: new Date(this.now()).toISOString(),
    };

    this.pending.delete(requestId);
    try {
      await this.respondImpl(payload);
    } catch (error) {
      return { ok: false, reason: "CHANNEL_FAILED", detail: error?.code ?? error?.message ?? "approval delivery failed" };
    }
    this.responded += 1;
    if (decision === "session") {
      this.sessionGrants.set(this._grantKey(entry), {
        executionId: entry.request.executionId,
        action: entry.request.action,
        resourceHash: entry.request.resourceHash,
        resource: entry.request.displayResource,
        at: this.now(),
      });
    }
    return { ok: true, payload };
  }

  /** Drop every grant for a finished execution. */
  endExecution(executionId) {
    for (const [key, grant] of this.sessionGrants) {
      if (grant.executionId === executionId) this.sessionGrants.delete(key);
    }
    for (const [id, entry] of this.pending) {
      if (entry.request.executionId === executionId) this.pending.delete(id);
    }
  }

  /** Pending requests are denied when a stream ends or is cancelled. */
  denyAllPending() {
    const ids = [...this.pending.keys()];
    this.pending.clear();
    return ids;
  }

  grants() {
    return [...this.sessionGrants.values()].map((grant) => ({
      executionId: grant.executionId,
      action: grant.action,
      resource: grant.resource,
      at: grant.at,
    }));
  }

  get pendingCount() {
    return this.pending.size;
  }
}
