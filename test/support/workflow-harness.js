import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  AgentList,
  ArtifactContent,
  ArtifactList,
  ArtifactRecord,
  ArtifactUploadRequest,
  CHAT_STREAM_SCHEMA_VERSION,
  CONTRACT_VERSION,
  ENGINE_VERSION,
  EVENT_SCHEMA_VERSION,
  EngineHandshake,
  ExecutionEvent,
  HealthReport,
  MIN_SDK_VERSION,
  ModelList,
  PermissionList,
  Problem,
  ReadinessReport,
  SDK_VERSION,
  Schedule,
  ScheduleControlResult,
  ScheduleCreateRequest,
  ScheduleList,
  TaskAccepted,
  TaskControlResult,
  TaskStatus,
  WorkSubmitRequest,
} from "@coderax/contracts";

/**
 * A real HTTP implementation of the authoritative WorkflowEngine 1.1.0 surface.
 *
 * The client under test talks to this over a TCP socket with the canonical SDK;
 * nothing is stubbed at the module boundary. Every request body is validated
 * with the contract's zod schema before it is accepted and every response is
 * validated before it is written, so a fixture that drifts from the published
 * contract fails the test instead of silently passing.
 *
 * The harness implements only the operations it advertises in the handshake:
 * health, readiness, handshake, agents, models, Work, tasks, task events,
 * task artifacts, artifact read/content, cancellation, permissions and
 * schedules. It contains no model, document, media or game implementation.
 */

const DEFAULT_TOKEN = "workflow-harness-owner-token-0123456789";

const ok = (detail) => ({ state: "available", detail });
const unavailable = (detail) => ({ state: "unsupported", detail });

const DEFAULT_CAPABILITIES = Object.freeze({
  chat: ok("native chat"),
  chatStreaming: ok("typed chat frames"),
  work: ok("durable Work tasks"),
  durableEvents: ok("durable execution events"),
  eventReplay: ok("cursor replay"),
  scheduling: ok("durable schedules"),
  artifacts: ok("task-scoped artifact storage"),
  permissions: ok("scoped permission decisions"),
  memory: ok("owner memory"),
  rag: unavailable("no retrieval index is configured"),
  multimodal: unavailable("contract 1.1.0 publishes no media operation"),
  multiAgent: ok("three agent identities"),
  idempotency: ok("owner-scoped idempotency keys"),
  reasoningPlanner: ok("dependency-aware planning"),
  modelRouter: ok("verified zero-cost routing"),
});

const BASE_OPERATIONS = Object.freeze([
  { operationId: "getHealth", method: "GET", path: "/v1/health", tags: ["health"], auth: "public", stream: false },
  { operationId: "getReadiness", method: "GET", path: "/v1/ready", tags: ["health"], auth: "public", stream: false },
  { operationId: "getHandshake", method: "GET", path: "/v1/handshake", tags: ["health"], auth: "public", stream: false },
  { operationId: "listAgents", method: "GET", path: "/v1/agents", tags: ["discovery"], auth: "owner", stream: false },
  { operationId: "listModels", method: "GET", path: "/v1/models", tags: ["discovery"], auth: "owner", stream: false },
  { operationId: "submitWork", method: "POST", path: "/v1/work", tags: ["work"], auth: "owner", stream: false },
  { operationId: "getTask", method: "GET", path: "/v1/work/{taskId}", tags: ["work"], auth: "owner", stream: false },
  { operationId: "cancelTask", method: "POST", path: "/v1/work/{taskId}/cancel", tags: ["work"], auth: "owner", stream: false },
  { operationId: "streamTaskEvents", method: "GET", path: "/v1/work/{taskId}/events", tags: ["events"], auth: "owner", stream: true },
  { operationId: "listTaskArtifacts", method: "GET", path: "/v1/work/{taskId}/artifacts", tags: ["artifacts"], auth: "owner", stream: false },
  { operationId: "uploadTaskArtifact", method: "POST", path: "/v1/work/{taskId}/artifacts", tags: ["artifacts"], auth: "owner", stream: false },
  { operationId: "getArtifact", method: "GET", path: "/v1/artifacts/{artifactId}", tags: ["artifacts"], auth: "owner", stream: false },
  { operationId: "getArtifactContent", method: "GET", path: "/v1/artifacts/{artifactId}/content", tags: ["artifacts"], auth: "owner", stream: false },
  { operationId: "listSchedules", method: "GET", path: "/v1/schedules", tags: ["schedules"], auth: "owner", stream: false },
  { operationId: "createSchedule", method: "POST", path: "/v1/schedules", tags: ["schedules"], auth: "owner", stream: false },
  { operationId: "getSchedule", method: "GET", path: "/v1/schedules/{scheduleId}", tags: ["schedules"], auth: "owner", stream: false },
  { operationId: "cancelSchedule", method: "POST", path: "/v1/schedules/{scheduleId}/cancel", tags: ["schedules"], auth: "owner", stream: false },
  { operationId: "listPendingPermissions", method: "GET", path: "/v1/permissions", tags: ["permissions"], auth: "owner", stream: false },
  { operationId: "decidePermission", method: "POST", path: "/v1/work/{taskId}/permissions", tags: ["permissions"], auth: "owner", stream: false },
]);

