import { CoderaxError } from "./errors.js";
import { httpRequest, joinRoute } from "./http.js";
import { createRedactor, redact, redactValue } from "./redact.js";

export { CoderaxError, redact, redactValue };

export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Deployment request helper retained for the OpenAPI discovery commands and
 * `coderax call`. Engine traffic goes through `src/engine/client.js`, which
 * validates the versioned contract.
 */
export async function request({
  baseUrl,
  token,
  path,
  method = "GET",
  body,
  timeoutMs = 15_000,
  accept = "application/json",
  includeRaw = false,
  fetchImpl = fetch,
  signal,
} = {}) {
  const response = await httpRequest({
    baseUrl,
    token,
    path,
    method,
    body,
    timeoutMs,
    accept,
    fetchImpl,
    signal,
  });
  return {
    status: response.status,
    headers: response.headers,
    json: response.json,
    rawJson: includeRaw ? response.rawJson : undefined,
    text: response.text,
  };
}

function extractDelta(payload) {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.text === "string" && payload.message === true) {
    return payload.delta ? String(payload.delta) : "";
  }
  const candidate = payload.delta ?? payload.token ?? payload.content ?? payload.choices?.[0]?.delta?.content;
  return typeof candidate === "string" ? candidate : "";
}

/**
 * Legacy deployment SSE reader. It handles both incremental deltas and the
 * cumulative `message: true` snapshots the native Work route emits, and holds
 * back a token prefix so a split secret cannot escape in two pieces.
 */
export async function streamRequest({
  baseUrl,
  token,
  path,
  method = "POST",
  body,
  timeoutMs = 15_000,
  signal,
  onEvent = () => {},
  fetchImpl = fetch,
} = {}) {
  const target = joinRoute(baseUrl, path);
  const displayPath = redact(target.pathname, token);
  const headers = { accept: "text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let response;
  try {
    response = await fetchImpl(target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) throw new CoderaxError("CANCELLED", "request cancelled");
    throw new CoderaxError("REQUEST_FAILED", `request to ${displayPath} failed`);
  }
  if (!response.ok || !response.body) {
    signal?.removeEventListener("abort", onAbort);
    const text = await response.text().catch(() => "");
    throw new CoderaxError(`HTTP_${response.status}`, `HTTP ${response.status} from ${displayPath}${text ? `: ${redact(text.slice(0, 300), token)}` : ""}`, { status: response.status });
  }
  const { parseSseStream } = await import("./http.js");
  const deltaRedactor = createRedactor([token]).stream();
  let assembled = "";
  let lastSnapshot = null;
  try {
    for await (const frame of parseSseStream(response.body)) {
      if (frame.data === "[DONE]") break;
      let payload;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        payload = frame.data;
      }
      let delta = extractDelta(payload);
      if (payload?.message === true && typeof payload.text === "string" && payload.delta == null) {
        const snapshot = payload.text;
        if (lastSnapshot === null || snapshot.startsWith(lastSnapshot)) {
          delta = snapshot.slice(lastSnapshot?.length ?? 0);
        } else {
          assembled = redact(snapshot, token);
          deltaRedactor.reset();
          onEvent({ type: "replace", text: assembled, payload: redactValue(payload, token) });
          delta = "";
        }
        lastSnapshot = snapshot;
      }
      if (delta) {
        const safe = deltaRedactor.push(delta);
        if (safe) {
          assembled += safe;
          onEvent({ type: "delta", text: safe, payload: redactValue(payload, token) });
        }
      } else {
        onEvent({ type: "event", payload: redactValue(payload, token) });
      }
      if (payload?.final === true || payload?.error) {
        const terminal = payload?.responseMessage?.text;
        if (payload?.final === true && typeof terminal === "string") {
          const safe = redact(terminal, token);
          if (safe !== assembled) {
            assembled = safe;
            deltaRedactor.reset();
            onEvent({ type: "replace", text: assembled, payload: redactValue(payload, token) });
          }
        }
        onEvent({ type: "final", payload: redactValue(payload, token) });
        if (payload.error) {
          throw new CoderaxError("STREAM_ERROR", redact(typeof payload.error === "string" ? payload.error : payload.error.message ?? "stream error", token));
        }
      }
    }
    const tail = deltaRedactor.flush();
    if (tail) {
      assembled += tail;
      onEvent({ type: "delta", text: tail });
    }
    return assembled;
  } catch (error) {
    if (error instanceof CoderaxError) throw error;
    if (signal?.aborted) throw new CoderaxError("CANCELLED", "request cancelled");
    throw new CoderaxError("REQUEST_FAILED", `the stream from ${displayPath} failed`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
