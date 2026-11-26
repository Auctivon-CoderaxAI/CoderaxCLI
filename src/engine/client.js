import { CoderaxError } from "../errors.js";
import { httpRequest, openSseStream } from "../http.js";
import { createRedactor } from "../redact.js";
import {
  API_PREFIX,
  CONTRACT_VERSION,
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
} from "./contract.js";

const AUTH_CODES = new Set(["unauthorized", "HTTP_401"]);

function encode(value) {
  return encodeURIComponent(value);
}

function isAuthFailure(error) {
  return AUTH_CODES.has(String(error?.code)) || error?.status === 401;
}

/**
 * The engine client is a faithful, dependency-free implementation of
 * `@coderax/sdk` 1.x over the published `/v1` contract. Every response and every
 * event is validated before it is returned; a drift is a named contract error,
 * never a plausible wrong value.
 */
export class EngineClient {
  constructor({
    baseUrl,
    tokenProvider,
    fetchImpl = fetch,
    timeoutMs = 30_000,
    secrets = [],
    onWarning = () => {},
    now = () => Date.now(),
  } = {}) {
    if (!baseUrl) throw new CoderaxError("BASE_URL_REQUIRED", "an engine URL is required");
    if (!tokenProvider) throw new TypeError("EngineClient requires a tokenProvider");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.tokens = tokenProvider;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.extraSecrets = secrets;
    this.onWarning = onWarning;
    this.now = now;
    this.negotiated = null;
    this.agentCache = null;
  }

  get contractVersion() {
    return CONTRACT_VERSION;
  }

  redact(value, token) {
    return createRedactor([token, ...this.extraSecrets]).redactValue(value);
  }

