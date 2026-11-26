import { createServer } from "node:http";
import { once } from "node:events";

/**
 * WorkflowEngine contract harness.
 *
 * A real HTTP server that publishes an OpenAPI 3.1 document and implements the
 * operations in it, with state. The CLI under test discovers the document over
 * the network and binds every command to it. Routes that are filtered out of
 * the document still exist on the server, so a test can prove the CLI never
 * requests an operation the deployment did not publish.
 *
 * This is a contract fixture, not a Coderax deployment. It proves the CLI's
 * discovery, binding, validation and transport behaviour against the shapes in
 * docs/CONTRACT.md; it does not prove those routes exist on a production
 * deployment.
 */

const SCHEDULE_PROPERTIES = {
  name: { type: "string" },
  cron: { type: "string" },
  prompt: { type: "string" },
  timezone: { type: "string" },
  enabled: { type: "boolean" },
  model: { type: "string" },
  agent: { type: "string" },
};

function scheduleSchema(required) {
  return {
    type: "object",
    required,
    properties: SCHEDULE_PROPERTIES,
    additionalProperties: false,
  };
}

const LIST_PARAMETERS = [
  { name: "limit", in: "query", required: false, schema: { type: "integer" } },
  { name: "cursor", in: "query", required: false, schema: { type: "string" } },
];

function initialState() {
  return {
    conversations: [
      { id: "conv-1", title: "Repository review", updatedAt: "2026-11-20T10:00:00Z", messageCount: 4 },
      { id: "conv-2", title: "Release plan", updatedAt: "2026-11-19T09:00:00Z", messageCount: 2 },
    ],
    tasks: [
      { id: "task-1", status: "running", prompt: "Fix the failing build" },
      { id: "task-2", status: "failed", prompt: "Retry the migration" },
      { id: "task-3", status: "paused", prompt: "Resume the audit" },
    ],
    permissions: [
      { id: "perm-1", scope: "repo:read", granted: true },
      { id: "perm-2", scope: "repo:write", granted: false },
    ],
    memory: [
      { id: "mem-1", key: "style", value: "tabs" },
      { id: "mem-2", key: "stack", value: "node" },
    ],
    schedules: [],
    notifications: [{ id: "note-1", title: "Build finished", read: false }],
    artifacts: new Map(),
    plugins: [
      { id: "plugin-1", name: "github", enabled: true },
      { id: "plugin-2", name: "jira", enabled: false },
    ],
    tools: [{ id: "tool-1", name: "read_file", inputSchema: { type: "object" } }],
    projects: [{ id: "proj-1", name: "Coderax", status: "active" }],
    nextArtifact: 1,
    nextSchedule: 1,
  };
}

function notFound(resource, id) {
  return { status: 404, json: { message: `${resource} not found: ${id}` } };
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  if (!boundaryMatch) return [];
  const delimiter = `--${boundaryMatch[1] ?? boundaryMatch[2]}`;
  const parts = [];
  let start = buffer.indexOf(delimiter);
  while (start !== -1) {
    const next = buffer.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const segment = buffer.subarray(start + delimiter.length, next);
    const headerEnd = segment.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headers = segment.subarray(0, headerEnd).toString("utf8");
      let content = segment.subarray(headerEnd + 4);
      if (content.length >= 2 && content[content.length - 2] === 13 && content[content.length - 1] === 10) {
        content = content.subarray(0, content.length - 2);
      }
      parts.push({
        name: /name="([^"]*)"/.exec(headers)?.[1] ?? null,
        filename: /filename="([^"]*)"/.exec(headers)?.[1] ?? null,
        headers,
        content,
      });
    }
    start = next;
  }
  return parts;
}

