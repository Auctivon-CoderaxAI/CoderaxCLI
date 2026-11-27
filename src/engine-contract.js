import { createHash } from "node:crypto";

/**
 * Pinned WorkflowEngine contract.
 *
 * The authoritative definition is `Auctivon-CoderaxAI/Coderax-WorkflowEngine`
 * pull request #7 (`feat/contracts`, head
 * `a048a0283e6aa32531f7a6c1b74034843230ab0f`): `packages/contracts/src/routes.ts`
 * and the generated `openapi.json`. The CLI keeps a byte-for-byte copy of that
 * document in `contracts/workflow-engine-1.2.0.openapi.json` and a route table
 * derived from it. `test/engine-contract.test.js` refuses a table, version,
 * fingerprint or digest that no longer matches the document.
 *
 * This module is a *contract consumer*, not a second API authority. It contains
 * no routing, orchestration, model selection or persistence. The canonical SDK
 * is `@coderax/sdk` 1.2.0 from the same commit; its artifact digest is pinned in
 * `contracts/workflow-engine-sdk-pin.json`.
 */

export const CONTRACT_VERSION = "1.2.0";
export const CONTRACT_MAJOR = 1;
export const SUPPORTED_CONTRACT_VERSIONS = Object.freeze(["1.0.0", "1.1.0", "1.2.0"]);
export const API_PREFIX = "/v1";
export const EVENT_SCHEMA_VERSION = 1;
export const CHAT_STREAM_VERSION = 1;

/** The catalogue identity the server reports in `GET /v1/handshake`. */
export const CONTRACT_FINGERPRINT =
  "sha256:dd90179e40429ed4e91b75e0e3606be668c8fd1a7cf068d1f2c4f329b4516f21";

export const CONTRACT_SOURCE = Object.freeze({
  repository: "Auctivon-CoderaxAI/Coderax-WorkflowEngine",
  pullRequest: 7,
  branch: "freebuff/5e5de30e8775a8e9225cc0e2",
  commit: "a048a0283e6aa32531f7a6c1b74034843230ab0f",
  openapiPath: "contracts/workflow-engine-1.2.0.openapi.json",
  openapiSha256: "7d73c5cdf58554fcd807b6c08f00fb42135762ea0e97b74cd62e274733b0efa1",
  sdkPackage: "@coderax/sdk",
  sdkVersion: "1.2.0",
  sdkArtifact: "artifacts/coderax-sdk-1.2.0.tgz",
  sdkArtifactSha256: "223ce865ae0ccea8caf6246e35e1e3e0f486bbca3930e02ccaf6fe1f7a187a8c",
  sdkArtifactBytes: 40144,
});

/**
 * Every operation the engine publishes at contract 1.2.0, in catalogue order.
 * `auth: "owner"` operations require the owner bearer token. `stream` marks an
 * operation whose success response can be server-sent events.
 */
