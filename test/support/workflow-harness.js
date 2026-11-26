import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

/**
 * A real-HTTP fixture for the WorkflowEngine contract this CLI targets.
 *
 * It implements exactly the 30 operations published by PR #7
 * (`9b4cb5ce4f8688cf232d006028e5e255eda6cb1f`) and nothing else. Every response
 * is parsed by the canonical SDK the CLI ships, so a fixture that drifts from
 * the contract fails the CLI at its client boundary instead of passing.
 *
 * The fixture owns no intelligence: it emits the task, event, artifact,
 * schedule and permission shapes the engine publishes, and it never invents an
 * operation to make a test pass. Options exist only to exercise failure paths
 * (a disabled capability, a missing operation, a tampered digest, a hung run).
 */

export const DEFAULT_TOKEN = "workflow-harness-owner-token-0123456789";

const CONTRACT_VERSION = "1.1.0";
const API_PREFIX = "/v1";
const EVENT_SCHEMA_VERSION = 1;
const CHAT_STREAM_VERSION = 1;
const MAX_BODY_BYTES = 1024 * 1024;

const ENGINE_CAPABILITIES = Object.freeze({
  streaming: true,
  tools: true,
  cancellation: true,
  resume: true,
  modelSelection: true,
  durable: true,
});

const BASE_OPERATIONS = Object.freeze([
  ["getHealth", "GET", "/v1/health", ["health"], "public", false],
  ["getReadiness", "GET", "/v1/ready", ["health"], "public", false],
  ["getHandshake", "GET", "/v1/handshake", ["handshake"], "owner", false],
  ["listAgents", "GET", "/v1/agents", ["discovery"], "owner", false],
  ["listModels", "GET", "/v1/models", ["discovery"], "owner", false],
  ["submitChat", "POST", "/v1/chat", ["chat"], "owner", true],
  ["submitWork", "POST", "/v1/work", ["work"], "owner", false],
  ["listTasks", "GET", "/v1/work", ["work"], "owner", false],
  ["getTask", "GET", "/v1/work/{taskId}", ["work"], "owner", false],
  ["cancelTask", "POST", "/v1/work/{taskId}/cancel", ["work"], "owner", false],
  ["resumeTask", "POST", "/v1/work/{taskId}/resume", ["work"], "owner", false],
  ["retryTask", "POST", "/v1/work/{taskId}/retry", ["work"], "owner", false],
  ["streamTaskEvents", "GET", "/v1/work/{taskId}/events", ["events"], "owner", true],
  ["listArtifacts", "GET", "/v1/work/{taskId}/artifacts", ["artifacts"], "owner", false],
  ["createArtifact", "POST", "/v1/work/{taskId}/artifacts", ["artifacts"], "owner", false],
  ["getArtifact", "GET", "/v1/work/{taskId}/artifacts/{artifactId}", ["artifacts"], "owner", false],
  ["listConversations", "GET", "/v1/conversations", ["conversations"], "owner", false],
  ["getConversation", "GET", "/v1/conversations/{conversationId}", ["conversations"], "owner", false],
  ["listMemory", "GET", "/v1/memory", ["memory"], "owner", false],
  ["writeMemory", "POST", "/v1/memory", ["memory"], "owner", false],
  ["deleteMemory", "POST", "/v1/memory/delete", ["memory"], "owner", false],
  ["searchMemory", "GET", "/v1/memory/search", ["memory"], "owner", false],
  ["listPermissions", "GET", "/v1/work/{taskId}/permissions", ["permissions"], "owner", false],
  ["decidePermission", "POST", "/v1/work/{taskId}/permissions", ["permissions"], "owner", false],
  ["listNotifications", "GET", "/v1/notifications", ["notifications"], "owner", false],
  ["markNotificationRead", "POST", "/v1/notifications/{taskId}", ["notifications"], "owner", false],
  ["listSchedules", "GET", "/v1/schedules", ["schedules"], "owner", false],
  ["createSchedule", "POST", "/v1/schedules", ["schedules"], "owner", false],
  ["controlSchedule", "POST", "/v1/schedules/{scheduleId}", ["schedules"], "owner", false],
  ["deleteSchedule", "DELETE", "/v1/schedules/{scheduleId}", ["schedules"], "owner", false],
]);

