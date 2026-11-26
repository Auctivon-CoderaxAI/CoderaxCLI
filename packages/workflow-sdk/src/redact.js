function redactionMarker(token) {
  const preferred = "[REDACTED]";
  // A marker that shares any character with the token can form the token
  // across a replacement boundary, so require a disjoint alphabet. Short
  // tokens such as "E" are the common case where `[REDACTED]` is unsafe.
  if (![...preferred].some((char) => token.includes(char))) return preferred;
  for (const char of "*#~^|+=%0123456789") {
    if (!token.includes(char)) return char.repeat(3);
  }
  for (let code = 0x2588; code <= 0x10ffff; code += 1) {
    const char = String.fromCodePoint(code);
    if (!token.includes(char)) return char.repeat(3);
  }
  throw new Error("could not build a token-safe redaction marker");
}

export function redact(text, token) {
  if (typeof text !== "string" || !token) return text;
  return text.split(token).join(redactionMarker(token));
}

/**
 * Redact a token anywhere in a parsed JSON value, preserving the shape so
 * machine-readable output stays valid JSON.
 */
export function redactValue(value, token) {
  if (!token) return value;
  if (typeof value === "string") return redact(value, token);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, token));
  if (value !== null && typeof value === "object") {
    const redacted = {};
    const keys = new Set();
    const nextSuffix = new Map();
    for (const [key, item] of Object.entries(value)) {
      const base = redact(key, token);
      let safe = base;
      if (keys.has(base)) {
        let n = nextSuffix.get(base) ?? 2;
        let candidate = redact(`${base}#${n}`, token);
        while (keys.has(candidate)) {
          n += 1;
          candidate = redact(`${base}#${n}`, token);
        }
        safe = candidate;
        nextSuffix.set(base, n + 1);
      }
      keys.add(safe);
      Object.defineProperty(redacted, safe, {
        value: redactValue(item, token),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return redacted;
  }
  return value;
}

/**
 * Hold back a suffix that could be the beginning of a token, so a token split
 * across SSE deltas is redacted as a whole instead of leaking in two pieces.
 */
export class StreamTextRedactor {
  constructor(token) {
    this.token = token || "";
    this.pending = "";
  }

  push(text) {
    if (!this.token) return text;
    this.pending += text;
    const complete = this.pending.lastIndexOf(this.token);
    const emit = complete === -1 ? "" : this.pending.slice(0, complete + this.token.length);
    const remainder = complete === -1 ? this.pending : this.pending.slice(complete + this.token.length);
    let hold = 0;
    const max = Math.min(this.token.length - 1, remainder.length);
    for (let length = max; length > 0; length -= 1) {
      if (this.token.startsWith(remainder.slice(-length))) {
        hold = length;
        break;
      }
    }
    const safe = emit + remainder.slice(0, remainder.length - hold);
    this.pending = remainder.slice(remainder.length - hold);
    return redact(safe, this.token);
  }

  reset() {
    this.pending = "";
  }

  flush() {
    if (!this.token) return "";
    const tail = redact(this.pending, this.token);
    this.pending = "";
    return tail;
  }
}
