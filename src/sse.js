/**
 * Server-sent-event framing.
 *
 * The decoder is chunk-agnostic: a frame may arrive split at any byte, including
 * between `\r` and `\n`, between two `data:` lines, or in the middle of a JSON
 * string. It never assumes one network read equals one frame.
 */

const MAX_LINE_LENGTH = 1024 * 1024;
const MAX_FRAME_LENGTH = 4 * 1024 * 1024;

export class SseDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "SseDecodeError";
  }
}

/**
 * Builds frames from arbitrary chunks. `push` returns every complete frame and
 * keeps only the bounded, incomplete remainder. A trailing CR terminates
 * its line immediately; the following LF, if present, belongs to that CR.
 */
export class SseDecoder {
  #line = "";
  #lines = [];
  #frameLength = 0;
  #skipLf = false;

  #append(part) {
    if (this.#line.length + part.length > MAX_LINE_LENGTH) {
      throw new SseDecodeError("an SSE line exceeded the size limit");
    }
    if (this.#frameLength + this.#line.length + part.length > MAX_FRAME_LENGTH) {
      throw new SseDecodeError("an SSE frame exceeded the size limit");
    }
    this.#line += part;
  }

  #finishLine() {
    if (this.#line === "") return this.#finishFrame();
    this.#frameLength += this.#line.length + 1;
    if (this.#frameLength > MAX_FRAME_LENGTH) {
      throw new SseDecodeError("an SSE frame exceeded the size limit");
    }
    this.#lines.push(this.#line);
    this.#line = "";
    return null;
  }

  #finishFrame() {
    const frame = parseFrame(this.#lines.join("\n"));
    this.#lines = [];
    this.#frameLength = 0;
    return frame;
  }

  push(chunk) {
    const text = String(chunk);
    const frames = [];
    let start = 0;
    for (const match of text.matchAll(/[\r\n]/g)) {
      const index = match.index;
      if (this.#skipLf && index === start && match[0] === "\n") {
        this.#skipLf = false;
      } else {
        this.#append(text.slice(start, index));
        const frame = this.#finishLine();
        if (frame) frames.push(frame);
        this.#skipLf = match[0] === "\r";
      }
      start = index + 1;
    }
    if (start < text.length) {
      this.#skipLf = false;
      this.#append(text.slice(start));
    }
    return frames;
  }

  end() {
    if (this.#line !== "") this.#finishLine();
    this.#skipLf = false;
    const frame = this.#finishFrame();
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
