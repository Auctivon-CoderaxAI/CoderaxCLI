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

function detailText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    if (typeof value.detail === "string") return value.detail;
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
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
  includeRaw = false,
  responseType = "json",
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no base URL configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  const target = joinRoute(baseUrl, path);
  const displayPath = redact(target.pathname, token);
  const headers = { accept };
  if (token) headers.authorization = `Bearer ${token}`;

  let payload;
  if (body !== undefined) {
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      // fetch sets the multipart boundary itself; a manual content-type would
      // omit it and the server could not parse the upload.
      payload = body;
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
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
        `request to ${displayPath} timed out after ${timeoutMs}ms`,
      );
    }
    throw new CoderaxError(
      "REQUEST_FAILED",
      `request to ${displayPath} failed: ${truncate(redact(String(error?.message ?? "network error"), token))}`,
    );
  }

  if (responseType === "buffer") {
    let buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const name = error?.name ?? "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new CoderaxError(
          "REQUEST_TIMEOUT",
          `request to ${displayPath} timed out after ${timeoutMs}ms`,
        );
      }
      throw new CoderaxError("RESPONSE_UNREADABLE", `could not read the response from ${displayPath}`);
    }
    if (!response.ok) {
      const text = buffer.toString("utf8").slice(0, 2000);
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const safeJson = redactValue(parsed, token);
      const detail = detailText(safeJson?.message ?? safeJson?.error ?? redact(text, token));
      const message = `HTTP ${response.status} from ${displayPath}${detail ? `: ${truncate(detail)}` : ""}`;
      const failure = new CoderaxError(`HTTP_${response.status}`, message, { status: response.status });
      failure.body = safeJson;
      throw failure;
    }
    return { status: response.status, headers: response.headers, json: null, text: "", buffer };
  }

  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    const name = error?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new CoderaxError(
        "REQUEST_TIMEOUT",
        `request to ${displayPath} timed out after ${timeoutMs}ms`,
      );
    }
    throw new CoderaxError("RESPONSE_UNREADABLE", `could not read the response from ${displayPath}`);
  }

  const fullText = redact(text, token);
  const diagnosticText = fullText.slice(0, 2000);

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
    const detail = detailText(safeJson?.message ?? safeJson?.error ?? diagnosticText);
    const message = `HTTP ${response.status} from ${displayPath}${detail ? `: ${truncate(detail)}` : ""}`;
    const failure = new CoderaxError(`HTTP_${response.status}`, message, { status: response.status });
    failure.body = safeJson;
    throw failure;
  }

  const result = { status: response.status, headers: response.headers, json: safeJson, text: fullText };
  // Discovery needs the original route keys to issue requests. This field is
  // opt-in so ordinary output never receives an unredacted document.
  if (includeRaw) result.rawJson = json;
  return result;
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
    return { text: data, raw: true };
  }
}

function extractDelta(payload) {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  if (payload.raw === true && typeof payload.text === "string") return payload.text;
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

/**
 * Hold back a suffix that could be the beginning of a token, so a token split
 * across SSE deltas is redacted as a whole instead of leaking in two pieces.
 */
class StreamTextRedactor {
  constructor(token) {
    this.token = token || "";
    this.pending = "";
  }

  push(text) {
    if (!this.token) return text;
    this.pending += text;
    // A complete token takes precedence over a suffix that also looks like a
    // prefix, so overlapping tokens such as "aba" in "ab" + "a" are caught.
    const complete = this.pending.lastIndexOf(this.token);
    const emit = complete === -1 ? "" : this.pending.slice(0, complete + this.token.length);
    const remainder = complete === -1 ? this.pending : this.pending.slice(complete + this.token.length);
    let hold = 0;
    const max = Math.min(this.token.length - 1, remainder.length);
    for (let length = max; length > 0; length -= 1) {
      if (this.token.startsWith(remainder.slice(-length))) {
        hold = length;
        break;
      }
    }
    const safe = emit + remainder.slice(0, remainder.length - hold);
    this.pending = remainder.slice(remainder.length - hold);
    return redact(safe, this.token);
  }

  reset() {
    this.pending = "";
  }

  flush() {
    if (!this.token) return "";
    const tail = redact(this.pending, this.token);
    this.pending = "";
    return tail;
  }
}

function applySafeDelta(payload, delta, safeDelta) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  for (const field of ["delta", "token", "content"]) {
    if (typeof payload[field] === "string" && payload[field] === delta) payload[field] = safeDelta;
  }
  if (typeof payload.text === "string" && payload.text === delta) payload.text = safeDelta;
  const choice = payload.choices?.[0]?.delta;
  if (choice !== null && typeof choice === "object" && typeof choice.content === "string" && choice.content === delta) {
    choice.content = safeDelta;
  }
  return payload;
}

