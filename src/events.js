import { CoderaxError } from "./client.js";
import { TERMINAL_EVENT_TYPES, TERMINAL_TASK_STATES } from "./contract.js";

/**
 * Assemble a task's text from both incremental and cumulative events.
 *
 * The engine's native stream is incremental (`text.delta`) and can revise an
 * answer with `text.replace`. Legacy Work frames are cumulative (`message:true`
 * with the full text so far). A client may receive both forms in one stream, so
 * the rule is: a cumulative snapshot is authoritative; when it only extends what
 * is displayed, emit the unseen suffix; when it rewrites the answer, emit a
 * replacement. A legacy delta that merely repeats the tail of the current snapshot is
 * discarded rather than printed twice.
 *
 * `eventId` and the per-task `seq` are the dedupe keys. A replayed event is
 * ignored, and an out-of-order event cannot move the cursor backwards.
 */
export class EventAssembler {
  constructor() {
    this.text = "";
    this.mode = "incremental";
    this.lastSeq = 0;
    this.seen = new Set();
    this.terminal = null;
    this.usage = null;
    this.eventCount = 0;
  }

  apply(event) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      return { kind: "ignored", event };
    }

    const eventId = typeof event.eventId === "string" ? event.eventId : null;
    const seq = Number.isInteger(event.seq) && event.seq > 0 ? event.seq : null;
    if ((eventId !== null && this.seen.has(eventId)) || (seq !== null && seq <= this.lastSeq)) {
      return { kind: "duplicate", event };
    }
    if (eventId !== null) this.seen.add(eventId);
    if (seq !== null) this.lastSeq = seq;
    this.eventCount += 1;

    if (event.message === true && typeof event.text === "string") {
      return this.#snapshot(event.text, event);
    }
    if (event.type === "text.replace") {
      const text = event.payload?.text;
      if (typeof text !== "string") return { kind: "ignored", event };
      return this.#snapshot(text, event);
    }
    if (event.type === "text.delta") {
      const text = event.payload?.text;
      if (typeof text !== "string" || text === "") return { kind: "ignored", event };
      return this.#delta(text, event);
    }
    if (typeof event.delta === "string" && event.delta !== "") {
      // Legacy Work frames carry the increment at the top level.
      return this.#delta(event.delta, event, true);
    }

    if (event.type === "usage") {
      if (event.payload && typeof event.payload === "object") this.usage = event.payload;
      return { kind: "usage", event };
    }
    if (event.type === "approval.required") {
      return { kind: "approval", event, request: event.payload ?? null };
    }
    if (event.type === "step.started" || event.type === "step.completed") {
      return { kind: "step", event };
    }
    if (event.type === "tool.call" || event.type === "tool.result" || event.type === "file.edit") {
      return { kind: "event", event };
    }

    const terminalState = terminalStateFor(event);
    if (terminalState !== null) {
      // A final legacy frame carries the persisted answer; apply it before the
      // terminal marker so the reported text is the authoritative one.
      if (event.final === true && typeof event.responseMessage?.text === "string") {
        this.#snapshot(event.responseMessage.text, event);
      }
      this.terminal = { state: terminalState, event };
      return { kind: "terminal", event, terminal: this.terminal };
    }
    if (event.final === true) {
      this.terminal = { state: event.error ? "failed" : "completed", event };
      return { kind: "terminal", event, terminal: this.terminal };
    }
    if (event.error) {
      this.terminal = { state: "failed", event };
      return { kind: "terminal", event, terminal: this.terminal };
    }

    // An unknown event type is ignored, as the event contract requires, but its
    // cursor was already advanced so a reconnect does not replay it.
    return { kind: "unknown", event };
  }

  #delta(text, event, legacy = false) {
    // In snapshot mode a delta that is already the tail of the displayed text is
    // the increment the snapshot was built from. Printing it again is the
    // duplicate this guard exists to prevent.
    if (legacy && this.mode === "snapshot" && this.text.endsWith(text)) {
      return { kind: "duplicate-text", event };
    }
    this.text += text;
    return { kind: "delta", text, event };
  }

  #snapshot(snapshot, event) {
    this.mode = "snapshot";
    if (snapshot === this.text) return { kind: "duplicate-text", event };
    if (snapshot.startsWith(this.text)) {
      const suffix = snapshot.slice(this.text.length);
      this.text = snapshot;
      return suffix === ""
        ? { kind: "duplicate-text", event }
        : { kind: "delta", text: suffix, event, snapshot: true };
    }
    this.text = snapshot;
    return { kind: "replace", text: snapshot, event };
  }
}

export function terminalStateFor(event) {
  switch (event?.type) {
    case "task.completed":
      return "completed";
    case "task.failed":
      return "failed";
    case "task.cancelled":
      return "cancelled";
    case "task.interrupted":
      return "interrupted";
    default:
      return null;
  }
}

export function isTerminalState(state) {
  return TERMINAL_TASK_STATES.includes(state);
}

export function isTerminalEvent(event) {
  return TERMINAL_EVENT_TYPES.includes(event?.type);
}

const RETRYABLE_CODES = new Set([
  "REQUEST_TIMEOUT",
  "REQUEST_FAILED",
  "STREAM_DISCONNECTED",
  "engine_unavailable",
  "not_ready",
  "internal_error",
]);

/** A dropped connection, idle deadline or 5xx is worth reconnecting; auth is not. */
export function isRetryableStreamError(error) {
  if (!(error instanceof CoderaxError)) return false;
  if (RETRYABLE_CODES.has(error.code)) return true;
  return typeof error.status === "number" && error.status >= 500;
}

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function reconnectDelay(attempt, { baseMs = 250, maxMs = 5000 } = {}) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/**
 * Replay and tail a task's events, reconnecting from the last seen sequence
 * after a transport failure. The task itself is never affected: the engine owns
 * it, and detaching only closes this stream.
 *
 * A 401/403 is fatal so an expired session is reported instead of retried
 * forever. A clean close without a terminal event (proxy timeout, server
 * restart) reconnects with the same cursor, and replay is deduplicated by the
 * assembler.
 */
export async function followTaskEvents({
  client,
  taskId,
  after = 0,
  signal,
  onEvent,
  sleep = defaultSleep,
  maxReconnects = 8,
} = {}) {
  const assembler = new EventAssembler();
  let cursor = Number.isInteger(after) && after > 0 ? after : 0;
  let failures = 0;

  for (;;) {
    if (signal?.aborted) throw new CoderaxError("CANCELLED", "event stream detached");
    try {
      for await (const event of client.events(taskId, { after: cursor, signal })) {
        const previousCount = assembler.eventCount;
        const outcome = assembler.apply(event);
        if (assembler.eventCount > previousCount) {
          failures = 0;
          cursor = Math.max(cursor, assembler.lastSeq);
          onEvent?.(event, outcome);
        }
        if (assembler.terminal) return assembler;
      }
      if (assembler.terminal) return assembler;
      // The connection ended without a terminal event.
    } catch (error) {
      if (signal?.aborted || error?.code === "CANCELLED") {
        throw new CoderaxError("CANCELLED", "event stream detached");
      }
      if (!isRetryableStreamError(error)) throw error;
    }

    failures += 1;
    if (failures > maxReconnects) {
      throw new CoderaxError(
        "STREAM_DISCONNECTED",
        `lost the event stream for ${taskId} after ${maxReconnects} reconnect attempts; the task may still be running`,
      );
    }
    await sleep(reconnectDelay(failures));
  }
}
