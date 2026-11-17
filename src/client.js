export class CoderaxError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = "CoderaxError";
    this.code = code;
    this.status = status;
  }
}

function redactionMarker(token) {
  const preferred = "[REDACTED]";
  // A marker that shares any character with the token can form the token
  // across a replacement boundary, so require a disjoint alphabet. Short
  // tokens such as "E" are the common case where `[REDACTED]` is unsafe.
  if (![...preferred].some((char) => token.includes(char))) return preferred;
  for (const char of "*#~^|+=%0123456789") {
    if (!token.includes(char)) return char.repeat(3);
  }
  for (let code = 0x2588; code <= 0x10ffff; code += 1) {
    const char = String.fromCodePoint(code);
    if (!token.includes(char)) return char.repeat(3);
  }
  throw new Error("could not build a token-safe redaction marker");
}

export function redact(text, token) {
  if (typeof text !== "string" || !token) return text;
  return text.split(token).join(redactionMarker(token));
}

/**
 * Redact a token anywhere in a parsed JSON value, preserving the shape so
 * machine-readable output stays valid JSON.
 */
export function redactValue(value, token) {
  if (!token) return value;
  if (typeof value === "string") return redact(value, token);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, token));
  if (value !== null && typeof value === "object") {
    const redacted = {};
    const keys = new Set();
    const nextSuffix = new Map();
    for (const [key, item] of Object.entries(value)) {
      const base = redact(key, token);
      let safe = base;
      // Two keys can redact to the same name; suffix rather than drop a field.
      // Remember where this base's search stopped so many collisions stay linear.
      if (keys.has(base)) {
        let n = nextSuffix.get(base) ?? 2;
        // Redact the suffix too: a numeric token must not return through "#2".
        let candidate = redact(`${base}#${n}`, token);
        while (keys.has(candidate)) {
          n += 1;
          candidate = redact(`${base}#${n}`, token);
        }
        safe = candidate;
        nextSuffix.set(base, n + 1);
      }
      keys.add(safe);
      // defineProperty keeps a `__proto__` entry an own field instead of
      // assigning the result's prototype.
      Object.defineProperty(redacted, safe, {
        value: redactValue(item, token),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return redacted;
  }
  return value;
}

/**
 * Append a route beneath the configured deployment prefix. `new URL(path, base)`
 * would discard a prefix such as `https://example.com/coderax`.
 */
function joinRoute(baseUrl, path) {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const target = new URL(`${base}${suffix}`);
  if (target.origin !== new URL(base).origin) {
    throw new CoderaxError("BASE_URL_INVALID", `route ${path} resolves outside the configured origin`);
  }
  return target;
}

function truncate(value, limit = 300) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/**
 * Single-request helper. No retries, no redirects, no cookie jar, and no token
 * in any error string.
 */
export async function request({
  baseUrl,
  token,
  path,
  method = "GET",
  body,
  timeoutMs = 15000,
  accept = "application/json",
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no base URL configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  const target = joinRoute(baseUrl, path);
  const headers = { accept };
  if (token) headers.authorization = `Bearer ${token}`;

  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetchImpl(target, {
      method,
      headers,
      body: payload,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new CoderaxError(
        "REQUEST_TIMEOUT",
        `request to ${target.pathname} timed out after ${timeoutMs}ms`,
      );
    }
    throw new CoderaxError(
      "REQUEST_FAILED",
      redact(`request to ${target.pathname} failed: ${truncate(error?.message ?? "network error")}`, token),
    );
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new CoderaxError("RESPONSE_UNREADABLE", `could not read the response from ${target.pathname}`);
  }

  const fullText = redact(text, token);
  const diagnosticText = redact(text.slice(0, 2000), token);

  let json = null;
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const safeJson = redactValue(json, token);

  if (!response.ok) {
    const detail = safeJson?.message ?? safeJson?.error ?? diagnosticText;
    const message = `HTTP ${response.status} from ${target.pathname}${detail ? `: ${truncate(String(detail))}` : ""}`;
    const failure = new CoderaxError(`HTTP_${response.status}`, message, { status: response.status });
    failure.body = safeJson;
    throw failure;
  }

  return { status: response.status, headers: response.headers, json: safeJson, text: fullText };
}

function parseSseEvent(rawEvent) {
  const dataLines = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) return undefined;
  const data = dataLines.join("\n");
  if (data === "[DONE]" || data === "") return null;
  try {
    return JSON.parse(data);
  } catch {
    return { text: data };
  }
}

function extractDelta(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.text === "string" && payload.message === true) {
    // Legacy ask endpoints resend the whole message; emit the tail only.
    return payload.delta ? String(payload.delta) : "";
  }
  const candidate =
    payload.delta
    ?? payload.token
    ?? payload.content
    ?? payload.choices?.[0]?.delta?.content;
  return typeof candidate === "string" ? candidate : "";
}

function streamFailure(status, text, token, pathname) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const safeJson = redactValue(parsed, token);
  const detail = safeJson?.message ?? safeJson?.error ?? redact(text.slice(0, 200), token);
  const failure = new CoderaxError(
    `HTTP_${status}`,
    `HTTP ${status} from ${pathname}${detail ? `: ${truncate(String(detail))}` : ""}`,
    { status },
  );
  failure.body = safeJson;
  return failure;
}

/**
 * POST a prompt and consume a server-sent-event response. The token is removed
 * from every delta, event payload, and error string before it reaches output.
 */
export async function streamRequest({
  baseUrl,
  token,
  path,
  method = "POST",
  body,
  timeoutMs = 15000,
  signal,
  onEvent,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no base URL configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  const target = joinRoute(baseUrl, path);
  const headers = { accept: "text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;

  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchImpl(target, {
      method,
      headers,
      body: payload,
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw streamFailure(response.status, await response.text(), token, target.pathname);
    }
    if (!response.body) {
      throw new CoderaxError("RESPONSE_UNREADABLE", `the response from ${target.pathname} has no body`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assembled = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE permits CRLF line endings. Normalise after each chunk so a CRLF
      // split across reads still terminates a frame.
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseEvent(rawEvent);
        if (event !== null && event !== undefined) {
          const delta = extractDelta(event);
          if (delta) {
            const safeDelta = redact(delta, token);
            assembled += safeDelta;
            onEvent?.({ type: "delta", text: safeDelta, payload: redactValue(event, token) });
          } else {
            onEvent?.({ type: "event", payload: redactValue(event, token) });
          }
          if (event?.final === true || event?.error) {
            onEvent?.({ type: "final", payload: redactValue(event, token) });
            if (event.error) {
              throw new CoderaxError("STREAM_ERROR", redact(String(event.error), token));
            }
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    return assembled;
  } catch (error) {
    if (error instanceof CoderaxError) throw error;
    if (signal?.aborted) throw new CoderaxError("CANCELLED", "request cancelled");
    const name = error?.name ?? "";
    if (timedOut || name === "TimeoutError" || name === "AbortError") {
      throw new CoderaxError(
        "REQUEST_TIMEOUT",
        `request to ${target.pathname} timed out after ${timeoutMs}ms`,
      );
    }
    throw new CoderaxError(
      "REQUEST_FAILED",
      redact(`request to ${target.pathname} failed: ${truncate(error?.message ?? "network error")}`, token),
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
