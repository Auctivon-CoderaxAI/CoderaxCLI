/**
 * The single WorkflowEngine adapter.
 *
 * Transport, payload validation, event framing and artifact decoding come from
 * the canonical `@coderax/sdk@1.1.0` package published by
 * `Auctivon-CoderaxAI/Coderax-WorkflowEngine` on `contract/authoritative-v1.1`
 * (see `vendor/PROVENANCE.md`). This module adds only client policy the SDK
 * deliberately leaves out:
 *
 * - negotiation is performed once per invocation and never guessed;
 * - a capability is resolved from the handshake before a request is made;
 * - a file-bearing Work task uploads its attachment immediately after the task
 *   is accepted and cancels the task if that upload fails;
 * - waiting is bounded by an owner deadline and distinguishes a local wait
 *   timeout from engine cancellation;
 * - errors are translated into the CLI's stable codes once, at the boundary.
 *
 * It does not plan, execute, infer, render documents or generate artifacts.
 */

import {
  CoderaxApiError,
  CoderaxClient,
  CoderaxCompatibilityError,
  CoderaxContractError,
  SDK_CONTRACT_VERSION,
  SDK_COVERAGE,
  SDK_EVENT_SCHEMA_VERSION,
  SDK_MANIFEST,
  SDK_VERSION,
} from "@coderax/sdk";
import { CoderaxError } from "./client.js";

export const ENGINE = Object.freeze({
  sdkVersion: SDK_VERSION,
  contractVersion: SDK_CONTRACT_VERSION,
  eventSchemaVersion: SDK_EVENT_SCHEMA_VERSION,
  operations: Object.freeze(Object.keys(SDK_COVERAGE)),
  streams: Object.freeze(SDK_MANIFEST.streams),
});

