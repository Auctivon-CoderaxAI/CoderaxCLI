import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { runCli } from "../src/cli.js";
import {
  TOKEN,
  acceptedBody,
  agentsBody,
  capture,
  chatBody,
  conversationBody,
  event,
  healthBody,
  json,
  modelsBody,
  notificationsBody,
  permissionBody,
  problem,
  readBody,
  sseHead,
  sseWrite,
  taskBody,
  tempEnv,
  withServer,
} from "./support.js";

function delta(seq, text, eventId = `evt_${seq}`) {
  return event("text.delta", seq, { text }, { eventId });
}

function replace(seq, text) {
  return event("text.replace", seq, { text }, { eventId: `evt_${seq}` });
}

function terminal(seq) {
  return event("task.completed", seq, { summary: "hello world" }, { eventId: `evt_${seq}` });
}

function createState() {
  return {
    requests: [],
    events: [
      delta(1, "hello"),
      replace(2, "hello world"),
      delta(3, " world"),
      terminal(4),
    ],
    task: taskBody(),
    permissions: [permissionBody()],
    eventsAuthFail: false,
    chatText: null,
  };
}

async function handler(state, req, res) {
  const url = new URL(req.url, "http://localhost");
  const entry = {
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    authorization: req.headers.authorization ?? null,
    body: undefined,
  };
  state.requests.push(entry);

  if (req.method !== "GET" && req.method !== "HEAD") entry.body = await readBody(req);

  const publicPath = url.pathname === "/v1/health" || url.pathname === "/v1/ready";
  if (!publicPath && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return json(res, 401, problem(401, "unauthorized", "owner token required"));
  }

  if (url.pathname === "/v1/health") return json(res, 200, healthBody());
  if (url.pathname === "/v1/ready") {
    return json(res, 200, { ready: true, missing: [], checks: [] });
  }
  if (url.pathname === "/v1/agents") return json(res, 200, agentsBody());
  if (url.pathname === "/v1/models") return json(res, 200, modelsBody());

  if (url.pathname === "/v1/chat" && req.method === "POST") {
    assert.equal(req.headers.accept, "application/json");
    if (state.onChatRequest) {
      state.onChatRequest();
      return;
    }
    const body = entry.body ?? {};
    return json(res, 200, chatBody({
      text: state.chatText ?? `echo:${body.message}`,
      conversationId: body.conversationId ?? "conv-1",
      agent: body.agent ?? "coderax",
      model: body.model ?? { providerId: "free", modelId: "coderax-small" },
    }));
  }

  if (url.pathname === "/v1/work" && req.method === "POST") {
    return json(res, 202, acceptedBody());
  }

  if (url.pathname === "/v1/work/task-1" && req.method === "GET") {
    if (state.taskUnavailable) return json(res, 404, problem(404, "not_found", "status unavailable"));
    return json(res, 200, state.task);
  }

  if (url.pathname === "/v1/work/task-1/events" && req.method === "GET") {
    if (state.eventsAuthFail) {
      return json(res, 401, problem(401, "unauthorized", "expired token"));
    }
    const after = Number(url.searchParams.get("after") ?? 0);
    sseHead(res);
    if (state.onEventsRequest) {
      sseWrite(res, delta(1, "started"));
      state.onEventsRequest();
      return;
    }
    for (const value of state.events) {
      if (value.seq > after) sseWrite(res, value);
    }
    res.end();
    return;
  }

  if (url.pathname === "/v1/work/task-1/cancel" && req.method === "POST") {
    state.task = taskBody({ state: "cancelled", result: undefined });
    return json(res, 200, { taskId: "task-1", state: "cancelled", generation: 1, outcome: "accepted" });
  }
  if (url.pathname === "/v1/work/task-1/resume" && req.method === "POST") {
    return json(res, 200, { taskId: "task-1", state: "running", generation: 2, outcome: "accepted" });
  }
  if (url.pathname === "/v1/work/task-1/retry" && req.method === "POST") {
    return json(res, 200, { taskId: "task-1", state: "queued", generation: 2, outcome: "accepted" });
  }

  if (url.pathname === "/v1/work/task-1/permissions") {
    if (req.method === "POST") {
      const body = entry.body ?? {};
      state.permissions = state.permissions.map((request) =>
        request.requestId === body.requestId
          ? { ...request, decision: body.decision, ...(body.reason ? { reason: body.reason } : {}) }
          : request,
      );
    }
    return json(res, 200, { requests: state.permissions });
  }

  if (url.pathname === "/v1/notifications") return json(res, 200, notificationsBody());
  if (url.pathname === "/v1/conversations") {
    return json(res, 200, {
      conversations: [
        {
          conversationId: "conv-1",
          title: "hello",
          isWork: false,
          agent: "coderax",
          updatedAt: "2026-11-26T00:00:01.000Z",
        },
      ],
    });
  }
  if (url.pathname === "/v1/conversations/conv-1") return json(res, 200, conversationBody());
  if (url.pathname === "/v1/memory") {
    return json(res, 200, {
      entries: [
        {
          key: "preference",
          value: "concise",
          mode: url.searchParams.get("mode") ?? "private",
          updatedAt: "2026-11-26T00:00:00.000Z",
        },
      ],
    });
  }

  return json(res, 404, problem(404, "not_found", `no route for ${url.pathname}`));
}

