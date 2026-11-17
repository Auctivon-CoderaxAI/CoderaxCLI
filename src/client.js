export class CoderaxError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = "CoderaxError";
    this.code = code;
    this.status = status;
  }
}

export function redact(text, token) {
  if (typeof text !== "string" || !token) return text;
  return text.split(token).join("[REDACTED]");
}

/**
 * Redact a token anywhere in a parsed JSON value, preserving the shape so
 * machine-readable output stays valid JSON.
 */
export function redactValue(value, token) {
  if (!token) return value;
  if (typeof value === "string") return value.split(token).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redactValue(item, token));
  if (value !== null && typeof value === "object") {
    const redacted = {};
    const keys = new Set();
    const nextSuffix = new Map();
    for (const [key, item] of Object.entries(value)) {
      const base = key.split(token).join("[REDACTED]");
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

export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
