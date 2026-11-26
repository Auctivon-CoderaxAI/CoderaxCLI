/**
 * One error vocabulary for every command.
 *
 * Exit codes are part of the CLI contract: scripts branch on them without
 * parsing prose. A code is added only when a caller can act differently.
 */
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  NETWORK: 4,
  NOT_FOUND: 5,
  UNAVAILABLE: 6,
  UNSUPPORTED: 7,
  APPROVAL: 8,
  UNCERTAIN: 9,
  CONFLICT: 10,
  CANCELLED: 130,
});

const NETWORK_CODES = new Set([
  "REQUEST_TIMEOUT",
  "REQUEST_FAILED",
  "RESPONSE_UNREADABLE",
  "RESPONSE_TOO_LARGE",
  "STREAM_INTERRUPTED",
]);

const AUTH_CODES = new Set([
  "UNAUTHENTICATED",
  "AUTH_REFRESH_FAILED",
  "AUTH_REFRESH_UNAVAILABLE",
  "unauthorized",
  "forbidden",
  "workspace_denied",
]);

const UNAVAILABLE_CODES = new Set([
  "UNAVAILABLE",
  "HEALTH_UNAVAILABLE",
  "not_ready",
  "engine_unavailable",
  "engine_not_configured",
  "model_missing",
  "OPENAPI_NOT_FOUND",
]);

const UNSUPPORTED_CODES = new Set([
  "CONTRACT_MISMATCH",
  "CONTRACT_UNSUPPORTED",
  "CAPABILITY_UNSUPPORTED",
  "EVENT_GAP",
  "PROTOCOL_ERROR",
  "paid_model_refused",
  "OPERATION_NOT_FOUND",
]);

const CONFLICT_CODES = new Set(["conflict", "busy", "TASK_BUSY", "SUBMISSION_IN_PROGRESS"]);

export class CoderaxError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message user-safe text; never contains a credential
   * @param {{status?: number, requestId?: string, retryable?: boolean, transmitted?: boolean, details?: unknown, hint?: string, exitCode?: number}} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = "CoderaxError";
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.transmitted = options.transmitted;
    this.details = options.details;
    this.hint = options.hint;
    this.exitCode = options.exitCode;
  }
}

export class UsageError extends CoderaxError {
  constructor(message, options = {}) {
    super("USAGE", message, { ...options, exitCode: EXIT.USAGE });
    this.name = "UsageError";
  }
}

export class ContractError extends CoderaxError {
  constructor(message, options = {}) {
    super("CONTRACT_MISMATCH", message, { ...options, exitCode: EXIT.UNSUPPORTED });
    this.name = "ContractError";
  }
}

export class CancelledError extends CoderaxError {
  constructor(message = "cancelled") {
    super("CANCELLED", message, { exitCode: EXIT.CANCELLED });
    this.name = "CancelledError";
  }
}

export function exitFor(error) {
  if (!error || typeof error !== "object") return EXIT.ERROR;
  if (Number.isInteger(error.exitCode)) return error.exitCode;
  const code = String(error.code ?? "");
  if (code === "CANCELLED" || error.name === "AbortError") return EXIT.CANCELLED;
  if (code === "USAGE" || code === "ENGINE_URL_REQUIRED" || code.startsWith("CONFIG_") || code.startsWith("BASE_URL_")) {
    return EXIT.USAGE;
  }
  if (code === "TIMEOUT_INVALID") return EXIT.USAGE;
  if (code === "HTTP_401" || code === "HTTP_403") return EXIT.AUTH;
  if (AUTH_CODES.has(code)) return EXIT.AUTH;
  if (code === "HTTP_404" || code === "not_found" || code === "TASK_NOT_FOUND") return EXIT.NOT_FOUND;
  if (code === "HTTP_405") return EXIT.UNSUPPORTED;
  if (NETWORK_CODES.has(code)) return EXIT.NETWORK;
  if (UNAVAILABLE_CODES.has(code)) return EXIT.UNAVAILABLE;
  if (UNSUPPORTED_CODES.has(code)) return EXIT.UNSUPPORTED;
  if (code === "PERMISSION_REQUIRED") return EXIT.APPROVAL;
  if (code === "SUBMISSION_UNCERTAIN") return EXIT.UNCERTAIN;
  if (CONFLICT_CODES.has(code)) return EXIT.CONFLICT;
  if (code === "budget_exhausted") return EXIT.ERROR;
  if (code === "validation_failed") return EXIT.USAGE;
  if (/^HTTP_\d+$/.test(code)) return EXIT.ERROR;
  return EXIT.ERROR;
}

/** A stable, redaction-safe document for `--json` failures. */
export function errorDocument(error, { command = null } = {}) {
  const code = String(error?.code ?? "ERROR");
  const document = {
    ok: false,
    command,
    error: {
      code,
      message: String(error?.message ?? "unexpected failure"),
      retryable: Boolean(error?.retryable),
      exitCode: exitFor(error),
    },
  };
  if (error?.status !== undefined) document.error.status = error.status;
  if (error?.requestId) document.error.requestId = error.requestId;
  if (error?.hint) document.error.hint = error.hint;
  if (error?.details !== undefined) document.error.details = error.details;
  return document;
}

export function successDocument(command, data) {
  return { ok: true, command, data };
}
