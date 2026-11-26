import { CoderaxError, CancelledError } from "./errors.js";
import { createRedactor, environmentSecrets } from "./redact.js";
import { USER_AGENT } from "./version.js";

const PRE_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_INVALID_URL",
]);

export function joinRoute(baseUrl, path) {
  if (!baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no Coderax URL configured; set one with `coderax config set --engine-url <url>` or CODERAX_ENGINE_URL",
    );
  }
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = String(path).startsWith("/") ? String(path) : `/${path}`;
  let target;
  try {
    target = new URL(`${base}${suffix}`);
  } catch {
    throw new CoderaxError("BASE_URL_INVALID", "the configured URL is not a valid absolute URL");
  }
  if (target.origin !== new URL(base).origin) {
    throw new CoderaxError("BASE_URL_INVALID", `route ${path} resolves outside the configured origin`);
  }
  return target;
}

export function createTransportRedactor(secrets) {
  return createRedactor([...(secrets ?? []), ...environmentSecrets()]);
}

function errorCodeOf(error) {
  const candidates = [error?.code, error?.cause?.code, error?.errno];
  return candidates.find((value) => typeof value === "string") ?? "";
}

function redactedMessage(error, redactor) {
  return redactor.redact(String(error?.message ?? error?.cause?.message ?? "network error"));
}

export function classifyNetworkError(error, { path, timeoutMs, redactor, idle = false }) {
  if (error instanceof CoderaxError) return error;
  if (error?.name === "AbortError" && error?.cause === "caller") return new CancelledError();
  const code = errorCodeOf(error);
  const timedOut = error?.name === "TimeoutError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";
  if (timedOut) {
    return new CoderaxError(
      "REQUEST_TIMEOUT",
      `${idle ? "the stream" : `request to ${path}`} was idle for ${timeoutMs}ms`,
      { retryable: true, transmitted: true },
    );
  }
  const transmitted = !PRE_CONNECT_CODES.has(code);
  return new CoderaxError(
    "REQUEST_FAILED",
    `request to ${path} failed: ${redactedMessage(error, redactor)}`,
    { retryable: transmitted, transmitted },
  );
}

export function isProblem(value) {
  return Boolean(
    value
    && typeof value === "object"
    && typeof value.type === "string"
    && typeof value.title === "string"
    && Number.isInteger(value.status)
    && typeof value.code === "string"
    && typeof value.retryable === "boolean",
  );
}

export function problemError({ status, json, text, path, redactor }) {
  if (isProblem(json)) {
    const detail = typeof json.detail === "string" && json.detail.length > 0 ? json.detail : json.title;
    return new CoderaxError(redactor.redact(json.code), redactor.redact(detail), {
      status,
      requestId: typeof json.requestId === "string" ? redactor.redact(json.requestId) : undefined,
      retryable: json.retryable,
      details: redactor.redactValue(json),
    });
  }
  const safe = redactor.redact(String(text ?? "").trim().slice(0, 2000));
  const detail = safe.length > 0 ? `: ${safe.slice(0, 300)}` : "";
  return new CoderaxError(`HTTP_${status}`, `HTTP ${status} from ${path}${detail}`, { status });
}