async function scenario(run) {
  const state = createState();
  await withServer(
    (req, res) => handler(state, req, res),
    async (url) => {
      const env = { ...(await tempEnv()), CODERAX_BASE_URL: url, CODERAX_TOKEN: TOKEN };
      const invoke = async (argv, options = {}) => {
        const io = capture();
        const code = await runCli(["engine", ...argv], {
          env: options.env ?? env,
          stdout: io.stdout,
          stderr: io.stderr,
          stdinIsTTY: true,
          ...options,
        });
        return { code, out: io.out(), err: io.err() };
      };
      return run({ state, env, invoke, url });
    },
  );
}

test("login verifies the owner token before storing it", async () => {
  await scenario(async ({ invoke, env }) => {
    const rejected = await invoke(["login", "--json"], { env: { ...env, CODERAX_TOKEN: "wrong-token" } });
    assert.equal(rejected.code, 3);
    await assert.rejects(readFile(env.CODERAX_CONFIG, "utf8"), (error) => error.code === "ENOENT");

    const accepted = await invoke(["login", "--json"]);
    assert.equal(accepted.code, 0);
    assert.equal(accepted.out.includes(TOKEN), false);
    const payload = JSON.parse(accepted.out);
    assert.equal(payload.owner, true);
    const stored = JSON.parse(await readFile(env.CODERAX_CONFIG, "utf8"));
    assert.equal(stored.token, TOKEN);

    const status = await invoke(["status", "--json"]);
    assert.equal(status.code, 0);
    assert.equal(status.out.includes(TOKEN), false);
    assert.equal(JSON.parse(status.out).authenticated, true);
  });
});

test("chat sends the selected agent, model, mode and conversation", async () => {
  await scenario(async ({ state, invoke }) => {
    const result = await invoke([
      "chat", "hi",
      "--agent", "opencode",
      "--model", "free/coderax-small",
      "--mode", "cloud",
      "--conversation", "conv-9",
      "--json",
    ]);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.out).text, "echo:hi");
    const call = state.requests.find((request) => request.path === "/v1/chat");
    assert.deepEqual(call.body, {
      message: "hi",
      agent: "opencode",
      model: { providerId: "free", modelId: "coderax-small" },
      mode: "cloud",
      conversationId: "conv-9",
    });

    const plain = await invoke(["chat", "plain", "--json"]);
    assert.equal(plain.code, 0);
    const second = state.requests.filter((request) => request.path === "/v1/chat")[1];
    assert.deepEqual(second.body, { message: "plain" });
  });
});

test("invalid agent, model or mode is a usage error before any request", async () => {
  await scenario(async ({ state, invoke }) => {
    for (const argv of [
      ["chat", "hi", "--agent", "nobody"],
      ["chat", "hi", "--model", "unqualified"],
      ["chat", "hi", "--mode", "secret"],
    ]) {
      const result = await invoke(argv);
      assert.equal(result.code, 2, argv.join(" "));
    }
    assert.equal(state.requests.length, 0);
  });
});

test("a missing owner token fails before a request", async () => {
  await scenario(async ({ state, invoke, env }) => {
    const withoutToken = { ...env };
    delete withoutToken.CODERAX_TOKEN;
    const result = await invoke(["chat", "hi"], { env: withoutToken });
    assert.equal(result.code, 3);
    assert.match(result.err, /no owner token/i);
    assert.equal(state.requests.length, 0);
  });
});

test("work streams, reports the authoritative summary and supports detach", async () => {
  await scenario(async ({ state, invoke }) => {
    const followed = await invoke(["work", "do the work", "--json"]);
    assert.equal(followed.code, 0);
    const payload = JSON.parse(followed.out);
    assert.equal(payload.state, "completed");
    assert.equal(payload.text, "hello world");
    assert.equal("streamedText" in payload, false);
    assert.equal("summary" in payload, false);
    assert.equal(payload.events, 4);
    const submitted = state.requests.find((request) => request.path === "/v1/work");
    assert.equal(submitted.body.requireApproval, true);

    const detached = await invoke(["work", "do the work", "--detach", "--json"]);
    assert.equal(detached.code, 0);
    assert.equal(JSON.parse(detached.out).detached, true);
    assert.equal(state.requests.filter((request) => request.path.endsWith("/events")).length, 1);

    const noApproval = await invoke(["work", "do the work", "--no-approval", "--json"]);
    assert.equal(noApproval.code, 0);
    const submissions = state.requests.filter((request) => request.path === "/v1/work");
    assert.equal(submissions.at(-1).body.requireApproval, false);
  });
});

