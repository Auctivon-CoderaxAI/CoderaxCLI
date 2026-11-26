import { CoderaxError, redact } from "./client.js";
import { SseDecoder, SseDecodeError, parseJsonFrame } from "./sse.js";
import {
  CONTRACT_VERSION,
  ROUTES,
  conversationPath,
  taskPath,
} from "./contract.js";

/**
 * A thin client for the versioned WorkflowEngine HTTP surface.
 *
 * This mirrors the public methods of `@coderax/sdk` 1.0.0, which is the client
 * both Coderax and CoderaxCLI are specified to consume. The SDK is a private
 * workspace package, so the CLI cannot import it at runtime; it consumes the
 * same pinned contract instead. The client performs one request per call, keeps
 * no cookie jar, follows no redirect, and never places the token in a URL or an
 * error message. It contains no model routing, orchestration or persistence.
 */

const OPERATIONS = new Map(ROUTES.map((route) => [route.operationId, route]));

function operation(operationId) {
  const route = OPERATIONS.get(operationId);
  if (!route) throw new Error(`unknown workflow-engine operation: ${operationId}`);
  return route;
}

function joinUrl(baseUrl, path, query) {
  const base = baseUrl.replace(/\/+$/, "");
  const target = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
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
    if (typeof value.message === "string") return value.message;
    if (typeof value.title === "string") return value.title;
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

/**
 * An engine failure carries the stable `Problem.code`, its HTTP status and the
 * request id, so the CLI can branch without parsing prose. A response that is
 * not a Problem body keeps an `HTTP_<status>` code.
 */
function problemError(problem, status, operationId, token) {
  const code = typeof problem?.code === "string" ? problem.code : `HTTP_${status}`;
  const detail = detailText(problem?.detail ?? problem?.title ?? problem);
  const message = `HTTP ${status} from ${operationId}${detail ? `: ${truncated(redact(detail, token))}` : ""}`;
  const error = new CoderaxError(code, message, { status });
  if (typeof problem?.requestId === "string") error.requestId = problem.requestId;
  if (typeof problem?.retryable === "boolean") error.retryable = problem.retryable;
  error.operationId = operationId;
  error.body = problem;
  return error;
}

function contractError(operationId, detail) {
  return new CoderaxError(
    "CONTRACT_ERROR",
    `the response for ${operationId} did not match the workflow-engine ${CONTRACT_VERSION} contract: ${detail}`,
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectAt(value, key, operationId) {
  const found = value?.[key];
  if (!isRecord(found)) throw contractError(operationId, `missing object "${key}"`);
  return found;
}

function arrayAt(value, key, operationId) {
  const found = value?.[key];
  if (!Array.isArray(found)) throw contractError(operationId, `missing array "${key}"`);
  return found;
}

function stringAt(value, key, operationId) {
  const found = value?.[key];
  if (typeof found !== "string" || found === "") {
    throw contractError(operationId, `missing string "${key}"`);
  }
  return found;
}

function integerAt(value, key, operationId) {
  const found = value?.[key];
  if (!Number.isInteger(found) || found < 0) {
    throw contractError(operationId, `missing non-negative integer "${key}"`);
  }
  return found;
}

const VALIDATORS = {
  getHealth(operationId, body) {
    stringAt(body, "status", operationId);
    stringAt(body, "contractVersion", operationId);
    arrayAt(body, "checks", operationId);
    arrayAt(body, "engines", operationId);
    return body;
  },
  getReadiness(operationId, body) {
    if (typeof body?.ready !== "boolean") throw contractError(operationId, 'missing boolean "ready"');
    arrayAt(body, "missing", operationId);
    arrayAt(body, "checks", operationId);
    return body;
  },
  listAgents(operationId, body) {
    for (const agent of arrayAt(body, "agents", operationId)) {
      stringAt(agent, "id", operationId);
      stringAt(agent, "label", operationId);
      objectAt(agent, "capabilities", operationId);
      objectAt(agent, "availability", operationId);
      objectAt(agent, "isolation", operationId);
    }
    return body;
  },
  listModels(operationId, body) {
    for (const model of arrayAt(body, "models", operationId)) {
      objectAt(model, "ref", operationId);
      stringAt(model, "label", operationId);
      stringAt(model, "costClass", operationId);
      objectAt(model, "availability", operationId);
    }
    arrayAt(body, "route", operationId);
    if (body?.allowPaid !== false) throw contractError(operationId, '"allowPaid" must be false');
    return body;
  },
  submitChat(operationId, body) {
    stringAt(body, "conversationId", operationId);
    stringAt(body, "messageId", operationId);
    stringAt(body, "text", operationId);
    stringAt(body, "agent", operationId);
    objectAt(body, "model", operationId);
    return body;
  },
  submitWork(operationId, body) {
    stringAt(body, "taskId", operationId);
    stringAt(body, "conversationId", operationId);
    stringAt(body, "state", operationId);
    integerAt(body, "generation", operationId);
    stringAt(body, "eventsPath", operationId);
    return body;
  },
  getTask(operationId, body) {
    stringAt(body, "taskId", operationId);
    stringAt(body, "state", operationId);
    integerAt(body, "generation", operationId);
    arrayAt(body, "steps", operationId);
    return body;
  },
  cancelTask(operationId, body) {
    return controlResult(operationId, body);
  },
  resumeTask(operationId, body) {
    return controlResult(operationId, body);
  },
  retryTask(operationId, body) {
    return controlResult(operationId, body);
  },
  listConversations(operationId, body) {
    for (const conversation of arrayAt(body, "conversations", operationId)) {
      stringAt(conversation, "conversationId", operationId);
      stringAt(conversation, "agent", operationId);
    }
    return body;
  },
  getConversation(operationId, body) {
    stringAt(body, "conversationId", operationId);
    stringAt(body, "agent", operationId);
    for (const message of arrayAt(body, "messages", operationId)) {
      stringAt(message, "role", operationId);
      if (typeof message?.text !== "string") throw contractError(operationId, 'missing string "text"');
    }
    return body;
  },
  listMemory(operationId, body) {
    for (const entry of arrayAt(body, "entries", operationId)) {
      stringAt(entry, "key", operationId);
      stringAt(entry, "mode", operationId);
    }
    return body;
  },
  listPermissions(operationId, body) {
    for (const request of arrayAt(body, "requests", operationId)) {
      stringAt(request, "requestId", operationId);
      stringAt(request, "decision", operationId);
    }
    return body;
  },
  decidePermission(operationId, body) {
    return VALIDATORS.listPermissions(operationId, body);
  },
  listNotifications(operationId, body) {
    arrayAt(body, "notifications", operationId);
    integerAt(body, "unread", operationId);
    return body;
  },
};

function controlResult(operationId, body) {
  stringAt(body, "taskId", operationId);
  stringAt(body, "state", operationId);
  integerAt(body, "generation", operationId);
  stringAt(body, "outcome", operationId);
  return body;
}

export class EngineClient {
  constructor({ baseUrl, token = null, timeoutMs = 15000, eventTimeoutMs, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.eventTimeoutMs = Math.max(Number(eventTimeoutMs ?? timeoutMs), 1000);
    this.fetchImpl = fetchImpl;
  }

  headers(accept = "application/json") {
    const headers = { accept };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async #send({ method, path, query, body, accept = "application/json", signal, timeoutMs, cancelled }) {
    let target;
    try {
      target = joinUrl(this.baseUrl, path, query);
    } catch (error) {
      if (error instanceof CoderaxError) throw error;
      throw new CoderaxError("BASE_URL_INVALID", "the configured base URL is not a valid URL");
    }
    const headers = this.headers(accept);
    let payload;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const timeout = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    try {
      return await this.fetchImpl(target, {
        method,
        headers,
        body: payload,
        redirect: "error",
        signal: combined,
      });
    } catch (error) {
      if ((cancelled?.() ?? false) || signal?.aborted) {
        throw new CoderaxError("CANCELLED", "request cancelled");
      }
      const name = error?.name ?? "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new CoderaxError(
          "REQUEST_TIMEOUT",
          `request to ${target.pathname} timed out after ${timeoutMs ?? this.timeoutMs}ms`,
        );
      }
      throw new CoderaxError(
        "REQUEST_FAILED",
        `request to ${target.pathname} failed: ${truncated(redact(String(error?.message ?? "network error"), this.token))}`,
      );
    }
  }

  async #readText(response) {
    try {
      return await response.text();
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new CoderaxError("REQUEST_TIMEOUT", "the response body could not be read before the timeout");
      }
      throw new CoderaxError("RESPONSE_UNREADABLE", "the response body could not be read");
    }
  }

  async #json(operationId, input) {
    const route = operation(operationId);
    const response = await this.#send({ ...input, method: route.method, path: input.path ?? route.path });
    const text = await this.#readText(response);
    let body = null;
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      throw problemError(body, response.status, operationId, this.token);
    }
    if (body === null) throw contractError(operationId, "empty response body");
    const validate = VALIDATORS[operationId];
    return validate ? validate(operationId, body) : body;
  }

  health() {
    return this.#json("getHealth", { path: operation("getHealth").path });
  }

  ready() {
    return this.#json("getReadiness", { path: operation("getReadiness").path });
  }

  agents() {
    return this.#json("listAgents", { path: operation("listAgents").path });
  }

  models() {
    return this.#json("listModels", { path: operation("listModels").path });
  }

  chat(request) {
    return this.#json("submitChat", { path: operation("submitChat").path, body: request });
  }

  submitWork(request) {
    return this.#json("submitWork", { path: operation("submitWork").path, body: request });
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

  conversations() {
    return this.#json("listConversations", { path: operation("listConversations").path });
  }

  conversation(conversationId) {
    return this.#json("getConversation", { path: conversationPath(conversationId) });
  }

  memory(mode = "private") {
    return this.#json("listMemory", {
      path: operation("listMemory").path,
      query: { mode },
    });
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
    return this.#json("listNotifications", { path: operation("listNotifications").path });
  }

  /**
   * Replay and tail execution events from a sequence cursor. The stream closes
   * on a terminal event; a dropped connection is reported so the caller can
   * reconnect from its own cursor. Frames that are not JSON are a protocol
   * failure, never silently discarded.
   */
  async *events(taskId, { after, signal } = {}) {
    const path = taskPath(taskId, "/events");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    let timer;

    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.eventTimeoutMs);
    };

    try {
      arm();
      const response = await this.#send({
        method: "GET",
        path,
        query: { after },
        accept: "text/event-stream",
        signal: controller.signal,
        timeoutMs: this.eventTimeoutMs,
        // The internal controller also aborts on the idle deadline; only the
        // caller's own signal means a deliberate detach.
        cancelled: () => signal?.aborted === true,
      });

      if (!response.ok) {
        const text = await this.#readText(response);
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        throw problemError(body, response.status, "streamTaskEvents", this.token);
      }
      if (!response.body) {
        throw new CoderaxError("RESPONSE_UNREADABLE", `the event stream for ${taskId} has no body`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const frames = new SseDecoder();
      arm();

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          arm();
          for (const frame of frames.push(decoder.decode(value, { stream: true }))) {
            const event = parseJsonFrame(frame);
            if (event === null) continue;
            if (!isRecord(event)) {
              throw new CoderaxError("STREAM_PROTOCOL", "an event frame was not a JSON object");
            }
            yield event;
          }
        }
      } catch (error) {
        if (error instanceof CoderaxError) throw error;
        if (error instanceof SseDecodeError) {
          throw new CoderaxError("STREAM_PROTOCOL", error.message);
        }
        if (signal?.aborted) throw new CoderaxError("CANCELLED", "event stream detached");
        if (timedOut || error?.name === "TimeoutError" || error?.name === "AbortError") {
          throw new CoderaxError(
            "REQUEST_TIMEOUT",
            `the event stream for ${taskId} was idle for ${this.eventTimeoutMs}ms`,
          );
        }
        throw new CoderaxError(
          "REQUEST_FAILED",
          `the event stream for ${taskId} failed: ${truncated(redact(String(error?.message ?? "network error"), this.token))}`,
        );
      } finally {
        try {
          await reader.cancel();
        } catch {
          // The stream is already gone.
        }
      }
    } catch (error) {
      if (error instanceof CoderaxError) throw error;
      if (signal?.aborted) throw new CoderaxError("CANCELLED", "event stream detached");
      if (timedOut) {
        throw new CoderaxError(
          "REQUEST_TIMEOUT",
          `the event stream for ${taskId} was idle for ${this.eventTimeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
