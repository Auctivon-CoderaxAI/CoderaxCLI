import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

/**
 * A local HTTP harness for real-network CLI tests.
 *
 * It speaks the WorkflowEngine contract conventions that already exist:
 * owner bearer auth, `Problem` error bodies, `/v1/ready`, `/v1/work/{id}`,
 * sequenced SSE events and the versioned contract. It also implements the
 * capability, upload and artifact routes this CLI consumes. It is a test
 * double for transport and contract behavior, not a provider or an executor.
 */

export const OWNER_TOKEN = "workflow-harness-owner-token-0123456789";
export const OWNER_ID = "owner-test";

export function problem(status, code, detail, title = code.replace(/_/g, " ")) {
  return {
    type: `https://coderax.dev/problems/${code}`,
    title,
    status,
    code,
    detail,
    retryable: status === 503,
  };
}

export function pdfBytes(text = "harness pdf") {
  return Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`, "utf8");
}

export function pngBytes(text = "harness png") {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(text, "utf8"),
  ]);
}

export function wavBytes(text = "harness wav") {
  const data = Buffer.from(text, "utf8");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function digestOf(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function defaultRegistry(overrides = {}) {
  const capabilities = [
    { id: "file.upload", command: "upload", title: "File upload", status: "available" },
    { id: "document.analyze", command: "analyze-document", title: "Document analysis", status: "available" },
    { id: "pdf.analyze", command: "analyze-pdf", title: "PDF analysis", status: "available" },
    { id: "spreadsheet.analyze", command: "analyze-spreadsheet", title: "Spreadsheet analysis", status: "available" },
    { id: "presentation.create", command: "create-presentation", title: "Presentation creation", status: "available" },
    { id: "image.understand", command: "understand-image", title: "Image understanding", status: "available" },
    { id: "image.generate", command: "generate-image", title: "Image generation", status: "available" },
    { id: "audio.transcribe", command: "transcribe", title: "Audio transcription", status: "available" },
    { id: "audio.speech", command: "speak", title: "Text-to-speech", status: "available" },
    { id: "software.create", command: "create-software", title: "Software creation", status: "available" },
    { id: "game.create", command: "create-game", title: "Game creation", status: "available" },
  ].map((entry) => ({
    reason: entry.status === "available" ? "ready" : "not_ready",
    detail: "",
    ...entry,
  }));
  return {
    contractVersion: "1.0.0",
    registryVersion: "harness-1",
    capabilities,
    artifacts: { status: "available", reason: "ready", detail: "" },
    ...overrides,
  };
}

function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  if (!match) throw new Error("missing boundary");
  const boundary = (match[1] ?? match[2]).trim();
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(delimiter);
  while (cursor !== -1) {
    cursor += delimiter.length;
    if (buffer.subarray(cursor, cursor + 2).toString("latin1") === "--") break;
    if (buffer.subarray(cursor, cursor + 2).toString("latin1") === "\r\n") cursor += 2;
    const next = buffer.indexOf(delimiter, cursor);
    if (next === -1) break;
    const part = buffer.subarray(cursor, next);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      cursor = next;
      continue;
    }
    const headers = part.subarray(0, headerEnd).toString("latin1");
    const body = part.subarray(headerEnd + 4, Math.max(headerEnd + 4, part.length - 2));
    const disposition = /name="([^"]+)"/.exec(headers);
    const filename = /filename="([^"]+)"/.exec(headers);
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers);
    parts.push({
      name: disposition?.[1] ?? "",
      filename: filename?.[1] ?? null,
      mimeType: type?.[1]?.trim() ?? null,
      body,
    });
    cursor = next;
  }
  return parts;
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeSse(res, events) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  let seq = 0;
  for (const event of events) {
    seq += 1;
    res.write(
      `data: ${JSON.stringify({
        v: 1,
        eventId: `evt_${seq}`,
        seq,
        at: new Date().toISOString(),
        agent: "coderax",
        generation: 1,
        ...event,
      })}\n\n`,
    );
  }
  res.end();
}

export async function startHarness(options = {}) {
  const state = {
    registry: options.registry === undefined ? defaultRegistry() : options.registry,
    registryMissing: options.registry === null,
    ready: options.ready ?? true,
    missing: options.missing ?? [],
    events: options.events !== false,
    behavior: options.behavior ?? {},
    uploads: new Map(),
    tasks: new Map(),
    artifacts: new Map(),
    requests: [],
    taskReads: 0,
  };

  const defaultArtifact = options.artifacts?.[0] ?? {
    artifactId: "art_default",
    name: "result.pdf",
    path: "artifacts/result.pdf",
    content: pdfBytes("result"),
    projectId: null,
    conversationId: "conv_test",
  };
  const seedArtifacts = options.artifacts ?? [defaultArtifact];
  for (const artifact of seedArtifacts) {
    const content = artifact.content ?? Buffer.from(`artifact ${artifact.artifactId}`, "utf8");
    state.artifacts.set(artifact.artifactId, {
      artifactId: artifact.artifactId,
      name: artifact.name,
      path: artifact.path,
      mimeType: artifact.mimeType ?? "application/pdf",
      bytes: content.length,
      digest: `sha256:${digestOf(content)}`,
      projectId: artifact.projectId ?? null,
      conversationId: artifact.conversationId ?? "conv_test",
      taskId: artifact.taskId ?? null,
      createdAt: artifact.createdAt ?? "2026-11-26T00:00:00.000Z",
      ...(artifact.corrupt ? { corrupt: true } : {}),
      content,
    });
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    state.requests.push({ method: req.method, path, headers: req.headers });

    if (path === "/v1/health") {
      return writeJson(res, 200, {
        status: "ok",
        contractVersion: "1.0.0",
        startedAt: "2026-11-26T00:00:00.000Z",
        uptimeMs: 1,
        checks: [],
        engines: [],
      });
    }
    if (path === "/v1/ready") {
      return writeJson(res, 200, {
        ready: state.ready,
        missing: state.missing,
        checks: [],
      });
    }

    if (!path.startsWith("/v1/")) return writeJson(res, 404, problem(404, "not_found", "route missing"));
    if (req.headers.authorization !== `Bearer ${OWNER_TOKEN}`) {
      return writeJson(res, 401, problem(401, "unauthorized", "owner token required"));
    }

    if (path === "/v1/capabilities" && req.method === "GET") {
      if (state.registryMissing) return writeJson(res, 404, problem(404, "not_found", "capability registry is not published"));
      return writeJson(res, 200, state.registry);
    }

    if (path === "/v1/files" && req.method === "POST") {
      let parts;
      try {
        parts = parseMultipart(await readRawBody(req), req.headers["content-type"]);
      } catch (error) {
        return writeJson(res, 400, problem(400, "validation_failed", error.message));
      }
      const file = parts.find((part) => part.name === "file");
      if (!file || !file.filename) {
        return writeJson(res, 400, problem(400, "validation_failed", "multipart file part is required"));
      }
      const sha256 = digestOf(file.body);
      if (req.headers["x-content-sha256"] !== sha256) {
        return writeJson(res, 400, problem(400, "validation_failed", "upload digest mismatch"));
      }
      if (options.corruptUploadEcho) {
        return writeJson(res, 201, {
          uploadId: `upl_${state.uploads.size + 1}`,
          name: file.filename,
          bytes: file.body.length,
          sha256: "0".repeat(64),
          mimeType: file.mimeType ?? "application/octet-stream",
        });
      }
      const uploadId = `upl_${state.uploads.size + 1}`;
      const upload = {
        uploadId,
        name: file.filename,
        bytes: file.body.length,
        sha256,
        mimeType: file.mimeType ?? "application/octet-stream",
        expiresAt: "2026-11-27T00:00:00.000Z",
      };
      state.uploads.set(uploadId, { ...upload, body: file.body, fields: Object.fromEntries(parts.filter((p) => p.name !== "file").map((p) => [p.name, p.body.toString("utf8")])) });
      return writeJson(res, 201, upload);
    }

    const execute = /^\/v1\/capabilities\/([^/]+)\/execute$/.exec(path);
    if (execute && req.method === "POST") {
      const capabilityId = decodeURIComponent(execute[1]);
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return writeJson(res, 400, problem(400, "validation_failed", error.message));
      }
      const capability = (state.registry?.capabilities ?? []).find((item) => item.id === capabilityId);
      if (!capability) {
        return writeJson(res, 404, problem(404, "not_found", `capability ${capabilityId} is not published`));
      }
      if (capability.status !== "available") {
        return writeJson(res, 409, problem(409, "not_ready", `${capabilityId} is ${capability.status}`));
      }
      if (body.capabilityId !== capabilityId) {
        return writeJson(res, 400, problem(400, "validation_failed", "capabilityId does not match the path"));
      }
      const taskId = `task_${state.tasks.size + 1}`;
      const behavior = state.behavior[capabilityId] ?? options.behaviorDefault ?? {};
      if (behavior.permissionRequired) {
        return writeJson(
          res,
          409,
          problem(409, "permission_required", "the owner must approve this capability run"),
        );
      }
      const task = {
        taskId,
        conversationId: body.conversationId ?? "conv_test",
        capabilityId,
        inputs: body.inputs ?? {},
        projectId: body.projectId ?? null,
        state: "queued",
        generation: 1,
        reads: 0,
        pollsBeforeComplete: behavior.pollsBeforeComplete ?? 1,
        fail: behavior.fail === true,
        cancel: behavior.cancel === true,
        summary: behavior.summary ?? `${capabilityId} completed`,
        artifactIds: behavior.artifactIds ?? [defaultArtifact.artifactId],
        eventsSeen: false,
      };
      state.tasks.set(taskId, task);
      return writeJson(res, 202, {
        taskId,
        conversationId: task.conversationId,
        state: "queued",
        generation: 1,
        eventsPath: `/v1/work/${taskId}/events`,
      });
    }

    const taskMatch = /^\/v1\/work\/([^/]+)$/.exec(path);
    if (taskMatch && req.method === "GET") {
      const task = state.tasks.get(decodeURIComponent(taskMatch[1]));
      if (!task) return writeJson(res, 404, problem(404, "not_found", "task not found"));
      task.reads += 1;
      state.taskReads += 1;
      if (!task.eventsSeen && task.reads >= task.pollsBeforeComplete) {
        task.state = task.fail ? "failed" : task.cancel ? "cancelled" : "completed";
      }
      if (task.state === "completed") {
        for (const artifactId of task.artifactIds) {
          const artifact = state.artifacts.get(artifactId);
          if (artifact && artifact.taskId === null) artifact.taskId = task.taskId;
        }
      }
      const artifacts = task.artifactIds
        .map((id) => state.artifacts.get(id))
        .filter(Boolean)
        .map((artifact) => ({ path: artifact.path, bytes: artifact.bytes, digest: artifact.digest }));
      return writeJson(res, 200, {
        taskId: task.taskId,
        conversationId: task.conversationId,
        state: task.state,
        agent: "coderax",
        mode: "cloud",
        generation: 1,
        createdAt: "2026-11-26T00:00:00.000Z",
        updatedAt: "2026-11-26T00:00:01.000Z",
        cancelRequested: false,
        steps: [{ id: "step_1", title: "Run capability", state: task.state === "completed" ? "completed" : task.state }],
        ...(task.state === "completed"
          ? { result: { summary: task.summary, artifacts } }
          : task.state === "failed"
            ? { failure: { code: "provider_error", detail: "the provider refused the request" } }
            : {}),
      });
    }

    const eventsMatch = /^\/v1\/work\/([^/]+)\/events$/.exec(path);
    if (eventsMatch && req.method === "GET") {
      const task = state.tasks.get(decodeURIComponent(eventsMatch[1]));
      if (!task) return writeJson(res, 404, problem(404, "not_found", "task not found"));
      if (!state.events) return writeJson(res, 404, problem(404, "not_found", "event stream is not published"));
      task.eventsSeen = true;
      task.state = task.fail ? "failed" : task.cancel ? "cancelled" : "completed";
      if (task.state === "completed") {
        for (const artifactId of task.artifactIds) {
          const artifact = state.artifacts.get(artifactId);
          if (artifact && artifact.taskId === null) artifact.taskId = task.taskId;
        }
      }
      const terminal = task.fail
        ? { type: "task.failed", payload: { code: "provider_error", detail: "the provider refused the request", retryable: false } }
        : task.cancel
          ? { type: "task.cancelled", payload: { reason: "owner cancelled" } }
          : { type: "task.completed", payload: { summary: task.summary } };
      writeSse(res, [
        { taskId: task.taskId, type: "task.queued" },
        { taskId: task.taskId, type: "task.started" },
        { taskId: task.taskId, type: "step.started", payload: { stepId: "step_1", title: "Run capability" } },
        { taskId: task.taskId, type: "tool.call", payload: { callId: "call_1", tool: "remote-engine" } },
        { taskId: task.taskId, type: "tool.result", payload: { callId: "call_1", tool: "remote-engine", ok: true, output: "accepted" } },
        { taskId: task.taskId, type: "text.delta", payload: { text: "working" } },
        { taskId: task.taskId, type: "step.completed", payload: { stepId: "step_1", title: "Run capability" } },
        { taskId: task.taskId, ...terminal },
      ]);
      return;
    }

    if (path === "/v1/artifacts" && req.method === "GET") {
      const projectId = url.searchParams.get("projectId");
      const conversationId = url.searchParams.get("conversationId");
      const taskId = url.searchParams.get("taskId");
      const artifacts = [...state.artifacts.values()]
        .filter((artifact) => (projectId ? artifact.projectId === projectId : true))
        .filter((artifact) => (conversationId ? artifact.conversationId === conversationId : true))
        .filter((artifact) => (taskId ? artifact.taskId === taskId : true))
        .map(({ content, corrupt, ...metadata }) => metadata);
      return writeJson(res, 200, { artifacts });
    }

    const artifactMatch = /^\/v1\/artifacts\/([^/]+)$/.exec(path);
    if (artifactMatch && req.method === "GET") {
      const artifact = state.artifacts.get(decodeURIComponent(artifactMatch[1]));
      if (!artifact) return writeJson(res, 404, problem(404, "not_found", "artifact not found"));
      const { content, corrupt, ...metadata } = artifact;
      return writeJson(res, 200, metadata);
    }

    const contentMatch = /^\/v1\/artifacts\/([^/]+)\/content$/.exec(path);
    if (contentMatch && req.method === "GET") {
      const artifact = state.artifacts.get(decodeURIComponent(contentMatch[1]));
      if (!artifact) return writeJson(res, 404, problem(404, "not_found", "artifact not found"));
      const body = artifact.corrupt ? Buffer.from("tampered", "utf8") : artifact.content;
      res.writeHead(200, {
        "content-type": artifact.mimeType,
        "content-length": body.length,
        "x-artifact-sha256": artifact.digest,
      });
      res.end(body);
      return;
    }

    const associateMatch = /^\/v1\/artifacts\/([^/]+)\/project$/.exec(path);
    if (associateMatch && req.method === "POST") {
      const artifact = state.artifacts.get(decodeURIComponent(associateMatch[1]));
      if (!artifact) return writeJson(res, 404, problem(404, "not_found", "artifact not found"));
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return writeJson(res, 400, problem(400, "validation_failed", error.message));
      }
      if (typeof body.projectId !== "string" || body.projectId.trim() === "") {
        return writeJson(res, 400, problem(400, "validation_failed", "projectId is required"));
      }
      artifact.projectId = body.projectId;
      const { content, corrupt, ...metadata } = artifact;
      return writeJson(res, 200, metadata);
    }

    return writeJson(res, 404, problem(404, "not_found", "route missing"));
  };

  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) writeJson(res, 500, problem(500, "internal_error", "harness failure"));
      else res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    token: OWNER_TOKEN,
    state,
    uploads: state.uploads,
    tasks: state.tasks,
    artifacts: state.artifacts,
    requests: state.requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