function streamFailure(status, text, token, pathname) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const safeJson = redactValue(parsed, token);
  const detail = detailText(safeJson?.message ?? safeJson?.error ?? redact(text, token).slice(0, 200));
  const failure = new CoderaxError(
    `HTTP_${status}`,
    `HTTP ${status} from ${pathname}${detail ? `: ${truncate(detail)}` : ""}`,
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
  const displayPath = redact(target.pathname, token);
  const headers = { accept: "text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;

  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer;
  // The timeout is an idle deadline: it covers connection setup and the wait
  // for each next chunk, not the total duration of a healthy stream.
  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  armTimer();
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
      throw streamFailure(response.status, await response.text(), token, displayPath);
    }
    if (!response.body) {
      throw new CoderaxError("RESPONSE_UNREADABLE", `the response from ${displayPath} has no body`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const deltaRedactor = new StreamTextRedactor(token);
    let buffer = "";
    let assembled = "";
    let lastMessageSnapshot = null;
    armTimer();

    while (true) {
      const { value, done } = await reader.read();
      armTimer();
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
          let delta = extractDelta(event);
          // Native Work sends the full response text after every delta, not a
          // delta field. Emit only the unseen suffix; never echo the full snapshot.
          if (event?.message === true && typeof event.text === "string" && event.delta == null) {
            const snapshot = event.text;
            if (lastMessageSnapshot === null || snapshot.startsWith(lastMessageSnapshot)) {
              delta = snapshot.slice(lastMessageSnapshot?.length ?? 0);
            } else {
              // A text_replace event rewrites the answer rather than appending.
              // The returned answer must reflect that revision, not stale text.
              assembled = redact(snapshot, token);
              deltaRedactor.reset();
              onEvent?.({ type: "replace", text: assembled, payload: redactValue(event, token) });
              delta = "";
            }
            lastMessageSnapshot = snapshot;
          }
          if (delta) {
            const safeDelta = deltaRedactor.push(delta);
            if (safeDelta) {
              assembled += safeDelta;
              const payload = typeof event === "string"
                ? safeDelta
                : applySafeDelta(redactValue(event, token), delta, safeDelta);
              onEvent?.({ type: "delta", text: safeDelta, payload });
            }
          } else {
            onEvent?.({ type: "event", payload: redactValue(event, token) });
          }
          if (event?.final === true || event?.error) {
            // The final persisted response is authoritative, including if the
            // engine rewrote its answer before completion.
            const terminalText = event?.responseMessage?.text;
            if (event?.final === true && typeof terminalText === "string") {
              const safeTerminalText = redact(terminalText, token);
              if (safeTerminalText !== assembled) {
                assembled = safeTerminalText;
                deltaRedactor.reset();
                onEvent?.({ type: "replace", text: assembled, payload: redactValue(event, token) });
              }
            }
            onEvent?.({ type: "final", payload: redactValue(event, token) });
            if (event.error) {
              throw new CoderaxError("STREAM_ERROR", redact(detailText(event.error) || "stream error", token));
            }
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    const tail = deltaRedactor.flush();
    if (tail) {
      assembled += tail;
      onEvent?.({ type: "delta", text: tail });
    }

    return assembled;
  } catch (error) {
    if (error instanceof CoderaxError) throw error;
    if (signal?.aborted) throw new CoderaxError("CANCELLED", "request cancelled");
    const name = error?.name ?? "";
    if (timedOut || name === "TimeoutError" || name === "AbortError") {
      throw new CoderaxError(
        "REQUEST_TIMEOUT",
        `request to ${displayPath} timed out after ${timeoutMs}ms`,
      );
    }
    throw new CoderaxError(
      "REQUEST_FAILED",
      `request to ${displayPath} failed: ${truncate(redact(String(error?.message ?? "network error"), token))}`,
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener("abort", onAbort);
  }
}

export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
