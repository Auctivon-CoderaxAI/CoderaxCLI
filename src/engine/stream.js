import { CoderaxError, CancelledError } from "../errors.js";

const TERMINAL_EVENTS = new Set([
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.interrupted",
]);

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Exponential backoff with jitter. A healthy long task reconnects quietly; a
 * deployment that is down is not hammered.
 */
export function backoffDelay(attempt, { base = 500, cap = 15_000, random = Math.random } = {}) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 8);
  const ceiling = Math.min(cap, base * 2 ** exponent);
  const floor = ceiling / 2;
  return Math.floor(floor + random() * (ceiling - floor));
}

function retryable(error) {
  if (!error) return false;
  if (error.code === "CONTRACT_MISMATCH" || error.code === "CONTRACT_UNSUPPORTED") return false;
  if (error.code === "CONTRACT_ADAPTER_PENDING") return false;
  if (error.code === "CAPABILITY_UNSUPPORTED") return false;
  if (error.code === "not_found" || error.code === "HTTP_404") return false;
  if (error.code === "validation_failed") return false;
  if (error.code === "forbidden" || error.code === "workspace_denied") return false;
  if (error.code === "paid_model_refused") return false;
  return error.retryable === true
    || error.code === "REQUEST_FAILED"
    || error.code === "REQUEST_TIMEOUT"
    || error.code === "not_ready"
    || error.code === "engine_unavailable"
    || error.code === "engine_not_configured"
    || error.code === "busy"
    || error.code === "conflict"
    || error.code === "unauthorized"
    || error.code === "HTTP_401"
    || error.status === 401
    || error.status === 429
    || (Number.isInteger(error.status) && error.status >= 500);
}

/**
 * Tail a durable task from a cursor.
 *
 * - replay uses `after=<lastSeq>` (the contract's cursor) and `Last-Event-ID`;
 * - `eventId` deduplicates replays; `seq` detects a gap or an out-of-order frame;
 * - a stream that ends without a terminal event re-reads task state and
 *   reconnects, so a proxy timeout or a terminal crash is recovered;
 * - a 401 refreshes the owner token once, inside the engine client;
 * - after `maxReconnects` the caller receives `STREAM_INTERRUPTED` with the
 *   cursor needed to attach again.
 */
export async function watchTask({
  client,
  taskId,
  after = 0,
  signal,
  onEvent = () => {},
  onCheckpoint = () => {},
  onReconnect = () => {},
  onUnknown = null,
  onStatus = () => {},
  maxReconnects = 12,
  sleep = defaultSleep,
  random = Math.random,
  baseDelayMs = 500,
  maxDelayMs = 15_000,
} = {}) {
  let lastSeq = Number.isInteger(after) && after > 0 ? after : 0;
  let lastEventId = lastSeq > 0 ? String(lastSeq) : undefined;
  let attempts = 0;
  let gaps = 0;
  const seen = new Set();

  const remember = (eventId) => {
    if (!eventId) return;
    seen.add(eventId);
    if (seen.size > 10_000) {
      const oldest = seen.values().next().value;
      seen.delete(oldest);
    }
  };

  for (;;) {
    if (signal?.aborted) throw new CancelledError();
    let opened = false;
    let streamEnded = false;
    try {
      for await (const { event } of client.events(taskId, {
        after: lastSeq,
        signal,
        onUnknown,
      })) {
        opened = true;
        attempts = 0;
        if (event.eventId && seen.has(event.eventId)) continue;
        if (event.seq <= lastSeq) {
          remember(event.eventId);
          continue;
        }
        if (event.seq !== lastSeq + 1) {
          // A dropped frame is not applied. The engine replays from `after`.
          gaps += 1;
          if (gaps > 3) {
            throw new CoderaxError(
              "EVENT_GAP",
              `the event stream skipped from ${lastSeq} to ${event.seq}; the replay buffer may be truncated`,
              { retryable: false, details: { taskId, lastSeq, received: event.seq } },
            );
          }
          streamEnded = true;
          break;
        }
        gaps = 0;
        remember(event.eventId);
        lastSeq = event.seq;
        lastEventId = String(event.seq);
        await onEvent(event);
        try {
          await onCheckpoint(lastSeq, event);
        } catch (error) {
          onReconnect({ reason: "checkpoint-write", error, attempt: 0, delayMs: 0 });
        }
        if (TERMINAL_EVENTS.has(event.type)) {
          return { lastSeq, terminalEvent: event, status: null, interrupted: event.type === "task.interrupted" };
        }
      }
      if (streamEnded) {
        // Reconnect from the same cursor; this is a gap, not a lost task.
      }
    } catch (error) {
      if (signal?.aborted) throw new CancelledError();
      if (error instanceof CoderaxError && !retryable(error)) throw error;
      if (!retryable(error)) throw error;
    }

    // A stream may close normally while the task is still running (idle proxy,
    // replica handoff). Task state is authoritative; never infer completion.
    let status;
    try {
      status = await client.task(taskId, { signal });
      onStatus(status);
    } catch (error) {
      if (signal?.aborted) throw new CancelledError();
      if (error?.code === "not_found" || error?.code === "HTTP_404") {
        throw new CoderaxError("TASK_NOT_FOUND", `task ${taskId} no longer exists`, {
          hint: "Run `coderax work list` to see the tasks this terminal knows about.",
        });
      }
      if (!retryable(error)) throw error;
    }

    if (status && TERMINAL_STATES.has(status.state)) {
      return {
        lastSeq,
        terminalEvent: null,
        status,
        interrupted: status.state === "interrupted",
      };
    }

    attempts += 1;
    if (attempts > maxReconnects) {
      throw new CoderaxError(
        "STREAM_INTERRUPTED",
        `the event stream for ${taskId} did not recover after ${maxReconnects} attempts`,
        {
          retryable: true,
          details: { taskId, lastSeq, lastEventId, state: status?.state ?? null },
          hint: `The task was not cancelled. Reattach with \`coderax work attach ${taskId}\`.`,
        },
      );
    }
    const delayMs = backoffDelay(attempts, { base: baseDelayMs, cap: maxDelayMs, random });
    onReconnect({ attempt: attempts, delayMs, reason: opened ? "stream-ended" : "connect-failed", lastSeq });
    await sleep(delayMs);
  }
}
