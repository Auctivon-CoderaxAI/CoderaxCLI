/**
 * Adapter between the CLI's registry-driven handlers and the authoritative
 * engine core adopted from `feat/engine-thin-client-v1`.
 *
 * The engine core (`contract.js`, `engine.js`, `sse.js`, `events.js`) and the
 * adopted handler surface (`engine-surface.js`) own the route catalogue, HTTP
 * validation, SSE parsing and event assembly. This module owns only the
 * CLI-facing gate: it validates the served contract version before
 * authenticated use, proves the owner token, validates identifiers and maps
 * engine error codes onto this CLI's exit vocabulary.
 */
import { CoderaxError } from "./client.js";
import { CONTRACT_VERSION } from "./contract.js";
import { EngineClient } from "./engine.js";

export const SUPPORTED_CONTRACT_MAJOR = 1;
export const SUPPORTED_CONTRACT_MINOR = 0;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * A 1.0.x server is the same contract line. Any other major or minor is
 * refused before the CLI trusts a response shape.
 */
export function assertContractVersion(served) {
  const text = typeof served === "string" ? served.trim() : "";
  const match = SEMVER.exec(text);
  if (match === null) {
    throw new CoderaxError(
      "API_VERSION_UNVERIFIED",
      `the engine did not report a semantic contract version (received ${JSON.stringify(served)}); refusing to guess compatibility`,
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== SUPPORTED_CONTRACT_MAJOR || minor !== SUPPORTED_CONTRACT_MINOR) {
    throw new CoderaxError(
      "API_VERSION_UNSUPPORTED",
      `the engine serves contract ${text}; this CLI implements ${CONTRACT_VERSION}.x`,
    );
  }
  return { version: text, major, minor, patch: Number(match[3]) };
}

export function assertIdentifier(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!IDENTIFIER.test(text)) {
    throw new CoderaxError(
      "USAGE",
      `${label} must be a single identifier (letters, digits, dot, underscore, colon, hyphen; at most 128 characters)`,
    );
  }
  return text;
}

/**
 * The engine core already maps Problem responses to its own codes. Translate
 * those to the exit codes this CLI documents.
 */
function mapEngineError(error) {
  if (!(error instanceof CoderaxError)) return error;
  switch (error.code) {
    case "unauthorized":
      return new CoderaxError("UNAUTHENTICATED", error.message, { status: error.status });
    case "forbidden":
      return new CoderaxError("FORBIDDEN", error.message, { status: error.status });
    case "not_found":
      return new CoderaxError("NOT_FOUND", error.message, { status: error.status });
    case "engine_unavailable":
    case "not_ready":
      return new CoderaxError("CAPABILITY_UNAVAILABLE", error.message, { status: error.status });
    case "STREAM_PROTOCOL":
    case "RESPONSE_UNREADABLE":
      return new CoderaxError("CONTRACT_VIOLATION", error.message, { status: error.status });
    default:
      if (typeof error.code === "string" && error.code.startsWith("CONTRACT_")) {
        return new CoderaxError("CONTRACT_VIOLATION", error.message, { status: error.status });
      }
      return error;
  }
}

function clientFor(ctx, { token = ctx.token } = {}) {
  if (!ctx.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no engine deployment configured; set CODERAX_BASE_URL or pass --base-url <url>",
    );
  }
  return new EngineClient({
    baseUrl: ctx.baseUrl,
    token: token || null,
    timeoutMs: ctx.timeoutMs,
    eventTimeoutMs: ctx.eventTimeoutMs ?? 60_000,
    fetchImpl: ctx.fetchImpl,
  });
}

/**
 * Public health check. The token is deliberately not sent to a public route.
 */
export async function engineHealth(ctx) {
  try {
    const report = await clientFor(ctx, { token: null }).health();
    const contract = assertContractVersion(report.contractVersion);
    return { report, contract, path: "/v1/health" };
  } catch (error) {
    throw mapEngineError(error);
  }
}

export async function engineReady(ctx) {
  try {
    const report = await clientFor(ctx, { token: null }).ready();
    return { report, path: "/v1/ready" };
  } catch (error) {
    throw mapEngineError(error);
  }
}

/**
 * Validate the public contract first, then prove the token is the engine owner.
 * No operation is trusted before both steps succeed.
 */
export async function connectEngine(ctx, { auth = true } = {}) {
  if (!ctx.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no engine deployment configured; set CODERAX_BASE_URL or pass --base-url <url>",
    );
  }
  const health = await engineHealth(ctx);
  if (!auth) return { ...health, agents: null };
  if (!ctx.token) {
    throw new CoderaxError(
      "UNAUTHENTICATED",
      "no owner token configured for the engine; set CODERAX_TOKEN or run coderax login against that deployment",
    );
  }
  try {
    const response = await clientFor(ctx).agents();
    if (!Array.isArray(response?.agents)) {
      throw new CoderaxError(
        "CONTRACT_VIOLATION",
        "GET /v1/agents did not return the contracted agent list",
      );
    }
    return { ...health, agents: response.agents };
  } catch (error) {
    throw mapEngineError(error);
  }
}