test("work detaches at an approval request with the exact decision commands", async () => {
  await scenario(async ({ state, invoke }) => {
    state.events = [
      delta(1, "waiting"),
      event("approval.required", 2, {
        requestId: "perm-1",
        tool: "write_file",
        description: "write the release checklist",
      }),
    ];
    const result = await invoke(["work", "do the work", "--json"]);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.out);
    assert.equal(payload.detached, true);
    assert.equal(payload.state, "awaiting_approval");
    assert.match(result.err, /coderax engine approve task-1 perm-1/);
    assert.match(result.err, /coderax engine deny task-1 perm-1/);
  });
});

test("an interrupted follow detaches without cancelling the task", async () => {
  await scenario(async ({ state, invoke }) => {
    const controller = new AbortController();
    controller.abort();
    const result = await invoke(["work", "long task", "--json"], { signal: controller.signal });
    assert.equal(result.code, 130);
    assert.equal(JSON.parse(result.out).detached, true);
    assert.equal(state.requests.some((request) => request.path.endsWith("/cancel")), false);
  });
});

test("events replays once, honours --after and filters duplicates", async () => {
  await scenario(async ({ state, invoke }) => {
    const all = await invoke(["events", "task-1", "--once", "--json"]);
    assert.equal(all.code, 0);
    const events = all.out.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((value) => value.seq), [1, 2, 3, 4]);

    const after = await invoke(["events", "task-1", "--after", "2", "--once", "--json"]);
    assert.equal(after.code, 0);
    const later = after.out.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(later.map((value) => value.seq), [3, 4]);
    assert.equal(state.requests.some((request) => request.path.endsWith("/events") && request.query.after === "2"), true);
  });
});

test("permission requests can be listed, approved and denied", async () => {
  await scenario(async ({ state, invoke }) => {
    const listed = await invoke(["permissions", "task-1", "--json"]);
    assert.equal(listed.code, 0);
    assert.equal(JSON.parse(listed.out).requests[0].decision, "pending");

    const approved = await invoke([
      "approve", "task-1", "perm-1", "--reason", "checked", "--json",
    ]);
    assert.equal(approved.code, 0);
    const decision = state.requests.find(
      (request) => request.path.endsWith("/permissions") && request.method === "POST",
    );
    assert.deepEqual(decision.body, { requestId: "perm-1", decision: "approved", reason: "checked" });

    state.permissions = [permissionBody({ decision: "pending" })];
    const denied = await invoke(["deny", "task-1", "perm-1", "--json"]);
    assert.equal(denied.code, 0);
  });
});

test("task control commands fetch the generation and send the right body", async () => {
  await scenario(async ({ state, invoke }) => {
    const cancelled = await invoke(["cancel", "task-1", "--reason", "stop", "--json"]);
    assert.equal(cancelled.code, 0);
    const cancelCall = state.requests.find((request) => request.path.endsWith("/cancel"));
    assert.deepEqual(cancelCall.body, { reason: "stop" });

    const resumed = await invoke(["resume", "task-1", "--json"]);
    assert.equal(resumed.code, 0);
    const resumeCall = state.requests.find((request) => request.path.endsWith("/resume"));
    assert.deepEqual(resumeCall.body, { generation: 1 });

    const retried = await invoke(["retry", "task-1", "--model", "free/other", "--json"]);
    assert.equal(retried.code, 0);
    const retryCall = state.requests.find((request) => request.path.endsWith("/retry"));
    assert.deepEqual(retryCall.body, {
      generation: 1,
      model: { providerId: "free", modelId: "other" },
    });
  });
});

test("history, memory, notifications, task discovery and artifacts are discoverable", async () => {
  await scenario(async ({ state, invoke }) => {
    state.task = taskBody({
      result: { summary: "hello world", artifacts: [{ path: "out.txt", bytes: 3, digest: "abc" }] },
    });

    assert.equal((await invoke(["task", "task-1", "--json"])).code, 0);
    const conversations = await invoke(["conversations", "--json"]);
    assert.equal(JSON.parse(conversations.out).conversations[0].conversationId, "conv-1");
    const history = await invoke(["conversation", "conv-1", "--json"]);
    assert.equal(JSON.parse(history.out).messages.length, 2);
    const memory = await invoke(["memory", "--mode", "cloud", "--json"]);
    assert.equal(JSON.parse(memory.out).entries[0].mode, "cloud");
    const notifications = await invoke(["notifications", "--json"]);
    assert.equal(JSON.parse(notifications.out).unread, 1);
    const tasks = await invoke(["tasks", "--json"]);
    assert.equal(JSON.parse(tasks.out).notifications[0].taskId, "task-1");
    const artifacts = await invoke(["artifacts", "task-1", "--json"]);
    const payload = JSON.parse(artifacts.out);
    assert.equal(payload.artifacts[0].path, "out.txt");
    assert.equal(payload.transferSupported, false);
  });
});

