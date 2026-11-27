/**
 * Incremental server-sent-events decoder for the WorkflowEngine stream.
 *
 * A frame ends at a blank line. Only `data` fields carry the JSON event; `id`,
 * `event` and `retry` are parsed per the EventSource format so a deployment that
 * adds them is not rejected, but the engine's authoritative cursor is the
 * per-task `seq` in the payload, not an SSE id.
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
      const frame = parseSseFrame(raw);
      if (frame !== null) frames.push(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
    return frames;
  }

  /** A trailing frame without its blank line is incomplete; it is discarded. */
  flush() {
    this.buffer = "";
  }
}

export function parseSseFrame(raw) {
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
    // Unknown fields are ignored, as the EventSource format requires.
  }

  if (data.length === 0) return null;
  return { id, event, retry, data: data.join("\n") };
}
