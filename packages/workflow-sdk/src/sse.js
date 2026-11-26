import { diagnostic } from "./errors.js";

/**
 * Incremental SSE frame decoder. A frame ends at a blank line; `id`, `event`,
 * `retry` and multi-line `data` are parsed per the EventSource format.
 */
export class SseDecoder {
  constructor() {
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += chunk;
    // SSE permits CRLF. Normalise per chunk so a split CRLF still terminates.
    this.buffer = this.buffer.replace(/\r\n/g, "\n");
    const frames = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame !== null) frames.push(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
    return frames;
  }

  /** A trailing frame without its blank line is incomplete; do not emit it. */
  flush() {
    this.buffer = "";
  }
}

export function parseFrame(raw) {
  let id = null;
  let event = null;
  let retry = null;
  const data = [];

  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
    else if (field === "eventId") id = value;
    // Unknown fields are ignored, as the EventSource format requires.
  }

  if (data.length === 0) return null;
  const text = data.join("\n");
  if (text === "[DONE]") return { id, event, retry, done: true, data: null, text };

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { text, raw: true };
  }
  return { id, event, retry, done: false, data: payload, text };
}

function sequenceOf(frame) {
  if (frame.id !== null && /^\d+$/.test(frame.id)) return Number(frame.id);
  const data = frame.data;
  if (data === null || typeof data !== "object") return null;
  for (const field of ["seq", "sequence", "eventSeq", "event_id", "eventId"]) {
    const value = data[field];
    if (Number.isInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/**
 * Deduplicate and re-order an event stream by `id` or a numeric sequence field.
 *
 * The current backend emits neither, so the SDK reports CURSOR_UNSUPPORTED
 * instead of pretending it can replay. When a deployment does emit ids, this
 * class makes reconnects idempotent and exposes duplicate/out-of-order events.
 */
export class EventSequencer {
  constructor() {
    this.seenIds = new Set();
    this.seenSequences = new Set();
    this.lastSequence = 0;
    this.pending = new Map();
    this.sawCursor = false;
    this.cursorReplayDetected = false;
  }

  accept(frame) {
    const diagnostics = [];
    if (frame.id !== null) this.sawCursor = true;
    const sequence = sequenceOf(frame);
    if (sequence !== null) this.sawCursor = true;

    if (frame.id !== null) {
      if (this.seenIds.has(frame.id)) {
        this.cursorReplayDetected = true;
        diagnostics.push(
          diagnostic("DUPLICATE_EVENT", `the server sent event id ${frame.id} more than once`),
        );
        return { action: "drop", diagnostics };
      }
      this.seenIds.add(frame.id);
    }

    if (sequence === null) {
      return { action: "emit", frames: [frame], diagnostics };
    }

    if (this.seenSequences.has(sequence) || sequence <= this.lastSequence) {
      this.cursorReplayDetected = true;
      diagnostics.push(
        diagnostic(
          "DUPLICATE_EVENT",
          `the server replayed sequence ${sequence} after ${this.lastSequence}`,
        ),
      );
      return { action: "drop", diagnostics };
    }
    this.seenSequences.add(sequence);

    if (sequence === this.lastSequence + 1) {
      this.lastSequence = sequence;
      const frames = [frame];
      let next = this.lastSequence + 1;
      while (this.pending.has(next)) {
        frames.push(this.pending.get(next));
        this.pending.delete(next);
        this.lastSequence = next;
        next += 1;
      }
      return { action: "emit", frames, diagnostics };
    }

    if (sequence > this.lastSequence + 1) {
      this.pending.set(sequence, frame);
      diagnostics.push(
        diagnostic(
          "OUT_OF_ORDER_EVENT",
          `event ${sequence} arrived before ${this.lastSequence + 1}; buffering until the gap fills`,
        ),
      );
      return { action: "buffer", diagnostics };
    }

    return { action: "emit", frames: [frame], diagnostics };
  }

  /** Emit buffered frames in sequence order when the stream ends with a gap. */
  flush() {
    const diagnostics = [];
    const sequences = [...this.pending.keys()].sort((a, b) => a - b);
    if (sequences.length === 0) return { frames: [], diagnostics };

    const frames = sequences.map((sequence) => this.pending.get(sequence));
    this.pending.clear();
    diagnostics.push(
      diagnostic(
        "OUT_OF_ORDER_EVENT",
        `${frames.length} event(s) were never delivered in order; rendering them by sequence at end of stream`,
      ),
    );
    this.lastSequence = sequences[sequences.length - 1];
    return { frames, diagnostics };
  }
}
