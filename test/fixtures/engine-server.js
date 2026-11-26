/**
 * A contract-faithful WorkflowEngine fixture for the CLI's tests.
 *
 * It is deliberately not an engine implementation: it performs no inference and
 * executes no code. It serves the published `/v1` shapes, sequences events and
 * accepts approvals so the client's replay, reconnect, cancellation, resume,
 * notification and rendering paths can be exercised over real HTTP without a
 * deployment, a credential or any spending.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

const CONTRACT_VERSION = "1.0.0";

function iso() {
  return new Date().toISOString();
}

function problem(status, code, detail, retryable = false) {
  return {
    type: `https://coderax.dev/problems/${code}`,
    title: code.replaceAll("_", " "),
    status,
    code,
    ...(detail ? { detail } : {}),
    retryable,
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function defaultScript({ tools }) {
  const script = [
    { type: "task.queued", delay: 5 },
    { type: "task.started", delay: 10 },
    { type: "step.started", payload: { stepId: "s1", title: "Inspect the cloud workspace" }, delay: 10 },
    { type: "text.delta", payload: { text: "I inspected the workspace. " }, delay: 10 },
  ];
  if (tools) {
    script.push(
      { type: "tool.call", payload: { callId: "c1", tool: "read", input: { path: "README.md" } }, delay: 10 },
      { type: "tool.result", payload: { callId: "c1", tool: "read", ok: true, output: "# Fixture repository" }, delay: 10 },
      { type: "file.edit", payload: { path: "src/index.js" }, delay: 10 },
    );
  }
  script.push(
    { type: "text.delta", payload: { text: "The change is ready." }, delay: 10 },
    { type: "step.completed", payload: { stepId: "s1", title: "Inspect the cloud workspace" }, delay: 10 },
    { type: "usage", payload: { inputTokens: 120, outputTokens: 30 }, delay: 5 },
    {
      type: "task.completed",
      payload: {
        summary: "## Fixture result\n\n- inspected the workspace\n- verified the change\n\n```js\nconst ok = true;\n```",
        usage: { inputTokens: 120, outputTokens: 30 },
      },
      delay: 10,
    },
  );
  return script;
}

export async function startFixtureEngine({
  token = "fixture-owner-token-0123456789",
  tools = true,
  contractVersion = CONTRACT_VERSION,
  script = null,
  requireApproval = false,
  disconnectAfter = null,
  chatReply = null,
  bufferStart = 1,
  port = 0,
} = {}) {
  const tasks = new Map();
  const conversations = new Map();
  const notifications = [];
  const requests = [];
  const idempotency = new Map();
  const maxEvents = 2_000;

  const agents = [
    {
      id: "coderax",
      engine: "native",
      label: "Coderax Native",
      external: false,
      capabilities: {
        streaming: true,
        tools,
        cancellation: true,
        resume: true,
        modelSelection: true,
        durable: true,
      },
      availability: { available: true, reason: "ready", detail: "fixture" },
      isolation: { workspace: "isolated", memory: "none", credentials: "none", conversations: "none" },
    },
    {
      id: "opencode",
      engine: "opencode",
      label: "OpenCode",
      external: true,
      capabilities: {
        streaming: false,
        tools: false,
        cancellation: false,
        resume: false,
        modelSelection: false,
        durable: false,
      },
      availability: { available: false, reason: "not_configured", detail: "fixture does not configure it" },
      isolation: { workspace: "isolated", memory: "none", credentials: "none", conversations: "none" },
    },
    {
      id: "freebuff",
      engine: "freebuff",
      label: "FreeBuff",
      external: true,
      capabilities: {
        streaming: false,
        tools: false,
        cancellation: false,
        resume: false,
        modelSelection: false,
        durable: false,
      },
      availability: { available: false, reason: "sdk_unavailable", detail: "fixture does not load it" },
      isolation: { workspace: "isolated", memory: "none", credentials: "none", conversations: "none" },
    },
  ];

  const model = { providerId: "fixture", modelId: "free-model" };

  function health() {
    return {
      status: "ok",
      contractVersion,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      uptimeMs: 60_000,
      checks: [{ name: "persistence", status: "ok", required: true }],
      engines: [
        {
          id: "native",
          capabilities: agents[0].capabilities,
          availability: agents[0].availability,
        },
      ],
    };
  }

  function conversationFor(id, { isWork = false, mode = "private", agent = "coderax", title = null } = {}) {
    if (conversations.has(id)) return conversations.get(id);
    const conversation = {
      conversationId: id,
      ...(title ? { title } : {}),
      mode,
      isWork,
      agent,
      createdAt: iso(),
      updatedAt: iso(),
      messages: [],
    };
    conversations.set(id, conversation);
    return conversation;
  }

  function addMessage(conversation, role, text) {
    conversation.messages.push({
      messageId: `msg_${randomUUID()}`,
      conversationId: conversation.conversationId,
      role,
      text,
      createdAt: iso(),
    });
    conversation.updatedAt = iso();
  }

  function eventFor(task, type, payload) {
    task.seq += 1;
    const event = {
      v: 1,
      eventId: `evt_${task.taskId}_${task.seq}`,
      taskId: task.taskId,
      seq: task.seq,
      at: iso(),
      agent: task.agent,
      generation: task.generation,
      type,
      ...(payload === undefined ? {} : { payload }),
    };
    task.events.push(event);
    if (task.events.length > maxEvents) task.events.shift();
    task.updatedAt = iso();
    if (type === "task.queued") task.state = "queued";
    if (type === "task.started") task.state = "running";
    if (type === "step.started") {
      const existing = task.steps.find((step) => step.id === payload.stepId);
      if (existing) existing.state = "running";
      else task.steps.push({ id: payload.stepId, title: payload.title, state: "running" });
    }
    if (type === "step.completed") {
      const existing = task.steps.find((step) => step.id === payload.stepId);
      if (existing) existing.state = "completed";
      else task.steps.push({ id: payload.stepId, title: payload.title, state: "completed" });
    }
    if (type === "task.failed" || type === "task.cancelled" || type === "task.interrupted") {
      task.state = type.slice(5);
    }
    if (type === "task.completed") {
      task.state = "completed";
      task.result = {
        ...(payload?.summary ? { summary: payload.summary } : {}),
        artifacts: task.artifacts,
      };
      if (payload?.usage) task.usage = payload.usage;
    }
    if (type === "task.failed") {
      task.failure = { code: payload?.code ?? "provider_error", ...(payload?.detail ? { detail: payload.detail } : {}) };
    }
    if (type === "usage") task.usage = payload;
    if (["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(type)) {
      notifications.push({
        taskId: task.taskId,
        conversationId: task.conversationId,
        agent: task.agent,
        mode: task.mode,
        state: task.state,
        ...(payload?.summary ? { summary: payload.summary.slice(0, 500) } : {}),
        createdAt: iso(),
        read: false,
      });
      const conversation = conversations.get(task.conversationId);
      if (conversation) {
        const text = payload?.summary ?? `Task ${task.state}.`;
        addMessage(conversation, "assistant", text);
      }
    }
    for (const listener of task.listeners) listener(event);
    return event;
  }

  function statusFor(task) {
    return {
      taskId: task.taskId,
      conversationId: task.conversationId,
      state: task.state,
      agent: task.agent,
      mode: task.mode,
      ...(task.model ? { model: task.model } : {}),
      generation: task.generation,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      cancelRequested: task.cancelRequested,
      steps: task.steps.map((step) => ({ id: step.id, title: step.title, state: step.state })),
      ...(task.result ? { result: task.result } : {}),
      ...(task.usage ? { usage: task.usage } : {}),
      ...(task.failure ? { failure: task.failure } : {}),
    };
  }

  function schedule(task, delay) {
    if (task.state === "cancelled") return;
    task.timer = setTimeout(() => advance(task), Math.max(0, delay ?? 10));
    task.timer.unref?.();
  }

  function advance(task) {
    if (task.state === "cancelled") return;
    if (task.index >= task.script.length) return;
    const step = task.script[task.index];
    task.index += 1;
    if (step.type === "approval.required") {
      const request = {
        requestId: step.payload?.requestId ?? `req_${randomUUID()}`,
        taskId: task.taskId,
        agent: task.agent,
        scope: step.payload?.scope ?? "command.execute",
        description: step.payload?.description ?? "Run the verification command",
        resource: step.payload?.resource ?? "npm test",
        requestedAt: iso(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        decision: "pending",
      };
      task.permissions.push(request);
      task.state = "awaiting_approval";
      eventFor(task, "approval.required", {
        requestId: request.requestId,
        tool: step.payload?.tool ?? "command",
        description: request.description,
      });
      task.approval = {
        requestId: request.requestId,
        resolve: (approved) => {
          request.decision = approved ? "approved" : "denied";
          request.decidedAt = iso();
          task.approval = null;
          if (!approved) {
            task.state = "failed";
            eventFor(task, "task.failed", { code: "cancelled", detail: "permission denied", retryable: false });
            task.listeners.clear();
            return;
          }
          task.state = "running";
          schedule(task, 10);
        },
      };
      return;
    }
    if (step.type === "file.edit" && step.payload?.path) {
      if (!task.artifacts.some((artifact) => artifact.path === step.payload.path)) {
        task.artifacts.push({ path: step.payload.path, bytes: 42 });
      }
    }
    eventFor(task, step.type, step.payload);
    if (["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(step.type)) {
      task.listeners.clear();
      return;
    }
    schedule(task, step.delay);
  }

  function startTask(task) {
    const baseScript = script ?? defaultScript({ tools });
    const steps = [...baseScript];
    if (requireApproval && !steps.some((entry) => entry.type === "approval.required")) {
      steps.splice(4, 0, {
        type: "approval.required",
        payload: {
          requestId: "req_fixture",
          tool: "command",
          description: "Run the fixture test command",
          resource: "npm test",
        },
        delay: 10,
      });
    }
    task.script = steps;
    task.index = 0;
    schedule(task, 5);
  }

  function auth(req) {
    const header = req.headers.authorization;
    return header === `Bearer ${token}`;
  }

  function serveEvents(req, res, task) {
    const url = new URL(req.url, "http://fixture");
    const after = Number(url.searchParams.get("after") ?? 0);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const seen = new Set();
    let sent = 0;
    let closed = false;
    const writeEvent = (event) => {
      if (closed || event.seq <= after || seen.has(event.eventId)) return;
      seen.add(event.eventId);
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      sent += 1;
      if (disconnectAfter !== null && sent >= disconnectAfter) {
        closed = true;
        res.end();
      } else if (["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(event.type)) {
        closed = true;
        setTimeout(() => res.end(), 5);
      }
    };
    const replay = task.events.filter((event) => event.seq >= bufferStart && event.seq > after);
    for (const event of replay) writeEvent(event);
    if (closed) return;
    const listener = (event) => writeEvent(event);
    task.listeners.add(listener);
    const heartbeat = setInterval(() => {
      if (!closed) res.write(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref?.();
    const cleanup = () => {
      closed = true;
      clearInterval(heartbeat);
      task.listeners.delete(listener);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  const server = createServer((req, res) => {
    void (async () => {
      let url;
      try {
        url = new URL(req.url, "http://fixture");
      } catch {
        json(res, 400, problem(400, "validation_failed", "bad URL"));
        return;
      }
      requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, at: iso() });

      if (req.method === "GET" && url.pathname === "/v1/health") {
        json(res, 200, health());
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/ready") {
        json(res, 200, { ready: true, missing: [], checks: [] });
        return;
      }
      if (!auth(req)) {
        json(res, 401, problem(401, "unauthorized", "the owner token is required"));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/agents") {
        json(res, 200, { agents });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        json(res, 200, {
          models: [
            {
              ref: model,
              label: "Fixture Free Model",
              costClass: "free",
              contextTokens: 32_000,
              toolCalling: tools,
              streaming: true,
              availability: { available: true, reason: "ready", detail: "fixture" },
            },
          ],
          route: [model],
          allowPaid: false,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat") {
        const body = await readJson(req).catch(() => null);
        if (!body || typeof body.message !== "string" || body.message.length === 0) {
          json(res, 400, problem(400, "validation_failed", "message is required"));
          return;
        }
        const conversation = conversationFor(body.conversationId ?? `conv_${randomUUID()}`, {
          mode: body.mode ?? "private",
          agent: body.agent ?? "coderax",
        });
        addMessage(conversation, "user", body.message);
        const text = chatReply ?? `Echo: ${body.message}`;
        addMessage(conversation, "assistant", text);
        json(res, 200, {
          conversationId: conversation.conversationId,
          messageId: conversation.messages[conversation.messages.length - 1].messageId,
          text,
          agent: body.agent ?? "coderax",
          model: body.model ?? model,
          usage: { inputTokens: 5, outputTokens: 7 },
          createdAt: iso(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/work") {
        const body = await readJson(req).catch(() => null);
        if (!body || typeof body.objective !== "string" || body.objective.length === 0) {
          json(res, 400, problem(400, "validation_failed", "objective is required"));
          return;
        }
        const key = req.headers["idempotency-key"];
        if (typeof key === "string" && idempotency.has(key)) {
          const existing = idempotency.get(key);
          json(res, 202, {
            taskId: existing.taskId,
            conversationId: existing.conversationId,
            state: existing.state,
            generation: existing.generation,
            eventsPath: `/v1/work/${existing.taskId}/events`,
          });
          return;
        }
        const conversation = conversationFor(body.conversationId ?? `conv_${randomUUID()}`, {
          isWork: true,
          mode: body.mode ?? "cloud",
          agent: body.agent ?? "coderax",
          title: body.objective.slice(0, 60),
        });
        addMessage(conversation, "user", body.objective);
        const task = {
          taskId: `task_${randomUUID()}`,
          conversationId: conversation.conversationId,
          state: "queued",
          agent: body.agent ?? "coderax",
          mode: body.mode ?? "cloud",
          model: body.model ?? model,
          generation: 0,
          createdAt: iso(),
          updatedAt: iso(),
          cancelRequested: false,
          steps: [],
          artifacts: [],
          events: [],
          seq: 0,
          listeners: new Set(),
          permissions: [],
          approval: null,
          script: [],
          index: 0,
          timer: null,
        };
        tasks.set(task.taskId, task);
        if (typeof key === "string") idempotency.set(key, task);
        const accepted = {
          taskId: task.taskId,
          conversationId: task.conversationId,
          state: task.state,
          generation: task.generation,
          eventsPath: `/v1/work/${task.taskId}/events`,
        };
        json(res, 202, accepted);
        startTask(task);
        return;
      }

      const taskMatch = url.pathname.match(/^\/v1\/work\/([^/]+)(?:\/(cancel|resume|retry|events|permissions))?$/);
      if (taskMatch) {
        const task = tasks.get(decodeURIComponent(taskMatch[1]));
        if (!task) {
          json(res, 404, problem(404, "not_found", "task not found"));
          return;
        }
        const action = taskMatch[2] ?? null;
        if (req.method === "GET" && action === null) {
          json(res, 200, statusFor(task));
          return;
        }
        if (req.method === "GET" && action === "events") {
          serveEvents(req, res, task);
          return;
        }
        if (req.method === "POST" && action === "cancel") {
          const body = await readJson(req).catch(() => ({}));
          if (["completed", "failed", "cancelled", "interrupted"].includes(task.state)) {
            json(res, 200, {
              taskId: task.taskId,
              state: task.state,
              generation: task.generation,
              outcome: "already_terminal",
            });
            return;
          }
          task.cancelRequested = true;
          if (task.timer) clearTimeout(task.timer);
          task.state = "cancelled";
          eventFor(task, "task.cancelled", body.reason ? { reason: body.reason } : {});
          json(res, 200, {
            taskId: task.taskId,
            state: task.state,
            generation: task.generation,
            outcome: "accepted",
          });
          return;
        }
        if (req.method === "POST" && (action === "resume" || action === "retry")) {
          const body = await readJson(req).catch(() => ({}));
          task.generation += 1;
          task.state = "running";
          task.index = 0;
          task.script = [
            { type: "task.started", delay: 5 },
            { type: "text.delta", payload: { text: `${action === "retry" ? "Retrying" : "Resuming"}. ` }, delay: 5 },
            { type: "task.completed", payload: { summary: `${action === "retry" ? "Retried" : "Resumed"} successfully.` }, delay: 5 },
          ];
          eventFor(task, "task.started", {});
          schedule(task, 5);
          json(res, 200, {
            taskId: task.taskId,
            state: task.state,
            generation: task.generation,
            outcome: "accepted",
          });
          return;
        }
        if (action === "permissions" && req.method === "GET") {
          json(res, 200, { requests: task.permissions });
          return;
        }
        if (action === "permissions" && req.method === "POST") {
          const body = await readJson(req).catch(() => null);
          if (!body || typeof body.requestId !== "string" || !["approved", "denied"].includes(body.decision)) {
            json(res, 400, problem(400, "validation_failed", "requestId and decision are required"));
            return;
          }
          const request = task.permissions.find((entry) => entry.requestId === body.requestId);
          if (!request) {
            json(res, 404, problem(404, "not_found", "permission request not found"));
            return;
          }
          request.decision = body.decision;
          request.decidedAt = iso();
          if (task.approval?.requestId === body.requestId) {
            const resolve = task.approval.resolve;
            resolve(body.decision === "approved");
          }
          json(res, 200, { requests: task.permissions });
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/v1/conversations") {
        const list = [...conversations.values()]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((conversation) => ({
            conversationId: conversation.conversationId,
            ...(conversation.title ? { title: conversation.title } : {}),
            isWork: conversation.isWork,
            agent: conversation.agent,
            updatedAt: conversation.updatedAt,
          }));
        json(res, 200, { conversations: list });
        return;
      }
      const conversationMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
      if (req.method === "GET" && conversationMatch) {
        const conversation = conversations.get(decodeURIComponent(conversationMatch[1]));
        if (!conversation) {
          json(res, 404, problem(404, "not_found", "conversation not found"));
          return;
        }
        json(res, 200, conversation);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/memory") {
        json(res, 200, { entries: [] });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/notifications") {
        json(res, 200, {
          notifications: notifications.slice().reverse(),
          unread: notifications.filter((entry) => !entry.read).length,
        });
        return;
      }

      json(res, 404, problem(404, "not_found", "route not found"));
    })().catch(() => {
      if (!res.headersSent) json(res, 500, problem(500, "internal_error", "fixture failure"));
      else res.end();
    });
  });

  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  return {
    url: base,
    token,
    port: address.port,
    tasks,
    conversations,
    notifications,
    requests,
    model,
    async close() {
      for (const task of tasks.values()) {
        if (task.timer) clearTimeout(task.timer);
        task.listeners.clear();
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
    getTask(taskId) {
      const task = tasks.get(taskId);
      return task ? statusFor(task) : null;
    },
    emit(taskId, type, payload) {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`unknown task ${taskId}`);
      return eventFor(task, type, payload);
    },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  const engine = await startFixtureEngine();
  process.stdout.write(`${JSON.stringify({ url: engine.url, token: engine.token })}\n`);
  process.on("SIGINT", async () => {
    await engine.close();
    process.exit(0);
  });
}
