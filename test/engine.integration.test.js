import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "../src/cli.js";
import { EngineClient } from "../src/engine.js";
import { capture } from "./support.js";

/**
 * These tests run the CLI against the real WorkflowEngine HTTP server: its own
 * router, contract schemas, event bus, orchestration service and test harness.
 *
 * The harness injects a deterministic model gateway. That makes the transport,
 * contract and lifecycle assertions real, but it is not a production model: a
 * passing run here is not evidence that a paid or free provider produced the
 * answer. The engine's own README says the same.
 *
 * `WORKFLOW_ENGINE_ROOT` points at a built checkout of
 * `Auctivon-CoderaxAI/Coderax-WorkflowEngine`. CI checks out the pinned commit.
 */

const engineRoot = process.env.WORKFLOW_ENGINE_ROOT
  ? resolve(process.env.WORKFLOW_ENGINE_ROOT)
  : null;
const skip = engineRoot
  ? false
  : "set WORKFLOW_ENGINE_ROOT to a built Coderax-WorkflowEngine checkout";

const helpers = engineRoot
  ? await import(pathToFileURL(join(engineRoot, "dist/tests/helpers.js")).href)
  : null;

async function cli(started, argv, { token = helpers?.OWNER_TOKEN, config } = {}) {
  const file = config ?? join(await mkdtemp(join(tmpdir(), "coderax-integration-")), "config.json");
  const io = capture();
  const env = {
    CODERAX_CONFIG: file,
    CODERAX_BASE_URL: started.url,
    CODERAX_TOKEN: token,
  };
  const code = await runCli(argv, {
    env,
    stdout: io.stdout,
    stderr: io.stderr,
    stdinIsTTY: true,
  });
  return { code, out: io.out(), err: io.err(), config: file };
}

async function waitFor(client, taskId, state, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await client.task(taskId);
    if (status.state === state) return status;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${taskId} to become ${state}; last state ${status.state}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

test("the CLI meets the real engine contract and owner-only auth", { skip }, async () => {
  const started = await helpers.startTestApp();
  try {
    const health = await cli(started, ["health", "--json"]);
    assert.equal(health.code, 0);
    assert.equal(JSON.parse(health.out).contractVersion, "1.0.0");

    const ready = await cli(started, ["ready", "--json"]);
    assert.equal(ready.code, 0);
    assert.equal(JSON.parse(ready.out).ready, true);

    const denied = await cli(started, ["agents", "--json"], { token: "not-the-owner" });
    assert.equal(denied.code, 3);
    assert.match(denied.err, /unauthorized/);

    const agents = await cli(started, ["agents", "--json"]);
    assert.equal(agents.code, 0);
    assert.equal(JSON.parse(agents.out).agents.length, 3);

    const models = await cli(started, ["models", "--json"]);
    assert.equal(models.code, 0);
    assert.equal(JSON.parse(models.out).allowPaid, false);

    const capabilities = await cli(started, ["capabilities", "--json"]);
    assert.equal(capabilities.code, 0);
    assert.equal(JSON.parse(capabilities.out).cli.fileTransfers, false);
  } finally {
    await started.close();
  }
});

test("chat and conversation history are shared across clients", { skip }, async () => {
  const started = await helpers.startTestApp();
  try {
    const chat = await cli(started, [
      "chat", "Summarize the release",
      "--agent", "coderax",
      "--model", "free/coderax-small",
      "--json",
    ]);
    assert.equal(chat.code, 0);
    const reply = JSON.parse(chat.out);
    assert.equal(reply.agent, "coderax");
    assert.equal(reply.text, "A verified result.");
    assert.ok(reply.conversationId);

    const followUp = await cli(started, [
      "chat", "Add a verification step",
      "--conversation", reply.conversationId,
      "--json",
    ]);
    assert.equal(followUp.code, 0);
    assert.equal(JSON.parse(followUp.out).conversationId, reply.conversationId);

    // A second CLI config represents the same owner on another device.
    const otherDevice = await cli(started, ["conversation", reply.conversationId, "--json"]);
    assert.equal(otherDevice.code, 0);
    const history = JSON.parse(otherDevice.out);
    assert.equal(history.conversationId, reply.conversationId);
    assert.equal(history.messages.length, 4);
    assert.equal(history.messages[0].text, "Summarize the release");
    assert.equal(history.messages[1].text, "A verified result.");
    assert.equal(history.messages[2].text, "Add a verification step");

    const list = await cli(started, ["conversations", "--json"]);
    assert.equal(JSON.parse(list.out).conversations[0].conversationId, reply.conversationId);

    const memory = await cli(started, ["memory", "--mode", "private", "--json"]);
    assert.equal(memory.code, 0);
    assert.equal(Array.isArray(JSON.parse(memory.out).entries), true);
  } finally {
    await started.close();
  }
});

test("work streams, persists status, notifications, history and artifact metadata", { skip }, async () => {
  const started = await helpers.startTestApp();
  try {
    const work = await cli(started, ["work", "prepare the release checklist", "--json"]);
    assert.equal(work.code, 0);
    const result = JSON.parse(work.out);
    assert.equal(result.state, "completed");
    assert.equal(result.generation, 1);
    assert.equal(result.text, "A verified result.\n\nA verified result.\n\nA verified result.");
    assert.ok(result.events >= 5);
    assert.ok(result.conversationId);

    const status = await cli(started, ["task", result.taskId, "--json"]);
    assert.equal(status.code, 0);
    assert.equal(JSON.parse(status.out).state, "completed");

    const notifications = await cli(started, ["notifications", "--json"]);
    assert.equal(notifications.code, 0);
    const notificationList = JSON.parse(notifications.out);
    assert.equal(notificationList.unread, 1);
    assert.equal(notificationList.notifications[0].taskId, result.taskId);

    const tasks = await cli(started, ["tasks", "--json"]);
    assert.equal(JSON.parse(tasks.out).notifications[0].taskId, result.taskId);

    const history = await cli(started, ["conversation", result.conversationId, "--json"]);
    assert.equal(history.code, 0);
    assert.equal(JSON.parse(history.out).messages.length, 2);

    const replay = await cli(started, ["events", result.taskId, "--once", "--json"]);
    assert.equal(replay.code, 0);
    const events = replay.out.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].seq, 1);
    assert.equal(events.at(-1).type, "task.completed");
    for (let index = 1; index < events.length; index += 1) {
      assert.ok(events[index].seq > events[index - 1].seq, "event sequence must increase");
    }

    const permissions = await cli(started, ["permissions", result.taskId, "--json"]);
    assert.equal(permissions.code, 0);
    assert.deepEqual(JSON.parse(permissions.out).requests, []);

    const artifacts = await cli(started, ["artifacts", result.taskId, "--json"]);
    assert.equal(artifacts.code, 0);
    const artifactPayload = JSON.parse(artifacts.out);
    assert.deepEqual(artifactPayload.artifacts, []);
    assert.equal(artifactPayload.transferSupported, false);
  } finally {
    await started.close();
  }
});