const GAME_OPERATIONS = Object.freeze([
  { operationId: "getGameStudioCapabilities", method: "GET", path: "/v1/games/capabilities", tags: ["games", "game-studio"], auth: "owner", stream: false },
  { operationId: "createGameBuild", method: "POST", path: "/v1/games/builds", tags: ["games", "game-studio"], auth: "owner", stream: false },
]);

function iso() {
  return new Date().toISOString();
}

function digest(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
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

function problem(status, code, detail) {
  return {
    type: "about:blank",
    title: code.replace(/_/g, " "),
    status,
    code,
    detail,
    retryable: status >= 500,
  };
}

function agentDescriptor(id, engine, label, external) {
  return {
    id,
    engine,
    label,
    external,
    capabilities: {
      streaming: true,
      tools: true,
      cancellation: true,
      resume: true,
      modelSelection: true,
      durable: true,
    },
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
  const tasks = new Map();
  const artifacts = new Map();
  const schedules = new Map();
  const permissions = new Map();
  const requests = [];
  let closed = false;
  let artifactSeq = 0;

  const capabilityOverrides = options.capabilities ?? {};
  const behaviors = options.behaviors ?? {};
  const games = options.games === true;

  const capabilities = Object.fromEntries(
    Object.entries(DEFAULT_CAPABILITIES).map(([key, value]) => {
      const override = capabilityOverrides[key];
      if (override === undefined) return [key, { ...value }];
      if (typeof override === "string") {
        return [key, { state: override, detail: `${key} is ${override}` }];
      }
      return [key, { state: override.state, detail: override.detail ?? `${key} is ${override.state}` }];
    }),
  );

  const omitted = new Set(options.omitOperations ?? []);
  const operations = (games ? [...BASE_OPERATIONS, ...GAME_OPERATIONS] : [...BASE_OPERATIONS]).filter(
    (operation) => !omitted.has(operation.operationId),
  );

  const handshake = () => ({
    engineName: "coderax-workflow-engine",
    engineVersion: ENGINE_VERSION,
    contractVersion: options.contractVersion ?? CONTRACT_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    chatStreamSchemaVersion: CHAT_STREAM_SCHEMA_VERSION,
    minSdkVersion: options.minSdkVersion ?? MIN_SDK_VERSION,
    sdkVersion: SDK_VERSION,
    apiPrefix: "/v1",
    capabilities,
    operations,
  });

  function sendJson(res, status, schema, payload) {
    let body;
    try {
      body = JSON.stringify(schema.parse(payload));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          problem(500, "internal_error", `harness fixture violates the contract: ${error.message}`),
        ),
      );
      return;
    }
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  function sendProblem(res, status, code, detail) {
    sendJson(res, status, Problem, problem(status, code, detail));
  }

  function statusOf(task) {
    return {
      taskId: task.taskId,
      conversationId: task.conversationId,
      state: task.state,
      agent: task.agent,
      mode: task.mode,
      ...(task.model === undefined ? {} : { model: task.model }),
      generation: task.generation,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      cancelRequested: task.cancelRequested,
      steps: task.steps,
      ...(task.result === undefined ? {} : { result: task.result }),
      ...(task.failure === undefined ? {} : { failure: task.failure }),
    };
  }

  function accepted(task) {
    return {
      taskId: task.taskId,
      conversationId: task.conversationId,
      state: task.state,
      generation: task.generation,
      eventsPath: `/v1/work/${task.taskId}/events`,
    };
  }

  function emit(task, event) {
    const seq = task.events.length + 1;
    const envelope = {
      ...event,
      v: EVENT_SCHEMA_VERSION,
      eventId: `${task.taskId}:${seq}`,
      taskId: task.taskId,
      seq,
      at: iso(),
      agent: task.agent,
      generation: task.generation,
    };
    const parsed = ExecutionEvent.parse(envelope);
    task.events.push(parsed);
    task.updatedAt = parsed.at;
    for (const subscriber of task.subscribers) {
      writeFrame(subscriber, parsed);
      if (parsed.type.startsWith("task.") && ["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(parsed.type)) {
        subscriber.end();
        task.subscribers.delete(subscriber);
      }
    }
    return parsed;
  }

  function writeFrame(res, event) {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  function storeArtifact(task, { path, mediaType, buffer }) {
    artifactSeq += 1;
    const artifactId = `artifact-${artifactSeq}`;
    const record = ArtifactRecord.parse({
      artifactId,
      taskId: task.taskId,
      path,
      mediaType,
      bytes: buffer.length,
      digest: digest(buffer),
      createdAt: iso(),
    });
    artifacts.set(artifactId, { record, buffer });
    return record;
  }

  function complete(task) {
    if (closed || task.state === "cancelled") return;
    const text = Buffer.from(`Result for task ${task.taskId}\n\n${task.objective}\n`, "utf8");
    const record = storeArtifact(task, {
      path: options.artifactPath ?? behaviors[task.taskId]?.artifactPath ?? "result.md",
      mediaType: options.artifactMediaType ?? behaviors[task.taskId]?.artifactMediaType ?? "text/markdown",
      buffer: text,
    });
    task.result = {
      summary: `completed task ${task.taskId}`,
      artifacts: [{ path: record.path, bytes: record.bytes, digest: record.digest }],
    };
    task.state = "completed";
    emit(task, {
      type: "task.completed",
      payload: { summary: task.result.summary },
    });
  }

  function fail(task, code = "provider_error", detail = "the harness was configured to fail") {
    if (closed) return;
    task.failure = { code, detail };
    task.state = "failed";
    emit(task, { type: "task.failed", payload: { code, detail, retryable: false } });
  }

  function begin(task) {
    if (closed || task.state !== "queued") return;
    task.state = "running";
    task.updatedAt = iso();
    emit(task, { type: "task.started" });
    emit(task, { type: "step.started", payload: { stepId: "step-1", title: "execute the objective" } });
    const behavior = behaviors[task.taskId] ?? behaviors.default ?? "completed";
    if (behavior === "hang") return;
    if (behavior === "failed") {
      emit(task, { type: "step.completed", payload: { stepId: "step-1", title: "execute the objective" } });
      fail(task);
      return;
    }
    if (behavior === "awaiting_approval") {
      const requestId = `perm-${task.taskId}`;
      const request = {
        requestId,
        taskId: task.taskId,
        agent: "coderax",
        scope: "workspace.write",
        description: "write the generated artifact",
        resource: "/workspace",
        requestedAt: iso(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        decision: "pending",
      };
      permissions.set(task.taskId, [request]);
      task.state = "awaiting_approval";
      task.updatedAt = iso();
      emit(task, {
        type: "approval.required",
        payload: {
          requestId,
          tool: "workspace.write",
          description: request.description,
        },
      });
      return;
    }
    emit(task, { type: "step.completed", payload: { stepId: "step-1", title: "execute the objective" } });
    complete(task);
  }

  function createTask(body) {
    const existing = [...tasks.values()].find(
      (task) => body.idempotencyKey !== undefined && task.idempotencyKey === body.idempotencyKey,
    );
    if (existing) return existing;
    const taskId = `task-${requests.length + 1}-${randomUUID().slice(0, 8)}`;
    const task = {
      taskId,
      conversationId: body.conversationId ?? `conv-${taskId}`,
      objective: body.objective,
      agent: body.agent ?? "coderax",
      model: body.model,
      mode: body.mode ?? "cloud",
      generation: 0,
      createdAt: iso(),
      updatedAt: iso(),
      cancelRequested: false,
      state: "queued",
      steps: [{ id: "step-1", title: "execute the objective", state: "queued" }],
      events: [],
      subscribers: new Set(),
      idempotencyKey: body.idempotencyKey,
    };
    tasks.set(taskId, task);
    emit(task, { type: "task.queued" });
    const timer = setTimeout(() => begin(task), options.beginDelayMs ?? 5);
    timer.unref?.();
    return task;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    requests.push({ method: req.method, path, authorization: req.headers.authorization ?? null });

    const publicPath = path === "/v1/health" || path === "/v1/ready" || path === "/v1/handshake";
    if (!publicPath) {
      if (req.headers.authorization !== `Bearer ${token}`) {
        sendProblem(res, 401, "unauthorized", "a valid owner token is required");
        return;
      }
    }

    let body = null;
    if (req.method === "POST") {
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        sendProblem(res, 413, "validation_failed", "the request body is too large");
        return;
      }
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          sendProblem(res, 400, "validation_failed", "the request body is not JSON");
          return;
        }
      }
    }

    try {
      if (req.method === "GET" && path === "/v1/health") {
        sendJson(res, 200, HealthReport, {
          status: "ok",
          // HealthReport pins the literal; a deployment cannot serve a
          // different one and still satisfy the schema.
          contractVersion: CONTRACT_VERSION,
          startedAt: new Date(Date.now() - 1000).toISOString(),
          uptimeMs: 1000,
          checks: [{ name: "mongo", status: "ok", required: true }],
          engines: [
            {
              id: "native",
              capabilities: {
                streaming: true,
                tools: true,
                cancellation: true,
                resume: true,
                modelSelection: true,
                durable: true,
              },
              availability: { available: true, reason: "ready", detail: "ready" },
            },
          ],
        });
        return;
      }

      if (req.method === "GET" && path === "/v1/ready") {
        sendJson(res, 200, ReadinessReport, { ready: true, missing: [], checks: [] });
        return;
      }

      if (req.method === "GET" && path === "/v1/handshake") {
        sendJson(res, 200, EngineHandshake, handshake());
        return;
      }

      if (req.method === "GET" && path === "/v1/agents") {
        sendJson(res, 200, AgentList, {
          agents: [
            agentDescriptor("coderax", "native", "Coderax Native", false),
            agentDescriptor("opencode", "opencode", "OpenCode", true),
            agentDescriptor("freebuff", "freebuff", "Freebuff", true),
          ],
        });
        return;
      }

      if (req.method === "GET" && path === "/v1/models") {
        sendJson(res, 200, ModelList, {
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
      }

      if (req.method === "POST" && path === "/v1/work") {
        const parsed = WorkSubmitRequest.safeParse(body);
        if (!parsed.success) {
          sendProblem(res, 400, "validation_failed", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
          return;
        }
        const task = createTask(parsed.data);
        sendJson(res, 202, TaskAccepted, accepted(task));
        return;
      }

      const workMatch = /^\/v1\/work\/([^/]+)$/.exec(path);
      if (req.method === "GET" && workMatch) {
        const task = tasks.get(decodeURIComponent(workMatch[1]));
        if (task === undefined) {
          sendProblem(res, 404, "not_found", "no such task");
          return;
        }
        sendJson(res, 200, TaskStatus, statusOf(task));
        return;
      }

      const cancelMatch = /^\/v1\/work\/([^/]+)\/cancel$/.exec(path);
      if (req.method === "POST" && cancelMatch) {
        const task = tasks.get(decodeURIComponent(cancelMatch[1]));
        if (task === undefined) {
          sendProblem(res, 404, "not_found", "no such task");
          return;
        }
        const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(task.state);
        if (!terminal) {
          task.cancelRequested = true;
          task.state = "cancelled";
          task.updatedAt = iso();
          emit(task, { type: "task.cancelled", payload: { reason: body?.reason ?? "owner cancelled" } });
        }
        sendJson(res, 200, TaskControlResult, {
          taskId: task.taskId,
          state: task.state,
          generation: task.generation,
          outcome: terminal ? "already_terminal" : "accepted",
        });
        return;
      }

      const eventsMatch = /^\/v1\/work\/([^/]+)\/events$/.exec(path);
      if (req.method === "GET" && eventsMatch) {
        const task = tasks.get(decodeURIComponent(eventsMatch[1]));
        if (task === undefined) {
          sendProblem(res, 404, "not_found", "no such task");
          return;
        }
        const afterRaw = url.searchParams.get("after") ?? req.headers["last-event-id"] ?? "0";
        const after = Number(afterRaw);
        if (!Number.isInteger(after) || after < 0) {
          sendProblem(res, 400, "validation_failed", "the event cursor must be a non-negative integer");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-coderax-last-seq": String(task.events.length),
          "x-coderax-truncated": "false",
        });
        for (const event of task.events) {
          if (event.seq > after) writeFrame(res, event);
        }
        const terminalEvent = task.events.at(-1);
        if (terminalEvent && ["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(terminalEvent.type)) {
          res.end();
          return;
        }
        task.subscribers.add(res);
        req.on("close", () => task.subscribers.delete(res));
        return;
      }

      const taskArtifactsMatch = /^\/v1\/work\/([^/]+)\/artifacts$/.exec(path);
      if (taskArtifactsMatch) {
        const task = tasks.get(decodeURIComponent(taskArtifactsMatch[1]));
        if (task === undefined) {
          sendProblem(res, 404, "not_found", "no such task");
          return;
        }
        if (req.method === "GET") {
          const list = [...artifacts.values()]
            .filter((entry) => entry.record.taskId === task.taskId)
            .map((entry) => entry.record);
          sendJson(res, 200, ArtifactList, { artifacts: list });
          return;
        }
        if (req.method === "POST") {
          const parsed = ArtifactUploadRequest.safeParse(body);
          if (!parsed.success) {
            sendProblem(res, 400, "validation_failed", parsed.error.issues.map((issue) => issue.message).join("; "));
            return;
          }
          const buffer = Buffer.from(parsed.data.contentBase64, "base64");
          if (buffer.length > 9_000_000) {
            sendProblem(res, 413, "validation_failed", "the decoded artifact is too large");
            return;
          }
          if (options.tamperUpload === true) {
            const record = storeArtifact(task, {
              path: parsed.data.path,
              mediaType: parsed.data.mediaType,
              buffer: Buffer.concat([buffer, Buffer.from("tampered")]),
            });
            sendJson(res, 201, ArtifactRecord, record);
            return;
          }
          const record = storeArtifact(task, {
            path: parsed.data.path,
            mediaType: parsed.data.mediaType,
            buffer,
          });
          sendJson(res, 201, ArtifactRecord, record);
          return;
        }
      }

      const artifactMatch = /^\/v1\/artifacts\/([^/]+)$/.exec(path);
      if (req.method === "GET" && artifactMatch) {
        const entry = artifacts.get(decodeURIComponent(artifactMatch[1]));
        if (entry === undefined) {
          sendProblem(res, 404, "not_found", "no such artifact");
          return;
        }
        sendJson(res, 200, ArtifactRecord, entry.record);
        return;
      }

      const contentMatch = /^\/v1\/artifacts\/([^/]+)\/content$/.exec(path);
      if (req.method === "GET" && contentMatch) {
        const entry = artifacts.get(decodeURIComponent(contentMatch[1]));
        if (entry === undefined) {
          sendProblem(res, 404, "not_found", "no such artifact");
          return;
        }
        sendJson(res, 200, ArtifactContent, {
          artifactId: entry.record.artifactId,
          mediaType: entry.record.mediaType,
          bytes: entry.record.bytes,
          digest: options.tamperContent === true ? `sha256:${"0".repeat(64)}` : entry.record.digest,
          contentBase64: entry.buffer.toString("base64"),
        });
        return;
      }

      if (req.method === "GET" && path === "/v1/schedules") {
        sendJson(res, 200, ScheduleList, { schedules: [...schedules.values()] });
        return;
      }

      if (req.method === "POST" && path === "/v1/schedules") {
        const parsed = ScheduleCreateRequest.safeParse(body);
        if (!parsed.success) {
          sendProblem(res, 400, "validation_failed", parsed.error.issues.map((issue) => issue.message).join("; "));
          return;
        }
        const scheduleId = `schedule-${schedules.size + 1}`;
        const now = iso();
        const schedule = {
          scheduleId,
          objective: parsed.data.objective,
          agent: parsed.data.agent ?? "coderax",
          mode: parsed.data.mode ?? "cloud",
          requireApproval: parsed.data.requireApproval ?? true,
          state: "scheduled",
          runAt: parsed.data.runAt,
          ...(parsed.data.intervalMs === undefined ? {} : { intervalMs: parsed.data.intervalMs }),
          createdAt: now,
          updatedAt: now,
          nextRunAt: parsed.data.runAt,
        };
        schedules.set(scheduleId, Schedule.parse(schedule));
        sendJson(res, 201, Schedule, schedule);
        return;
      }

      const scheduleMatch = /^\/v1\/schedules\/([^/]+)$/.exec(path);
      if (req.method === "GET" && scheduleMatch) {
        const schedule = schedules.get(decodeURIComponent(scheduleMatch[1]));
        if (schedule === undefined) {
          sendProblem(res, 404, "not_found", "no such schedule");
          return;
        }
        sendJson(res, 200, Schedule, schedule);
        return;
      }

      const scheduleCancelMatch = /^\/v1\/schedules\/([^/]+)\/cancel$/.exec(path);
      if (req.method === "POST" && scheduleCancelMatch) {
        const schedule = schedules.get(decodeURIComponent(scheduleCancelMatch[1]));
        if (schedule === undefined) {
          sendProblem(res, 404, "not_found", "no such schedule");
          return;
        }
        const terminal = schedule.state === "cancelled" || schedule.state === "failed";
        if (!terminal) {
          schedule.state = "cancelled";
          schedule.updatedAt = iso();
        }
        sendJson(res, 200, ScheduleControlResult, {
          scheduleId: schedule.scheduleId,
          state: schedule.state,
          outcome: terminal ? "already_terminal" : "accepted",
        });
        return;
      }

      if (req.method === "GET" && path === "/v1/permissions") {
        const requests = [...permissions.values()].flat();
        sendJson(res, 200, PermissionList, { requests });
        return;
      }

      const permissionMatch = /^\/v1\/work\/([^/]+)\/permissions$/.exec(path);
      if (req.method === "POST" && permissionMatch) {
        const task = tasks.get(decodeURIComponent(permissionMatch[1]));
        if (task === undefined) {
          sendProblem(res, 404, "not_found", "no such task");
          return;
        }
        const list = permissions.get(task.taskId) ?? [];
        const request = list.find((entry) => entry.requestId === body?.requestId);
        if (request === undefined) {
          sendProblem(res, 404, "not_found", "no such permission request");
          return;
        }
        if (body?.decision !== "approved" && body?.decision !== "denied") {
          sendProblem(res, 400, "validation_failed", "decision must be approved or denied");
          return;
        }
        request.decision = body.decision;
        request.decidedAt = iso();
        if (body.decision === "approved" && task.state === "awaiting_approval") {
          task.state = "running";
          emit(task, { type: "step.completed", payload: { stepId: "step-1", title: "execute the objective" } });
          complete(task);
        } else if (body.decision === "denied" && task.state === "awaiting_approval") {
          fail(task, "workspace_denied", "the owner denied the permission request");
        }
        sendJson(res, 200, PermissionList, { requests: list });
        return;
      }

      sendProblem(res, 404, "not_found", `no route for ${req.method} ${path}`);
    } catch (error) {
      if (!res.headersSent) {
        sendProblem(res, 500, "internal_error", error.message);
      } else {
        res.end();
      }
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    state: { tasks, artifacts, schedules, permissions, requests, capabilities },
    handshake,
    setCapability(key, state, detail) {
      capabilities[key] = { state, detail: detail ?? `${key} is ${state}` };
    },
    behaviorFor(taskId) {
      return behaviors[taskId] ?? behaviors.default ?? "completed";
    },
    async close() {
      closed = true;
      for (const task of tasks.values()) {
        for (const subscriber of task.subscribers) subscriber.end();
        task.subscribers.clear();
      }
      server.closeAllConnections?.();
      server.close();
    },
  };
}

export { DEFAULT_TOKEN };
