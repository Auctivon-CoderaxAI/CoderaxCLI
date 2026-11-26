import {
  CoderaxError,
  errorFromResponse,
  joinRoute,
  parseSseEvent,
  redact,
  request,
} from "./client.js";
import { buildMultipart } from "./file-transfer.js";

/**
 * WorkflowEngine client for the CLI.
 *
 * This is the only module that talks to `/v1`. It follows the shared
 * `@coderax/sdk` contract version (`1.0.0`), owner bearer auth, Problem error
 * bodies, redirect refusal, no retries and no cookie jar. It contains no
 * provider adapter, inference, artifact generation or execution logic: a
 * capability is submitted to the engine and the engine performs the work.
 */

export const ENGINE_CONTRACT_VERSION = "1.0.0";
export const TASK_STATES = Object.freeze([
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);

const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

export function assertArtifactId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!ARTIFACT_ID.test(id) || id.includes("..")) {
    throw new CoderaxError("ARTIFACT_ID_INVALID", `invalid artifact id: ${String(value ?? "")}`);
  }
  return id;
}

export function assertProjectId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!PROJECT_ID.test(id) || id.includes("..")) {
    throw new CoderaxError("PROJECT_ID_INVALID", `invalid project id: ${String(value ?? "")}`);
  }
  return id;
}

export function assertConversationId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!CONVERSATION_ID.test(id) || id.includes("..")) {
    throw new CoderaxError("CONVERSATION_ID_INVALID", `invalid conversation id: ${String(value ?? "")}`);
  }
  return id;
}

function objectBody(response, path) {
  if (response.json === null || typeof response.json !== "object" || Array.isArray(response.json)) {
    throw new CoderaxError("ENGINE_RESPONSE_INVALID", `${path} did not return a JSON object`);
  }
  return response.json;
}

function requireString(value, field, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CoderaxError("ENGINE_RESPONSE_INVALID", `${path} omitted ${field}`);
  }
  return value;
}

function requireInteger(value, field, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CoderaxError("ENGINE_RESPONSE_INVALID", `${path} returned an invalid ${field}`);
  }
  return value;
}

function normalizeTask(payload, path) {
  const taskId = requireString(payload.taskId, "taskId", path);
  const state = TASK_STATES.includes(payload.state) ? payload.state : null;
  if (state === null) {
    throw new CoderaxError("ENGINE_RESPONSE_INVALID", `${path} returned an unknown task state`);
  }
  return {
    ...payload,
    taskId,
    state,
    generation: Number.isSafeInteger(payload.generation) ? payload.generation : 0,
  };
}

function withQuery(path, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && String(value) !== "") {
      params.set(key, String(value));
    }
  }
  const search = params.toString();
  return search === "" ? path : `${path}?${search}`;
}

