/**
 * Owner client for the WorkflowEngine `/v1` contract.
 *
 * Every request goes through the shared SDK's single HTTP layer
 * (`../http.js`), so this module adds no second transport, retry policy or
 * redaction rule. Every response and every execution event is validated against
 * the mirrored contract before it reaches the terminal.
 *
 * Two behaviours are deliberate:
 *
 * 1. Negotiation is explicit. `negotiate()` reads `/v1/health` and refuses a
 *    different contract major. A newer `1.x` minor is recorded as a diagnostic,
 *    not treated as a failure, so a compatible engine patch does not require a
 *    CLI release.
 * 2. An ambiguous submission is never retried here. `submitWork` sends the
 *    caller's idempotency key and returns what the engine said; duplicate
 *    prevention lives in `submit.js` and its durable ledger.
 */

import { SdkError } from "../errors.js";
import { createTransport } from "../http.js";
import { SseDecoder } from "../sse.js";
import {
  CONTRACT_VERSION,
  ROUTE,
  agentCapability,
  assertAgentList,
  assertChatReply,
  assertConversation,
  assertConversationList,
  assertExecutionEvent,
  assertHealth,
  assertMemoryList,
  assertModelList,
  assertNotificationList,
  assertPermissionList,
  assertReadiness,
  assertTaskAccepted,
  assertTaskControl,
  assertTaskStatus,
  negotiateContractVersion,
} from "./contract.js";

const AUTH_CODES = new Set(["UNAUTHENTICATED", "HTTP_401", "unauthorized"]);

function isAuthFailure(error) {
  return AUTH_CODES.has(String(error?.code)) || error?.status === 401;
}

function chatFrames(text) {
  const decoder = new SseDecoder();
  return decoder.push(text);
}

/**
 * Normalise the two shapes `/v1/chat` may answer with.
 *
 * The published document declares `text/event-stream` while the reference
 * handler returns a JSON `ChatReply`; both are accepted so a deployment is
 * usable either way. An SSE reply yields `text.delta` / `text.replace` frames
 * and must end in a `ChatReply` frame, otherwise the reply is incomplete.
 */
function interpretChat({ json, text, headers }) {
  const contentType = String(headers?.get?.("content-type") ?? "").toLowerCase();
  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    return { reply: assertChatReply(json), deltas: [] };
  }
  if (!contentType.includes("text/event-stream")) {
    throw new SdkError(
      "CONTRACT_VIOLATION",
      `/v1/chat answered with ${contentType || "no content type"}; the contract requires application/json or text/event-stream`,
    );
  }
  const deltas = [];
  let reply = null;
  for (const frame of chatFrames(String(text ?? ""))) {
    if (frame.data === null || frame.done === true) continue;
    const value = frame.data;
    if (value === null || typeof value !== "object") {
      throw new SdkError("CONTRACT_VIOLATION", "a /v1/chat frame was not a JSON object");
    }
    if (value.type === "text.delta" && typeof value.text === "string") {
      deltas.push({ type: "delta", text: value.text });
      continue;
    }
    if (value.type === "text.replace" && typeof value.text === "string") {
      deltas.push({ type: "replace", text: value.text });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(value, "conversationId")) {
      reply = assertChatReply(value, "chat");
    }
  }
  if (reply === null) {
    throw new SdkError(
      "STREAM_INCOMPLETE",
      "the /v1/chat stream ended without a ChatReply frame",
      { retryable: true },
    );
  }
  return { reply, deltas };
}

export class V1Client {
  /**
   * @param {object} options
   * @param {string} options.baseUrl deployment origin, optionally with a path prefix
   * @param {{get: () => (string|null|Promise<string|null>), refresh?: () => Promise<string|null>}} [options.tokenProvider]
   * @param {string|null} [options.token] convenience for a fixed token
   * @param {typeof fetch} [options.fetchImpl]
   * @param {number} [options.timeoutMs]
   * @param {string[]} [options.secrets] extra strings to redact from errors
   * @param {string} [options.clientVersion]
   * @param {(entry: object) => void} [options.onDiagnostic]
   */
  constructor({
    baseUrl,
    tokenProvider = null,
    token = null,
    fetchImpl = fetch,
    timeoutMs = 30_000,
    secrets = [],
    clientVersion = "0.0.0",
    onDiagnostic = () => {},
    now = () => Date.now(),
  } = {}) {
    if (!baseUrl) throw new SdkError("BASE_URL_REQUIRED", "an engine URL is required");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.tokenProvider = tokenProvider ?? {
      get: () => token,
      refresh: async () => null,
    };
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.secrets = secrets;
    this.clientVersion = clientVersion;
    this.onDiagnostic = onDiagnostic;
    this.now = now;
    this.negotiated = null;
    this.agentCache = null;
    this.currentToken = null;
    this.transport = null;
    // Set when `refresh()` returns a token. A provider is not required to make
    // `get()` return the new value immediately, so the refreshed token is used
    // for the retry even if `get()` is still stale.
    this.pendingToken = null;
  }

