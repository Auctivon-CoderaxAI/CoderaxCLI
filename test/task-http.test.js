import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskClient,
  TaskState,
  WorkflowClient,
} from "../packages/workflow-sdk/src/index.js";
import { createFileTaskStateStore } from "../src/task-store.js";
import { runCli } from "../src/cli.js";

/**
 * These are real HTTP tests over loopback sockets. The harness mirrors the
 * authoritative route behaviour read from Coderax at a5d237b0:
 *
 * - `handlers.ts#streamRun` writes `data: {"run": ...}` snapshots, no `id:`,
 *   no sequence, and closes on a terminal status;
 * - `handlers.ts#approveStep` answers 409 when the step is not waiting;
 * - `handlers.ts#cancelRun` answers 200 with the existing terminal run;
 * - `work/router.ts` answers 409 WORK_TASK_ALREADY_FINISHED /
 *   WORK_NOTHING_TO_CANCEL;
 * - `handlers.ts#startBuild` accepts no idempotency key and creates a run.
 *
 * The tests assert the client against those semantics, not against invented
 * routes or event ids.
 */

const TOKEN = "task-http-token-that-must-never-leak";

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function sse(res, frames) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  for (const frame of frames) res.write(frame);
  res.end();
}

function RUN(id, status, extra = {}) {
  return {
    id,
    workflowId: "wf-1",
    workflowName: "Task workflow",
    agentId: "agent-1",
    status,
    steps: [],
    events: [],
    createdAt: new Date(0).toISOString(),
    ...extra,
  };
}

function negotiation(handler) {
  return (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/meta") return json(res, 404, { message: "not found" });
    if (url.pathname === "/api/work/tasks") return json(res, 200, { tasks: [] });
    if (url.pathname === "/api/workflows") return json(res, 200, { workflows: [] });
    return handler(req, res);
  };
}

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function taskPair(baseUrl, { statePath } = {}) {
  const path =
    statePath ?? join(await mkdtemp(join(tmpdir(), "coderax-task-http-")), "tasks.json");
  const store = createFileTaskStateStore(path);
  const state = new TaskState({ persist: store.persist });
  state.restore(await store.load());
  const client = new WorkflowClient({ baseUrl, token: TOKEN, maxRetries: 2, retryDelayMs: 5 });
  return { path, store, state, client, tasks: new TaskClient({ client, state }) };
}

test("a lost build response becomes SUBMISSION_UNKNOWN after exactly one POST", async () => {
  let posts = 0;
  await withServer(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/workflows/builds" && req.method === "POST") {
        posts += 1;
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          // The deployment accepted the request, then the connection died
          // before the response reached the client.
          assert.equal(JSON.parse(body).request, "implement the fix");
          req.socket.destroy();
        });
        return;
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const { state, tasks } = await taskPair(baseUrl);
      await assert.rejects(
        () =>
          tasks.submit({
            submissionKey: "cli:http:ambiguous",
            request: "implement the fix",
            agentId: "agent-1",
            repository: { owner: "acme", name: "app" },
            workspace: "coderax-acme-app-test",
          }),
        (error) =>
          error.code === "SUBMISSION_UNKNOWN" &&
          error.details.submissionKey === "cli:http:ambiguous",
      );
      assert.equal(posts, 1, "an ambiguous submission must not be retried");
      assert.equal(state.submission("cli:http:ambiguous").state, "unknown");
    },
  );
});

