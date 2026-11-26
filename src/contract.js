/**
 * Pinned WorkflowEngine contract.
 *
 * The authoritative definition lives in
 * `Auctivon-CoderaxAI/Coderax-WorkflowEngine`: `packages/contracts/src/routes.ts`
 * and the generated `openapi.json`. `@coderax/sdk` (version 1.0.0) is a private
 * workspace package and cannot be installed by this repository, so the CLI keeps
 * a read-only mirror of the published route catalogue and validates against the
 * same version. `test/contract.test.js` fails when this table stops matching the
 * committed engine document, which is the drift gate for this repository.
 *
 * Nothing here decides routing, model choice, orchestration or persistence. It
 * is a list of operations a client may call.
 */

export const CONTRACT_VERSION = "1.0.0";
export const API_PREFIX = "/v1";
export const EVENT_SCHEMA_VERSION = 1;
export const SDK_VERSION = "1.0.0";

/** Provenance for the pinned document. Update with a contract version bump. */
export const CONTRACT_SOURCE = Object.freeze({
  repository: "Auctivon-CoderaxAI/Coderax-WorkflowEngine",
  commit: "808dfd3797f9b1d7647ebd14bd395806fc4ab9bd",
  openapiPath: "openapi.json",
  openapiSha256: "4be54dc95fe8b9c00d3521e8e289807716a928bc77c61cc173401303a048cf93",
});

/**
 * Every operation the engine publishes, in the order of its route catalogue.
 * `auth: "owner"` operations require the owner bearer token; `public` ones do
 * not. A `stream` operation answers with server-sent events.
 */
export const ROUTES = Object.freeze([
  Object.freeze({ operationId: "getHealth", method: "GET", path: "/v1/health", auth: "public", stream: false }),
  Object.freeze({ operationId: "getReadiness", method: "GET", path: "/v1/ready", auth: "public", stream: false }),
  Object.freeze({ operationId: "listAgents", method: "GET", path: "/v1/agents", auth: "owner", stream: false }),
  Object.freeze({ operationId: "listModels", method: "GET", path: "/v1/models", auth: "owner", stream: false }),
  Object.freeze({ operationId: "submitChat", method: "POST", path: "/v1/chat", auth: "owner", stream: false }),
  Object.freeze({ operationId: "submitWork", method: "POST", path: "/v1/work", auth: "owner", stream: false }),
  Object.freeze({ operationId: "getTask", method: "GET", path: "/v1/work/{taskId}", auth: "owner", stream: false }),
  Object.freeze({ operationId: "cancelTask", method: "POST", path: "/v1/work/{taskId}/cancel", auth: "owner", stream: false }),
  Object.freeze({ operationId: "resumeTask", method: "POST", path: "/v1/work/{taskId}/resume", auth: "owner", stream: false }),
  Object.freeze({ operationId: "retryTask", method: "POST", path: "/v1/work/{taskId}/retry", auth: "owner", stream: false }),
  Object.freeze({ operationId: "streamTaskEvents", method: "GET", path: "/v1/work/{taskId}/events", auth: "owner", stream: true }),
  Object.freeze({ operationId: "listConversations", method: "GET", path: "/v1/conversations", auth: "owner", stream: false }),
  Object.freeze({ operationId: "getConversation", method: "GET", path: "/v1/conversations/{conversationId}", auth: "owner", stream: false }),
  Object.freeze({ operationId: "listMemory", method: "GET", path: "/v1/memory", auth: "owner", stream: false }),
  Object.freeze({ operationId: "listPermissions", method: "GET", path: "/v1/work/{taskId}/permissions", auth: "owner", stream: false }),
  Object.freeze({ operationId: "decidePermission", method: "POST", path: "/v1/work/{taskId}/permissions", auth: "owner", stream: false }),
  Object.freeze({ operationId: "listNotifications", method: "GET", path: "/v1/notifications", auth: "owner", stream: false }),
]);

const routeIndex = new Map(ROUTES.map((route) => [route.operationId, route]));

export function routeFor(operationId) {
  const route = routeIndex.get(operationId);
  if (!route) throw new Error(`unknown workflow-engine operation: ${operationId}`);
  return route;
}

export function taskPath(taskId, suffix = "") {
  return `/v1/work/${encodeURIComponent(taskId)}${suffix}`;
}

export function conversationPath(conversationId) {
  return `/v1/conversations/${encodeURIComponent(conversationId)}`;
}

export const TERMINAL_TASK_STATES = Object.freeze(["completed", "failed", "cancelled", "interrupted"]);

export const TERMINAL_EVENT_TYPES = Object.freeze([
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.interrupted",
]);

export const KNOWN_EVENT_TYPES = Object.freeze([
  "task.queued",
  "task.started",
  "step.started",
  "step.completed",
  "text.delta",
  "text.replace",
  "tool.call",
  "tool.result",
  "file.edit",
  "approval.required",
  "usage",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.interrupted",
]);

export const KNOWN_AGENTS = Object.freeze(["coderax", "opencode", "freebuff"]);
export const DATA_MODES = Object.freeze(["private", "cloud"]);

/**
 * The engine has no upload or download operation in contract 1.0.0. Task status
 * exposes artifact metadata only. Reporting this is part of capability
 * discovery; pretending otherwise would advertise a feature that cannot work.
 */
export const CAPABILITIES = Object.freeze({
  streaming: true,
  tools: true,
  cancellation: true,
  resume: true,
  modelSelection: true,
  durable: true,
  fileTransfers: false,
  artifactMetadata: true,
});

export function contractBanner() {
  return `workflow-engine ${CONTRACT_VERSION} (events v${EVENT_SCHEMA_VERSION})`;
}