const GAME_OPERATIONS = Object.freeze([
  ["getGameStudioCapabilities", "GET", "/v1/games/capabilities", ["games", "game-studio"], "owner", false],
  ["createGameBuild", "POST", "/v1/games/builds", ["games", "game-studio"], "owner", false],
]);

const FLAG_BY_KEY = Object.freeze({
  health: ["getHealth"],
  discovery: ["listAgents", "listModels"],
  chat: ["submitChat"],
  chatStreaming: ["submitChat"],
  work: ["submitWork"],
  workStreaming: ["streamTaskEvents"],
  cursorReplay: ["streamTaskEvents"],
  cancellation: ["cancelTask"],
  resume: ["resumeTask"],
  retry: ["retryTask"],
  permissions: ["listPermissions", "decidePermission"],
  notifications: ["listNotifications", "markNotificationRead"],
  notificationRead: ["markNotificationRead"],
  schedules: ["listSchedules", "createSchedule", "controlSchedule", "deleteSchedule"],
  artifacts: ["listArtifacts", "createArtifact", "getArtifact"],
  memory: ["listMemory", "writeMemory", "deleteMemory"],
  memorySearch: ["searchMemory"],
  conversations: ["listConversations", "getConversation"],
  taskList: ["listTasks"],
  idempotentSubmission: ["submitWork"],
});

function iso() {
  return new Date().toISOString();
}

