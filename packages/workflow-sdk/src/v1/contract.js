/**
 * WorkflowEngine `/v1` wire contract.
 *
 * This module is the shared SDK's mirror of the engine's published contract.
 * It does not define a second contract: every route, version and payload shape
 * comes from the engine's generated `openapi.json` plus the `@coderax/contracts`
 * schemas the engine validates against. The mirror exists because
 * `@coderax/contracts` and `@coderax/sdk` are `private: true` workspace packages
 * and are not published to a registry this project can install from.
 *
 * Version policy:
 *
 * - The engine's authoritative HTTP contract is `1.0.0` at commit `7b7c9d7a`.
 * - A client accepts any server that reports major `1`, and records a
 *   diagnostic when the server's minor version is newer than this mirror.
 * - A server that reports a different major is refused with
 *   `CONTRACT_UNSUPPORTED`; there is no silent downgrade and no best-effort
 *   parsing of an unknown contract.
 *
 * A drifted payload is a named `CONTRACT_VIOLATION` at the client boundary, not
 * a plausible but wrong value.
 */

import { SdkError } from "../errors.js";

/** Version of the document this mirror was generated from. */
export const CONTRACT_VERSION = "1.0.0";
export const CONTRACT_MAJOR = 1;
export const CONTRACT_MINOR = 0;
export const EVENT_SCHEMA_VERSION = 1;
export const API_PREFIX = "/v1";
export const SDK_NAME = "@coderax/sdk";
export const SDK_VERSION = "1.0.0";

/**
 * Provenance of the vendored OpenAPI document. `contracts/PROVENANCE.md` and
 * `test/v1-contract.test.js` verify the digest offline; `scripts/check.js`
 * verifies it in CI.
 */
export const CONTRACT_SOURCE = Object.freeze({
  repository: "Auctivon-CoderaxAI/Coderax-WorkflowEngine",
  commit: "7b7c9d7a88b8e483995ebe445f2bbbdd29050229",
  document: "openapi.json",
  openapiSha256: "66add22a0d38405e9aaa49a62a9e463648df00457ce0b0080e3cca240c9736f4", // gitleaks:allow — published OpenAPI SHA-256 digest
});

/** Published `/v1` operations. A route outside this catalogue is not invented. */
export const ROUTE = Object.freeze({
  health: "/v1/health",
  ready: "/v1/ready",
  agents: "/v1/agents",
  models: "/v1/models",
  chat: "/v1/chat",
  work: "/v1/work",
  task: (taskId) => `/v1/work/${encodeURIComponent(taskId)}`,
  cancel: (taskId) => `/v1/work/${encodeURIComponent(taskId)}/cancel`,
  resume: (taskId) => `/v1/work/${encodeURIComponent(taskId)}/resume`,
  retry: (taskId) => `/v1/work/${encodeURIComponent(taskId)}/retry`,
  events: (taskId) => `/v1/work/${encodeURIComponent(taskId)}/events`,
  conversations: "/v1/conversations",
  conversation: (conversationId) => `/v1/conversations/${encodeURIComponent(conversationId)}`,
  memory: "/v1/memory",
  permissions: (taskId) => `/v1/work/${encodeURIComponent(taskId)}/permissions`,
  notifications: "/v1/notifications",
});

