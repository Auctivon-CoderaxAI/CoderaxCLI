/**
 * Server-sent-event framing.
 *
 * The decoder is chunk-agnostic: a frame may arrive split at any byte, including
 * between `\r` and `\n`, between two `data:` lines, or in the middle of a JSON
 * string. It never assumes one network read equals one frame.
 */

const CRLF = /\r\n|\r/g;

export class SseDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "SseDecodeError";
  }
}

/**
 * Builds frames from arbitrary chunks. `push` returns every complete frame and
 * keeps the incomplete remainder. `end` flushes a final frame that used a lone
 * blank line terminator (SSE permits it) and otherwise discards a partial frame.
 */
export class SseDecoder {
  constructor() {
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += String(chunk);
    // Normalise complete CRLF pairs and lone CRs, but hold a trailing CR until
    // the next read. Converting it immediately would turn a CRLF split across
    // reads into two newlines and fabricate a frame boundary.
    let text = this.buffer;
    let carry = "";
    if (text.endsWith("\r")) {
      carry = "\r";
      text = text.slice(0, -1);
    }
    this.buffer = `${text.replace(CRLF, "\n")}${carry}`;
    const frames = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
    return frames;
  }

  end() {
    const remainder = this.buffer.replace(CRLF, "\n").trim();
    this.buffer = "";
    if (remainder === "") return [];
    const frame = parseFrame(remainder);
    return frame ? [frame] : [];
  }
}

/**
 * A frame is a set of fields. Unknown fields are ignored as the SSE
 * specification requires; a frame without data is a keep-alive, not an event.
 */
export function parseFrame(raw) {
  const data = [];
  let event = "";
  let id = "";
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  if (data.length === 0) return null;
  return { data: data.join("\n"), event, id };
}

/**
 * Parse a frame's data as the engine's JSON event envelope. `[DONE]` is the
 * conventional legacy terminator, not an event. A frame that is not JSON is a
 * protocol failure: silently treating it as text would hide a broken server.
 */
export function parseJsonFrame(frame) {
  const data = frame.data.trim();
  if (data === "" || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    throw new SseDecodeError("an SSE frame was not valid JSON");
  }
}
