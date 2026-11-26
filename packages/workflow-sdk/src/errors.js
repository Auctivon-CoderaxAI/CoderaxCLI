/**
 * Typed SDK failure. `code` is stable and machine-readable; the CLI maps it to
 * an exit code, and contract tests assert it rather than matching prose.
 */
export class SdkError extends Error {
  constructor(code, message, { status = null, details = null, retryable = false } = {}) {
    super(message);
    this.name = "SdkError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }
}

export function isSdkError(error) {
  return error instanceof SdkError;
}

/** Codes that mean the deployment cannot satisfy the client contract. */
export const CONTRACT_CODES = Object.freeze([
  "CONTRACT_VIOLATION",
  "STREAM_INCOMPLETE",
  "RESUME_UNSUPPORTED",
  "API_VERSION_UNSUPPORTED",
  "API_VERSION_UNVERIFIED",
  "CAPABILITY_UNAVAILABLE",
  "OWNER_UNVERIFIABLE",
  "UNKNOWN_RUN_STATUS",
]);

export function diagnostic(code, message, severity = "warning") {
  return { code, message, severity };
}