function digest(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function problem(status, code, detail) {
  const titles = {
    unauthorized: "Unauthorized",
    forbidden: "Forbidden",
    not_found: "Not found",
    validation_failed: "Invalid request",
    conflict: "Conflict",
    busy: "Busy",
    not_ready: "Not ready",
    engine_unavailable: "Engine unavailable",
    internal_error: "Internal error",
  };
  return {
    type: "about:blank",
    title: titles[code] ?? "Failed",
    status,
    code,
    detail,
    retryable: status >= 500,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { code: "TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseBody(buffer) {
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function agentDescriptor(id, engine, label, external = false) {
  return {
    id,
    engine,
    label,
    external,
    capabilities: { ...ENGINE_CAPABILITIES },
    availability: { available: true, reason: "ready", detail: "ready" },
    isolation: {
      workspace: "isolated",
      memory: external ? "none" : "granted",
      credentials: external ? "none" : "scoped",
      conversations: external ? "none" : "granted",
    },
  };
}

export async function startWorkflowHarness(options = {}) {
  const token = options.token ?? DEFAULT_TOKEN;
  const startedAt = iso();
  const state = {
    requests: [],
    tasks: new Map(),
    artifacts: new Map(),
    schedules: new Map(),
    permissions: new Map(),
    notifications: new Map(),
    conversations: new Map(),
    memory: new Map(),
    events: new Map(),
    seq: 0,
    id: 0,
  };

  function nextId(prefix) {
    state.id += 1;
    return `${prefix}-${String(state.id).padStart(4, "0")}`;
  }

  const omitted = new Set(options.omitOperations ?? []);
  const gameRows = options.games === true ? [...BASE_OPERATIONS, ...GAME_OPERATIONS] : [...BASE_OPERATIONS];
  const operations = gameRows
    .filter(([operationId]) => !omitted.has(operationId))
    .map(([operationId, method, path, tags, auth, stream]) => ({
      operationId,
      method,
      path,
      tags,
      auth,
      stream,
    }));
  const published = new Set(operations.map((operation) => operation.operationId));

  const overrides = options.capabilities ?? {};
  const capabilities = {};
  for (const [key, operationIds] of Object.entries(FLAG_BY_KEY)) {
    capabilities[key] = operationIds.some((id) => published.has(id));
  }
  capabilities.externalAgents = false;
  capabilities.paidModels = false;
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "boolean") capabilities[key] = value;
    else if (value === "available") capabilities[key] = true;
    else if (value === "unsupported" || value === "unconfigured") capabilities[key] = false;
  }

  const requestLog = options.recordRequests === false ? null : state.requests;

  function emit(task, type, payload, patch = {}) {
    task.status = { ...task.status, ...patch };
    // Contract 1.1.0 sequences events per task, starting at 1.
    task.seq = (task.seq ?? 0) + 1;
    const event = {
      v: EVENT_SCHEMA_VERSION,
      eventId: nextId("event"),
      taskId: task.status.taskId,
      seq: task.seq,
      at: iso(),
      agent: task.status.agent,
      generation: task.status.generation,
      type,
      ...(payload === undefined ? {} : { payload }),
    };
    const list = state.events.get(task.status.taskId) ?? [];
    list.push(event);
    state.events.set(task.status.taskId, list);
    for (const listener of task.listeners) {
      listener(event);
    }
    return event;
  }

  function taskSummary(task) {
    const status = task.status;
    return {
      taskId: status.taskId,
      conversationId: status.conversationId,
      title: status.title,
      state: status.state,
      agent: status.agent,
      mode: status.mode,
      ...(status.model === undefined ? {} : { model: status.model }),
      generation: status.generation,
      createdAt: status.createdAt,
      updatedAt: status.updatedAt,
      cancelRequested: status.cancelRequested,
    };
  }

  function publicStatus(task) {
    const { title, ...status } = task.status;
    return status;
  }

  const engine = {
    id: "native",
    capabilities: { ...ENGINE_CAPABILITIES },
    availability: { available: true, reason: "ready", detail: "ready" },
  };

  function storeArtifact(task, { path, mediaType, buffer, origin }) {
    const artifactId = nextId("artifact");
    const record = {
      artifactId,
      taskId: task.status.taskId,
      conversationId: task.status.conversationId,
      path,
      mediaType,
      bytes: buffer.length,
      digest: digest(buffer),
      origin,
      createdAt: iso(),
    };
    state.artifacts.set(artifactId, { record, buffer });
    return record;
  }

  function complete(task) {
    if (task.status.state !== "running" && task.status.state !== "awaiting_approval") return;
    const text = `# Result\n\n${task.objective}\n`;
    const buffer = Buffer.from(text, "utf8");
    const artifact = storeArtifact(task, {
      path: options.artifactPath ?? "result.md",
      mediaType: "text/markdown",
      buffer,
      origin: "engine",
    });
    emit(task, "step.completed", { stepId: "plan", title: "Produce the result" }, {
      generation: task.status.generation + 1,
      steps: task.status.steps.map((step) => ({ ...step, state: "completed" })),
      state: "completed",
      result: {
        summary: `completed: ${task.objective}`,
        artifacts: [{ path: artifact.path, bytes: artifact.bytes, digest: artifact.digest }],
      },
      updatedAt: iso(),
    });
    emit(task, "task.completed", {
      summary: `completed: ${task.objective}`,
      usage: { outputTokens: 12 },
    });
    state.notifications.set(task.status.taskId, {
      taskId: task.status.taskId,
      conversationId: task.status.conversationId,
      agent: task.status.agent,
      mode: task.status.mode,
      state: "completed",
      summary: `completed: ${task.objective}`,
      createdAt: iso(),
      read: false,
    });
  }

  function fail(task) {
    if (task.status.state === "cancelled") return;
    emit(task, "task.failed", {
      code: "provider_error",
      detail: "the harness was configured to fail",
      retryable: false,
    }, {
      generation: task.status.generation + 1,
      state: "failed",
      failure: { code: "provider_error", detail: "the harness was configured to fail" },
      updatedAt: iso(),
    });
    state.notifications.set(task.status.taskId, {
      taskId: task.status.taskId,
      conversationId: task.status.conversationId,
      agent: task.status.agent,
      mode: task.status.mode,
      state: "failed",
      summary: "the harness was configured to fail",
      createdAt: iso(),
      read: false,
    });
  }

  function begin(task) {
    if (task.status.state !== "queued") return;
    emit(task, "task.started", undefined, {
      generation: task.status.generation + 1,
      state: "running",
      steps: task.status.steps.map((step) => ({ ...step, state: "running" })),
      updatedAt: iso(),
    });
    emit(task, "step.started", { stepId: "plan", title: "Produce the result" });
    const behavior = task.behavior;
    if (behavior === "hang") return;
    if (behavior === "failed") {
      setTimeout(() => fail(task), 10);
      return;
    }
    setTimeout(() => complete(task), 10);
  }

  function createTask(body) {
    const taskId = nextId("task");
    const conversationId = body.conversationId ?? nextId("conversation");
    const behavior =
      options.behaviors?.[taskId] ?? options.behaviors?.default ?? "completed";
    const now = iso();
    const status = {
      taskId,
      conversationId,
      title: String(body.objective).slice(0, 120),
      state: "queued",
      agent: body.agent ?? "coderax",
      mode: body.mode ?? "cloud",
      ...(body.model === undefined ? {} : { model: body.model }),
      generation: 0,
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
      steps: [{ id: "plan", title: "Produce the result", state: "queued" }],
    };
    const task = { status, objective: body.objective, behavior, listeners: new Set(), seq: 0 };
    state.tasks.set(taskId, task);
    state.events.set(taskId, []);
    state.permissions.set(taskId, [
      {
        requestId: nextId("request"),
        taskId,
        agent: status.agent,
        scope: "workspace.write",
        description: "Write the requested artifact",
        resource: "workspace://cloud/result.md",
        requestedAt: now,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        decision: "pending",
      },
    ]);
    emit(task, "task.queued");

    const delay = options.beginDelayMs ?? 25;
    const timer = setTimeout(() => begin(task), delay);
    timer.unref?.();
    return task;
  }

  function markCancelled(task, reason) {
    if (["completed", "failed", "cancelled", "interrupted"].includes(task.status.state)) {
      return "already_terminal";
    }
    emit(task, "task.cancelled", reason === undefined ? undefined : { reason }, {
      generation: task.status.generation + 1,
      state: "cancelled",
      cancelRequested: true,
      updatedAt: iso(),
    });
    return "accepted";
  }

  function sendJson(res, status, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
    });
    res.end(text);
  }

  function sendProblem(res, status, code, detail) {
    sendJson(res, status, problem(status, code, detail));
  }

  function authorize(req, res, operation) {
    if (operation.auth === "public") return true;
    const header = req.headers.authorization ?? "";
    if (header !== `Bearer ${token}`) {
      sendProblem(res, 401, "unauthorized", "a valid owner token is required");
      return false;
    }
    return true;
  }

  function findOperation(method, path) {
    for (const operation of operations) {
      const pattern = new RegExp(
        `^${operation.path.replace(/\/\{([A-Za-z]+)\}/g, "/([^/]+)")}$`,
      );
      const match = pattern.exec(path);
      if (match && operation.method === method) {
        const keys = [...operation.path.matchAll(/\{([A-Za-z]+)\}/g)].map((entry) => entry[1]);
        return {
          operation,
          params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])),
        };
      }
    }
    return null;
  }

  async function streamEvents(req, res, task, after) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    let cursor = Number.isFinite(after) ? after : 0;
    let closed = false;
    const write = (event) => {
      if (closed) return;
      if (event.seq <= cursor) return;
      cursor = event.seq;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const listener = (event) => write(event);
    task.listeners.add(listener);
    for (const event of state.events.get(task.status.taskId) ?? []) write(event);
    const keepAlive = setInterval(() => {
      if (!closed) res.write(": keep-alive\n\n");
    }, 15000);
    keepAlive.unref?.();
    const finish = () => {
      closed = true;
      clearInterval(keepAlive);
      task.listeners.delete(listener);
      try {
        res.end();
      } catch {
        // The client already closed.
      }
    };
    const check = setInterval(() => {
      if (["completed", "failed", "cancelled", "interrupted"].includes(task.status.state)) {
        clearInterval(check);
        setTimeout(finish, 10).unref?.();
      }
    }, 25);
    check.unref?.();
    req.on("close", () => {
      clearInterval(check);
      finish();
    });
  }

  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      sendProblem(res, 400, "validation_failed", "invalid URL");
      return;
    }
    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      if (error.code === "TOO_LARGE") {
        sendProblem(res, 400, "validation_failed", "request body exceeds the published limit");
        return;
      }
      sendProblem(res, 400, "validation_failed", "could not read the request body");
      return;
    }
    const body = parseBody(raw);
    if (body === null) {
      sendProblem(res, 400, "validation_failed", "request body is not JSON");
      return;
    }
    if (requestLog) {
      requestLog.push({ method: req.method, path: url.pathname, query: url.search, body });
    }

    if (req.method === "GET" && url.pathname === "/v1/health") {
      sendJson(res, 200, {
        status: "ok",
        contractVersion: CONTRACT_VERSION,
        startedAt,
        uptimeMs: Date.now() - Date.parse(startedAt),
        checks: [{ name: "engine", status: "ok", required: true, detail: "ready" }],
        engines: [engine],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/ready") {
      sendJson(res, 200, {
        ready: true,
        missing: [],
        checks: [{ name: "startup", status: "ok", required: true, detail: "validated" }],
      });
      return;
    }

    const route = findOperation(req.method, url.pathname);
    if (route === null) {
      sendProblem(res, 404, "not_found", `no route for ${req.method} ${url.pathname}`);
      return;
    }
    if (!authorize(req, res, route.operation)) return;

    const params = route.params;
    const id = route.operation.operationId;

    switch (id) {
      case "getHandshake": {
        const requested = url.searchParams.get("contract") ?? undefined;
        const incompatible = options.incompatible === true;
        sendJson(res, 200, {
          contractVersion: CONTRACT_VERSION,
          contractMajor: 1,
          eventSchemaVersion: EVENT_SCHEMA_VERSION,
          chatStreamVersion: CHAT_STREAM_VERSION,
          apiPrefix: API_PREFIX,
          supportedContractVersions: incompatible ? [] : ["1.0.0", "1.1.0"],
          ...(requested === undefined ? {} : { requestedContractVersion: requested }),
          compatible: !incompatible,
          negotiatedContractVersion: CONTRACT_VERSION,
          negotiation: requested === undefined ? "no_request" : "exact",
          server: { name: "coderax-workflow-engine", version: "0.2.0", startedAt },
          operations,
          capabilities,
          limits: {
            maxBodyBytes: MAX_BODY_BYTES,
            eventBufferSize: 1000,
            maxConcurrentTasks: 4,
            scheduleMinIntervalMs: 60_000,
            artifactMaxBytes: 1_048_576,
            memoryMaxValueLength: 20_000,
          },
        });
        return;
      }
      case "listAgents":
        sendJson(res, 200, {
          agents: [
            agentDescriptor("coderax", "native", "Coderax Native"),
            agentDescriptor("opencode", "opencode", "OpenCode", true),
            agentDescriptor("freebuff", "freebuff", "FreeBuff", true),
          ],
        });
        return;
      case "listModels":
        sendJson(res, 200, {
          models: [
            {
              ref: { providerId: "local", modelId: "zero" },
              label: "Zero-cost route",
              costClass: "free",
              toolCalling: true,
              streaming: true,
              availability: { available: true, reason: "ready", detail: "ready" },
            },
          ],
          route: [{ providerId: "local", modelId: "zero" }],
          allowPaid: false,
        });
        return;
      case "submitChat": {
        const conversationId = body.conversationId ?? nextId("conversation");
        const messageId = nextId("message");
        const reply = {
          conversationId,
          messageId,
          text: `reply: ${body.message}`,
          agent: body.agent ?? "coderax",
          model: { providerId: "local", modelId: "zero" },
          createdAt: iso(),
        };
        if ((req.headers.accept ?? "").includes("text/event-stream")) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          });
          const frames = [
            {
              v: CHAT_STREAM_VERSION,
              type: "chat.started",
              conversationId,
              messageId,
              agent: reply.agent,
              model: reply.model,
            },
            { v: CHAT_STREAM_VERSION, type: "chat.delta", text: reply.text },
            { v: CHAT_STREAM_VERSION, type: "chat.completed", reply },
          ];
          for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
          res.end();
          return;
        }
        sendJson(res, 200, reply);
        return;
      }
      case "submitWork": {
        if (body.idempotencyKey !== undefined) {
          for (const existing of state.tasks.values()) {
            if (existing.idempotencyKey === body.idempotencyKey) {
              sendJson(res, 202, {
                taskId: existing.status.taskId,
                conversationId: existing.status.conversationId,
                state: existing.status.state,
                generation: existing.status.generation,
                eventsPath: `/v1/work/${existing.status.taskId}/events`,
                replayed: true,
              });
              return;
            }
          }
        }
        const task = createTask(body);
        task.idempotencyKey = body.idempotencyKey;
        sendJson(res, 202, {
          taskId: task.status.taskId,
          conversationId: task.status.conversationId,
          state: task.status.state,
          generation: task.status.generation,
          eventsPath: `/v1/work/${task.status.taskId}/events`,
        });
        return;
      }
      case "listTasks": {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const tasks = [...state.tasks.values()]
          .filter((task) => {
            const stateParam = url.searchParams.get("state");
            return stateParam === null || task.status.state === stateParam;
          })
          .slice(0, Number.isFinite(limit) ? limit : 50)
          .map(taskSummary);
        sendJson(res, 200, { tasks });
        return;
      }
      case "getTask": {
        const task = state.tasks.get(params.taskId);
        if (!task) {
          sendProblem(res, 404, "not_found", `no task ${params.taskId}`);
          return;
        }
        sendJson(res, 200, publicStatus(task));
        return;
      }
      case "cancelTask": {
        const task = state.tasks.get(params.taskId);
        if (!task) {
          sendProblem(res, 404, "not_found", `no task ${params.taskId}`);
          return;
        }
        const outcome = markCancelled(task, body.reason);
        if (outcome === "accepted" && task.status.state === "cancelled") {
          state.notifications.set(task.status.taskId, {
            taskId: task.status.taskId,
            conversationId: task.status.conversationId,
            agent: task.status.agent,
            mode: task.status.mode,
            state: "cancelled",
            createdAt: iso(),
            read: false,
          });
        }
        sendJson(res, 200, {
          taskId: task.status.taskId,
          state: task.status.state,
          generation: task.status.generation,
          outcome,
        });
        return;
      }
      case "resumeTask":
      case "retryTask": {
        const task = state.tasks.get(params.taskId);
        if (!task) {
          sendProblem(res, 404, "not_found", `no task ${params.taskId}`);
          return;
        }
        const accepted = task.status.generation === body.generation;
        if (accepted) {
          task.status = {
            ...task.status,
            state: "running",
            generation: task.status.generation + 1,
            cancelRequested: false,
            updatedAt: iso(),
          };
          emit(task, "task.started", undefined, {
            generation: task.status.generation,
            state: "running",
          });
          setTimeout(() => (options.behaviors?.default === "hang" ? undefined : complete(task)), 10).unref?.();
        }
        sendJson(res, 200, {
          taskId: task.status.taskId,
          state: task.status.state,
          generation: task.status.generation,
          outcome: accepted ? "accepted" : "superseded",
        });
        return;
      }
      case "streamTaskEvents": {
        const task = state.tasks.get(params.taskId);
        if (!task) {
          sendProblem(res, 404, "not_found", `no task ${params.taskId}`);
          return;
        }
        const after = Number(url.searchParams.get("after") ?? 0);
        await streamEvents(req, res, task, after);
        return;
      }
      case "listArtifacts": {
        const task = state.tasks.get(params.taskId);
        if (!task) {
          sendProblem(res, 404, "not_found", `no task ${params.taskId}`);
          return;
        }
        const artifacts = [...state.artifacts.values()]
          .filter((entry) => entry.record.taskId === params.taskId)
          .map((entry) => entry.record);
        sendJson(res, 200, { artifacts });
        return;
      }
      case "createArtifact": {
        const task = state.tasks.get(params.taskId);
        if (!task) {
          sendProblem(res, 404, "not_found", `no task ${params.taskId}`);
          return;
        }
        const encoding = body.encoding ?? "utf8";
        if (encoding !== "utf8" && encoding !== "base64") {
          sendProblem(res, 400, "validation_failed", "encoding must be utf8 or base64");
          return;
        }
        const buffer = Buffer.from(body.content ?? "", encoding === "base64" ? "base64" : "utf8");
        if (buffer.length === 0) {
          sendProblem(res, 400, "validation_failed", "artifact content is empty");
          return;
        }
        const record = storeArtifact(task, {
          path: body.path,
          mediaType: body.mediaType ?? "text/plain",
          buffer,
          origin: "owner",
        });
        if (options.tamperUpload === true) {
          record.digest = digest(Buffer.from("tampered", "utf8"));
          record.bytes = 8;
        }
        sendJson(res, 201, record);
        return;
      }
      case "getArtifact": {
        const entry = state.artifacts.get(params.artifactId);
        if (!entry || entry.record.taskId !== params.taskId) {
          sendProblem(res, 404, "not_found", `no artifact ${params.artifactId} on task ${params.taskId}`);
          return;
        }
        const content = options.tamperContent === true
          ? Buffer.from("tampered content", "utf8").toString("base64")
          : entry.buffer.toString("base64");
        sendJson(res, 200, {
          artifact: entry.record,
          encoding: "base64",
          content,
        });
        return;
      }
      case "listConversations":
        sendJson(res, 200, {
          conversations: [...state.conversations.values()].map((conversation) => ({
            conversationId: conversation.conversationId,
            title: conversation.title,
            isWork: conversation.isWork,
            agent: conversation.agent,
            updatedAt: conversation.updatedAt,
          })),
        });
        return;
      case "getConversation": {
        const conversation = state.conversations.get(params.conversationId);
        if (!conversation) {
          sendProblem(res, 404, "not_found", `no conversation ${params.conversationId}`);
          return;
        }
        sendJson(res, 200, conversation);
        return;
      }
      case "listMemory": {
        const mode = url.searchParams.get("mode");
        sendJson(res, 200, {
          entries: [...state.memory.values()].filter((entry) => mode === null || entry.mode === mode),
        });
        return;
      }
      case "writeMemory": {
        const entry = { key: body.key, value: body.value, mode: body.mode ?? "private", updatedAt: iso() };
        state.memory.set(`${entry.mode}:${entry.key}`, entry);
        sendJson(res, 200, { entries: [...state.memory.values()] });
        return;
      }
      case "deleteMemory": {
        state.memory.delete(`${body.mode ?? "private"}:${body.key}`);
        sendJson(res, 200, { entries: [...state.memory.values()] });
        return;
      }
      case "searchMemory": {
        const query = (url.searchParams.get("q") ?? "").toLowerCase();
        const matches = [...state.memory.values()]
          .filter((entry) => entry.key.toLowerCase().includes(query) || entry.value.toLowerCase().includes(query))
          .map((entry) => ({ key: entry.key, value: entry.value, mode: entry.mode }));
        sendJson(res, 200, { query, matches });
        return;
      }
      case "listPermissions": {
        const task = state.tasks.get(params.taskId);
        if (!task) {
          sendProblem(res, 404, "not_found", `no task ${params.taskId}`);
          return;
        }
        sendJson(res, 200, { requests: state.permissions.get(params.taskId) ?? [] });
        return;
      }
      case "decidePermission": {
        const requests = state.permissions.get(params.taskId);
        const request = requests?.find((entry) => entry.requestId === body.requestId);
        if (!requests || !request) {
          sendProblem(res, 404, "not_found", `no permission request ${body.requestId}`);
          return;
        }
        if (request.decision !== "pending") {
          sendProblem(res, 409, "conflict", "the request has already been decided");
          return;
        }
        request.decision = body.decision;
        request.decidedAt = iso();
        sendJson(res, 200, { requests });
        return;
      }
      case "listNotifications":
        sendJson(res, 200, {
          notifications: [...state.notifications.values()],
          unread: [...state.notifications.values()].filter((entry) => !entry.read).length,
        });
        return;
      case "markNotificationRead": {
        const notification = state.notifications.get(params.taskId);
        if (!notification) {
          sendProblem(res, 404, "not_found", `no notification for ${params.taskId}`);
          return;
        }
        notification.read = true;
        sendJson(res, 200, {
          notifications: [...state.notifications.values()],
          unread: [...state.notifications.values()].filter((entry) => !entry.read).length,
        });
        return;
      }
      case "listSchedules":
        sendJson(res, 200, { schedules: [...state.schedules.values()] });
        return;
      case "createSchedule": {
        if (!Number.isInteger(body.intervalMs) || body.intervalMs < 60_000) {
          sendProblem(res, 400, "validation_failed", "intervalMs must be at least 60000");
          return;
        }
        const scheduleId = nextId("schedule");
        const now = iso();
        const enabled = body.enabled !== false;
        const schedule = {
          scheduleId,
          objective: body.objective,
          agent: body.agent ?? "coderax",
          mode: body.mode ?? "cloud",
          intervalMs: body.intervalMs,
          enabled,
          ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
          createdAt: now,
          updatedAt: now,
          ...(enabled ? { nextRunAt: new Date(Date.now() + body.intervalMs).toISOString() } : {}),
          runs: 0,
          skipped: 0,
        };
        state.schedules.set(scheduleId, schedule);
        sendJson(res, 201, schedule);
        return;
      }
      case "controlSchedule": {
        const schedule = state.schedules.get(params.scheduleId);
        if (!schedule) {
          sendProblem(res, 404, "not_found", `no schedule ${params.scheduleId}`);
          return;
        }
        if (body.action !== "pause" && body.action !== "resume") {
          sendProblem(res, 400, "validation_failed", "action must be pause or resume");
          return;
        }
        const enabled = body.action === "resume";
        const changed = schedule.enabled !== enabled;
        schedule.enabled = enabled;
        schedule.updatedAt = iso();
        if (enabled) schedule.nextRunAt = new Date(Date.now() + schedule.intervalMs).toISOString();
        else delete schedule.nextRunAt;
        sendJson(res, 200, {
          scheduleId: schedule.scheduleId,
          enabled: schedule.enabled,
          ...(schedule.nextRunAt === undefined ? {} : { nextRunAt: schedule.nextRunAt }),
          runs: schedule.runs,
          outcome: changed ? "accepted" : "unchanged",
        });
        return;
      }
      case "deleteSchedule": {
        const existed = state.schedules.delete(params.scheduleId);
        sendJson(res, 200, {
          scheduleId: params.scheduleId,
          outcome: existed ? "deleted" : "not_found",
        });
        return;
      }
      default:
        sendProblem(res, 404, "not_found", `no handler for ${id}`);
    }
  });

  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    token,
    state,
    handshake: () => ({ contractVersion: CONTRACT_VERSION, operations, capabilities }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
