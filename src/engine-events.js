import { CoderaxError } from "./client.js";
import {
  EVENT_SCHEMA_VERSION,
  EXECUTION_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  isTerminalEventType,
} from "./engine-contract.js";

/**
 * Execution-event validation and text assembly.
 *
 * The engine emits a versioned envelope carrying a stable `eventId` and a
 * per-task monotonic `seq` (starting at 1). Those two fields are the only
 * dedupe keys: an event is applied at most once, and a gap means events were
 * lost, not that the sequence reset. `stream.truncated` is a synthetic server
 * frame telling the client its cursor predates the retained window; it is never
 * rendered and triggers a snapshot reconciliation instead.
 */

function contractError(message, details = null) {
  return new CoderaxError("CONTRACT_VIOLATION", message, { details });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateExecutionEvent(event, { taskId } = {}) {
  if (!isRecord(event)) throw contractError("an execution event was not a JSON object");
  if (event.v !== EVENT_SCHEMA_VERSION) {
    throw contractError(
      `an execution event carries schema v${JSON.stringify(event.v)}; this client parses v${EVENT_SCHEMA_VERSION}`,
      { eventId: event.eventId ?? null },
    );
  }
  if (typeof event.eventId !== "string" || event.eventId === "") {
    throw contractError("an execution event has no eventId");
  }
  if (typeof event.taskId !== "string" || event.taskId === "") {
    throw contractError("an execution event has no taskId", { eventId: event.eventId });
  }
  if (taskId !== undefined && event.taskId !== taskId) {
    throw contractError(
      `the stream for ${taskId} emitted an event for ${event.taskId}`,
      { eventId: event.eventId },
    );
  }
  if (!Number.isInteger(event.seq) || event.seq < 1) {
    throw contractError("an execution event has no positive integer seq", {
      eventId: event.eventId,
    });
  }
  if (!EXECUTION_EVENT_TYPES.includes(event.type)) {
    throw contractError(`unknown execution event type ${JSON.stringify(event.type)}`, {
      eventId: event.eventId,
    });
  }
  if (typeof event.at !== "string" || event.at === "") {
    throw contractError("an execution event has no timestamp", { eventId: event.eventId });
  }
  if (typeof event.agent !== "string" || event.agent === "") {
    throw contractError("an execution event has no agent", { eventId: event.eventId });
  }
  if (!Number.isInteger(event.generation) || event.generation < 0) {
    throw contractError("an execution event has no generation", { eventId: event.eventId });
  }

  if (event.type === "text.delta") {
    if (!isRecord(event.payload) || typeof event.payload.text !== "string" || event.payload.text === "") {
      throw contractError("a text.delta event has no text", { eventId: event.eventId });
    }
  }
  if (event.type === "text.replace") {
    if (!isRecord(event.payload) || typeof event.payload.text !== "string") {
      throw contractError("a text.replace event has no text", { eventId: event.eventId });
    }
  }
  if (event.type === "stream.truncated") {
    if (
      !isRecord(event.payload) ||
      !Number.isInteger(event.payload.after) ||
      event.payload.after < 0 ||
      !Number.isInteger(event.payload.oldestSeq) ||
      event.payload.oldestSeq < 1
    ) {
      throw contractError("a stream.truncated event has no after/oldestSeq", {
        eventId: event.eventId,
      });
    }
  }
  return event;
}

/**
 * Assemble the visible answer from a validated event stream.
 *
 * `seq` ordering is enforced before this class sees an event (see
 * `EngineTaskSynchronizer`), so this class only handles text semantics: deltas
 * append, `text.replace` rewrites or extends, and legacy cumulative Work frames
 * (`message: true`) are tolerated through the explicitly identified legacy
 * adapter path rather than becoming a second protocol authority.
 */
export class EventAssembler {
  constructor() {
    this.text = "";
    this.mode = "incremental";
    this.terminal = null;
    this.usage = null;
    this.eventCount = 0;
  }

  apply(event) {
    if (event.type === "text.delta") {
      this.text += event.payload.text;
      this.eventCount += 1;
      return { kind: "delta", text: event.payload.text, event };
    }
    if (event.type === "text.replace") {
      const snapshot = event.payload.text;
      this.mode = "snapshot";
      this.eventCount += 1;
      if (snapshot === this.text) return { kind: "duplicate-text", event };
      if (snapshot.startsWith(this.text)) {
        const suffix = snapshot.slice(this.text.length);
        this.text = snapshot;
        return suffix === ""
          ? { kind: "duplicate-text", event }
          : { kind: "delta", text: suffix, snapshot: true, event };
      }
      this.text = snapshot;
      return { kind: "replace", text: snapshot, event };
    }
    if (event.type === "usage") {
      this.usage = event.payload ?? null;
      this.eventCount += 1;
      return { kind: "usage", event };
    }
    if (event.type === "approval.required") {
      this.eventCount += 1;
      return { kind: "approval", request: event.payload ?? null, event };
    }
    if (event.type === "step.started" || event.type === "step.completed") {
      this.eventCount += 1;
      return { kind: "step", event };
    }
    if (
      event.type === "tool.call" ||
      event.type === "tool.result" ||
      event.type === "file.edit"
    ) {
      this.eventCount += 1;
      return { kind: "event", event };
    }
    if (isTerminalEventType(event.type)) {
      this.terminal = { state: terminalStateFor(event.type), event };
      this.eventCount += 1;
      return { kind: "terminal", terminal: this.terminal, event };
    }
    if (event.type === "task.queued" || event.type === "task.started") {
      this.eventCount += 1;
      return { kind: "lifecycle", event };
    }
    this.eventCount += 1;
    return { kind: "unknown", event };
  }
}

export function terminalStateFor(type) {
  switch (type) {
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

export { TERMINAL_EVENT_TYPES };