export const ROUTES = Object.freeze([
  ["getHealth", "GET", "/v1/health", "public", false],
  ["getReadiness", "GET", "/v1/ready", "public", false],
  ["getHandshake", "GET", "/v1/handshake", "owner", false],
  ["listAgents", "GET", "/v1/agents", "owner", false],
  ["listModels", "GET", "/v1/models", "owner", false],
  ["submitChat", "POST", "/v1/chat", "owner", true],
  ["submitWork", "POST", "/v1/work", "owner", false],
  ["listTasks", "GET", "/v1/tasks", "owner", false],
  ["listWork", "GET", "/v1/work", "owner", false],
  ["getTask", "GET", "/v1/work/{taskId}", "owner", false],
  ["cancelTask", "POST", "/v1/work/{taskId}/cancel", "owner", false],
  ["resumeTask", "POST", "/v1/work/{taskId}/resume", "owner", false],
  ["retryTask", "POST", "/v1/work/{taskId}/retry", "owner", false],
  ["streamTaskEvents", "GET", "/v1/work/{taskId}/events", "owner", true],
  ["listArtifacts", "GET", "/v1/artifacts", "owner", false],
  ["uploadArtifact", "POST", "/v1/artifacts", "owner", false],
  ["pruneArtifacts", "POST", "/v1/artifacts/prune", "owner", false],
  ["getArtifact", "GET", "/v1/artifacts/{artifactId}", "owner", false],
  ["uploadArtifactVersion", "POST", "/v1/artifacts/{artifactId}/versions", "owner", false],
  ["listArtifactVersions", "GET", "/v1/artifacts/{artifactId}/versions", "owner", false],
  ["downloadArtifact", "GET", "/v1/artifacts/{artifactId}/content", "owner", false],
  ["exportArtifact", "GET", "/v1/artifacts/{artifactId}/export", "owner", false],
  ["deleteArtifact", "POST", "/v1/artifacts/{artifactId}/delete", "owner", false],
  ["listTaskArtifacts", "GET", "/v1/work/{taskId}/artifacts", "owner", false],
  ["createTaskArtifact", "POST", "/v1/work/{taskId}/artifacts", "owner", false],
  ["getTaskArtifact", "GET", "/v1/work/{taskId}/artifacts/{artifactId}", "owner", false],
  ["listConversations", "GET", "/v1/conversations", "owner", false],
  ["getConversation", "GET", "/v1/conversations/{conversationId}", "owner", false],
  ["listMemory", "GET", "/v1/memory", "owner", false],
  ["writeMemory", "POST", "/v1/memory", "owner", false],
  ["deleteMemory", "POST", "/v1/memory/delete", "owner", false],
  ["searchMemory", "GET", "/v1/memory/search", "owner", false],
  ["listPermissions", "GET", "/v1/work/{taskId}/permissions", "owner", false],
  ["decidePermission", "POST", "/v1/work/{taskId}/permissions", "owner", false],
  ["listNotifications", "GET", "/v1/notifications", "owner", false],
  ["markNotificationRead", "POST", "/v1/notifications/{taskId}", "owner", false],
  ["listSchedules", "GET", "/v1/schedules", "owner", false],
  ["createSchedule", "POST", "/v1/schedules", "owner", false],
  ["controlSchedule", "POST", "/v1/schedules/{scheduleId}", "owner", false],
  ["deleteSchedule", "DELETE", "/v1/schedules/{scheduleId}", "owner", false],
].map(([operationId, method, path, auth, stream]) =>
  Object.freeze({ operationId, method, path, auth, stream }),
));

export const ROUTE_BY_OPERATION = new Map(
  ROUTES.map((route) => [route.operationId, route]),
);

/** `TaskState` in the engine contract. */
export const TASK_STATES = Object.freeze([
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const TERMINAL_TASK_STATES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** `ExecutionEventType` in the engine contract (schema version 1). */
export const EXECUTION_EVENT_TYPES = Object.freeze([
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
  "stream.truncated",
]);

export const TERMINAL_EVENT_TYPES = Object.freeze([
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.interrupted",
]);

export const TASK_OUTCOMES = Object.freeze([
  "accepted",
  "already_terminal",
  "not_found",
  "superseded",
]);

export const KNOWN_AGENTS = Object.freeze(["coderax", "opencode", "freebuff"]);
export const DATA_MODES = Object.freeze(["private", "cloud"]);

/**
 * The fingerprint algorithm is the engine's own (`packages/contracts/src/
 * fingerprint.ts`): a version line followed by every operation id, method and
 * path in catalogue order, hashed with SHA-256. Reproducing it here lets the
 * client detect a same-version catalogue collision during the handshake.
 */
export function contractFingerprint(routes = ROUTES, version = CONTRACT_VERSION) {
  const manifest = [
    `contract ${version}`,
    ...routes.map((route) => `${route.operationId} ${route.method} ${route.path}`),
  ].join("\n");
  return `sha256:${createHash("sha256").update(manifest, "utf8").digest("hex")}`;
}

export function routeFor(operationId) {
  const route = ROUTE_BY_OPERATION.get(operationId);
  if (!route) throw new Error(`unknown workflow-engine operation: ${operationId}`);
  return route;
}

export function taskPath(taskId, suffix = "") {
  return `/v1/work/${encodeURIComponent(taskId)}${suffix}`;
}

export function conversationPath(conversationId) {
  return `/v1/conversations/${encodeURIComponent(conversationId)}`;
}

export function artifactPath(artifactId, suffix = "") {
  return `/v1/artifacts/${encodeURIComponent(artifactId)}${suffix}`;
}

export function schedulePath(scheduleId) {
  return `/v1/schedules/${encodeURIComponent(scheduleId)}`;
}

export function isTerminalTaskState(state) {
  return TERMINAL_TASK_STATES.includes(state);
}

export function isTerminalEventType(type) {
  return TERMINAL_EVENT_TYPES.includes(type);
}

export function contractBanner() {
  return `workflow-engine ${CONTRACT_VERSION} (events v${EVENT_SCHEMA_VERSION}, chat v${CHAT_STREAM_VERSION})`;
}