export const AGENT_IDS = Object.freeze(["coderax", "opencode", "freebuff"]);
export const ENGINE_IDS = Object.freeze(["native", "opencode", "freebuff"]);
export const DATA_MODES = Object.freeze(["private", "cloud"]);
/** Work submission may let the engine choose; a status only reports the result. */
export const WORK_REASONING_MODES = Object.freeze(["auto", "fast", "complex"]);
export const TASK_REASONING_MODES = Object.freeze(["fast", "complex"]);
export const TASK_STATES = Object.freeze([
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export const TERMINAL_TASK_STATES = Object.freeze(["completed", "failed", "cancelled", "interrupted"]);
export const EVENT_TYPES = Object.freeze([
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
export const TERMINAL_EVENT_TYPES = Object.freeze([
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.interrupted",
]);
export const PROBLEM_CODES = Object.freeze([
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_failed",
  "conflict",
  "busy",
  "not_ready",
  "engine_unavailable",
  "engine_not_configured",
  "model_missing",
  "workspace_denied",
  "budget_exhausted",
  "paid_model_refused",
  "permission_required",
  "cancelled",
  "protocol_error",
  "internal_error",
]);
export const PERMISSION_SCOPES = Object.freeze([
  "workspace.read",
  "workspace.write",
  "command.execute",
  "network.access",
  "memory.read",
  "conversation.read",
  "credential.use",
]);
export const ENGINE_FAILURE_CODES = Object.freeze([
  "disabled",
  "sdk_unavailable",
  "not_configured",
  "server_unavailable",
  "workspace_denied",
  "busy",
  "timeout",
  "cancelled",
  "protocol_error",
  "provider_error",
  "budget_exhausted",
  "paid_model_refused",
]);
export const AVAILABILITY_REASONS = Object.freeze([
  "ready",
  "disabled",
  "not_configured",
  "sdk_unavailable",
  "server_unavailable",
  "model_missing",
  "forbidden",
  "not_ready",
]);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function violation(path, message) {
  throw new SdkError("CONTRACT_VIOLATION", `contract violation at ${path}: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value, path, required, optional = []) {
  if (!isPlainObject(value)) violation(path, "expected an object");
  const keys = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) violation(`${path}.${key}`, "unexpected field");
  }
  for (const key of required) {
    if (!(key in value)) violation(`${path}.${key}`, "required field is missing");
  }
  return value;
}

function string(value, path, { min = 0, max = Infinity, pattern } = {}) {
  if (typeof value !== "string") violation(path, "expected a string");
  if (value.length < min) violation(path, `must contain at least ${min} characters`);
  if (value.length > max) violation(path, `must contain at most ${max} characters`);
  if (pattern && !pattern.test(value)) violation(path, "has an invalid format");
  return value;
}

function identifier(value, path, max = 128) {
  string(value, path, { min: 1, max });
  if (value.trim().length === 0) violation(path, "must not be blank");
  return value;
}

function integer(value, path, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value)) violation(path, "expected an integer");
  if (value < min) violation(path, `must be at least ${min}`);
  if (value > max) violation(path, `must be at most ${max}`);
  return value;
}

function boolean(value, path) {
  if (typeof value !== "boolean") violation(path, "expected a boolean");
  return value;
}

function literal(value, expected, path) {
  if (value !== expected) violation(path, `expected ${JSON.stringify(expected)}`);
  return value;
}

function oneOf(value, allowed, path) {
  if (!allowed.includes(value)) violation(path, `expected one of ${allowed.join(", ")}`);
  return value;
}

function array(value, path, item, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(value)) violation(path, "expected an array");
  if (value.length < min) violation(path, `must contain at least ${min} items`);
  if (value.length > max) violation(path, `must contain at most ${max} items`);
  value.forEach((entry, index) => item(entry, `${path}[${index}]`));
  return value;
}

function iso(value, path) {
  string(value, path, { min: 20, max: 40, pattern: ISO });
  if (Number.isNaN(Date.parse(value))) violation(path, "is not a valid date");
  return value;
}

function optional(value, path, check) {
  if (value === undefined) return undefined;
  return check(value, path);
}

export function assertProblem(value, path = "problem") {
  object(value, path, ["type", "title", "status", "code", "retryable"], ["detail", "requestId"]);
  string(value.type, `${path}.type`, { min: 1, max: 200 });
  string(value.title, `${path}.title`, { min: 1, max: 200 });
  integer(value.status, `${path}.status`, { min: 400, max: 599 });
  oneOf(value.code, PROBLEM_CODES, `${path}.code`);
  optional(value.detail, `${path}.detail`, (v, p) => string(v, p, { max: 2000 }));
  optional(value.requestId, `${path}.requestId`, identifier);
  boolean(value.retryable, `${path}.retryable`);
  return value;
}

function capabilities(value, path) {
  object(value, path, ["streaming", "tools", "cancellation", "resume", "modelSelection", "durable"]);
  for (const key of ["streaming", "tools", "cancellation", "resume", "modelSelection", "durable"]) {
    boolean(value[key], `${path}.${key}`);
  }
  return value;
}

function availability(value, path) {
  object(value, path, ["available", "reason", "detail"]);
  boolean(value.available, `${path}.available`);
  oneOf(value.reason, AVAILABILITY_REASONS, `${path}.reason`);
  string(value.detail, `${path}.detail`, { max: 500 });
  return value;
}

function checks(value, path) {
  array(value, path, (entry, entryPath) => {
    object(entry, entryPath, ["name", "status", "required"], ["detail"]);
    string(entry.name, `${entryPath}.name`, { min: 1, max: 80 });
    oneOf(entry.status, ["ok", "degraded", "failed"], `${entryPath}.status`);
    boolean(entry.required, `${entryPath}.required`);
    optional(entry.detail, `${entryPath}.detail`, (v, p) => string(v, p, { max: 500 }));
  });
}

export function assertHealth(value, path = "health") {
  object(value, path, ["status", "contractVersion", "startedAt", "uptimeMs", "checks", "engines"]);
  oneOf(value.status, ["ok", "degraded", "failed"], `${path}.status`);
  string(value.contractVersion, `${path}.contractVersion`, { min: 1, max: 20 });
  iso(value.startedAt, `${path}.startedAt`);
  integer(value.uptimeMs, `${path}.uptimeMs`, { min: 0 });
  checks(value.checks, `${path}.checks`);
  array(value.engines, `${path}.engines`, (entry, entryPath) => {
    object(entry, entryPath, ["id", "capabilities", "availability"]);
    string(entry.id, `${entryPath}.id`, { min: 1, max: 40 });
    capabilities(entry.capabilities, `${entryPath}.capabilities`);
    availability(entry.availability, `${entryPath}.availability`);
  });
  return value;
}

export function assertReadiness(value, path = "readiness") {
  object(value, path, ["ready", "missing", "checks"]);
  boolean(value.ready, `${path}.ready`);
  array(value.missing, `${path}.missing`, (entry, entryPath) => string(entry, entryPath, { max: 120 }));
  checks(value.checks, `${path}.checks`);
  return value;
}

export function assertAgentList(value, path = "agents") {
  object(value, path, ["agents"]);
  array(value.agents, `${path}.agents`, (entry, entryPath) => {
    object(entry, entryPath, [
      "id", "engine", "label", "external", "capabilities", "availability", "isolation",
    ]);
    oneOf(entry.id, AGENT_IDS, `${entryPath}.id`);
    oneOf(entry.engine, ENGINE_IDS, `${entryPath}.engine`);
    string(entry.label, `${entryPath}.label`, { min: 1, max: 80 });
    boolean(entry.external, `${entryPath}.external`);
    capabilities(entry.capabilities, `${entryPath}.capabilities`);
    availability(entry.availability, `${entryPath}.availability`);
    object(entry.isolation, `${entryPath}.isolation`, ["workspace", "memory", "credentials", "conversations"]);
    literal(entry.isolation.workspace, "isolated", `${entryPath}.isolation.workspace`);
    oneOf(entry.isolation.memory, ["none", "granted"], `${entryPath}.isolation.memory`);
    oneOf(entry.isolation.credentials, ["none", "scoped"], `${entryPath}.isolation.credentials`);
    oneOf(entry.isolation.conversations, ["none", "granted"], `${entryPath}.isolation.conversations`);
  });
  return value;
}

function modelRef(value, path) {
  object(value, path, ["providerId", "modelId"]);
  identifier(value.providerId, `${path}.providerId`, 64);
  identifier(value.modelId, `${path}.modelId`, 160);
  return value;
}

function usage(value, path) {
  object(value, path, [], ["inputTokens", "outputTokens"]);
  optional(value.inputTokens, `${path}.inputTokens`, (v, p) => integer(v, p, { min: 0 }));
  optional(value.outputTokens, `${path}.outputTokens`, (v, p) => integer(v, p, { min: 0 }));
  return value;
}

export function assertModelList(value, path = "models") {
  object(value, path, ["models", "route", "allowPaid"]);
  array(value.models, `${path}.models`, (entry, entryPath) => {
    object(entry, entryPath, ["ref", "label", "costClass", "toolCalling", "streaming", "availability"], ["contextTokens"]);
    modelRef(entry.ref, `${entryPath}.ref`);
    string(entry.label, `${entryPath}.label`, { min: 1, max: 160 });
    oneOf(entry.costClass, ["free", "paid"], `${entryPath}.costClass`);
    optional(entry.contextTokens, `${entryPath}.contextTokens`, (v, p) => integer(v, p, { min: 1 }));
    boolean(entry.toolCalling, `${entryPath}.toolCalling`);
    boolean(entry.streaming, `${entryPath}.streaming`);
    availability(entry.availability, `${entryPath}.availability`);
  });
  array(value.route, `${path}.route`, modelRef);
  literal(value.allowPaid, false, `${path}.allowPaid`);
  return value;
}

export function assertChatReply(value, path = "chat") {
  object(value, path, ["conversationId", "messageId", "text", "agent", "model", "createdAt"], ["usage"]);
  identifier(value.conversationId, `${path}.conversationId`);
  identifier(value.messageId, `${path}.messageId`);
  string(value.text, `${path}.text`);
  oneOf(value.agent, AGENT_IDS, `${path}.agent`);
  modelRef(value.model, `${path}.model`);
  optional(value.usage, `${path}.usage`, usage);
  iso(value.createdAt, `${path}.createdAt`);
  return value;
}

export function assertTaskAccepted(value, path = "task") {
  object(value, path, ["taskId", "conversationId", "state", "generation", "eventsPath"]);
  identifier(value.taskId, `${path}.taskId`);
  identifier(value.conversationId, `${path}.conversationId`);
  oneOf(value.state, TASK_STATES, `${path}.state`);
  integer(value.generation, `${path}.generation`, { min: 0 });
  string(value.eventsPath, `${path}.eventsPath`, { min: 1, max: 300 });
  return value;
}

export function assertTaskStatus(value, path = "task") {
  object(value, path, [
    "taskId", "conversationId", "state", "agent", "mode", "generation",
    "createdAt", "updatedAt", "cancelRequested", "steps",
  ], ["model", "reasoning", "leaseExpiresAt", "result", "usage", "failure"]);
  identifier(value.taskId, `${path}.taskId`);
  identifier(value.conversationId, `${path}.conversationId`);
  oneOf(value.state, TASK_STATES, `${path}.state`);
  oneOf(value.agent, AGENT_IDS, `${path}.agent`);
  oneOf(value.mode, DATA_MODES, `${path}.mode`);
  optional(value.model, `${path}.model`, modelRef);
  optional(value.reasoning, `${path}.reasoning`, (v, p) => oneOf(v, TASK_REASONING_MODES, p));
  integer(value.generation, `${path}.generation`, { min: 0 });
  iso(value.createdAt, `${path}.createdAt`);
  iso(value.updatedAt, `${path}.updatedAt`);
  optional(value.leaseExpiresAt, `${path}.leaseExpiresAt`, iso);
  boolean(value.cancelRequested, `${path}.cancelRequested`);
  array(value.steps, `${path}.steps`, (entry, entryPath) => {
    object(entry, entryPath, ["id", "title", "state"], ["dependsOn", "attempts"]);
    string(entry.id, `${entryPath}.id`, { min: 1, max: 80 });
    string(entry.title, `${entryPath}.title`, { max: 200 });
    oneOf(entry.state, TASK_STATES, `${entryPath}.state`);
    optional(entry.dependsOn, `${entryPath}.dependsOn`, (v, p) =>
      array(v, p, (id, idPath) => string(id, idPath, { min: 1, max: 80 }), { max: 64 }),
    );
    optional(entry.attempts, `${entryPath}.attempts`, (v, p) => integer(v, p, { min: 0 }));
  });
  optional(value.result, `${path}.result`, (entry, entryPath) => {
    object(entry, entryPath, ["artifacts"], ["summary", "verification"]);
    optional(entry.summary, `${entryPath}.summary`, (v, p) => string(v, p, { max: 20_000 }));
    array(entry.artifacts, `${entryPath}.artifacts`, (artifact, artifactPath) => {
      object(artifact, artifactPath, ["path"], ["bytes", "digest"]);
      string(artifact.path, `${artifactPath}.path`, { min: 1, max: 1024 });
      optional(artifact.bytes, `${artifactPath}.bytes`, (v, p) => integer(v, p, { min: 0 }));
      optional(artifact.digest, `${artifactPath}.digest`, (v, p) => string(v, p, { min: 1, max: 128 }));
    });
    optional(entry.verification, `${entryPath}.verification`, (verification, verificationPath) => {
      object(verification, verificationPath, ["passed", "reason", "evidence"]);
      boolean(verification.passed, `${verificationPath}.passed`);
      string(verification.reason, `${verificationPath}.reason`, { max: 1000 });
      array(
        verification.evidence,
        `${verificationPath}.evidence`,
        (item, itemPath) => string(item, itemPath, { max: 500 }),
        { max: 20 },
      );
    });
  });
  optional(value.usage, `${path}.usage`, usage);
  optional(value.failure, `${path}.failure`, (entry, entryPath) => {
    object(entry, entryPath, ["code"], ["detail"]);
    string(entry.code, `${entryPath}.code`, { min: 1, max: 60 });
    optional(entry.detail, `${entryPath}.detail`, (v, p) => string(v, p, { max: 1000 }));
  });
  return value;
}

export function assertTaskControl(value, path = "control") {
  object(value, path, ["taskId", "state", "generation", "outcome"]);
  identifier(value.taskId, `${path}.taskId`);
  oneOf(value.state, TASK_STATES, `${path}.state`);
  integer(value.generation, `${path}.generation`, { min: 0 });
  oneOf(value.outcome, ["accepted", "already_terminal", "not_found", "superseded"], `${path}.outcome`);
  return value;
}

export function assertConversationList(value, path = "conversations") {
  object(value, path, ["conversations"]);
  array(value.conversations, `${path}.conversations`, (entry, entryPath) => {
    object(entry, entryPath, ["conversationId", "isWork", "agent", "updatedAt"], ["title"]);
    identifier(entry.conversationId, `${entryPath}.conversationId`);
    optional(entry.title, `${entryPath}.title`, (v, p) => string(v, p, { max: 300 }));
    boolean(entry.isWork, `${entryPath}.isWork`);
    oneOf(entry.agent, AGENT_IDS, `${entryPath}.agent`);
    iso(entry.updatedAt, `${entryPath}.updatedAt`);
  });
  return value;
}

export function assertConversation(value, path = "conversation") {
  object(value, path, [
    "conversationId", "mode", "isWork", "agent", "createdAt", "updatedAt", "messages",
  ], ["title"]);
  identifier(value.conversationId, `${path}.conversationId`);
  optional(value.title, `${path}.title`, (v, p) => string(v, p, { max: 300 }));
  oneOf(value.mode, DATA_MODES, `${path}.mode`);
  boolean(value.isWork, `${path}.isWork`);
  oneOf(value.agent, AGENT_IDS, `${path}.agent`);
  iso(value.createdAt, `${path}.createdAt`);
  iso(value.updatedAt, `${path}.updatedAt`);
  array(value.messages, `${path}.messages`, (entry, entryPath) => {
    object(entry, entryPath, ["messageId", "conversationId", "role", "text", "createdAt"], ["unfinished", "agent"]);
    identifier(entry.messageId, `${entryPath}.messageId`);
    identifier(entry.conversationId, `${entryPath}.conversationId`);
    oneOf(entry.role, ["user", "assistant", "tool"], `${entryPath}.role`);
    string(entry.text, `${entryPath}.text`);
    iso(entry.createdAt, `${entryPath}.createdAt`);
    optional(entry.unfinished, `${entryPath}.unfinished`, boolean);
    optional(entry.agent, `${entryPath}.agent`, (v, p) => oneOf(v, AGENT_IDS, p));
  });
  return value;
}

export function assertMemoryList(value, path = "memory") {
  object(value, path, ["entries"]);
  array(value.entries, `${path}.entries`, (entry, entryPath) => {
    object(entry, entryPath, ["key", "value", "mode", "updatedAt"]);
    string(entry.key, `${entryPath}.key`, { min: 1, max: 200 });
    string(entry.value, `${entryPath}.value`, { max: 20_000 });
    oneOf(entry.mode, DATA_MODES, `${entryPath}.mode`);
    iso(entry.updatedAt, `${entryPath}.updatedAt`);
  });
  return value;
}

export function assertPermissionList(value, path = "permissions") {
  object(value, path, ["requests"]);
  array(value.requests, `${path}.requests`, (entry, entryPath) => {
    object(entry, entryPath, [
      "requestId", "taskId", "agent", "scope", "description", "resource",
      "requestedAt", "expiresAt", "decision",
    ], ["decidedAt"]);
    identifier(entry.requestId, `${entryPath}.requestId`);
    identifier(entry.taskId, `${entryPath}.taskId`);
    oneOf(entry.agent, AGENT_IDS, `${entryPath}.agent`);
    oneOf(entry.scope, PERMISSION_SCOPES, `${entryPath}.scope`);
    string(entry.description, `${entryPath}.description`, { min: 1, max: 2000 });
    string(entry.resource, `${entryPath}.resource`, { min: 1, max: 1024 });
    iso(entry.requestedAt, `${entryPath}.requestedAt`);
    iso(entry.expiresAt, `${entryPath}.expiresAt`);
    oneOf(entry.decision, ["pending", "approved", "denied"], `${entryPath}.decision`);
    optional(entry.decidedAt, `${entryPath}.decidedAt`, iso);
  });
  return value;
}

export function assertNotificationList(value, path = "notifications") {
  object(value, path, ["notifications", "unread"]);
  array(value.notifications, `${path}.notifications`, (entry, entryPath) => {
    object(entry, entryPath, [
      "taskId", "conversationId", "agent", "mode", "state", "createdAt", "read",
    ], ["summary"]);
    identifier(entry.taskId, `${entryPath}.taskId`);
    identifier(entry.conversationId, `${entryPath}.conversationId`);
    oneOf(entry.agent, AGENT_IDS, `${entryPath}.agent`);
    oneOf(entry.mode, DATA_MODES, `${entryPath}.mode`);
    oneOf(entry.state, ["completed", "failed", "cancelled", "interrupted"], `${entryPath}.state`);
    optional(entry.summary, `${entryPath}.summary`, (v, p) => string(v, p, { max: 500 }));
    iso(entry.createdAt, `${entryPath}.createdAt`);
    boolean(entry.read, `${entryPath}.read`);
  });
  integer(value.unread, `${path}.unread`, { min: 0 });
  return value;
}

const ENVELOPE_KEYS = ["v", "eventId", "taskId", "seq", "at", "agent", "generation", "type"];

function envelope(event, path) {
  literal(event.v, EVENT_SCHEMA_VERSION, `${path}.v`);
  identifier(event.eventId, `${path}.eventId`, 120);
  identifier(event.taskId, `${path}.taskId`);
  integer(event.seq, `${path}.seq`, { min: 1 });
  iso(event.at, `${path}.at`);
  oneOf(event.agent, AGENT_IDS, `${path}.agent`);
  integer(event.generation, `${path}.generation`, { min: 0 });
}

/**
 * Validate one execution event.
 *
 * Returns `null` for an event type this client does not know. The event schema
 * is versioned and a newer engine may add a type; that is forward compatibility,
 * not a reason to fail. A malformed *known* event is a contract violation.
 */
export function assertExecutionEvent(value, path = "event") {
  if (!isPlainObject(value)) violation(path, "expected an event object");
  if (value.v !== EVENT_SCHEMA_VERSION) {
    throw new SdkError(
      "CONTRACT_VIOLATION",
      `unsupported execution event version ${String(value.v)} at ${path}; this client supports ${EVENT_SCHEMA_VERSION}`,
    );
  }
  if (!EVENT_TYPES.includes(value.type)) return null;
  envelope(value, path);
  const type = value.type;
  const payload = value.payload;
  const withPayload = (keys, optionalKeys = []) => object(payload, `${path}.payload`, keys, optionalKeys);

  switch (type) {
    case "task.queued":
      object(value, path, [...ENVELOPE_KEYS], []);
      break;
    case "task.started":
      object(value, path, [...ENVELOPE_KEYS], ["payload"]);
      if (payload !== undefined) {
        object(payload, `${path}.payload`, [], ["sessionId"]);
        optional(payload.sessionId, `${path}.payload.sessionId`, (v, p) => string(v, p, { min: 1, max: 200 }));
      }
      break;
    case "step.started":
    case "step.completed":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      withPayload(["stepId", "title"]);
      string(payload.stepId, `${path}.payload.stepId`, { min: 1, max: 80 });
      string(payload.title, `${path}.payload.title`, { max: 200 });
      break;
    case "text.delta":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      withPayload(["text"]);
      string(payload.text, `${path}.payload.text`, { min: 1 });
      break;
    case "text.replace":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      withPayload(["text"]);
      string(payload.text, `${path}.payload.text`);
      break;
    case "tool.call":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      withPayload(["callId", "tool"], ["input"]);
      identifier(payload.callId, `${path}.payload.callId`, 120);
      string(payload.tool, `${path}.payload.tool`, { min: 1, max: 80 });
      break;
    case "tool.result":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      withPayload(["callId", "tool", "ok"], ["output"]);
      identifier(payload.callId, `${path}.payload.callId`, 120);
      string(payload.tool, `${path}.payload.tool`, { min: 1, max: 80 });
      boolean(payload.ok, `${path}.payload.ok`);
      optional(payload.output, `${path}.payload.output`, (v, p) => string(v, p, { max: 20_000 }));
      break;
    case "approval.required":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      withPayload(["requestId", "tool", "description"]);
      identifier(payload.requestId, `${path}.payload.requestId`, 120);
      string(payload.tool, `${path}.payload.tool`, { min: 1, max: 80 });
      string(payload.description, `${path}.payload.description`, { max: 2000 });
      break;
    case "file.edit":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      withPayload(["path"]);
      string(payload.path, `${path}.payload.path`, { min: 1, max: 1024 });
      break;
    case "usage":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      usage(payload, `${path}.payload`);
      break;
    case "task.completed":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      withPayload([], ["summary", "model", "usage"]);
      optional(payload.summary, `${path}.payload.summary`, (v, p) => string(v, p, { max: 20_000 }));
      optional(payload.model, `${path}.payload.model`, modelRef);
      optional(payload.usage, `${path}.payload.usage`, usage);
      break;
    case "task.failed":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      withPayload(["code", "retryable"], ["detail"]);
      oneOf(payload.code, ENGINE_FAILURE_CODES, `${path}.payload.code`);
      optional(payload.detail, `${path}.payload.detail`, (v, p) => string(v, p, { max: 1000 }));
      boolean(payload.retryable, `${path}.payload.retryable`);
      break;
    case "task.cancelled":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      withPayload([], ["reason"]);
      optional(payload.reason, `${path}.payload.reason`, (v, p) => string(v, p, { max: 500 }));
      break;
    case "task.interrupted":
      object(value, path, [...ENVELOPE_KEYS, "payload"], []);
      withPayload(["detail"]);
      string(payload.detail, `${path}.payload.detail`, { max: 500 });
      break;
    default:
      return null;
  }
  return value;
}

export function isTerminalEventType(type) {
  return TERMINAL_EVENT_TYPES.includes(type);
}

export function isTerminalTaskState(state) {
  return TERMINAL_TASK_STATES.includes(state);
}

export function agentCapability(agents, agentId, capability) {
  const agent = agents?.agents?.find((entry) => entry.id === agentId);
  if (!agent) return { supported: false, reason: `agent ${agentId} is not published by this engine` };
  if (!agent.availability.available) {
    return {
      supported: false,
      reason: `agent ${agentId} is unavailable: ${agent.availability.reason} (${agent.availability.detail})`,
    };
  }
  if (capability && agent.capabilities[capability] !== true) {
    return { supported: false, reason: `agent ${agentId} does not support ${capability}` };
  }
  return { supported: true, agent };
}

/**
 * Decide whether this client can speak to a server that reports `reported`.
 *
 * Accepts the whole `1.x` line so a compatible engine minor release does not
 * require a CLI release. Refuses any other major. Returns a diagnostic when the
 * server is newer than the mirror, because a newer minor may add payload
 * fields this mirror rejects.
 */
export function negotiateContractVersion(reported, { source = "health" } = {}) {
  if (typeof reported !== "string" || reported.trim() === "") {
    throw new SdkError(
      "CONTRACT_UNVERIFIED",
      `the engine did not report a contract version (${source}); refusing to assume one`,
      { details: { source }, retryable: false },
    );
  }
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(reported.trim());
  if (match === null) {
    throw new SdkError(
      "CONTRACT_UNSUPPORTED",
      `the engine reported an unparseable contract version ${JSON.stringify(reported)} (${source})`,
      { details: { serverContract: reported, source }, retryable: false },
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== CONTRACT_MAJOR) {
    throw new SdkError(
      "CONTRACT_UNSUPPORTED",
      `the engine serves contract ${reported}; this client implements ${CONTRACT_MAJOR}.x`,
      {
        details: { serverContract: reported, clientContract: CONTRACT_VERSION, source },
        retryable: false,
      },
    );
  }
  return {
    serverContract: reported.trim(),
    clientContract: CONTRACT_VERSION,
    major,
    minor,
    newerMinor: minor > CONTRACT_MINOR,
    source,
  };
}

export const CONTRACT_IDENTIFIER = /^[\s\S]{1,128}$/;