test("reconnect re-reads the authoritative snapshot and never advances a synthetic cursor", async () => {
  const headers = [];
  let streams = 0;
  await withServer(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/api/workflows/runs/run-reconnect/stream") {
        return json(res, 404, { message: "not found" });
      }
      streams += 1;
      headers.push(req.headers["last-event-id"] ?? null);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (streams === 1) {
        res.write(`data: ${JSON.stringify({ run: RUN("run-reconnect", "running") })}\n\n`);
        setTimeout(() => res.destroy(), 10);
        return;
      }
      res.write(`data: ${JSON.stringify({ run: RUN("run-reconnect", "running") })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          run: RUN("run-reconnect", "running", {
            steps: [{ id: "one", title: "One", status: "running", approvalRequired: false }],
          }),
        })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ run: RUN("run-reconnect", "completed") })}\n\n`);
      res.end();
    }),
    async (baseUrl) => {
      const { state, store, tasks } = await taskPair(baseUrl);
      const rendered = [];
      const result = await tasks.follow("run-reconnect", {
        onRun: async (run) => {
          rendered.push(run.steps.length > 0 ? "progress" : run.status);
        },
      });

      assert.equal(result.outcome.kind, "completed");
      assert.equal(streams, 2);
      assert.deepEqual(headers, [null, null], "a snapshot-only stream has no cursor to send");
      assert.deepEqual(rendered, ["running", "progress", "completed"]);
      assert.equal(state.cursor, null);
      const persisted = await store.load();
      assert.equal(persisted.cursor, null, "a snapshot-only stream persists no cursor");
      assert.equal(persisted.appliedFingerprint !== null, true);
      assert.equal(result.run.status, "completed");
    },
  );
});

test("a handler failure leaves the cursor uncommitted and replays the snapshot", async () => {
  const cursors = [];
  let streams = 0;
  await withServer(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/api/workflows/runs/run-handler/stream") {
        return json(res, 404, { message: "not found" });
      }
      streams += 1;
      cursors.push(req.headers["last-event-id"] ?? null);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (streams === 1) {
        res.write(
          `id: 1\ndata: ${JSON.stringify({ run: RUN("run-handler", "running") })}\n\n`,
        );
        setTimeout(() => res.destroy(), 10);
        return;
      }
      res.write(
        `id: 1\ndata: ${JSON.stringify({ run: RUN("run-handler", "running") })}\n\n`,
      );
      res.write(
        `id: 2\ndata: ${JSON.stringify({ run: RUN("run-handler", "completed") })}\n\n`,
      );
      res.end();
    }),
    async (baseUrl) => {
      const { state, tasks } = await taskPair(baseUrl);
      let attempts = 0;
      const handler = async (run) => {
        if (run.status === "running") {
          attempts += 1;
          if (attempts === 1) throw new Error("renderer failed once");
        }
      };

      // A handler failure is not swallowed or treated as handled: the caller
      // sees it, and no cursor was committed.
      await assert.rejects(() => tasks.follow("run-handler", { onRun: handler }), /renderer failed/);
      assert.equal(streams, 1);
      assert.deepEqual(cursors, [null]);
      assert.equal(state.cursor, null);
      assert.equal(state.appliedFingerprint, null);

      // The next invocation reconnects without a cursor and receives the same
      // snapshot again, proving the failed attempt did not advance state.
      const result = await tasks.follow("run-handler", { onRun: handler });
      assert.equal(result.outcome.kind, "completed");
      assert.equal(streams, 2);
      assert.equal(attempts, 2, "the failed snapshot must be delivered again");
      assert.deepEqual(cursors, [null, null]);
      // The successful terminal snapshot committed its authoritative id.
      assert.deepEqual(state.cursor, { kind: "event-id", value: "2" });
    },
  );
});

test("a completed run is acknowledged once across processes", async () => {
  let reads = 0;
  const terminal = RUN("run-settled", "completed", {
    settledAt: "2026-11-26T01:02:03.000Z",
  });
  await withServer(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/workflows/runs/run-settled") {
        reads += 1;
        return json(res, 200, { run: terminal });
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const first = await taskPair(baseUrl);
      const settled = await first.tasks.settle("run-settled");
      assert.equal(settled.settled, true);
      assert.equal(settled.newlyAcknowledged, true);
      assert.equal((await first.tasks.settle("run-settled")).newlyAcknowledged, false);

      // A fresh process restores the ledger and does not notify again.
      const second = await taskPair(baseUrl, { statePath: first.path });
      const restored = await second.tasks.settle("run-settled");
      assert.equal(restored.settled, true);
      assert.equal(restored.newlyAcknowledged, false);
      assert.equal(reads, 3);
    },
  );
});