export function createWorkflowClient({
  baseUrl,
  token,
  timeoutMs = 15000,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no deployment configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  const common = { baseUrl, token, timeoutMs, fetchImpl, signal };

  return {
    baseUrl,
    contractVersion: ENGINE_CONTRACT_VERSION,

    async capabilities() {
      return request({ ...common, path: "/v1/capabilities" });
    },

    async readiness() {
      const response = await request({ ...common, path: "/v1/ready" });
      return { response, body: objectBody(response, "/v1/ready") };
    },

    async health() {
      const response = await request({ ...common, path: "/v1/health" });
      return { response, body: objectBody(response, "/v1/health") };
    },

    async executeCapability({ capabilityId, inputs, projectId, conversationId, wait = true }) {
      const id = String(capabilityId ?? "").trim();
      if (!/^[a-z][a-z0-9._-]{0,79}$/.test(id)) {
        throw new CoderaxError("CAPABILITY_ID_INVALID", `invalid capability id: ${id}`);
      }
      const project = projectId ? assertProjectId(projectId) : undefined;
      const conversation = conversationId ? assertConversationId(conversationId) : undefined;
      const body = {
        capabilityId: id,
        inputs,
        ...(project ? { projectId: project } : {}),
        ...(conversation ? { conversationId: conversation } : {}),
        wait: wait === true,
      };
      const path = `/v1/capabilities/${encodeURIComponent(id)}/execute`;
      const response = await request({
        ...common,
        method: "POST",
        path,
        body,
        // Submission is quick; the task itself is polled or streamed.
      });
      const payload = objectBody(response, path);
      return normalizeTask(payload, path);
    },

    /**
     * Upload an inspected file. The engine must echo the same byte count and
     * SHA-256, so a truncated or altered transfer cannot become a reference.
     */
    async uploadFile({ file, projectId, conversationId }) {
      if (!file || !Buffer.isBuffer(file.buffer)) {
        throw new CoderaxError("UPLOAD_INVALID", "inspect the file before uploading it");
      }
      const fields = {
        sha256: file.sha256,
        bytes: String(file.bytes),
        mimeType: file.mimeType,
        ...(projectId ? { projectId: assertProjectId(projectId) } : {}),
        ...(conversationId ? { conversationId: assertConversationId(conversationId) } : {}),
      };
      const multipart = buildMultipart({ file, fields });
      const path = "/v1/files";
      const response = await request({
        ...common,
        method: "POST",
        path,
        rawBody: multipart.body,
        headers: {
          "content-type": multipart.contentType,
          "x-content-sha256": file.sha256,
        },
        timeoutMs: Math.max(timeoutMs, 120000),
      });
      const payload = objectBody(response, path);
      const uploadId = requireString(payload.uploadId ?? payload.id, "uploadId", path);
      const bytes = Number(payload.bytes);
      const sha256 = typeof payload.sha256 === "string" ? payload.sha256.toLowerCase() : "";
      if (bytes !== file.bytes) {
        throw new CoderaxError(
          "UPLOAD_INTEGRITY_FAILED",
          `the engine accepted ${Number.isFinite(bytes) ? bytes : "an unknown number of"} bytes; ${file.bytes} were sent`,
        );
      }
      if (sha256 !== file.sha256) {
        throw new CoderaxError(
          "UPLOAD_INTEGRITY_FAILED",
          "the engine did not echo the uploaded file's SHA-256 digest",
        );
      }
      return {
        uploadId,
        name: typeof payload.name === "string" ? payload.name : file.name,
        bytes,
        sha256: file.sha256,
        mimeType: typeof payload.mimeType === "string" ? payload.mimeType : file.mimeType,
        ...(typeof payload.expiresAt === "string" ? { expiresAt: payload.expiresAt } : {}),
      };
    },

    async task(taskId) {
      const id = requireString(taskId, "taskId", "task");
      const path = `/v1/work/${encodeURIComponent(id)}`;
      const response = await request({ ...common, path });
      return normalizeTask(objectBody(response, path), path);
    },

    /**
     * Replay and tail execution events. Duplicate event ids and a sequence at or
     * below the cursor are ignored, as the engine contract requires.
     */
    async *events({ taskId, after = 0, signal: extraSignal } = {}) {
      const id = requireString(taskId, "taskId", "events");
      const path = `/v1/work/${encodeURIComponent(id)}/events`;
      const target = joinRoute(baseUrl, withQuery(path, { after }));
      const displayPath = redact(target.pathname, token);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      extraSignal?.addEventListener("abort", onAbort, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      let timer;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      };
      arm();

      try {
        const response = await fetchImpl(target, {
          method: "GET",
          headers: {
            accept: "text/event-stream",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw errorFromResponse({
            response,
            text: await response.text(),
            token,
            path: displayPath,
          });
        }
        if (!response.body) {
          throw new CoderaxError("ENGINE_RESPONSE_INVALID", `${displayPath} returned no event stream`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastSeq = Number.isSafeInteger(after) ? after : 0;
        const seen = new Set();
        for (;;) {
          const { value, done } = await reader.read();
          arm();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const parsed = parseSseEvent(frame);
            if (parsed !== null && parsed !== undefined && typeof parsed === "object") {
              const eventId = typeof parsed.eventId === "string" ? parsed.eventId : null;
              const seq = Number.isSafeInteger(parsed.seq) ? parsed.seq : null;
              const duplicate = (eventId !== null && seen.has(eventId)) || (seq !== null && seq <= lastSeq);
              if (!duplicate) {
                if (eventId !== null) seen.add(eventId);
                if (seq !== null) lastSeq = seq;
                yield { ...parsed, seq: seq ?? lastSeq };
                if (
                  parsed.final === true ||
                  ["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(
                    parsed.type,
                  )
                ) {
                  return;
                }
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (error instanceof CoderaxError) throw error;
        if (extraSignal?.aborted || signal?.aborted) {
          throw new CoderaxError("CANCELLED", "event stream cancelled");
        }
        if (timedOut || error?.name === "TimeoutError" || error?.name === "AbortError") {
          throw new CoderaxError(
            "REQUEST_TIMEOUT",
            `the event stream from ${displayPath} was idle for ${timeoutMs}ms`,
          );
        }
        throw new CoderaxError(
          "REQUEST_FAILED",
          `the event stream from ${displayPath} failed: ${redact(String(error?.message ?? "network error"), token)}`,
        );
      } finally {
        clearTimeout(timer);
        controller.abort();
        extraSignal?.removeEventListener("abort", onAbort);
        signal?.removeEventListener("abort", onAbort);
      }
    },

    async listArtifacts({ projectId, conversationId, taskId, limit } = {}) {
      const path = withQuery("/v1/artifacts", {
        projectId: projectId ? assertProjectId(projectId) : undefined,
        conversationId: conversationId ? assertConversationId(conversationId) : undefined,
        taskId,
        limit,
      });
      const response = await request({ ...common, path });
      const payload = objectBody(response, "/v1/artifacts");
      if (!Array.isArray(payload.artifacts)) {
        throw new CoderaxError("ENGINE_RESPONSE_INVALID", "/v1/artifacts did not return an artifacts array");
      }
      return payload.artifacts;
    },

    async inspectArtifact(artifactId) {
      const id = assertArtifactId(artifactId);
      const path = `/v1/artifacts/${encodeURIComponent(id)}`;
      const response = await request({ ...common, path });
      return objectBody(response, path);
    },

    async associateArtifact(artifactId, projectId) {
      const id = assertArtifactId(artifactId);
      const project = assertProjectId(projectId);
      const path = `/v1/artifacts/${encodeURIComponent(id)}/project`;
      const response = await request({
        ...common,
        method: "POST",
        path,
        body: { projectId: project },
      });
      return objectBody(response, path);
    },

    /** Return the raw content response so the caller can hash it while writing. */
    async artifactContent(artifactId, { signal: extraSignal } = {}) {
      const id = assertArtifactId(artifactId);
      const path = `/v1/artifacts/${encodeURIComponent(id)}/content`;
      const target = joinRoute(baseUrl, path);
      let response;
      try {
        response = await fetchImpl(target, {
          method: "GET",
          headers: {
            accept: "application/octet-stream",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          redirect: "error",
          // A large artifact may legitimately take longer than the per-request
          // control timeout; downloads keep a bounded five-minute ceiling.
          signal: extraSignal ?? signal ?? AbortSignal.timeout(Math.max(timeoutMs, 300000)),
        });
      } catch (error) {
        if (extraSignal?.aborted || signal?.aborted) {
          throw new CoderaxError("CANCELLED", "artifact download cancelled");
        }
        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
          throw new CoderaxError("REQUEST_TIMEOUT", "the artifact download timed out");
        }
        throw new CoderaxError(
          "REQUEST_FAILED",
          `the artifact download failed: ${redact(String(error?.message ?? "network error"), token)}`,
        );
      }
      if (!response.ok) {
        throw errorFromResponse({
          response,
          text: await response.text(),
          token,
          path: redact(target.pathname, token),
        });
      }
      if (!response.body) {
        throw new CoderaxError("ENGINE_RESPONSE_INVALID", "the artifact download had no body");
      }
      return response;
    },
  };
}