test("cancellation settles a running task without leaving it running", { skip }, async () => {
  const started = await helpers.startTestApp({ gateway: helpers.slowGateway(60_000) });
  const client = new EngineClient({ baseUrl: started.url, token: helpers.OWNER_TOKEN });
  try {
    const submitted = await cli(started, ["work", "long running work", "--detach", "--json"]);
    assert.equal(submitted.code, 0);
    const taskId = JSON.parse(submitted.out).taskId;
    await waitFor(client, taskId, "running");

    const cancelled = await cli(started, ["cancel", taskId, "--reason", "owner cancelled", "--json"]);
    assert.equal(cancelled.code, 0);
    assert.equal(JSON.parse(cancelled.out).outcome, "accepted");

    const settled = await waitFor(client, taskId, "cancelled");
    assert.equal(settled.generation, 1);
  } finally {
    await started.close();
  }
});

test("a failed task can be retried on the same engine with a new generation", { skip }, async () => {
  const started = await helpers.startTestApp({ gateway: helpers.failingGateway(1) });
  const client = new EngineClient({ baseUrl: started.url, token: helpers.OWNER_TOKEN });
  try {
    const submitted = await cli(started, ["work", "retryable work", "--detach", "--json"]);
    assert.equal(submitted.code, 0);
    const taskId = JSON.parse(submitted.out).taskId;

    const failed = await waitFor(client, taskId, "failed");
    assert.equal(failed.failure.code, "provider_error");

    const retried = await cli(started, ["retry", taskId, "--json"]);
    assert.equal(retried.code, 0);
    const control = JSON.parse(retried.out);
    assert.equal(control.outcome, "accepted");
    assert.equal(control.generation, 2);

    const completed = await waitFor(client, taskId, "completed");
    assert.equal(completed.generation, 2);
    assert.equal(completed.result.summary.startsWith("Recovered result."), true);
  } finally {
    await started.close();
  }
});

test("resume reports the engine's outcome for a terminal task", { skip }, async () => {
  const started = await helpers.startTestApp();
  try {
    const work = await cli(started, ["work", "resume check", "--json"]);
    assert.equal(work.code, 0);
    const taskId = JSON.parse(work.out).taskId;

    const resumed = await cli(started, ["resume", taskId, "--json"]);
    assert.equal(resumed.code, 0);
    const control = JSON.parse(resumed.out);
    assert.equal(control.taskId, taskId);
    assert.equal(control.outcome, "already_terminal");
    assert.equal(control.state, "completed");
  } finally {
    await started.close();
  }
});

test("an expired or wrong token is rejected by replay", { skip }, async () => {
  const started = await helpers.startTestApp();
  try {
    const work = await cli(started, ["work", "auth check", "--json"]);
    assert.equal(work.code, 0);
    const taskId = JSON.parse(work.out).taskId;

    const replay = await cli(started, ["events", taskId, "--once"], { token: "expired-token" });
    assert.equal(replay.code, 3);
    assert.match(replay.err, /unauthorized/);
  } finally {
    await started.close();
  }
});
