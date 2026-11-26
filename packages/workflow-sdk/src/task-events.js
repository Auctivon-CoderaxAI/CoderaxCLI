import { RUN_STATUSES, TERMINAL_RUN_STATUSES } from "./contract.js";
import { SdkError } from "./errors.js";

/**
 * Task event coordination layer.
 *
 * Every shape here was read from Auctivon-CoderaxAI/Coderax at main
 * (a5d237b0):
 *
 * - durable runs:   packages/api/src/workflows/{types.ts,engine.ts}
 * - run views:      packages/api/src/workflows/handlers.ts (toRunView)
 * - run routes:     api/server/routes/workflows.js
 * - run stream:     packages/api/src/workflows/handlers.ts (streamRun)
 * - work tasks:     packages/api/src/work/router.ts
 * - chat stream:    api/server/routes/workChat.js
 * - idempotency:    packages/api/src/middleware/generationRetry.ts
 *
 * Two properties matter more than anything else in this file:
 *
 * 1. The durable workflow run stream emits full run snapshots. It does not emit
 *    SSE `id:` fields, it has no event sequence numbers, and it ignores
 *    Last-Event-ID. A resume is therefore a re-read of authoritative state, not
 *    a replay of individual events.
 * 2. The durable event log is `{ at, type, stepId?, message? }`. There is no
 *    event identifier to invent and no permission-request identifier to use.
 *    Approvals are addressed by step index, exactly as the backend parser does.
 *
 * Nothing below synthesises an identifier. `cursorFromFrame()` returns null
 * when the deployment supplied no cursor, and callers must treat that as
 * "snapshot-only", never as "advance the cursor anyway".
 */

export const TASK_PROTOCOL = Object.freeze({
  workflowRunStream: Object.freeze({
    path: "/api/workflows/runs/:runId/stream",
    transport: "text/event-stream",
    payload: "run-snapshot",
    eventIds: false,
    sequenceNumbers: false,
    lastEventId: false,
    replay: "snapshot",
    closesOn: TERMINAL_RUN_STATUSES,
  }),
  workflowRun: Object.freeze({
    path: "/api/workflows/runs/:runId",
    method: "GET",
    payload: "run",
  }),
  legacyChatStream: Object.freeze({
    path: "/api/work/chat",
    transport: "text/event-stream",
    payload: "cumulative-snapshot",
    eventIds: false,
    sequenceNumbers: false,
    lastEventId: false,
    terminalFrame: "final",
  }),
});

/** Backend `WORKFLOW_RUN_STATUSES`; unknown statuses fail closed. */
export function assertRunSnapshot(run, source = "run") {
  if (run === null || typeof run !== "object" || Array.isArray(run)) {
    throw new SdkError("CONTRACT_VIOLATION", `${source} did not return a run object`);
  }
  if (typeof run.id !== "string" || run.id === "") {
    throw new SdkError("CONTRACT_VIOLATION", `${source} returned a run without an id`);
  }
  if (!RUN_STATUSES.includes(run.status)) {
    throw new SdkError(
      "UNKNOWN_RUN_STATUS",
      `${source} returned run status ${JSON.stringify(run.status)}; this client implements ${RUN_STATUSES.join(", ")}`,
      { details: { runId: run.id, status: run.status ?? null } },
    );
  }
  return run;
}

/**
 * Content identity of one authoritative snapshot. It is deliberately derived
 * from the whole snapshot rather than from an event id: the backend provides no
 * event id, and a snapshot is idempotent, so "same bytes" means "same state".
 */
export function runFingerprint(run) {
  return JSON.stringify(run);
}

/**
 * The only places a cursor may come from. A frame id or an explicit server
 * sequence field counts; a run snapshot does not. Returns null otherwise.
 */
export function cursorFromFrame(frame) {
  if (frame === null || typeof frame !== "object") return null;
  if (typeof frame.id === "string" && frame.id !== "") {
    return { kind: "event-id", value: frame.id };
  }
  const data = frame.data;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    if (Number.isInteger(data.seq) && data.seq >= 0) {
      return { kind: "sequence", value: data.seq };
    }
    if (Number.isInteger(data.sequence) && data.sequence >= 0) {
      return { kind: "sequence", value: data.sequence };
    }
  }
  return null;
}

export function terminalOutcome(run) {
  if (run === null || typeof run !== "object" || !TERMINAL_RUN_STATUSES.includes(run.status)) {
    return { terminal: false, kind: "pending", status: run?.status ?? null, error: null };
  }
  const kind =
    run.status === "failed" ? "failed" : run.status === "cancelled" ? "cancelled" : "completed";
  return {
    terminal: true,
    kind,
    status: run.status,
    error: typeof run.error === "string" && run.error !== "" ? run.error : null,
    settledAt: typeof run.settledAt === "string" ? run.settledAt : null,
  };
}

/**
 * Approval addressing is derived from the run view: the backend route accepts
 * `{ stepIndex }` only (parseApproveWorkflowStep). This is not a permission
 * request id, and it must not be presented as one.
 */
