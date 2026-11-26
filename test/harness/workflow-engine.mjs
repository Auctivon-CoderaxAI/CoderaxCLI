import { createServer } from "node:http";
import { once } from "node:events";

/**
 * An in-process WorkflowEngine compatible with the Coderax deployment surface
 * the CLI talks to. Every test drives it over a real TCP socket; nothing here
 * stubs `fetch`.
 *
 * The frame shapes follow the deployment's native Work engine: a `created`
 * frame with a stream id, cumulative `message` snapshots, non-text `event`
 * frames (including pending permission actions), and one `final` frame that
 * carries the authoritative answer. SSE `id:` lines make replay possible.
 */

export const OWNER_TOKEN = "owner-token-ci-owner";
export const NON_OWNER_TOKEN = "intruder-token-ci-guest";
export const API_VERSION = "1.0.0";

export function openapiDocument(version = API_VERSION) {
  return {
    openapi: "3.1.0",
    info: { title: "Coderax WorkflowEngine test harness", version },
    paths: {
      "/health": { get: { operationId: "health", summary: "Liveness" } },
      "/api/user": { get: { operationId: "getUser", summary: "Current account" } },
      "/api/models": { get: { operationId: "listModels", summary: "List models" } },
      "/api/agents": { get: { operationId: "listAgents", summary: "List agents" } },
      "/api/ask/agents": { post: { operationId: "chat", summary: "Chat completion" } },
      "/api/work/chat": { post: { operationId: "workChat", summary: "Start a Work run" } },
      "/api/work/chat/{streamId}/events": { get: { operationId: "workEvents", summary: "Replay a Work run" } },
      "/api/work/chat/{streamId}/cancel": { post: { operationId: "cancelWork", summary: "Cancel a Work run" } },
    },
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function startSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
}

function writeFrame(res, id, payload) {
  res.write(`id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function authenticate(req) {
  const header = req.headers.authorization ?? "";
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      body: { error: "UNAUTHENTICATED", message: "A bearer token is required." },
    };
  }
  const token = header.slice("Bearer ".length);
  if (token !== OWNER_TOKEN) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "OWNER_ONLY",
        message: "This deployment is owner-only; the presented token is not the instance owner.",
      },
    };
  }
  return { ok: true, token };
}

export async function startHarness({ apiVersion = API_VERSION } = {}) {
  const requests = [];
  const streams = new Map();
  const sockets = new Set();
  let counter = 0;

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "HARNESS_FAILURE", message: String(error?.message ?? error) });
      } else {
        res.destroy();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    requests.push({ method: req.method, path, headers: req.headers, query: url.searchParams });

    if (path === "/health") {
      sendJson(res, 200, { status: "ok", service: "coderax", apiVersion });
      return;
    }
    if (path === "/openapi.json") {
      sendJson(res, 200, openapiDocument(apiVersion));
      return;
    }

    if (path.startsWith("/api/")) {
      const auth = authenticate(req);
      if (!auth.ok) {
        sendJson(res, auth.status, auth.body);
        return;
      }

      if (path === "/api/user") {
        sendJson(res, 200, { email: "owner@coderax.test", role: "owner" });
        return;
      }
      if (path === "/api/models") {
        sendJson(res, 200, { models: ["gpt-4.1", "coderax-work"] });
        return;
      }
      if (path === "/api/agents") {
        sendJson(res, 200, { agents: [{ id: "agent-1", name: "Reviewer" }] });
        return;
      }
      if (path === "/api/whoami") {
        sendJson(res, 200, { ok: true, token: auth.token });
        return;
      }
      if (path === "/api/echo-error") {
        sendJson(res, 500, { error: "ENGINE_FAILED", message: `engine rejected bearer ${auth.token}` });
        return;
      }
      if (path === "/api/slow") {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (!res.destroyed) sendJson(res, 200, { ok: true });
        return;
      }
      if (path === "/api/ask/agents" && req.method === "POST") {
        const body = await readBody(req);
        requests.at(-1).body = body;
        startSse(res);
        writeFrame(res, 1, { delta: "hello " });
        writeFrame(res, 2, { delta: `from the owner ${auth.token}` });
        writeFrame(res, 3, { final: true, responseMessage: { text: `hello from the owner ${auth.token}` } });
        res.end();
        return;
      }
      if (path === "/api/work/chat" && req.method === "POST") {
        const body = await readBody(req);
        requests.at(-1).body = body;
        const text = typeof body?.text === "string" ? body.text : "";

        if (text.includes("reject")) {
          sendJson(res, 500, {
            error: "ENGINE_FAILED",
            message: `the engine failed for bearer ${auth.token}`,
          });
          return;
        }

        const streamId = `stream-${(counter += 1)}`;
        const state = { frames: [], done: false };
        streams.set(streamId, state);
        startSse(res);

        const emit = (payload) => {
          const id = state.frames.length + 1;
          state.frames.push({ id, payload });
          if (!res.destroyed) writeFrame(res, id, payload);
        };

        emit({ created: true, streamId, message: { conversationId: streamId } });
        const snapshots = text.includes("revise")
          ? ["old draft", "corrected answer"]
          : ["accepted", "accepted and verified"];
        for (const snapshot of snapshots) emit({ message: true, text: snapshot });
        emit({
          event: "on_pending_action",
          data: { actionId: "perm-1", tool: "shell", question: "Allow the test run?", status: "pending" },
        });

        if (text.includes("disconnect")) {
          // Drop the socket mid-run, as a proxy or a crashed engine would.
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        }
        if (text.includes("slow")) {
          const timer = setInterval(() => {
            if (!res.destroyed) res.write(": keep-alive\n\n");
          }, 1000);
          res.on("close", () => clearInterval(timer));
          return;
        }

        emit({
          final: true,
          responseMessage: { text: snapshots.at(-1) },
          conversation: { conversationId: streamId },
        });
        state.done = true;
        res.end();
        return;
      }

      const replay = /^\/api\/work\/chat\/([^/]+)\/events$/.exec(path);
      if (replay && req.method === "GET") {
        const state = streams.get(decodeURIComponent(replay[1]));
        if (!state) {
          sendJson(res, 404, { error: "STREAM_NOT_FOUND", message: "no such stream" });
          return;
        }
        const after = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0) || 0;
        startSse(res);
        for (const frame of state.frames.filter((entry) => entry.id > after)) {
          writeFrame(res, frame.id, frame.payload);
        }
        res.end();
        return;
      }

      const cancel = /^\/api\/work\/chat\/([^/]+)\/cancel$/.exec(path);
      if (cancel && req.method === "POST") {
        const streamId = decodeURIComponent(cancel[1]);
        sendJson(res, 200, { cancelled: streams.has(streamId), streamId });
        return;
      }
    }

    sendJson(res, 404, { error: "HTTP_404", message: `no route for ${req.method} ${path}` });
  }

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    ownerToken: OWNER_TOKEN,
    nonOwnerToken: NON_OWNER_TOKEN,
    apiVersion,
    requests,
    streams,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      if (server.listening) {
        const closed = once(server, "close");
        server.close();
        await closed;
      }
    },
  };
}