function routes(state) {
  const route = (definition) => definition;
  const find = (collection, id) => state[collection].find((entry) => entry.id === id);

  return [
    route({
      method: "GET",
      path: "/api/user",
      operationId: "getCurrentUser",
      summary: "Current account",
      handler: () => ({ json: { email: "harness@coderax.test", username: "harness" } }),
    }),
    route({
      method: "GET",
      path: "/api/capabilities",
      operationId: "getCapabilities",
      summary: "Deployment capability document",
      handler: () => ({
        json: { version: "harness", features: { work: true, schedules: true, artifacts: true } },
      }),
    }),
    route({
      method: "GET",
      path: "/api/agents",
      operationId: "listAgents",
      summary: "List agents",
      handler: () => ({ json: { agents: [{ id: "agent-1", name: "Reviewer" }] } }),
    }),
    route({
      method: "GET",
      path: "/api/models",
      operationId: "listModels",
      summary: "List models",
      handler: () => ({ json: { models: [{ id: "model-1", name: "Harness" }] } }),
    }),

    route({
      method: "GET",
      path: "/api/projects",
      operationId: "listProjects",
      summary: "List projects",
      handler: () => ({ json: { projects: state.projects, total: state.projects.length } }),
    }),

    route({
      method: "GET",
      path: "/api/conversations",
      operationId: "listConversations",
      summary: "List conversations",
      parameters: LIST_PARAMETERS,
      handler: ({ query }) => {
        const limit = query.limit ? Number(query.limit) : state.conversations.length;
        return {
          json: {
            conversations: state.conversations.slice(0, limit),
            total: state.conversations.length,
          },
        };
      },
    }),
    route({
      method: "GET",
      path: "/api/conversations/{conversationId}",
      operationId: "getConversation",
      summary: "Show a conversation",
      parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const conversation = find("conversations", params.conversationId);
        return conversation ? { json: conversation } : notFound("conversation", params.conversationId);
      },
    }),

    route({
      method: "GET",
      path: "/api/tasks",
      operationId: "listTasks",
      summary: "List Work tasks",
      parameters: [
        ...LIST_PARAMETERS,
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["running", "paused", "failed", "completed", "cancelled"] },
        },
      ],
      handler: ({ query }) => {
        const tasks = query.status
          ? state.tasks.filter((task) => task.status === query.status)
          : state.tasks;
        return { json: { tasks, total: tasks.length } };
      },
    }),
    route({
      method: "GET",
      path: "/api/tasks/{taskId}",
      operationId: "getTask",
      summary: "Show a Work task",
      parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const task = find("tasks", params.taskId);
        return task ? { json: task } : notFound("task", params.taskId);
      },
    }),
    ...["cancel", "retry", "resume", "detach"].map((action) => route({
      method: "POST",
      path: `/api/tasks/{taskId}/${action}`,
      operationId: `${action}Task`,
      summary: `${action} a Work task`,
      parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const task = find("tasks", params.taskId);
        if (!task) return notFound("task", params.taskId);
        task.status = action === "retry"
          ? "running"
          : action === "resume"
            ? "running"
            : action === "cancel"
              ? "cancelled"
              : "detached";
        task.lastAction = action;
        return { json: task };
      },
    })),

    route({
      method: "GET",
      path: "/api/permissions",
      operationId: "listPermissions",
      summary: "List permissions",
      parameters: LIST_PARAMETERS,
      handler: () => ({ json: { permissions: state.permissions, total: state.permissions.length } }),
    }),
    route({
      method: "GET",
      path: "/api/permissions/{permissionId}",
      operationId: "getPermission",
      summary: "Show a permission",
      parameters: [{ name: "permissionId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const permission = find("permissions", params.permissionId);
        return permission ? { json: permission } : notFound("permission", params.permissionId);
      },
    }),

    route({
      method: "GET",
      path: "/api/memory",
      operationId: "listMemory",
      summary: "List memory entries",
      parameters: LIST_PARAMETERS,
      handler: () => ({ json: { memory: state.memory, total: state.memory.length } }),
    }),
    route({
      method: "GET",
      path: "/api/memory/{memoryId}",
      operationId: "getMemory",
      summary: "Show a memory entry",
      parameters: [{ name: "memoryId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const entry = find("memory", params.memoryId);
        return entry ? { json: entry } : notFound("memory", params.memoryId);
      },
    }),
    route({
      method: "DELETE",
      path: "/api/memory/{memoryId}",
      operationId: "deleteMemory",
      summary: "Delete a memory entry",
      parameters: [{ name: "memoryId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const index = state.memory.findIndex((entry) => entry.id === params.memoryId);
        if (index === -1) return notFound("memory", params.memoryId);
        state.memory.splice(index, 1);
        return { status: 204 };
      },
    }),

    route({
      method: "GET",
      path: "/api/schedules",
      operationId: "listSchedules",
      summary: "List schedules",
      parameters: LIST_PARAMETERS,
      handler: () => ({ json: { schedules: state.schedules, total: state.schedules.length } }),
    }),
    route({
      method: "POST",
      path: "/api/schedules",
      operationId: "createSchedule",
      summary: "Create a schedule",
      requestBody: {
        required: true,
        content: { "application/json": { schema: scheduleSchema(["cron", "prompt"]) } },
      },
      handler: ({ body }) => {
        if (!body || typeof body.cron !== "string" || typeof body.prompt !== "string") {
          return { status: 400, json: { message: "cron and prompt are required" } };
        }
        const schedule = {
          id: `sched-${state.nextSchedule}`,
          name: body.name ?? `schedule-${state.nextSchedule}`,
          cron: body.cron,
          prompt: body.prompt,
          timezone: body.timezone ?? "UTC",
          enabled: body.enabled ?? true,
          status: "active",
        };
        state.nextSchedule += 1;
        state.schedules.push(schedule);
        return { status: 201, json: schedule };
      },
    }),
    route({
      method: "GET",
      path: "/api/schedules/{scheduleId}",
      operationId: "getSchedule",
      summary: "Show a schedule",
      parameters: [{ name: "scheduleId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const schedule = find("schedules", params.scheduleId);
        return schedule ? { json: schedule } : notFound("schedule", params.scheduleId);
      },
    }),
    route({
      method: "PATCH",
      path: "/api/schedules/{scheduleId}",
      operationId: "updateSchedule",
      summary: "Update a schedule",
      parameters: [{ name: "scheduleId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: scheduleSchema([]) } },
      },
      handler: ({ params, body }) => {
        const schedule = find("schedules", params.scheduleId);
        if (!schedule) return notFound("schedule", params.scheduleId);
        if (!body || Object.keys(body).length === 0) {
          return { status: 400, json: { message: "at least one field is required" } };
        }
        Object.assign(schedule, body);
        return { json: schedule };
      },
    }),
    ...["pause", "resume"].map((action) => route({
      method: "POST",
      path: `/api/schedules/{scheduleId}/${action}`,
      operationId: `${action}Schedule`,
      summary: `${action} a schedule`,
      parameters: [{ name: "scheduleId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const schedule = find("schedules", params.scheduleId);
        if (!schedule) return notFound("schedule", params.scheduleId);
        schedule.status = action === "pause" ? "paused" : "active";
        return { json: schedule };
      },
    })),
    route({
      method: "DELETE",
      path: "/api/schedules/{scheduleId}",
      operationId: "deleteSchedule",
      summary: "Delete a schedule",
      parameters: [{ name: "scheduleId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const index = state.schedules.findIndex((schedule) => schedule.id === params.scheduleId);
        if (index === -1) return notFound("schedule", params.scheduleId);
        state.schedules.splice(index, 1);
        return { status: 204 };
      },
    }),

    route({
      method: "GET",
      path: "/api/notifications",
      operationId: "listNotifications",
      summary: "List notifications",
      parameters: LIST_PARAMETERS,
      handler: () => ({ json: { notifications: state.notifications, total: state.notifications.length } }),
    }),
    route({
      method: "POST",
      path: "/api/notifications/{notificationId}/read",
      operationId: "markNotificationRead",
      summary: "Mark a notification read",
      parameters: [{ name: "notificationId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const notification = find("notifications", params.notificationId);
        if (!notification) return notFound("notification", params.notificationId);
        notification.read = true;
        return { json: notification };
      },
    }),

    route({
      method: "GET",
      path: "/api/artifacts",
      operationId: "listArtifacts",
      summary: "List artifacts",
      parameters: LIST_PARAMETERS,
      handler: () => ({
        json: {
          artifacts: [...state.artifacts.values()].map(({ bytes, ...metadata }) => ({
            ...metadata,
            bytes: bytes.length,
          })),
        },
      }),
    }),
    route({
      method: "POST",
      path: "/api/artifacts",
      operationId: "uploadArtifact",
      summary: "Upload an artifact",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file"],
              properties: { file: { type: "string", format: "binary" } },
            },
          },
        },
      },
      handler: ({ raw, contentType }) => {
        const parts = parseMultipart(raw, contentType);
        const file = parts.find((part) => part.name === "file" && part.filename);
        if (!file) return { status: 400, json: { message: "multipart field `file` is required" } };
        const id = `art-${state.nextArtifact}`;
        state.nextArtifact += 1;
        const artifact = {
          id,
          name: file.filename,
          contentType: "application/octet-stream",
          bytes: Buffer.from(file.content),
          createdAt: "2026-11-26T00:00:00Z",
        };
        state.artifacts.set(id, artifact);
        return { status: 201, json: { id, name: artifact.name, bytes: artifact.bytes.length } };
      },
    }),
    route({
      method: "GET",
      path: "/api/artifacts/{artifactId}",
      operationId: "getArtifact",
      summary: "Show artifact metadata",
      parameters: [{ name: "artifactId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const artifact = state.artifacts.get(params.artifactId);
        if (!artifact) return notFound("artifact", params.artifactId);
        return { json: { id: artifact.id, name: artifact.name, bytes: artifact.bytes.length } };
      },
    }),
    route({
      method: "GET",
      path: "/api/artifacts/{artifactId}/content",
      operationId: "downloadArtifact",
      summary: "Download artifact content",
      parameters: [{ name: "artifactId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const artifact = state.artifacts.get(params.artifactId);
        if (!artifact) return notFound("artifact", params.artifactId);
        return {
          buffer: artifact.bytes,
          contentType: "application/octet-stream",
          headers: { "content-disposition": `attachment; filename="${artifact.name}"` },
        };
      },
    }),
    route({
      method: "DELETE",
      path: "/api/artifacts/{artifactId}",
      operationId: "deleteArtifact",
      summary: "Delete an artifact",
      parameters: [{ name: "artifactId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        if (!state.artifacts.delete(params.artifactId)) return notFound("artifact", params.artifactId);
        return { status: 204 };
      },
    }),

    route({
      method: "GET",
      path: "/api/plugins",
      operationId: "listPlugins",
      summary: "List plugins",
      parameters: LIST_PARAMETERS,
      handler: () => ({ json: { plugins: state.plugins, total: state.plugins.length } }),
    }),
    route({
      method: "GET",
      path: "/api/plugins/{pluginId}",
      operationId: "getPlugin",
      summary: "Show a plugin",
      parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const plugin = find("plugins", params.pluginId);
        return plugin ? { json: plugin } : notFound("plugin", params.pluginId);
      },
    }),

    route({
      method: "GET",
      path: "/api/tools",
      operationId: "listTools",
      summary: "List tools",
      parameters: LIST_PARAMETERS,
      handler: () => ({ json: { tools: state.tools, total: state.tools.length } }),
    }),
    route({
      method: "GET",
      path: "/api/tools/{toolId}",
      operationId: "getTool",
      summary: "Show a tool",
      parameters: [{ name: "toolId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => {
        const tool = find("tools", params.toolId);
        return tool ? { json: tool } : notFound("tool", params.toolId);
      },
    }),
    route({
      method: "POST",
      path: "/api/tools/{toolId}/invoke",
      operationId: "invokeTool",
      summary: "Invoke a tool",
      parameters: [{ name: "toolId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: false,
        content: { "application/json": { schema: { type: "object" } } },
      },
      handler: ({ params, body }) => {
        const tool = find("tools", params.toolId);
        if (!tool) return notFound("tool", params.toolId);
        return { json: { tool: tool.id, input: body ?? {}, result: "ok" } };
      },
    }),

    route({
      method: "POST",
      path: "/api/work/chat",
      operationId: "workChat",
      hidden: true,
      summary: "Native Work chat stream",
      handler: () => ({
        sse: [
          'data: {"message":true,"text":"harness accepted"}\n\n',
          'data: {"message":true,"text":"harness accepted and verified"}\n\n',
          'data: {"final":true,"responseMessage":{"text":"harness accepted and verified"}}\n\n',
        ],
      }),
    }),
  ];
}

export async function startWorkflowEngine({
  token = "harness-token",
  only = null,
  includeCapabilityDocument = true,
  extraRoutes = [],
} = {}) {
  const state = initialState();
  const allRoutes = [...routes(state), ...extraRoutes];
  const requests = [];

  const documented = allRoutes.filter((route) => {
    if (route.hidden) return false;
    if (!includeCapabilityDocument && route.path === "/api/capabilities") return false;
    if (only === null) return true;
    return only.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`));
  });

  const document = {
    openapi: "3.1.0",
    info: { title: "WorkflowEngine contract harness", version: "1.0.0" },
    paths: {},
  };
  for (const route of documented) {
    document.paths[route.path] ??= {};
    document.paths[route.path][route.method.toLowerCase()] = {
      operationId: route.operationId,
      summary: route.summary,
      ...(route.parameters ? { parameters: route.parameters } : {}),
      ...(route.requestBody ? { requestBody: route.requestBody } : {}),
    };
  }

  const compiled = allRoutes.map((route) => {
    const names = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const pattern = new RegExp(
      `^${route.path
        .split("/")
        .map((segment) => (segment.startsWith("{") ? "([^/]+)" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/")}$`,
    );
    return { route, names, pattern };
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname });

    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === "/openapi.json") return json(200, document);
    if (url.pathname === "/health") return json(200, { status: "ok", service: "workflow-engine-harness" });

    if (req.headers.authorization !== `Bearer ${token}`) {
      return json(401, { message: "unauthorized" });
    }

    const match = compiled.find(
      (entry) => entry.route.method === req.method && entry.pattern.test(url.pathname),
    );
    if (!match) return json(404, { message: `no route for ${req.method} ${url.pathname}` });

    const values = match.pattern.exec(url.pathname).slice(1);
    const params = Object.fromEntries(match.names.map((name, index) => [name, decodeURIComponent(values[index])]));

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] ?? "";
    let body = null;
    if (raw.length > 0 && contentType.includes("application/json")) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = null;
      }
    }

    let result;
    try {
      result = await match.route.handler({
        params,
        query: Object.fromEntries(url.searchParams),
        body,
        raw,
        contentType,
        state,
      });
    } catch (error) {
      return json(500, { message: `harness failure: ${error.message}` });
    }

    if (!result) return json(500, { message: "harness handler returned nothing" });
    if (result.sse) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const chunk of result.sse) res.write(chunk);
      res.end();
      return;
    }
    if (result.buffer) {
      res.writeHead(result.status ?? 200, {
        "content-type": result.contentType ?? "application/octet-stream",
        ...(result.headers ?? {}),
      });
      res.end(result.buffer);
      return;
    }
    if (result.json === undefined) {
      res.writeHead(result.status ?? 204);
      res.end();
      return;
    }
    return json(result.status ?? 200, result.json);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    state,
    requests,
    document,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    },
  };
}