test("a deployment that echoes the owner token cannot put it in CLI output", async () => {
  await scenario(async ({ state, invoke }) => {
    state.chatText = `leaked ${TOKEN}`;
    state.task = taskBody({ result: { summary: `leaked ${TOKEN}`, artifacts: [] } });
    const chat = await invoke(["chat", "hi", "--json"]);
    assert.equal(chat.out.includes(TOKEN), false);
    const work = await invoke(["work", "hi", "--json"]);
    assert.equal(work.out.includes(TOKEN), false);
    const task = await invoke(["task", "task-1", "--json"]);
    assert.equal(task.out.includes(TOKEN), false);
  });
});

test("capability discovery reports engine truth and the transfer gap", async () => {
  await scenario(async ({ invoke }) => {
    const result = await invoke(["capabilities", "--json"]);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.out);
    assert.equal(payload.contractVersion, "1.0.0");
    assert.equal(payload.engines[0].id, "native");
    assert.equal(payload.cli.fileTransfers, false);
  });
});

test("doctor reports contract, readiness and owner authentication", async () => {
  await scenario(async ({ invoke, env }) => {
    const healthy = await invoke(["doctor", "--json"]);
    assert.equal(healthy.code, 0);
    const names = JSON.parse(healthy.out).checks.map((check) => check.name);
    for (const name of ["health", "contract", "readiness", "owner-auth"]) {
      assert.equal(names.includes(name), true, name);
    }

    const withoutToken = { ...env };
    delete withoutToken.CODERAX_TOKEN;
    const anonymous = await invoke(["doctor", "--json"], { env: withoutToken });
    assert.equal(anonymous.code, 1);
    assert.equal(
      JSON.parse(anonymous.out).checks.find((check) => check.name === "owner-token").ok,
      false,
    );
  });
});

test("an expired token during replay is reported once and not retried", async () => {
  await scenario(async ({ state, invoke }) => {
    state.eventsAuthFail = true;
    const result = await invoke(["events", "task-1"]);
    assert.equal(result.code, 3);
    assert.match(result.err, /expired token/);
    assert.equal(state.requests.filter((request) => request.path.endsWith("/events")).length, 1);
  });
});

test("work rejects invalid or detached replay cursors before sending a request", async () => {
  await scenario(async ({ state, invoke }) => {
    for (const flags of [["--after", "-1"], ["--after", "1", "--detach"]]) {
      const result = await invoke(["work", "do the work", ...flags]);
      assert.equal(result.code, 2);
      assert.match(result.err, /--after/);
    }
    assert.deepEqual(state.requests, []);
  });
});

test("work reports the accepted task ID when final status fails in JSON mode", async () => {
  await scenario(async ({ state, invoke }) => {
    state.taskUnavailable = true;
    const result = await invoke(["work", "do the work", "--json"]);
    assert.equal(result.code, 5);
    assert.deepEqual(JSON.parse(result.out), {
      taskId: "task-1",
      error: { code: "not_found", message: "HTTP 404 from getTask: status unavailable" },
    });
    assert.match(result.err, /coderax engine task task-1/);
  });
});

test("SIGINT stops a pending Chat and detaches a Work follower", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async () => {
  await scenario(async ({ env, state }) => {
    async function interrupt(args, hook) {
      let requested;
      const ready = new Promise((resolve) => { requested = resolve; });
      state[hook] = requested;
      const child = spawn(process.execPath, [
        fileURLToPath(new URL("../src/cli.js", import.meta.url)), "engine", ...args,
      ], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      const closed = once(child, "close");
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.resume();
      try {
        await Promise.race([ready, closed.then(() => { throw new Error("CLI exited before its request"); })]);
        child.kill("SIGINT");
        const [code, signal] = await closed;
        return { code, signal, output };
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }

    const chat = await interrupt(["chat", "wait", "--json"], "onChatRequest");
    assert.equal(chat.signal, "SIGINT");
    const work = await interrupt(["work", "wait", "--json"], "onEventsRequest");
    assert.equal(work.code, 130);
    assert.equal(JSON.parse(work.output).detached, true);
    assert.equal(state.requests.some((request) => request.path.endsWith("/cancel")), false);
  });
});
