/**
 * Adapter between the CLI's registry-driven handlers and the authoritative
 * engine core adopted from `feat/engine-thin-client-v1`.
 *
 * The engine core (`contract.js`, `engine.js`, `sse.js`, `events.js`) owns the
 * pinned route catalogue, HTTP validation, SSE parsing and event assembly.
 * This module owns only the CLI-facing gate: it validates the served contract
 * version before authenticated use, proves the owner token, validates
 * identifiers and maps engine error codes onto this CLI's exit vocabulary.
 */
import { CoderaxError } from "./client.js";
import { CONTRACT_VERSION, ROUTES } from "./contract.js";
import { EngineClient } from "./engine.js";
import { isTerminalEvent } from "./events.js";

export const SUPPORTED_CONTRACT_MAJOR = 1;
export const SUPPORTED_CONTRACT_MINOR = 0;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const ROUTE_BY_OPERATION = new Map(ROUTES.map((route) => [route.operationId, route]));

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

export function routePath(operationId, params = {}) {
  const route = ROUTE_BY_OPERATION.get(operationId);
  if (!route) {
    throw new CoderaxError("CONTRACT_VIOLATION", `unknown engine operation: ${operationId}`);
  }
  return route.path.replace(/\{([^}]+)\}/g, (_match, name) => {
    const value = params[name];
    if (value === undefined) {
      throw new CoderaxError("CONTRACT_VIOLATION", `missing ${name} for ${operationId}`);
    }
    return encodeURIComponent(assertIdentifier(value, name));
  });
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

/**
 * Operation dispatcher over the adopted engine client. Handlers keep using
 * one shape while the transport stays owned by `src/engine.js`.
 */
export async function engineRequest(ctx, { operationId, params, query, body } = {}) {
  const client = clientFor(ctx);
  try {
    let response;
    switch (operationId) {
      case "listAgents":
        response = await client.agents();
        break;
      case "listModels":
        response = await client.models();
        break;
      case "submitChat":
        response = await client.chat(body);
        break;
      case "submitWork":
        response = await client.submitWork(body);
        break;
      case "getTask":
        response = await client.task(params.taskId);
        break;
      case "cancelTask":
        response = await client.cancel(params.taskId, body?.reason);
        break;
      case "resumeTask":
        response = await client.resume(params.taskId, body?.generation);
        break;
      case "retryTask":
        response = await client.retry(params.taskId, body?.generation, body?.model);
        break;
      case "listConversations":
        response = await client.conversations();
        break;
      case "getConversation":
        response = await client.conversation(params.conversationId);
        break;
      case "listMemory":
        response = await client.memory(query?.mode ?? "private");
        break;
      case "listPermissions":
        response = await client.permissions(params.taskId);
        break;
      case "decidePermission":
        response = await client.decidePermission(params.taskId, body);
        break;
      case "listNotifications":
        response = await client.notifications();
        break;
      default:
        throw new CoderaxError("CONTRACT_VIOLATION", `unknown engine operation: ${operationId}`);
    }
    return {
      status: 200,
      body: response,
      text: "",
      path: routePath(operationId, params),
    };
  } catch (error) {
    throw mapEngineError(error);
  }
}

/**
 * Replay and tail events through the adopted engine client. No reconnect is
 * attempted here: the caller can re-run with `--after` because the task is
 * durable server-side and every event is replayable.
 */
export async function* streamTaskEvents({
  baseUrl,
  token,
  taskId,
  after = 0,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!baseUrl) {
    throw new CoderaxError("BASE_URL_REQUIRED", "no engine deployment configured");
  }
  if (!token) {
    throw new CoderaxError("UNAUTHENTICATED", "no owner token configured for the engine");
  }
  const id = assertIdentifier(taskId, "taskId");
  if (!Number.isInteger(after) || after < 0) {
    throw new CoderaxError("USAGE", "--after must be a non-negative integer");
  }
  const client = new EngineClient({
    baseUrl,
    token,
    timeoutMs: 15_000,
    eventTimeoutMs: 60_000,
    fetchImpl,
  });
  try {
    for await (const event of client.events(id, { after, signal })) {
      yield event;
    }
  } catch (error) {
    throw mapEngineError(error);
  }
}

export { isTerminalEvent };
