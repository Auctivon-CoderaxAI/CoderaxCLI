/**
 * Durable task tailing for the `/v1` contract.
 *
 * A Work task outlives any one connection: a proxy may close an idle stream, a
 * replica may hand off, and the terminal may be detached. The rules here are
 * the contract's, not a heuristic:
 *
 * - `seq` is monotonic per task and assigned only by the engine's event bus;
 * - an `eventId` already seen is dropped, so a replay is idempotent;
 * - `seq <= lastSeq` is a replay, and `seq > lastSeq + 1` is a gap; a gap
 *   reconnects from `lastSeq` instead of applying events out of order;
 * - task state fetched with `GET /v1/work/{taskId}` is authoritative. A stream
 *   that closes without a terminal event is never interpreted as completion;
 * - after `maxReconnects` the caller gets `STREAM_INTERRUPTED` with the cursor
 *   needed to reattach. The task is not cancelled and is never resubmitted.
 */

import { SdkError } from "../errors.js";
import { isTerminalEventType, isTerminalTaskState } from "./contract.js";

const MAX_SEEN_EVENTS = 10_000;

export function defaultSleep(ms) {
  return new Promise((resolve) => {
    // Keep the timer referenced: `watchTask` awaits it while reconnecting and an
    // unref'd timer would let a detached CLI exit mid-recovery.
    setTimeout(resolve, ms);
  });
}

/** Exponential backoff with jitter, bounded by `cap`. */
export function backoffDelay(attempt, { base = 500, cap = 15_000, random = Math.random } = {}) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 8);
  const ceiling = Math.min(cap, base * 2 ** exponent);
  const floor = ceiling / 2;
  return Math.floor(floor + random() * (ceiling - floor));
}

/**
 * Decide whether a failed read is worth retrying.
 *
 * A contract violation, an unsupported capability, a validation failure or a
 * missing actor is permanent: retrying it only burns the owner's time.
 */
export function isRetryable(error) {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "CONTRACT_VIOLATION" || code === "CONTRACT_UNSUPPORTED" || code === "CONTRACT_UNVERIFIED") {
    return false;
  }
  if (code === "CAPABILITY_UNAVAILABLE" || code === "API_VERSION_UNSUPPORTED") return false;
  if (code === "NOT_FOUND" || code === "HTTP_404") return false;
  if (code === "FORBIDDEN" || code === "HTTP_403") return false;
  if (code === "CANCELLED" || code === "USAGE") return false;
  if (error.retryable === true) return true;
  if (
    code === "NETWORK" ||
    code === "TIMEOUT" ||
    code === "STREAM_INCOMPLETE" ||
    code === "RESPONSE_UNREADABLE" ||
    code === "UNAVAILABLE" ||
    code === "RATE_LIMITED" ||
    code === "CONFLICT" ||
    code === "NOT_READY" ||
    code === "UNAUTHENTICATED" ||
    code === "HTTP_401"
  ) {
    return true;
  }
  return error.status === 401 || error.status === 429 || (Number.isInteger(error.status) && error.status >= 500);
}

function cancelled(signal) {
  return signal?.aborted === true;
}

/**
 * Tail a durable task until it reaches a terminal state.
 *
 * @param {object} options
 * @param {import("./client.js").V1Client} options.client
 * @param {string} options.taskId
 * @param {number} [options.after] resume cursor; `0` replays from the start
 * @param {AbortSignal} [options.signal]
 * @param {(event: object) => void|Promise<void>} [options.onEvent]
 * @param {(seq: number, event: object) => void|Promise<void>} [options.onCheckpoint]
 * @param {(info: object) => void} [options.onReconnect]
 * @param {(raw: object) => void} [options.onUnknown]
 * @param {(status: object) => void} [options.onStatus]
 * @param {number} [options.maxReconnects]
 * @param {(ms: number) => Promise<void>} [options.sleep]
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
  let lastEventId = lastSeq > 0 ? String(lastSeq) : null;
  let attempts = 0;
  let gaps = 0;
  const seen = new Set();

  const remember = (eventId) => {
    if (!eventId) return;
    seen.add(eventId);
    if (seen.size > MAX_SEEN_EVENTS) {
      const oldest = seen.values().next().value;
      seen.delete(oldest);
    }
  };

  for (;;) {
    if (cancelled(signal)) throw new SdkError("CANCELLED", "task tailing cancelled");
    let opened = false;
    let reconnectNow = false;

    try {
      for await (const { event } of client.events(taskId, { after: lastSeq, signal, onUnknown })) {
        opened = true;
        attempts = 0;
        if (event.eventId && seen.has(event.eventId)) continue;
        if (event.seq <= lastSeq) {
          // A replay of something already applied. Idempotent, not an error.
          remember(event.eventId);
          continue;
        }
        if (event.seq !== lastSeq + 1) {
          // Never apply a frame across a gap: the engine replays from `after`.
          gaps += 1;
          if (gaps > 3) {
            throw new SdkError(
              "EVENT_GAP",
              `the event stream skipped from ${lastSeq} to ${event.seq}; the replay buffer may be truncated`,
              {
                retryable: false,
                details: { taskId, lastSeq, received: event.seq },
              },
            );
          }
          reconnectNow = true;
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
          // A checkpoint failure must not lose the task. The cursor still moves.
          onReconnect({ reason: "checkpoint-write", error, attempt: 0, delayMs: 0, lastSeq });
        }
        if (isTerminalEventType(event.type)) {
          return {
            lastSeq,
            lastEventId,
            terminalEvent: event,
            status: null,
            interrupted: event.type === "task.interrupted",
          };
        }
      }
      if (reconnectNow) {
        // Reconnect from the same cursor; this is a gap, not a lost task.
      }
    } catch (error) {
      if (cancelled(signal)) throw new SdkError("CANCELLED", "task tailing cancelled");
      if (!isRetryable(error)) throw error;
    }

    // Task state is authoritative. Never infer completion from a closed stream.
    let status;
    try {
      status = await client.task(taskId, { signal });
      onStatus(status);
    } catch (error) {
      if (cancelled(signal)) throw new SdkError("CANCELLED", "task tailing cancelled");
      if (error?.code === "NOT_FOUND" || error?.code === "HTTP_404") {
        throw new SdkError("TASK_NOT_FOUND", `task ${taskId} no longer exists`, {
          details: { taskId, lastSeq, lastEventId },
          retryable: false,
        });
      }
      if (!isRetryable(error)) throw error;
    }

    if (status && isTerminalTaskState(status.state)) {
      return {
        lastSeq,
        lastEventId,
        terminalEvent: null,
        status,
        interrupted: status.state === "interrupted",
      };
    }

    attempts += 1;
    if (attempts > maxReconnects) {
      throw new SdkError(
        "STREAM_INTERRUPTED",
        `the event stream for ${taskId} did not recover after ${maxReconnects} attempts`,
        {
          retryable: true,
          details: { taskId, lastSeq, lastEventId, state: status?.state ?? null },
        },
      );
    }
    const delayMs = backoffDelay(attempts, { base: baseDelayMs, cap: maxDelayMs, random });
    onReconnect({
      attempt: attempts,
      delayMs,
      reason: opened ? "stream-ended" : "connect-failed",
      lastSeq,
    });
    await sleep(delayMs);
  }
}