  async #token() {
    return this.tokens.get();
  }

  async #send({
    method = "GET",
    path,
    body,
    query,
    signal,
    accept = "application/json",
    headers = {},
    retried = false,
    publicRequest = false,
  }) {
    let token;
    if (!publicRequest) {
      token = await this.#token();
    }
    try {
      return await httpRequest({
        baseUrl: this.baseUrl,
        token,
        path,
        method,
        body,
        query,
        signal,
        accept,
        headers,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        secrets: this.extraSecrets,
      });
    } catch (error) {
      if (!publicRequest && !retried && isAuthFailure(error)) {
        let refreshed;
        try {
          refreshed = await this.tokens.refresh();
        } catch (refreshError) {
          error.hint = refreshError.message;
          throw error;
        }
        if (refreshed) {
          return this.#send({ method, path, body, query, signal, accept, headers, retried: true });
        }
      }
      throw error;
    }
  }

  async #json(schema, input) {
    const response = await this.#send(input);
    if (response.rawJson === null || response.rawJson === undefined) {
      throw new CoderaxError("PROTOCOL_ERROR", `${input.path} returned an empty body`);
    }
    schema(response.rawJson, input.path);
    return response.redactor.redactValue(response.rawJson);
  }

  health() {
    return this.#json(assertHealth, { method: "GET", path: `${API_PREFIX}/health`, publicRequest: true });
  }

  readiness() {
    return this.#json(assertReadiness, { method: "GET", path: `${API_PREFIX}/ready`, publicRequest: true });
  }

  /**
   * Version negotiation happens once per client. A server that serves a
   * different contract is refused explicitly instead of being half-used.
   */
  async negotiate({ force = false } = {}) {
    if (this.negotiated && !force) return this.negotiated;
    const health = await this.health();
    if (health.contractVersion !== CONTRACT_VERSION) {
      throw new CoderaxError(
        "CONTRACT_UNSUPPORTED",
        `the engine serves contract ${health.contractVersion}; this CLI supports ${CONTRACT_VERSION}`,
        {
          details: {
            serverContract: health.contractVersion,
            clientContract: CONTRACT_VERSION,
          },
          hint: "Install a CLI release that matches the engine, or deploy an engine that serves this contract.",
        },
      );
    }
    this.negotiated = health;
    return health;
  }

  async agents({ refresh = false } = {}) {
    const cacheFresh = this.agentCache && this.now() - this.agentCache.at < 5_000;
    if (!refresh && cacheFresh) return this.agentCache.value;
    const value = await this.#json(assertAgentList, { method: "GET", path: `${API_PREFIX}/agents` });
    this.agentCache = { at: this.now(), value };
    return value;
  }

  models() {
    return this.#json(assertModelList, { method: "GET", path: `${API_PREFIX}/models` });
  }

  /**
   * Refuse work the selected agent cannot actually do. There is no silent
   * substitution: an unavailable agent stays unavailable.
   */
  async requireCapability(agentId, capability) {
    const agents = await this.agents();
    const result = agentCapability(agents, agentId, capability);
    if (!result.supported) {
      throw new CoderaxError("CAPABILITY_UNSUPPORTED", result.reason, {
        details: { agent: agentId, capability },
        hint: "Run `coderax agents` to see availability and capabilities.",
      });
    }
    return result.agent;
  }

  chat(request, { signal } = {}) {
    return this.#json(assertChatReply, {
      method: "POST",
      path: `${API_PREFIX}/chat`,
      body: request,
      signal,
    });
  }

  submitWork(request, { signal, idempotencyKey } = {}) {
    const headers = {};
    if (idempotencyKey) {
      headers["idempotency-key"] = idempotencyKey;
      headers["x-coderax-client-request-id"] = idempotencyKey;
    }
    return this.#json(assertTaskAccepted, {
      method: "POST",
      path: `${API_PREFIX}/work`,
      body: request,
      signal,
      headers,
    });
  }

  task(taskId, { signal } = {}) {
    return this.#json(assertTaskStatus, {
      method: "GET",
      path: `${API_PREFIX}/work/${encode(taskId)}`,
      signal,
    });
  }

  cancel(taskId, reason, { signal } = {}) {
    return this.#json(assertTaskControl, {
      method: "POST",
      path: `${API_PREFIX}/work/${encode(taskId)}/cancel`,
      body: reason ? { reason } : {},
      signal,
    });
  }

  resume(taskId, generation, { signal } = {}) {
    return this.#json(assertTaskControl, {
      method: "POST",
      path: `${API_PREFIX}/work/${encode(taskId)}/resume`,
      body: { generation },
      signal,
    });
  }

  retry(taskId, generation, model, { signal } = {}) {
    return this.#json(assertTaskControl, {
      method: "POST",
      path: `${API_PREFIX}/work/${encode(taskId)}/retry`,
      body: model ? { generation, model } : { generation },
      signal,
    });
  }

  conversations({ signal } = {}) {
    return this.#json(assertConversationList, {
      method: "GET",
      path: `${API_PREFIX}/conversations`,
      signal,
    });
  }

  conversation(conversationId, { signal } = {}) {
    return this.#json(assertConversation, {
      method: "GET",
      path: `${API_PREFIX}/conversations/${encode(conversationId)}`,
      signal,
    });
  }

  memory(mode = "private", { signal } = {}) {
    return this.#json(assertMemoryList, {
      method: "GET",
      path: `${API_PREFIX}/memory`,
      query: { mode },
      signal,
    });
  }

  permissions(taskId, { signal } = {}) {
    return this.#json(assertPermissionList, {
      method: "GET",
      path: `${API_PREFIX}/work/${encode(taskId)}/permissions`,
      signal,
    });
  }

  decidePermission(taskId, decision, { signal } = {}) {
    return this.#json(assertPermissionList, {
      method: "POST",
      path: `${API_PREFIX}/work/${encode(taskId)}/permissions`,
      body: decision,
      signal,
    });
  }

  notifications({ signal } = {}) {
    return this.#json(assertNotificationList, {
      method: "GET",
      path: `${API_PREFIX}/notifications`,
      signal,
    });
  }

  /**
   * Replay and tail execution events. `after` is the authoritative cursor;
   * `Last-Event-ID` is sent as well so a proxy or a future engine can use it.
   */
  async *events(taskId, { after = 0, signal, onUnknown = null } = {}) {
    let token = await this.#token();
    let retriedAuth = false;
    for (;;) {
      let stream;
      try {
        stream = await openSseStream({
          baseUrl: this.baseUrl,
          token,
          path: `${API_PREFIX}/work/${encode(taskId)}/events`,
          query: { after },
          lastEventId: after > 0 ? String(after) : undefined,
          signal,
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImpl,
          secrets: this.extraSecrets,
        });
      } catch (error) {
        if (!retriedAuth && isAuthFailure(error)) {
          retriedAuth = true;
          const refreshed = await this.tokens.refresh();
          if (refreshed) {
            token = refreshed;
            continue;
          }
        }
        throw error;
      }

      try {
        for await (const frame of stream.frames) {
          if (frame.data === "[DONE]" || frame.data.trim() === "") continue;
          let parsed;
          try {
            parsed = JSON.parse(frame.rawData);
          } catch {
            throw new CoderaxError("PROTOCOL_ERROR", "an execution event frame was not valid JSON");
          }
          const event = assertExecutionEvent(parsed);
          if (event === null) {
            onUnknown?.(parsed);
            continue;
          }
          yield {
            event: stream.redactor.redactValue(event),
            id: frame.id,
          };
          if (after !== undefined) {
            // The stream layer owns the cursor; this keeps the header useful if
            // the generator is re-entered without a new `after`.
            after = event.seq;
          }
        }
      } finally {
        await stream.close();
      }
      return;
    }
  }
}

export function createEngineClient(options) {
  return new EngineClient(options);
}