export const TERMINAL_TASK_STATES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const TASK_STATES = Object.freeze([
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalTaskState(state) {
  return TERMINAL_TASK_STATES.includes(state);
}

/** A method name the canonical SDK exposes for a published operation. */
export function sdkMethodFor(operationId) {
  return SDK_COVERAGE[operationId] ?? null;
}

export function createEngineClient({ baseUrl, token, timeoutMs = 30000, fetchImpl = fetch, signal } = {}) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no deployment configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  if (typeof token !== "string" || token.trim() === "") {
    throw new CoderaxError("UNAUTHENTICATED", "not signed in; run `coderax login` first");
  }
  return new CoderaxClient({ baseUrl, token, timeoutMs, fetchImpl, signal });
}

/**
 * Fetch the handshake and prove compatibility. The SDK validates the document
 * against the published schema and then compares contract, event and SDK
 * versions; a mismatch is a compatibility error, never a warning.
 */
export async function negotiate(client) {
  try {
    const handshake = await client.negotiate();
    return handshake;
  } catch (error) {
    throw translateError(error);
  }
}

/** Operations the engine publishes that this SDK has no method for. */
export function coverageGaps(handshake) {
  const gaps = [];
  for (const operation of handshake.operations ?? []) {
    if (!Object.hasOwn(SDK_COVERAGE, operation.operationId)) {
      gaps.push(operation.operationId);
    }
  }
  return gaps;
}

/**
 * Owner authorization is enforced by the engine. The cheapest owner-only read
 * is the agent list: a 401/403 proves the token is not owner-authorized, and a
 * success proves the deployment accepted it for owner operations.
 */
export async function verifyOwner(client) {
  try {
    return await client.agents();
  } catch (error) {
    throw translateError(error);
  }
}

export async function listAgentsOrNull(client) {
  try {
    return await client.agents();
  } catch (error) {
    const translated = translateError(error);
    if (translated.code === "UNAUTHENTICATED" || translated.code === "NOT_FOUND") return null;
    if (translated.status === 503) return null;
    throw translated;
  }
}

/** The cheapest authoritative read used by readiness output. */
export async function engineHealth(client) {
  try {
    const [health, handshake] = await Promise.all([client.health(), client.handshake()]);
    // A not-ready deployment answers /v1/ready with a report and a non-2xx
    // status; that is a readiness fact, not a transport failure.
    let readiness = null;
    let readinessError = null;
    try {
      readiness = await client.readiness();
    } catch (error) {
      readinessError = translateError(error).message;
    }
    return { health, readiness, readinessError, handshake };
  } catch (error) {
    throw translateError(error);
  }
}

export async function submitWork(client, request) {
  try {
    return await client.submitWork(request);
  } catch (error) {
    throw translateError(error);
  }
}

export async function getTask(client, taskId) {
  try {
    return await client.task(taskId);
  } catch (error) {
    throw translateError(error);
  }
}

export async function cancelTask(client, taskId, reason) {
  try {
    return await client.cancel(taskId, reason);
  } catch (error) {
    throw translateError(error);
  }
}

export async function listTasks(client, options = {}) {
  try {
    return await client.tasks(options);
  } catch (error) {
    throw translateError(error);
  }
}

export async function listArtifacts(client, taskId) {
  try {
    return await client.artifacts(taskId);
  } catch (error) {
    throw translateError(error);
  }
}

export async function getArtifact(client, artifactId) {
  try {
    return await client.artifact(artifactId);
  } catch (error) {
    throw translateError(error);
  }
}

export async function artifactContent(client, artifactId) {
  try {
    return await client.artifactContent(artifactId);
  } catch (error) {
    throw translateError(error);
  }
}

/** Upload validated bytes to the task that owns them; the engine computes the digest. */
export async function uploadArtifact(client, taskId, request) {
  try {
    return await client.uploadArtifact(taskId, request);
  } catch (error) {
    throw translateError(error);
  }
}

export async function listSchedules(client) {
  try {
    return await client.schedules();
  } catch (error) {
    throw translateError(error);
  }
}

export async function createSchedule(client, request) {
  try {
    return await client.createSchedule(request);
  } catch (error) {
    throw translateError(error);
  }
}

export async function getSchedule(client, scheduleId) {
  try {
    return await client.schedule(scheduleId);
  } catch (error) {
    throw translateError(error);
  }
}

export async function cancelSchedule(client, scheduleId) {
  try {
    return await client.cancelSchedule(scheduleId);
  } catch (error) {
    throw translateError(error);
  }
}

export async function listPendingPermissions(client) {
  try {
    return await client.pendingPermissions();
  } catch (error) {
    throw translateError(error);
  }
}

export async function decidePermission(client, taskId, request) {
  try {
    return await client.decidePermission(taskId, request);
  } catch (error) {
    throw translateError(error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

function retryable(error) {
  if (!(error instanceof CoderaxError)) return false;
  if (error.code === "CANCELLED" || error.code === "CONTRACT_INCOMPATIBLE") return false;
  if (error.code === "UNAUTHENTICATED" || error.code === "NOT_FOUND") return false;
  if (error.code === "REQUEST_REJECTED" || error.code === "CONFLICT") return false;
  if (error.retryable === true) return true;
  return ["NETWORK", "REQUEST_TIMEOUT", "UNAVAILABLE", "SERVER_ERROR"].includes(error.code);
}

/**
 * Wait for a durable task.
 *
 * Progress uses the published event stream when the deployment implements it and
 * falls back to polling only when that operation is absent. A dropped stream is
 * resumed from the last applied sequence, never replayed blindly. The local
 * deadline is reported as WAIT_TIMEOUT with the authoritative state, which is
 * distinct from the owner cancelling the task.
 */
export async function followTask(client, task, options = {}) {
  const { signal, deadline = Number.POSITIVE_INFINITY } = options;
  const watchdog = new AbortController();
  const remaining = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : null;
  const timer = remaining === null ? null : setTimeout(() => watchdog.abort(), remaining);
  timer?.unref?.();
  const combined = signal === undefined ? watchdog.signal : AbortSignal.any([signal, watchdog.signal]);
  try {
    return await followInner(client, task, { ...options, signal: combined });
  } catch (error) {
    const translated = translateError(error);
    if (signal?.aborted) {
      throw new CoderaxError(
        "CANCELLED",
        `stopped waiting for task ${task.taskId}; the task continues on the engine`,
        { details: { taskId: task.taskId } },
      );
    }
    if (watchdog.signal.aborted) {
      const state = translated.details?.state ?? "still running";
      throw new CoderaxError(
        "WAIT_TIMEOUT",
        `task ${task.taskId} did not finish before the wait limit (${state}); it continues on the engine. ` +
          `Reattach with 'coderax task ${task.taskId}' or cancel it explicitly.`,
        { details: { taskId: task.taskId, lastSeq: translated.details?.lastSeq ?? null } },
      );
    }
    throw translated;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function followInner(
  client,
  task,
  {
    onEvent,
    onTask,
    signal,
    deadline = Number.POSITIVE_INFINITY,
    pollMs = 1000,
    maxRetries = 4,
    stream = true,
  } = {},
) {
  const taskId = task.taskId;
  let cursor = 0;
  let events = 0;
  let attempt = 0;
  let streaming = stream;
  let lastTask = task;
  const delivered = new Set();

  const apply = async (event) => {
    if (event === null || typeof event !== "object") return;
    if (typeof event.seq === "number") {
      if (event.seq <= cursor) return;
      cursor = event.seq;
    }
    if (typeof event.eventId === "string") {
      if (delivered.has(event.eventId)) return;
      delivered.add(event.eventId);
    }
    events += 1;
    await onEvent?.(event, lastTask);
  };

  for (;;) {
    if (signal?.aborted) {
      throw new CoderaxError("CANCELLED", `stopped waiting for task ${taskId}`);
    }

    if (streaming) {
      try {
        const opened = await client.openEvents(taskId, {
          ...(cursor > 0 ? { after: cursor } : {}),
          signal,
        });
        if (opened.truncated) {
          await onEvent?.(
            { type: "stream.truncated", seq: cursor, at: new Date().toISOString() },
            lastTask,
          );
        }
        for await (const event of opened.events) {
          await apply(event);
        }
        attempt = 0;
      } catch (error) {
        const translated = translateError(error);
        if (translated.code === "NOT_FOUND") {
          // The deployment does not implement the event stream; poll instead.
          streaming = false;
        } else if (retryable(translated) && attempt < maxRetries) {
          attempt += 1;
          await sleep(Math.min(5000, 250 * 2 ** attempt));
        } else if (!retryable(translated)) {
          throw translated;
        } else {
          throw translated;
        }
      }
    }

    try {
      lastTask = await getTask(client, taskId);
      await onTask?.(lastTask);
    } catch (error) {
      const translated = translateError(error);
      if (retryable(translated) && attempt < maxRetries) {
        attempt += 1;
        await sleep(Math.min(5000, 250 * 2 ** attempt));
        continue;
      }
      throw translated;
    }

    if (isTerminalTaskState(lastTask.state)) {
      return { task: lastTask, events, lastSeq: cursor, streamed: streaming };
    }
    if (Date.now() >= deadline) {
      throw new CoderaxError(
        "WAIT_TIMEOUT",
        `task ${taskId} is still ${lastTask.state} after the wait limit; it continues on the engine. ` +
          `Reattach with 'coderax task ${taskId}' or cancel it explicitly.`,
        { details: { taskId, state: lastTask.state, lastSeq: cursor } },
      );
    }
    await sleep(pollMs);
    if (signal?.aborted) {
      throw new CoderaxError("CANCELLED", `stopped waiting for task ${taskId}`);
    }
  }
}

/** Map every transport failure onto the CLI's stable error codes exactly once. */
export function translateError(error) {
  if (error instanceof CoderaxError) return error;
  if (error instanceof CoderaxApiError) {
    const status = Number.isInteger(error.status) ? error.status : null;
    let code = "REQUEST_REJECTED";
    if (status === 401 || status === 403) code = "UNAUTHENTICATED";
    else if (status === 404) code = "NOT_FOUND";
    else if (status === 409) code = "CONFLICT";
    else if (status === 429) code = "RATE_LIMITED";
    else if (status === 503) code = "UNAVAILABLE";
    else if (status !== null && status >= 500) code = "SERVER_ERROR";
    return new CoderaxError(code, error.message, {
      status: status ?? undefined,
      details: { serverCode: error.code, requestId: error.requestId ?? null },
      retryable: error.retryable === true,
      requestId: error.requestId ?? undefined,
    });
  }
  if (error instanceof CoderaxCompatibilityError) {
    return new CoderaxError("CONTRACT_INCOMPATIBLE", error.message, {
      details: { problems: error.problems },
    });
  }
  if (error instanceof CoderaxContractError) {
    return new CoderaxError("CONTRACT_VIOLATION", error.message);
  }
  if (error?.name === "AbortError") {
    return new CoderaxError("CANCELLED", "the request was cancelled");
  }
  if (error?.name === "TimeoutError") {
    return new CoderaxError("REQUEST_TIMEOUT", "the engine did not answer before the timeout");
  }
  if (typeof error?.code === "string" && /^(ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|EAI_AGAIN|CERT_)/.test(error.code)) {
    return new CoderaxError("NETWORK", "the engine could not be reached");
  }
  return error;
}
