export class CoderaxError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = "CoderaxError";
    this.code = code;
    this.status = status;
  }
}

function redactionMarkerFor(secrets) {
  const combined = secrets.join("");
  const preferred = "[REDACTED]";
  // A marker that shares any character with a secret can form the secret
  // across a replacement boundary, so require a disjoint alphabet. Short
  // tokens such as "E" are the common case where `[REDACTED]` is unsafe. One
  // marker is chosen for every secret so replacing one secret cannot create
  // another across a marker boundary.
  if (![...preferred].some((char) => combined.includes(char))) return preferred;
  for (const char of "*#~^|+=%0123456789") {
    if (!combined.includes(char)) return char.repeat(3);
  }
  for (let code = 0x2588; code <= 0x10ffff; code += 1) {
    const char = String.fromCodePoint(code);
    if (!combined.includes(char)) return char.repeat(3);
  }
  throw new Error("could not build a token-safe redaction marker");
}

function secretsFrom(token) {
  const values = Array.isArray(token) ? token : [token];
  return [...new Set(
    values.filter((value) => typeof value === "string" && value.length > 0),
  )];
}

export function redact(text, token) {
  const secrets = secretsFrom(token);
  if (typeof text !== "string" || secrets.length === 0) return text;
  const marker = redactionMarkerFor(secrets);
  let result = text;
  for (const secret of secrets) result = result.split(secret).join(marker);
  return result;
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
  form,
  timeoutMs = 15000,
  accept = "application/json",
  includeRaw = false,
  secrets,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no base URL configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  const secretList = secretsFrom([token, ...(Array.isArray(secrets) ? secrets : [secrets])]);
  const target = joinRoute(baseUrl, path);
  const displayPath = redact(target.pathname, secretList);
  const headers = { accept };
  if (token) headers.authorization = `Bearer ${token}`;

  let payload;
  if (form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    const encoded = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value !== undefined && value !== null) encoded.set(key, String(value));
    }
    payload = encoded.toString();
  } else if (body !== undefined) {
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
        `request to ${displayPath} timed out after ${timeoutMs}ms`,
      );
    }
    throw new CoderaxError(
      "REQUEST_FAILED",
      `request to ${displayPath} failed: ${truncate(redact(String(error?.message ?? "network error"), secretList))}`,
    );
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

  const fullText = redact(text, secretList);
  const diagnosticText = fullText.slice(0, 2000);

  let json = null;
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const safeJson = redactValue(json, secretList);

  if (!response.ok) {
    const detail = detailText(safeJson?.message ?? safeJson?.error ?? diagnosticText);
    const message = `HTTP ${response.status} from ${displayPath}${detail ? `: ${truncate(detail)}` : ""}`;
    const failure = new CoderaxError(`HTTP_${response.status}`, message, { status: response.status });
    failure.body = safeJson;
    // Internal callers need the unredacted OAuth error code (for example
    // authorization_pending). This field is never printed; all user-facing
    // text above is redacted.
    failure.rawJson = json;
    failure.wwwAuthenticate = response.headers.get("www-authenticate");
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
  constructor(secrets) {
    this.secrets = secretsFrom(secrets);
    this.pending = "";
  }

  push(text) {
    if (this.secrets.length === 0) return text;
    this.pending += text;
    // Emit through the last complete secret occurrence. A suffix that could
    // begin any secret is held back, so secrets split across deltas are caught.
    let boundary = 0;
    for (const secret of this.secrets) {
      const complete = this.pending.lastIndexOf(secret);
      if (complete !== -1) boundary = Math.max(boundary, complete + secret.length);
    }
    const emit = this.pending.slice(0, boundary);
    const remainder = this.pending.slice(boundary);
    let hold = 0;
    for (let length = remainder.length; length > 0; length -= 1) {
      const suffix = remainder.slice(-length);
      if (this.secrets.some((secret) => secret.startsWith(suffix))) {
        hold = length;
        break;
      }
    }
    const safe = emit + remainder.slice(0, remainder.length - hold);
    this.pending = remainder.slice(remainder.length - hold);
    return redact(safe, this.secrets);
  }

  reset() {
    this.pending = "";
  }

  flush() {
    const tail = redact(this.pending, this.secrets);
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

function streamFailure(status, text, secrets, pathname, headers) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const safeJson = redactValue(parsed, secrets);
  const detail = detailText(safeJson?.message ?? safeJson?.error ?? redact(text, secrets).slice(0, 200));
  const failure = new CoderaxError(
    `HTTP_${status}`,
    `HTTP ${status} from ${pathname}${detail ? `: ${truncate(detail)}` : ""}`,
    { status },
  );
  failure.body = safeJson;
  failure.rawJson = parsed;
  failure.wwwAuthenticate = headers?.get?.("www-authenticate") ?? null;
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
  secrets,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no base URL configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  const secretList = secretsFrom([token, ...(Array.isArray(secrets) ? secrets : [secrets])]);
  const target = joinRoute(baseUrl, path);
  const displayPath = redact(target.pathname, secretList);
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
      throw streamFailure(response.status, await response.text(), secretList, displayPath, response.headers);
    }
    if (!response.body) {
      throw new CoderaxError("RESPONSE_UNREADABLE", `the response from ${displayPath} has no body`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const deltaRedactor = new StreamTextRedactor(secretList);
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
              assembled = redact(snapshot, secretList);
              deltaRedactor.reset();
              onEvent?.({ type: "replace", text: assembled, payload: redactValue(event, secretList) });
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
                : applySafeDelta(redactValue(event, secretList), delta, safeDelta);
              onEvent?.({ type: "delta", text: safeDelta, payload });
            }
          } else {
            onEvent?.({ type: "event", payload: redactValue(event, secretList) });
          }
          if (event?.final === true || event?.error) {
            // The final persisted response is authoritative, including if the
            // engine rewrote its answer before completion.
            const terminalText = event?.responseMessage?.text;
            if (event?.final === true && typeof terminalText === "string") {
              const safeTerminalText = redact(terminalText, secretList);
              if (safeTerminalText !== assembled) {
                assembled = safeTerminalText;
                deltaRedactor.reset();
                onEvent?.({ type: "replace", text: assembled, payload: redactValue(event, secretList) });
              }
            }
            onEvent?.({ type: "final", payload: redactValue(event, secretList) });
            if (event.error) {
              throw new CoderaxError("STREAM_ERROR", redact(detailText(event.error) || "stream error", secretList));
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
      `request to ${displayPath} failed: ${truncate(redact(String(error?.message ?? "network error"), secretList))}`,
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