export function approvalFor(run) {
  if (run?.status !== "waiting_approval") return null;
  const steps = Array.isArray(run.steps) ? run.steps : [];
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex];
    if (step?.approvalRequired !== true) continue;
    if (step.approvedAt) continue;
    if (["completed", "failed", "cancelled", "skipped"].includes(step.status)) continue;
    return {
      kind: "approval",
      derived: true,
      runId: run.id,
      stepIndex,
      stepId: typeof step.id === "string" ? step.id : null,
      title: typeof step.title === "string" ? step.title : null,
    };
  }
  return null;
}

/**
 * Classify one SSE frame from the durable workflow run stream. The caller owns
 * the failure: an invalid frame never becomes an empty successful event.
 */
export function workflowFrameEvent(frame) {
  if (frame === null || typeof frame !== "object") return { kind: "invalid" };
  if (frame.done === true) return { kind: "done" };
  const payload = frame.data;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "invalid" };
  }
  if (payload.type === "error") {
    return { kind: "stream-error", error: payload.error ?? payload.message ?? null };
  }
  if ("run" in payload) {
    return { kind: "run-snapshot", run: payload.run };
  }
  return { kind: "invalid", keys: Object.keys(payload) };
}

export const LEGACY_CHAT_PROTOCOL = Object.freeze({
  marker: "legacy-chat-sse",
  route: "/api/work/chat",
  reason:
    "The current Work chat route streams cumulative text snapshots with a final frame and no event identifiers. " +
    "It is kept as an explicit compatibility adapter; the durable workflow run protocol is authoritative for tasks.",
});

/**
 * Normalise one legacy chat payload. This is the single place that knows the
 * cumulative-snapshot rules, so the compatibility path cannot drift from the
 * durable path's assumptions.
 */
export function classifyChatPayload(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "ignored" };
  }
  if (payload.final === true) {
    return {
      kind: "final",
      text: typeof payload.responseMessage?.text === "string" ? payload.responseMessage.text : null,
      error:
        payload.error ?? payload.responseMessage?.error ?? null,
    };
  }
  if (payload.error !== undefined) {
    return { kind: "error", error: payload.error };
  }
  if (payload.type === "error") {
    return { kind: "error", error: payload.error ?? payload.message ?? null };
  }
  if (payload.type === "text" && typeof payload.text === "string") {
    if (payload.index === undefined || payload.index === 0) {
      return { kind: "snapshot", text: payload.text };
    }
    return { kind: "ignored", reason: "multi-index text frame" };
  }
  if (payload.message === true && typeof payload.text === "string") {
    return { kind: "snapshot", text: payload.text };
  }
  if (payload.raw === true && typeof payload.text === "string") {
    return { kind: "delta", text: payload.text };
  }
  const delta =
    payload.delta ?? payload.token ?? payload.content ?? payload.choices?.[0]?.delta?.content;
  if (typeof delta === "string") return { kind: "delta", text: delta };
  return { kind: "ignored" };
}

/**
 * Compatibility adapter for `/api/work/chat`. It owns the cumulative-snapshot
 * decision (append the unseen suffix, or replace on a rewrite) and emits the
 * normalised events a renderer expects. It never claims replay support.
 */
export class LegacyChatAdapter {
  constructor({ onEvent } = {}) {
    this.onEvent = onEvent;
    this.lastSnapshot = null;
    this.text = "";
    this.protocol = LEGACY_CHAT_PROTOCOL;
  }

  push(payload) {
    const event = classifyChatPayload(payload);
    if (event.kind === "final") {
      if (typeof event.text === "string" && event.text !== this.text) {
        this.text = event.text;
        this.lastSnapshot = event.text;
        this.onEvent?.({ type: "replace", text: this.text, protocol: this.protocol.marker });
      }
      this.onEvent?.({ type: "final", protocol: this.protocol.marker });
      return { type: "final", text: this.text };
    }
    if (event.kind === "error") {
      this.onEvent?.({ type: "error", error: event.error, protocol: this.protocol.marker });
      return { type: "error", error: event.error };
    }
    if (event.kind === "snapshot") {
      const snapshot = event.text;
      if (this.lastSnapshot !== null && !snapshot.startsWith(this.lastSnapshot)) {
        this.text = snapshot;
        this.lastSnapshot = snapshot;
        this.onEvent?.({ type: "replace", text: this.text, protocol: this.protocol.marker });
        return { type: "replace", text: this.text };
      }
      const delta = snapshot.slice(this.lastSnapshot?.length ?? 0);
      this.lastSnapshot = snapshot;
      if (delta === "") return { type: "ignored" };
      this.text += delta;
      this.onEvent?.({ type: "delta", text: delta, protocol: this.protocol.marker });
      return { type: "delta", text: delta };
    }
    if (event.kind === "delta") {
      this.text += event.text;
      this.onEvent?.({ type: "delta", text: event.text, protocol: this.protocol.marker });
      return { type: "delta", text: event.text };
    }
    return { type: "ignored" };
  }
}
