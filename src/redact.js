/**
 * Redaction is a boundary, not a formatting concern.
 *
 * The owner token and any credential-shaped environment value the process can
 * see are removed from every output path: human text, JSON values, JSON keys,
 * SSE deltas, error diagnostics and persisted journals. A marker is always
 * disjoint from every secret so a replacement can never reassemble one across
 * a boundary.
 */

function preferredMarker() {
  return "[REDACTED]";
}

function markerDisjoint(secrets) {
  const preferred = preferredMarker();
  const collides = (candidate) => secrets.some((secret) => [...candidate].some((char) => secret.includes(char)));
  if (!collides(preferred)) return preferred;
  for (const char of "*#~^|+=%0123456789") {
    if (!secrets.some((secret) => secret.includes(char))) return char.repeat(3);
  }
  for (let code = 0x2588; code <= 0x10ffff; code += 1) {
    const char = String.fromCodePoint(code);
    if (!secrets.some((secret) => secret.includes(char))) return char.repeat(3);
  }
  throw new Error("could not build a secret-safe redaction marker");
}

export function normalizeSecrets(input) {
  const list = Array.isArray(input) ? input : [input];
  const unique = new Set();
  for (const value of list) {
    if (typeof value !== "string" || value.length === 0) continue;
    unique.add(value);
  }
  // Longest first so a secret that contains another is replaced whole.
  return [...unique].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export function createRedactor(input) {
  const secrets = normalizeSecrets(input);
  const marker = markerDisjoint(secrets);
  const pattern = secrets.length === 0
    ? null
    : new RegExp(secrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");

  const redactText = (text) => {
    if (typeof text !== "string" || pattern === null) return text;
    return text.replace(pattern, marker);
  };

  const redactValue = (value) => {
    if (pattern === null) return value;
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value !== null && typeof value === "object") {
      const output = {};
      const keys = new Set();
      const nextSuffix = new Map();
      for (const [key, item] of Object.entries(value)) {
        const base = redactText(key);
        let safe = base;
        if (keys.has(base)) {
          let n = nextSuffix.get(base) ?? 2;
          let candidate = redactText(`${base}#${n}`);
          while (keys.has(candidate)) {
            n += 1;
            candidate = redactText(`${base}#${n}`);
          }
          safe = candidate;
          nextSuffix.set(base, n + 1);
        }
        keys.add(safe);
        // defineProperty keeps a `__proto__` entry an own field.
        Object.defineProperty(output, safe, {
          value: redactValue(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return output;
    }
    return value;
  };

  const redactError = (error) => {
    if (!(error instanceof Error)) return redactText(String(error));
    error.message = redactText(error.message);
    return error;
  };

  return {
    secrets,
    marker,
    active: pattern !== null,
    redact: redactText,
    redactValue,
    redactError,
    stream: () => new StreamRedactor(secrets, redactText),
  };
}

/** Backwards-compatible single-secret helper. */
export function redact(text, token) {
  if (typeof text !== "string" || !token) return text;
  return createRedactor([token]).redact(text);
}

export function redactValue(value, token) {
  if (!token) return value;
  return createRedactor([token]).redactValue(value);
}

/**
 * Holds back a suffix that could be the beginning of a secret, so a token split
 * across SSE deltas is removed as a whole instead of leaking in two pieces.
 */
export class StreamRedactor {
  constructor(secrets, redactText) {
    this.secrets = normalizeSecrets(secrets);
    this.redactText = redactText;
    this.pending = "";
    this.maxLength = this.secrets.reduce((max, secret) => Math.max(max, secret.length), 0);
  }

  push(text) {
    if (this.secrets.length === 0) return text;
    if (typeof text !== "string" || text.length === 0) return "";
    this.pending += text;
    const hold = this.#holdLength();
    const safeEnd = this.pending.length - hold;
    const safe = this.pending.slice(0, safeEnd);
    this.pending = this.pending.slice(safeEnd);
    return this.redactText(safe);
  }

  #holdLength() {
    const limit = Math.min(this.maxLength, this.pending.length);
    for (let length = limit; length > 0; length -= 1) {
      const suffix = this.pending.slice(-length);
      if (this.secrets.some((secret) => secret.startsWith(suffix))) {
        return length;
      }
    }
    return 0;
  }

  flush() {
    if (this.pending.length === 0) return "";
    const tail = this.redactText(this.pending);
    this.pending = "";
    return tail;
  }

  reset() {
    this.pending = "";
  }
}

const SENSITIVE_ENV = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|(?:^|_)pat(?:$|_))/i;

/**
 * Values of credential-shaped environment variables this process can see.
 * They are redacted even if the CLI never uses them, so an upstream echo cannot
 * turn an unrelated provider key into terminal output.
 */
export function environmentSecrets(env = process.env) {
  const values = [];
  for (const [name, value] of Object.entries(env)) {
    if (!SENSITIVE_ENV.test(name)) continue;
    if (typeof value !== "string" || value.length < 8) continue;
    values.push(value);
  }
  return values;
}
