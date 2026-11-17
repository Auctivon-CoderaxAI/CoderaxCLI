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
  const target = new URL(path.startsWith("/") ? path : `/${path}`, `${baseUrl}/`);
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

  const safeText = redact(text.slice(0, 2000), token);
  let json = null;
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const detail = json?.message ?? json?.error ?? safeText;
    const message = `HTTP ${response.status} from ${target.pathname}${detail ? `: ${truncate(redact(String(detail), token))}` : ""}`;
    const failure = new CoderaxError(`HTTP_${response.status}`, message, { status: response.status });
    failure.body = json;
    throw failure;
  }

  return { status: response.status, headers: response.headers, json, text: safeText };
}

export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
