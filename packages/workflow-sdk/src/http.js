import { SdkError } from "./errors.js";
import { redact, redactValue } from "./redact.js";
import { API_MAJOR, API_VERSION, CLIENT_NAME } from "./contract.js";

/**
 * Append a route beneath the configured deployment prefix. `new URL(path, base)`
 * would discard a prefix such as `https://example.com/coderax`.
 */
export function joinRoute(baseUrl, path) {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const target = new URL(`${base}${suffix}`);
  if (target.origin !== new URL(base).origin) {
    throw new SdkError("BASE_URL_INVALID", `route ${path} resolves outside the configured origin`);
  }
  return target;
}

function truncate(value, limit = 300) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function detailText(value) {
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

function detailFrom(payload, text) {
  if (payload !== null && typeof payload === "object") {
    return detailText(payload.message ?? payload.error ?? payload.detail ?? text);
  }
  return detailText(text);
}

function errorCodeFor(status) {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status === 502 || status === 503 || status === 504) return "UNAVAILABLE";
  return `HTTP_${status}`;
}

export function responseError(status, pathname, body, token) {
  let payload = null;
  if (typeof body === "string" && body.trim() !== "") {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }
  } else if (body !== null && typeof body === "object") {
    payload = body;
  }
  const safePayload = redactValue(payload, token);
  const detail = detailFrom(safePayload, redact(body, token));
  const serverCode =
    safePayload !== null && typeof safePayload === "object"
      ? safePayload.code ?? safePayload.error?.code ?? null
      : null;
  const failure = new SdkError(
    errorCodeFor(status),
    `HTTP ${status} from ${pathname}${detail ? `: ${truncate(detail)}` : ""}`,
    {
      status,
      details: serverCode === null ? null : { serverCode },
      retryable: status === 429 || status === 502 || status === 503 || status === 504,
    },
  );
  failure.body = safePayload;
  return failure;
}

export function parseApiVersion(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const match = /^(\d+)(?:\.(\d+))?/.exec(value.trim());
  if (match === null) return null;
  return { raw: value.trim(), major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

/**
 * Reject a server whose major API version this client does not implement.
 * A missing version is not a mismatch; callers record UNVERIFIED instead.
 */
export function assertCompatibleVersion(value, source) {
  const parsed = parseApiVersion(value);
  if (parsed === null) return null;
  if (parsed.major !== API_MAJOR) {
    throw new SdkError(
      "API_VERSION_UNSUPPORTED",
      `the deployment reports API version ${parsed.raw} (${source}); this client implements ${API_VERSION}.x`,
      { details: { serverVersion: parsed.raw, source } },
    );
  }
  return parsed;
}

function buildHeaders({ token, accept, body, clientVersion, extra }) {
  const headers = {
    accept,
    "x-coderax-api-version": API_VERSION,
    "x-coderax-client": `${CLIENT_NAME}/${clientVersion}`,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return Object.assign(headers, extra ?? {});
}

function networkError(pathname, error, token, timedOut, externalSignal) {
  if (externalSignal?.aborted) {
    return new SdkError("CANCELLED", "request cancelled");
  }
  const name = error?.name ?? "";
  if (timedOut || name === "TimeoutError" || name === "AbortError") {
    return new SdkError("TIMEOUT", `request to ${pathname} timed out`, { retryable: true });
  }
  return new SdkError(
    "NETWORK",
    `request to ${pathname} failed: ${truncate(redact(String(error?.message ?? "network error"), token))}`,
    { retryable: true },
  );
}

export function createTransport({
  baseUrl,
  token,
  timeoutMs = 15000,
  fetchImpl = fetch,
  clientVersion = "0.0.0",
} = {}) {
  if (!baseUrl) {
    throw new SdkError("BASE_URL_REQUIRED", "no deployment URL configured");
  }

  async function json(path, { method = "GET", body, signal, accept = "application/json", headers } = {}) {
    const target = joinRoute(baseUrl, path);
    const displayPath = redact(target.pathname, token);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers: buildHeaders({
          token,
          accept,
          body,
          clientVersion,
          extra: headers,
        }),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      throw networkError(displayPath, error, token, timedOut, signal);
    }

    let text;
    try {
      text = await response.text();
    } catch (error) {
      const name = error?.name ?? "";
      if (timedOut || name === "TimeoutError" || name === "AbortError") {
        throw new SdkError("TIMEOUT", `request to ${displayPath} timed out`, { retryable: true });
      }
      throw new SdkError("RESPONSE_UNREADABLE", `could not read the response from ${displayPath}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    const version = response.headers.get("x-coderax-api-version");
    if (version !== null) assertCompatibleVersion(version, "response header");

    const fullText = redact(text, token);
    let parsed = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    const safeJson = redactValue(parsed, token);

    if (!response.ok) {
      throw responseError(response.status, displayPath, parsed ?? text, token);
    }

    return { status: response.status, headers: response.headers, json: safeJson, text: fullText };
  }

  /**
   * Open an SSE response. The timeout is an idle deadline: the caller calls
   * `touch()` after every chunk, so a healthy long stream is never cut off.
   */
  async function stream(path, { method = "GET", body, signal, headers } = {}) {
    const target = joinRoute(baseUrl, path);
    const displayPath = redact(target.pathname, token);
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;

    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    };
    arm();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers: buildHeaders({
          token,
          accept: "text/event-stream",
          body,
          clientVersion,
          extra: headers,
        }),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      throw networkError(displayPath, error, token, timedOut, signal);
    }

    const version = response.headers.get("x-coderax-api-version");
    if (version !== null) assertCompatibleVersion(version, "response header");

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      let text = "";
      try {
        text = await response.text();
      } catch {
        text = "";
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      throw responseError(response.status, displayPath, text, token);
    }

    if (!contentType.toLowerCase().includes("text/event-stream")) {
      let preview = "";
      try {
        preview = await response.text();
      } catch {
        preview = "";
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      throw new SdkError(
        "CONTRACT_VIOLATION",
        `the deployment answered ${displayPath} with ${contentType || "no content type"}; the contract requires text/event-stream. ` +
          "Streaming chat cannot be rendered from a JSON response.",
        {
          status: response.status,
          details: {
            contentType: contentType || null,
            preview: truncate(redact(preview, token), 300),
          },
        },
      );
    }

    if (!response.body) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      throw new SdkError("RESPONSE_UNREADABLE", `the response from ${displayPath} has no body`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let closed = false;

    return {
      response,
      contentType,
      timedOut: () => timedOut,
      async next() {
        try {
          const result = await reader.read();
          arm();
          return result;
        } catch (error) {
          if (signal?.aborted) throw new SdkError("CANCELLED", "stream cancelled");
          throw networkError(displayPath, error, token, timedOut, signal);
        }
      },
      text(value) {
        return decoder.decode(value, { stream: true });
      },
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        try {
          // `cancel()` returns a promise; a rejected promise here is expected
          // when the peer already reset the socket and must not surface as an
          // unhandled rejection after the caller handled the network error.
          void reader.cancel().catch(() => {});
        } catch {
          // The peer may already be gone.
        }
      },
    };
  }

  return { json, stream, baseUrl, token, timeoutMs };
}