test("approval reconciles a 409 against the authoritative run view", async () => {
  let posts = 0;
  await withServer(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/workflows/runs/run-approve/approve" && req.method === "POST") {
        posts += 1;
        return json(res, 409, { error: "That step is not waiting for approval" });
      }
      if (url.pathname === "/api/workflows/runs/run-approve" && req.method === "GET") {
        return json(res, 200, {
          run: RUN("run-approve", "running", {
            steps: [{ id: "deploy", status: "running", approvalRequired: true, approvedAt: "now" }],
          }),
        });
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const { tasks } = await taskPair(baseUrl);
      const result = await tasks.approve("run-approve", 0);
      assert.equal(result.applied, false);
      assert.equal(result.alreadySettled, true);
      assert.equal(result.run.status, "running");
      assert.equal(posts, 1, "a conflict must not be retried");
    },
  );
});

test("repeated run cancellation returns the existing terminal run", async () => {
  let posts = 0;
  await withServer(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/workflows/runs/run-cancel/cancel" && req.method === "POST") {
        posts += 1;
        return json(res, 200, { run: RUN("run-cancel", "cancelled") });
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const { tasks } = await taskPair(baseUrl);
      const first = await tasks.cancelRun("run-cancel");
      const second = await tasks.cancelRun("run-cancel");
      assert.equal(first.canceled, true);
      assert.equal(second.canceled, true);
      assert.equal(posts, 2);
    },
  );
});

test("CLI completion notification is backend-confirmed and emitted once", async () => {
  let streams = 0;
  let reads = 0;
  const terminal = RUN("run-notify", "completed", {
    settledAt: "2026-11-26T02:00:00.000Z",
  });
  await withServer(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/workflows/runs/run-notify/stream") {
        streams += 1;
        return sse(res, [`data: ${JSON.stringify({ run: terminal })}\n\n`]);
      }
      if (url.pathname === "/api/workflows/runs/run-notify") {
        reads += 1;
        return json(res, 200, { run: terminal });
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const directory = await mkdtemp(join(tmpdir(), "coderax-notify-"));
      const env = {
        CODERAX_CONFIG: join(directory, "config.json"),
        CODERAX_BASE_URL: baseUrl,
        CODERAX_TOKEN: TOKEN,
      };
      const invoke = async () => {
        const out = [];
        const err = [];
        const code = await runCli(["run", "run-notify", "--notify"], {
          env,
          stdout: (text) => out.push(text),
          stderr: (text) => err.push(text),
          stdinIsTTY: false,
        });
        return { code, out: out.join(""), err: err.join("") };
      };

      const first = await invoke();
      assert.equal(first.code, 0, first.err);
      assert.equal((first.err.match(/\[notify\]/g) ?? []).length, 1);
      assert.equal(first.err.includes(TOKEN), false);

      // Same deployment and config directory, fresh process: the persisted
      // settlement ledger suppresses the duplicate notification.
      const second = await invoke();
      assert.equal(second.code, 0, second.err);
      assert.equal((second.err.match(/\[notify\]/g) ?? []).length, 0);

      assert.equal(streams, 2);
      assert.equal(reads, 2, "each notification decision reads the authoritative run");
    },
  );
});

test("work task cancellation maps the authoritative 409 codes", async () => {
  await withServer(
    negotiation((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/work/tasks/conv-finished/cancel") {
        return json(res, 409, { code: "WORK_TASK_ALREADY_FINISHED" });
      }
      if (url.pathname === "/api/work/tasks/conv-idle/cancel") {
        return json(res, 409, { code: "WORK_NOTHING_TO_CANCEL" });
      }
      return json(res, 404, { message: "not found" });
    }),
    async (baseUrl) => {
      const { tasks } = await taskPair(baseUrl);
      const finished = await tasks.cancelTask("conv-finished");
      assert.equal(finished.alreadyFinished, true);
      assert.equal(finished.canceled, false);
      const idle = await tasks.cancelTask("conv-idle");
      assert.equal(idle.nothingToCancel, true);
      assert.equal(idle.canceled, false);
    },
  );
});