  get contractVersion() {
    return CONTRACT_VERSION;
  }

  /**
   * Rebuild the shared transport only when the owner token actually changes.
   * `createTransport` captures the token in its headers, so a refreshed token
   * needs a new transport; rebuilding on every request would defeat keep-alive.
   */
  async #transport() {
    const token = this.pendingToken ?? (await this.tokenProvider.get());
    const value = token ?? null;
    if (this.transport === null || value !== this.currentToken) {
      this.currentToken = value;
      this.transport = createTransport({
        baseUrl: this.baseUrl,
        token: value,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        clientVersion: this.clientVersion,
      });
    }
    return this.transport;
  }

  async #send(input, { retried = false } = {}) {
    const transport = await this.#transport();
    try {
      return await transport.json(input.path, {
        method: input.method ?? "GET",
        body: input.body,
        signal: input.signal,
        accept: input.accept,
        headers: input.headers,
      });
    } catch (error) {
      if (!retried && input.authenticated !== false && isAuthFailure(error) && typeof this.tokenProvider.refresh === "function") {
        const refreshed = await this.tokenProvider.refresh();
        if (refreshed) {
          this.pendingToken = refreshed;
          this.transport = null;
          return this.#send(input, { retried: true });
        }
      }
      throw error;
    }
  }

  async #json(schema, input) {
    const response = await this.#send(input);
    if (response.json === null || response.json === undefined) {
      throw new SdkError("CONTRACT_VIOLATION", `${input.path} returned an empty body`);
    }
    return schema(response.json, input.path);
  }

  health({ signal } = {}) {
    return this.#json(assertHealth, { path: ROUTE.health, authenticated: false, signal });
  }

  readiness({ signal } = {}) {
    return this.#json(assertReadiness, { path: ROUTE.ready, authenticated: false, signal });
  }

  /**
   * Negotiate the contract once per client.
   *
   * @param {object} [options]
   * @param {boolean} [options.force] re-read health even when already negotiated
   */
  async negotiate({ force = false, signal } = {}) {
    if (this.negotiated !== null && !force) return this.negotiated;
    const health = await this.health({ signal });
    const result = negotiateContractVersion(health.contractVersion, { source: "/v1/health" });
    if (result.newerMinor) {
      this.onDiagnostic({
        code: "CONTRACT_MINOR_NEWER",
        message:
          `the engine serves contract ${result.serverContract}; this client mirrors ${CONTRACT_VERSION}. ` +
          "Newer optional fields are rejected as contract violations.",
        severity: "warning",
      });
    }
    this.negotiated = { ...result, health };
    return this.negotiated;
  }

  async agents({ refresh = false, signal } = {}) {
    const fresh = this.agentCache !== null && this.now() - this.agentCache.at < 5_000;
    if (!refresh && fresh) return this.agentCache.value;
    const value = await this.#json(assertAgentList, { path: ROUTE.agents, signal });
    this.agentCache = { at: this.now(), value };
    return value;
  }

  models({ signal } = {}) {
    return this.#json(assertModelList, { path: ROUTE.models, signal });
  }

  /**
   * Refuse work the selected agent cannot actually perform. There is no silent
   * substitution: an unavailable agent stays unavailable.
   */
  async requireCapability(agentId, capability, { signal } = {}) {
    const agents = await this.agents({ signal });
    const result = agentCapability(agents, agentId, capability);
    if (!result.supported) {
      throw new SdkError("CAPABILITY_UNAVAILABLE", result.reason, {
        details: { agent: agentId, capability: capability ?? null },
        retryable: false,
      });
    }
    return result.agent;
  }

  /**
   * One Chat turn. Returns the validated reply plus any streamed deltas the
   * deployment produced, so the caller can render progress without inventing a
   * second response shape.
   */
  async chat(request, { signal, onDelta = null } = {}) {
    const response = await this.#send({
      path: ROUTE.chat,
      method: "POST",
      body: request,
      signal,
      accept: "application/json, text/event-stream",
    });
    const { reply, deltas } = interpretChat(response);
    for (const delta of deltas) onDelta?.(delta);
    return reply;
  }

  submitWork(request, { signal, idempotencyKey } = {}) {
    const headers = {};
    if (idempotencyKey) {
      headers["idempotency-key"] = String(idempotencyKey);
      headers["x-coderax-client-request-id"] = String(idempotencyKey);
    }
    return this.#json(assertTaskAccepted, {
      path: ROUTE.work,
      method: "POST",
      body: request,
      signal,
      headers,
    });
  }

  task(taskId, { signal } = {}) {
    return this.#json(assertTaskStatus, { path: ROUTE.task(taskId), signal });
  }

  cancel(taskId, reason, { signal } = {}) {
    return this.#json(assertTaskControl, {
      path: ROUTE.cancel(taskId),
      method: "POST",
      body: reason ? { reason } : {},
      signal,
    });
  }

  resume(taskId, generation, { signal } = {}) {
    return this.#json(assertTaskControl, {
      path: ROUTE.resume(taskId),
      method: "POST",
      body: { generation },
      signal,
    });
  }

  retry(taskId, generation, model, { signal } = {}) {
    return this.#json(assertTaskControl, {
      path: ROUTE.retry(taskId),
      method: "POST",
      body: model ? { generation, model } : { generation },
      signal,
    });
  }

  conversations({ signal } = {}) {
    return this.#json(assertConversationList, { path: ROUTE.conversations, signal });
  }

  conversation(conversationId, { signal } = {}) {
    return this.#json(assertConversation, { path: ROUTE.conversation(conversationId), signal });
  }

  memory(mode = "private", { signal } = {}) {
    return this.#json(assertMemoryList, {
      path: `${ROUTE.memory}?mode=${encodeURIComponent(mode)}`,
      signal,
    });
  }

  permissions(taskId, { signal } = {}) {
    return this.#json(assertPermissionList, { path: ROUTE.permissions(taskId), signal });
  }

  decidePermission(taskId, decision, { signal } = {}) {
    return this.#json(assertPermissionList, {
      path: ROUTE.permissions(taskId),
      method: "POST",
      body: decision,
      signal,
    });
  }

  notifications({ signal } = {}) {
    return this.#json(assertNotificationList, { path: ROUTE.notifications, signal });
  }

  /**
   * Replay and tail execution events from `after`.
   *
   * The cursor is the contract's `after` query parameter; `Last-Event-ID` is
   * also sent so a proxy or a future engine can honour it. A duplicate
   * `eventId` inside one connection is dropped; `seq` ordering is enforced by
   * `watchTask`, which owns reconnect and gap recovery.
   */
  async *events(taskId, { after = 0, signal, onUnknown = null } = {}) {
    const cursor = Number.isInteger(after) && after > 0 ? after : 0;
    const query = cursor > 0 ? `?after=${cursor}` : "";
    const headers = cursor > 0 ? { "last-event-id": String(cursor) } : {};
    let transport = await this.#transport();
    let response;

    try {
      response = await transport.stream(`${ROUTE.events(taskId)}${query}`, { signal, headers });
    } catch (error) {
      if (isAuthFailure(error) && typeof this.tokenProvider.refresh === "function") {
        const refreshed = await this.tokenProvider.refresh();
        if (refreshed) {
          this.pendingToken = refreshed;
          this.transport = null;
          transport = await this.#transport();
          response = await transport.stream(`${ROUTE.events(taskId)}${query}`, { signal, headers });
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    const decoder = new SseDecoder();
    const seen = new Set();
    try {
      for (;;) {
        const { value, done } = await response.next();
        if (done) break;
        for (const frame of decoder.push(response.text(value))) {
          if (frame.done === true) return;
          if (frame.data === null) continue;
          if (frame.data.raw === true && typeof frame.data.text === "string") {
            throw new SdkError("CONTRACT_VIOLATION", "an execution event frame was not valid JSON");
          }
          const event = assertExecutionEvent(frame.data);
          if (event === null) {
            onUnknown?.(frame.data);
            continue;
          }
          const id = frame.id ?? event.eventId;
          if (seen.has(id)) continue;
          seen.add(id);
          yield { event, id };
        }
      }
    } finally {
      response.close();
    }
  }
}

export function createV1Client(options) {
  return new V1Client(options);
}
