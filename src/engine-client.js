import { CoderaxError, redact } from "./client.js";
import { SseDecoder } from "./engine-sse.js";
import {
  CONTRACT_FINGERPRINT,
  CONTRACT_MAJOR,
  CONTRACT_VERSION,
  CHAT_STREAM_VERSION,
  EVENT_SCHEMA_VERSION,
  ROUTES,
  SUPPORTED_CONTRACT_VERSIONS,
  TASK_STATES,
  artifactPath,
  conversationPath,
  routeFor,
  schedulePath,
  taskPath,
} from "./engine-contract.js";

/**
 * Dependency-free client for the authoritative WorkflowEngine 1.2.0 HTTP
 * surface.
 *
 * `@coderax/sdk` 1.2.0 is the canonical client. It is a `private: true`
 * TypeScript workspace package with a zod runtime; the CLI ships as a
 * dependency-free standalone archive, so it consumes the same pinned contract
 * (route table, fingerprint and byte-identical OpenAPI) with this module, and
 * `scripts/verify-engine-contract.mjs` checks the pin against a real engine
 * checkout. The legacy `/api/*` client in `packages/workflow-sdk` remains only
 * as the explicitly marked compatibility adapter for deployments that have not
 * migrated.
 *
 * This client sends one request per call, follows no redirect, keeps no cookie
 * jar, performs no automatic retry and never places the token in a URL or an
 * error message.
 */

const SDK_METHOD_COVERAGE = Object.freeze({
  getHealth: "health",
  getReadiness: "readiness",
  getHandshake: "handshake",
  listAgents: "agents",
  listModels: "models",
  submitChat: "chat",
  submitWork: "submitWork",
  listTasks: "tasks",
  listWork: "listWork",
  getTask: "task",
  cancelTask: "cancel",
  resumeTask: "resume",
  retryTask: "retry",
  streamTaskEvents: "events",
  listArtifacts: "listArtifacts",
  uploadArtifact: "uploadArtifact",
  pruneArtifacts: "pruneArtifacts",
  getArtifact: "getArtifact",
  uploadArtifactVersion: "uploadArtifactVersion",
  listArtifactVersions: "listArtifactVersions",
  downloadArtifact: "downloadArtifact",
  exportArtifact: "exportArtifact",
  deleteArtifact: "deleteArtifact",
  listTaskArtifacts: "taskArtifacts",
  createTaskArtifact: "createTaskArtifact",
  getTaskArtifact: "taskArtifact",
  listConversations: "conversations",
  getConversation: "conversation",
  listMemory: "memory",
  writeMemory: "writeMemory",
  deleteMemory: "deleteMemory",
  searchMemory: "searchMemory",
  listPermissions: "permissions",
  decidePermission: "decidePermission",
  listNotifications: "notifications",
  markNotificationRead: "markNotificationRead",
  listSchedules: "schedules",
  createSchedule: "createSchedule",
  controlSchedule: "controlSchedule",
  deleteSchedule: "deleteSchedule",
});

