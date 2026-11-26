import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TOKEN = "owner-test-token-0123456789abcdef";
export const BASE = "http://127.0.0.1:0";

export function capture() {
  const out = [];
  const err = [];
  return {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    out: () => out.join(""),
    err: () => err.join(""),
    clear: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

export async function tempEnv() {
  const directory = await mkdtemp(join(tmpdir(), "coderax-test-"));
  return { CODERAX_CONFIG: join(directory, "config.json") };
}

export function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

export function problem(status, code, detail, extra = {}) {
  return {
    type: `https://coderax.dev/problems/${code}`,
    title: code.replaceAll("_", " "),
    status,
    code,
    detail,
    retryable: false,
    ...extra,
  };
}

export function sseHead(res, status = 200) {
  res.writeHead(status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
}

export function sseWrite(res, value) {
  res.write(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
}

export function event(type, seq, payload, extra = {}) {
  return {
    v: 1,
    eventId: `evt_${seq}`,
    taskId: "task-1",
    seq,
    at: "2026-11-26T00:00:00.000Z",
    agent: "coderax",
    generation: 1,
    type,
    ...(payload === undefined ? {} : { payload }),
    ...extra,
  };
}

export async function withServer(handler, run) {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) json(res, 500, problem(500, "internal_error", String(error?.message ?? error)));
      else res.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  try {
    return await run(url, server);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

export function healthBody(overrides = {}) {
  return {
    status: "ok",
    contractVersion: "1.0.0",
    startedAt: "2026-11-26T00:00:00.000Z",
    uptimeMs: 1000,
    checks: [{ name: "configuration", status: "ok", required: true }],
    engines: [
      {
        id: "native",
        capabilities: {
          streaming: true,
          tools: false,
          cancellation: true,
          resume: true,
          modelSelection: true,
          durable: true,
        },
        availability: { available: true, reason: "ready", detail: "ready" },
      },
    ],
    ...overrides,
  };
}

export function agentsBody() {
  const capabilities = {
    streaming: true,
    tools: false,
    cancellation: true,
    resume: true,
    modelSelection: true,
    durable: true,
  };
  const isolation = { workspace: "isolated", memory: "none", credentials: "none", conversations: "none" };
  return {
    agents: ["coderax", "opencode", "freebuff"].map((id, index) => ({
      id,
      engine: id === "coderax" ? "native" : id,
      label: id,
      external: id !== "coderax",
      capabilities,
      availability: {
        available: index === 0,
        reason: index === 0 ? "ready" : "sdk_unavailable",
        detail: index === 0 ? "ready" : "not configured",
      },
      isolation,
    })),
  };
}

export function modelsBody() {
  return {
    models: [
      {
        ref: { providerId: "free", modelId: "coderax-small" },
        label: "free coderax-small",
        costClass: "free",
        toolCalling: false,
        streaming: true,
        availability: { available: true, reason: "ready", detail: "ready" },
      },
    ],
    route: [{ providerId: "free", modelId: "coderax-small" }],
    allowPaid: false,
  };
}

export function acceptedBody(overrides = {}) {
  return {
    taskId: "task-1",
    conversationId: "conv-1",
    state: "queued",
    generation: 1,
    eventsPath: "/v1/work/task-1/events",
    ...overrides,
  };
}

export function taskBody(overrides = {}) {
  return {
    taskId: "task-1",
    conversationId: "conv-1",
    state: "completed",
    agent: "coderax",
    mode: "cloud",
    model: { providerId: "free", modelId: "coderax-small" },
    generation: 1,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:01.000Z",
    cancelRequested: false,
    steps: [{ id: "step-1", title: "Interpret the objective", state: "completed" }],
    result: { summary: "hello world", artifacts: [] },
    usage: { inputTokens: 11, outputTokens: 13 },
    ...overrides,
  };
}

export function chatBody(overrides = {}) {
  return {
    conversationId: "conv-1",
    messageId: "msg-1",
    text: "a reply",
    agent: "coderax",
    model: { providerId: "free", modelId: "coderax-small" },
    usage: { inputTokens: 1, outputTokens: 2 },
    createdAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

export function notificationsBody(overrides = {}) {
  return {
    notifications: [
      {
        taskId: "task-1",
        conversationId: "conv-1",
        agent: "coderax",
        mode: "cloud",
        state: "completed",
        summary: "hello world",
        createdAt: "2026-11-26T00:00:01.000Z",
        read: false,
      },
    ],
    unread: 1,
    ...overrides,
  };
}

export function conversationBody(overrides = {}) {
  return {
    conversationId: "conv-1",
    title: "hello",
    mode: "private",
    isWork: false,
    agent: "coderax",
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:01.000Z",
    messages: [
      {
        messageId: "msg-1",
        conversationId: "conv-1",
        role: "user",
        text: "hello",
        createdAt: "2026-11-26T00:00:00.000Z",
      },
      {
        messageId: "msg-2",
        conversationId: "conv-1",
        role: "assistant",
        text: "a reply",
        createdAt: "2026-11-26T00:00:01.000Z",
      },
    ],
    ...overrides,
  };
}

export function permissionBody(overrides = {}) {
  return {
    requestId: "perm-1",
    taskId: "task-1",
    agent: "coderax",
    scope: "workspace.write",
    description: "write the release checklist",
    resource: "release-checklist.md",
    requestedAt: "2026-11-26T00:00:00.000Z",
    expiresAt: "2026-11-26T00:10:00.000Z",
    decision: "pending",
    ...overrides,
  };
}