async function readCapped(response, maxBytes, path) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new CoderaxError("RESPONSE_TOO_LARGE", `the response from ${path} exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/**
 * One HTTP exchange. No retries, no redirects, no cookies, no token in an error
 * message, and a bounded body. Retry policy belongs to the caller.
 */
export async function httpRequest({
  baseUrl,
  token,
  path,
  method = "GET",
  body,
  query,
  headers = {},
  timeoutMs = 30_000,
  signal,
  fetchImpl = fetch,
  secrets = [],
  maxBytes = 8 * 1024 * 1024,
  accept = "application/json",
} = {}) {
  if (signal?.aborted) throw new CancelledError();
  const redactor = createTransportRedactor([token, ...secrets]);
  const target = joinRoute(baseUrl, path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
  }
  const displayPath = redactor.redact(target.pathname);
  const requestHeaders = {
    accept,
    "user-agent": USER_AGENT,
    ...headers,
  };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    requestHeaders["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort("caller");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  let response;
  try {
    response = await fetchImpl(target, {
      method,
      headers: requestHeaders,
      body: payload,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) throw new CancelledError();
    if (controller.signal.aborted) {
      throw new CoderaxError("REQUEST_TIMEOUT", `request to ${displayPath} timed out after ${timeoutMs}ms`, {
        retryable: true,
        transmitted: true,
      });
    }
    throw classifyNetworkError(error, { path: displayPath, timeoutMs, redactor });
  }

  let text;
  try {
    text = await readCapped(response, maxBytes, displayPath);
  } catch (error) {
    if (error instanceof CoderaxError) throw error;
    if (signal?.aborted) throw new CancelledError();
    if (controller.signal.aborted) {
      throw new CoderaxError("REQUEST_TIMEOUT", `request to ${displayPath} timed out after ${timeoutMs}ms`, {
        retryable: true,
        transmitted: true,
      });
    }
    throw classifyNetworkError(error, { path: displayPath, timeoutMs, redactor });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  let json = null;
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    throw problemError({ status: response.status, json, text, path: displayPath, redactor });
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    json: redactor.redactValue(json),
    rawJson: json,
    text: redactor.redact(text),
    rawText: text,
    redactor,
  };
}

/**
 * Normalize SSE line endings without assuming a network read ends on a line
 * boundary. A trailing `\r` is held until the next read: converting it to `\n`
 * immediately would turn a CRLF split across reads into two newlines and
 * fabricate a frame boundary.
 */
export class SseTextNormalizer {
  constructor() {
    this.pendingCR = false;
  }

  push(text) {
    let input = `${this.pendingCR ? "\r" : ""}${text}`;
    this.pendingCR = false;
    if (input.endsWith("\r")) {
      this.pendingCR = true;
      input = input.slice(0, -1);
    }
    return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  end() {
    const input = this.pendingCR ? "\r" : "";
    this.pendingCR = false;
    return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }
}

/**
 * Parse an SSE byte stream into frames. `id`, `event` and `retry` are preserved
 * so a reconnecting stream can send `Last-Event-ID` and honour a server hint.
 */
export async function* parseSseStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const normalizer = new SseTextNormalizer();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += normalizer.push(decoder.decode(value, { stream: true }));
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseSseFrame(raw);
        if (frame) yield frame;
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += normalizer.push(decoder.decode());
    buffer += normalizer.end();
    if (buffer.trim().length > 0) {
      const frame = parseSseFrame(buffer);
      if (frame) yield frame;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The peer already closed.
    }
    reader.releaseLock();
  }
}

export function parseSseFrame(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let id;
  let event;
  let retry;
  const data = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "retry") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) retry = parsed;
    }
  }
  if (data.length === 0 && id === undefined && event === undefined) return null;
  return { id, event, retry, data: data.join("\n") };
}

/**
 * Open an SSE response with an idle deadline: a healthy long-lived stream is
 * never cut off, but a stalled one is. Returns an async frame iterator.
 */
export async function openSseStream({
  baseUrl,
  token,
  path,
  query,
  headers = {},
  timeoutMs = 30_000,
  signal,
  fetchImpl = fetch,
  secrets = [],
  lastEventId,
  accept = "text/event-stream",
  maxBytes = 64 * 1024 * 1024,
} = {}) {
  if (signal?.aborted) throw new CancelledError();
  const redactor = createTransportRedactor([token, ...secrets]);
  const target = joinRoute(baseUrl, path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
  }
  const displayPath = redactor.redact(target.pathname);
  const requestHeaders = {
    accept,
    "cache-control": "no-cache",
    "user-agent": USER_AGENT,
    ...headers,
  };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (lastEventId !== undefined && lastEventId !== null && String(lastEventId).length > 0) {
    requestHeaders["last-event-id"] = String(lastEventId);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort("caller");
  signal?.addEventListener("abort", onAbort, { once: true });
  let idle = false;
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      controller.abort("idle");
    }, timeoutMs);
  };
  arm();

  let response;
  try {
    response = await fetchImpl(target, {
      method: "GET",
      headers: requestHeaders,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) throw new CancelledError();
    if (idle || controller.signal.aborted) {
      throw new CoderaxError("REQUEST_TIMEOUT", `the stream from ${displayPath} was idle for ${timeoutMs}ms`, {
        retryable: true,
        transmitted: true,
      });
    }
    throw classifyNetworkError(error, { path: displayPath, timeoutMs, redactor, idle: true });
  }

  if (!response.ok || !response.body) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    const text = await readCapped(response, 1024 * 1024, displayPath).catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    throw problemError({ status: response.status, json, text, path: displayPath, redactor });
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    try {
      await response.body.cancel();
    } catch {
      // Ignore.
    }
    throw new CoderaxError(
      "PROTOCOL_ERROR",
      `${displayPath} answered with ${contentType || "no content type"} instead of an event stream`,
      { retryable: false },
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const normalizer = new SseTextNormalizer();
  let buffer = "";
  let received = 0;
  let closed = false;

  async function* frames() {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        arm();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          throw new CoderaxError("RESPONSE_TOO_LARGE", `the event stream exceeded ${maxBytes} bytes`);
        }
        buffer += normalizer.push(decoder.decode(value, { stream: true }));
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const frame = parseSseFrame(raw);
          if (frame) {
            yield {
              ...frame,
              data: redactor.redact(frame.data),
              rawData: frame.data,
            };
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      buffer += normalizer.push(decoder.decode());
      buffer += normalizer.end();
      if (buffer.trim().length > 0) {
        const frame = parseSseFrame(buffer);
        if (frame) {
          yield { ...frame, data: redactor.redact(frame.data), rawData: frame.data };
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new CancelledError();
      if (idle) {
        throw new CoderaxError("REQUEST_TIMEOUT", `the stream from ${displayPath} was idle for ${timeoutMs}ms`, {
          retryable: true,
          transmitted: true,
        });
      }
      throw classifyNetworkError(error, { path: displayPath, timeoutMs, redactor, idle: true });
    } finally {
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        await reader.cancel();
      } catch {
        // Ignore.
      }
      reader.releaseLock();
    }
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    frames: frames(),
    redactor,
    close: async () => {
      if (closed) return;
      try {
        await reader.cancel();
      } catch {
        // Ignore.
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}