export { SDK_METHOD_COVERAGE };

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function joinUrl(baseUrl, path, query) {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const target = new URL(`${base}${suffix}`);
  if (target.origin !== new URL(base).origin) {
    throw new CoderaxError("BASE_URL_INVALID", `route ${path} resolves outside the configured origin`);
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  return target;
}

function truncated(value, limit = 300) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function detailText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (typeof value.detail === "string") return value.detail;
    if (typeof value.title === "string") return value.title;
    if (typeof value.message === "string") return value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

function problemError(problem, status, operationId, token) {
  const code = typeof problem?.code === "string" ? problem.code : `HTTP_${status}`;
  const detail = detailText(problem?.detail ?? problem?.title ?? problem);
  const error = new CoderaxError(
    code,
    `HTTP ${status} from ${operationId}${detail ? `: ${truncated(redact(detail, token))}` : ""}`,
    {
      status,
      details: isRecord(problem) ? { requestId: problem.requestId ?? null } : null,
      retryable: problem?.retryable === true,
    },
  );
  error.operationId = operationId;
  error.body = problem;
  return error;
}

function contractError(operationId, detail) {
  return new CoderaxError(
    "CONTRACT_VIOLATION",
    `the response for ${operationId} did not match the workflow-engine ${CONTRACT_VERSION} contract: ${detail}`,
  );
}

function requireString(value, key, operationId) {
  if (typeof value?.[key] !== "string" || value[key] === "") {
    throw contractError(operationId, `missing string "${key}"`);
  }
}

function requireInteger(value, key, operationId) {
  if (!Number.isInteger(value?.[key]) || value[key] < 0) {
    throw contractError(operationId, `missing non-negative integer "${key}"`);
  }
}

function requireArray(value, key, operationId) {
  if (!Array.isArray(value?.[key])) throw contractError(operationId, `missing array "${key}"`);
}

function requireTask(value, operationId) {
  requireString(value, "taskId", operationId);
  requireString(value, "state", operationId);
  if (!TASK_STATES.includes(value.state)) {
    throw contractError(operationId, `unknown task state ${JSON.stringify(value.state)}`);
  }
  requireInteger(value, "generation", operationId);
}

function validateResponse(operationId, body) {
  if (!isRecord(body)) throw contractError(operationId, "the response was not a JSON object");
  switch (operationId) {
    case "getHealth":
      requireString(body, "status", operationId);
      requireString(body, "contractVersion", operationId);
      requireArray(body, "checks", operationId);
      return body;
    case "getReadiness":
      if (typeof body.ready !== "boolean") throw contractError(operationId, 'missing boolean "ready"');
      requireArray(body, "missing", operationId);
      return body;
    case "getHandshake":
      requireString(body, "contractVersion", operationId);
      if (!Number.isInteger(body.contractMajor)) throw contractError(operationId, 'missing integer "contractMajor"');
      if (!Number.isInteger(body.eventSchemaVersion)) throw contractError(operationId, 'missing integer "eventSchemaVersion"');
      if (!Number.isInteger(body.chatStreamVersion)) throw contractError(operationId, 'missing integer "chatStreamVersion"');
      requireString(body, "contractFingerprint", operationId);
      requireString(body, "negotiatedContractVersion", operationId);
      requireString(body, "negotiation", operationId);
      if (typeof body.compatible !== "boolean") throw contractError(operationId, 'missing boolean "compatible"');
      requireArray(body, "supportedContractVersions", operationId);
      requireArray(body, "operations", operationId);
      if (!isRecord(body.capabilities)) throw contractError(operationId, 'missing object "capabilities"');
      if (!isRecord(body.limits)) throw contractError(operationId, 'missing object "limits"');
      return body;
    case "listAgents":
      requireArray(body, "agents", operationId);
      return body;
    case "listModels":
      requireArray(body, "models", operationId);
      if (body.allowPaid !== false) throw contractError(operationId, 'the engine must report "allowPaid": false');
      return body;
    case "submitChat":
      requireString(body, "conversationId", operationId);
      requireString(body, "messageId", operationId);
      if (typeof body.text !== "string") throw contractError(operationId, 'missing string "text"');
      return body;
    case "submitWork":
      requireTask(body, operationId);
      requireString(body, "conversationId", operationId);
      requireString(body, "eventsPath", operationId);
      return body;
    case "listTasks":
    case "listWork":
      requireArray(body, "tasks", operationId);
      for (const task of body.tasks) requireTask(task, operationId);
      return body;
    case "getTask":
      requireTask(body, operationId);
      requireArray(body, "steps", operationId);
      if (typeof body.cancelRequested !== "boolean") {
        throw contractError(operationId, 'missing boolean "cancelRequested"');
      }
      return body;
    case "cancelTask":
    case "resumeTask":
    case "retryTask":
      requireTask(body, operationId);
      requireString(body, "outcome", operationId);
      return body;
    case "listPermissions":
    case "decidePermission":
      requireArray(body, "requests", operationId);
      return body;
    case "listNotifications":
    case "markNotificationRead":
      requireArray(body, "notifications", operationId);
      if (!Number.isInteger(body.unread) || body.unread < 0) {
        throw contractError(operationId, 'missing non-negative integer "unread"');
      }
      return body;
    case "listConversations":
      requireArray(body, "conversations", operationId);
      return body;
    case "getConversation":
      requireString(body, "conversationId", operationId);
      requireArray(body, "messages", operationId);
      return body;
    case "listMemory":
      requireArray(body, "entries", operationId);
      return body;
    case "listSchedules":
      requireArray(body, "schedules", operationId);
      return body;
    default:
      return body;
  }
}

function networkError(pathname, error, token, timedOut, externalSignal) {
  if (externalSignal?.aborted) return new CoderaxError("CANCELLED", "request cancelled");
  const name = error?.name ?? "";
  if (timedOut || name === "TimeoutError" || name === "AbortError") {
    return new CoderaxError("REQUEST_TIMEOUT", `request to ${pathname} timed out`, {
      retryable: true,
    });
  }
  return new CoderaxError(
    "REQUEST_FAILED",
    `request to ${pathname} failed: ${truncated(redact(String(error?.message ?? "network error"), token))}`,
    { retryable: true },
  );
}

export class EngineClient {
  constructor({
    baseUrl,
    token = null,
    timeoutMs = 15000,
    eventTimeoutMs = null,
    maxBodyBytes = 10 * 1024 * 1024,
    fetchImpl = fetch,
    clientVersion = "0.3.0",
  } = {}) {
    if (!baseUrl) throw new CoderaxError("BASE_URL_REQUIRED", "no engine deployment URL configured");
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.eventTimeoutMs = Math.max(Number(eventTimeoutMs ?? timeoutMs), 1000);
    this.maxBodyBytes = maxBodyBytes;
    this.fetchImpl = fetchImpl;
    this.clientVersion = clientVersion;
  }

  headers(accept = "application/json") {
    const headers = { accept };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  #requireOwner(operationId) {
    const route = routeFor(operationId);
    if (route.auth === "owner" && !this.token) {
      throw new CoderaxError("UNAUTHENTICATED", `no owner token is configured for ${operationId}`);
    }
  }

  async #send(operationId, { path, query, body, accept = "application/json", signal, timeoutMs } = {}) {
    const route = routeFor(operationId);
    this.#requireOwner(operationId);
    const target = joinUrl(this.baseUrl, path ?? route.path, query);
    const headers = this.headers(accept);
    let payload;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
      if (Buffer.byteLength(payload) > this.maxBodyBytes) {
        throw new CoderaxError("PAYLOAD_TOO_LARGE", `the request for ${operationId} exceeds ${this.maxBodyBytes} bytes`);
      }
    }
    const timeout = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.fetchImpl(target, {
        method: route.method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        redirect: "error",
        signal: combined,
      });
    } catch (error) {
      throw networkError(target.pathname, error, this.token, false, signal);
    }
  }

  async #readText(response, operationId) {
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new CoderaxError("REQUEST_TIMEOUT", `the response for ${operationId} could not be read before the timeout`);
      }
      throw new CoderaxError("RESPONSE_UNREADABLE", `the response for ${operationId} could not be read`);
    }
    if (Buffer.byteLength(text) > this.maxBodyBytes) {
      throw new CoderaxError("RESPONSE_TOO_LARGE", `the response for ${operationId} exceeds ${this.maxBodyBytes} bytes`);
    }
    return text;
  }

  async #json(operationId, input = {}) {
    const response = await this.#send(operationId, input);
    const text = await this.#readText(response, operationId);
    let body = null;
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!response.ok) throw problemError(body, response.status, operationId, this.token);
    return validateResponse(operationId, body);
  }

  health() {
    return this.#json("getHealth");
  }

  readiness() {
    return this.#json("getReadiness");
  }

  /**
   * Contract negotiation. Sending this build's version and fingerprint lets a
   * same-number/different-wire deployment be refused during the handshake
   * instead of one 404 at a time.
   */
  handshake({ contract = CONTRACT_VERSION, fingerprint = CONTRACT_FINGERPRINT } = {}) {
    const query = {};
    if (contract !== undefined) query.contract = contract;
    if (fingerprint !== undefined) query.fingerprint = fingerprint;
    return this.#json("getHandshake", { query });
  }

  async compatibility({ requiredOperations = ROUTES.map((route) => route.operationId) } = {}) {
    const handshake = await this.handshake();
    const problems = [];
    if (!handshake.compatible) problems.push(`the server rejected negotiation: ${handshake.negotiation}`);
    if (handshake.contractMajor !== CONTRACT_MAJOR) {
      problems.push(`the server speaks contract major ${handshake.contractMajor}; this client speaks ${CONTRACT_MAJOR}`);
    }
    if (!handshake.supportedContractVersions.includes(CONTRACT_VERSION)) {
      problems.push(`the server does not list ${CONTRACT_VERSION} among its supported contract versions`);
    }
    if (handshake.eventSchemaVersion !== EVENT_SCHEMA_VERSION) {
      problems.push(`the server emits execution events v${handshake.eventSchemaVersion}; this client parses v${EVENT_SCHEMA_VERSION}`);
    }
    if (handshake.chatStreamVersion !== CHAT_STREAM_VERSION) {
      problems.push(`the server emits chat frames v${handshake.chatStreamVersion}; this client parses v${CHAT_STREAM_VERSION}`);
    }
    if (
      handshake.contractVersion === CONTRACT_VERSION &&
      handshake.contractFingerprint !== CONTRACT_FINGERPRINT
    ) {
      problems.push("the server catalogue fingerprint differs from this client's pinned contract");
    }
    const published = new Set(handshake.operations.map((operation) => operation.operationId));
    const missingOperations = requiredOperations.filter((operationId) => !published.has(operationId));
    if (missingOperations.length > 0) {
      problems.push(`the server does not implement: ${missingOperations.join(", ")}`);
    }
    return {
      compatible: problems.length === 0,
      problems,
      server: handshake.server ?? null,
      contractVersion: handshake.contractVersion,
      negotiatedContractVersion: handshake.negotiatedContractVersion,
      eventSchemaVersion: handshake.eventSchemaVersion,
      chatStreamVersion: handshake.chatStreamVersion,
      caps: handshake.capabilities,
      limits: handshake.limits,
      missingOperations,
    };
  }

  agents() {
    return this.#json("listAgents");
  }

  models() {
    return this.#json("listModels");
  }

  chat(request) {
    return this.#json("submitChat", { body: request });
  }

  /**
   * Chat frames are versioned separately from execution events. The stream ends
   * at `chat.completed` or `chat.failed`; a dropped connection does not cancel a
   * turn the server already started.
   */
  async *chatStream(request, { signal } = {}) {
    yield* this.#sse("submitChat", {
      path: "/v1/chat",
      method: "POST",
      body: request,
      signal,
      accept: "text/event-stream, text/event-stream;truncation=signal",
    });
  }

  submitWork(request) {
    return this.#json("submitWork", { body: request });
  }

  tasks(query = {}) {
    return this.#json("listTasks", { query });
  }

  listWork(query = {}) {
    return this.#json("listWork", { query });
  }

  task(taskId) {
    return this.#json("getTask", { path: taskPath(taskId) });
  }

  cancel(taskId, reason) {
    return this.#json("cancelTask", {
      path: taskPath(taskId, "/cancel"),
      body: reason ? { reason } : {},
    });
  }

  resume(taskId, generation) {
    return this.#json("resumeTask", {
      path: taskPath(taskId, "/resume"),
      body: { generation },
    });
  }

  retry(taskId, generation, model) {
    return this.#json("retryTask", {
      path: taskPath(taskId, "/retry"),
      body: model ? { generation, model } : { generation },
    });
  }

  /**
   * Replay and tail execution events from a `seq` cursor. `after` is the last
   * sequence the caller applied; the engine returns events strictly after it.
   * Frames that are not JSON objects are a protocol failure, never silently
   * rendered.
   */
  async *events(taskId, { after, signal } = {}) {
    yield* this.#sse("streamTaskEvents", {
      path: taskPath(taskId, "/events"),
      method: "GET",
      query: after === undefined ? undefined : { after },
      signal,
      accept: "text/event-stream, text/event-stream;truncation=signal",
    });
  }

  async *#sse(operationId, { path, method, query, body, signal, accept }) {
    this.#requireOwner(operationId);
    const target = joinUrl(this.baseUrl, path, query);
    const headers = this.headers(accept);
    let payload;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.eventTimeoutMs);
    };
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    arm();

    let reader = null;
    try {
      let response;
      try {
        response = await this.fetchImpl(target, {
          method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        throw networkError(target.pathname, error, this.token, timedOut, signal);
      }

      if (!response.ok) {
        const text = await this.#readText(response, operationId);
        let problem = null;
        try {
          problem = JSON.parse(text);
        } catch {
          problem = null;
        }
        throw problemError(problem, response.status, operationId, this.token);
      }
      if (!response.body) {
        throw new CoderaxError("RESPONSE_UNREADABLE", `the stream for ${operationId} has no body`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("text/event-stream")) {
        throw new CoderaxError(
          "CONTRACT_VIOLATION",
          `${operationId} answered with ${contentType || "no content type"}; the contract requires text/event-stream`,
        );
      }

      reader = response.body.getReader();
      const textDecoder = new TextDecoder();
      const frames = new SseDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        arm();
        for (const frame of frames.push(textDecoder.decode(value, { stream: true }))) {
          let parsed;
          try {
            parsed = JSON.parse(frame.data);
          } catch {
            throw new CoderaxError("STREAM_PROTOCOL", `a frame from ${operationId} was not valid JSON`);
          }
          if (!isRecord(parsed)) {
            throw new CoderaxError("STREAM_PROTOCOL", `a frame from ${operationId} was not a JSON object`);
          }
          yield parsed;
        }
      }
    } catch (error) {
      if (error instanceof CoderaxError) throw error;
      if (signal?.aborted) throw new CoderaxError("CANCELLED", "stream detached");
      if (timedOut || error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new CoderaxError(
          "REQUEST_TIMEOUT",
          `the stream for ${operationId} was idle for ${this.eventTimeoutMs}ms`,
          { retryable: true },
        );
      }
      throw new CoderaxError(
        "REQUEST_FAILED",
        `the stream for ${operationId} failed: ${truncated(redact(String(error?.message ?? "network error"), this.token))}`,
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // The peer may already be gone.
        }
      }
    }
  }

  listArtifacts(query = {}) {
    return this.#json("listArtifacts", { query });
  }

  uploadArtifact(request) {
    return this.#json("uploadArtifact", { body: request });
  }

  pruneArtifacts(request = {}) {
    return this.#json("pruneArtifacts", { body: request });
  }

  getArtifact(artifactId, query = {}) {
    return this.#json("getArtifact", { path: artifactPath(artifactId), query });
  }

  uploadArtifactVersion(artifactId, request) {
    return this.#json("uploadArtifactVersion", {
      path: artifactPath(artifactId, "/versions"),
      body: request,
    });
  }

  listArtifactVersions(artifactId, query = {}) {
    return this.#json("listArtifactVersions", {
      path: artifactPath(artifactId, "/versions"),
      query,
    });
  }

  downloadArtifact(artifactId, query = {}) {
    return this.#json("downloadArtifact", { path: artifactPath(artifactId, "/content"), query });
  }

  exportArtifact(artifactId, query = {}) {
    return this.#json("exportArtifact", { path: artifactPath(artifactId, "/export"), query });
  }

  deleteArtifact(artifactId, request = {}) {
    return this.#json("deleteArtifact", { path: artifactPath(artifactId, "/delete"), body: request });
  }

  taskArtifacts(taskId) {
    return this.#json("listTaskArtifacts", { path: taskPath(taskId, "/artifacts") });
  }

  createTaskArtifact(taskId, request) {
    return this.#json("createTaskArtifact", { path: taskPath(taskId, "/artifacts"), body: request });
  }

  taskArtifact(taskId, artifactId) {
    return this.#json("getTaskArtifact", {
      path: taskPath(taskId, `/artifacts/${encodeURIComponent(artifactId)}`),
    });
  }

  conversations() {
    return this.#json("listConversations");
  }

  conversation(conversationId) {
    return this.#json("getConversation", { path: conversationPath(conversationId) });
  }

  memory(mode = "private") {
    return this.#json("listMemory", { query: { mode } });
  }

  writeMemory(request) {
    return this.#json("writeMemory", { body: request });
  }

  deleteMemory(request) {
    return this.#json("deleteMemory", { body: request });
  }

  searchMemory(query) {
    return this.#json("searchMemory", { query });
  }

  permissions(taskId) {
    return this.#json("listPermissions", { path: taskPath(taskId, "/permissions") });
  }

  decidePermission(taskId, request) {
    return this.#json("decidePermission", {
      path: taskPath(taskId, "/permissions"),
      body: request,
    });
  }

  notifications() {
    return this.#json("listNotifications");
  }

  markNotificationRead(taskId) {
    return this.#json("markNotificationRead", { path: `/v1/notifications/${encodeURIComponent(taskId)}` });
  }

  schedules() {
    return this.#json("listSchedules");
  }

  createSchedule(request) {
    return this.#json("createSchedule", { body: request });
  }

  controlSchedule(scheduleId, request) {
    return this.#json("controlSchedule", { path: schedulePath(scheduleId), body: request });
  }

  deleteSchedule(scheduleId) {
    return this.#json("deleteSchedule", { path: schedulePath(scheduleId) });
  }
}

export { CONTRACT_VERSION, CONTRACT_FINGERPRINT, SUPPORTED_CONTRACT_VERSIONS };
