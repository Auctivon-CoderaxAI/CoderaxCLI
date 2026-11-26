import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "../../src/cli.js";
import { capture, optionsFor } from "../helpers.js";

/**
 * Optional real-engine integration. It is skipped unless WORKFLOW_ENGINE_ROOT
 * points at a built WorkflowEngine checkout. CI checks out the pinned commit,
 * builds the engine and runs this file on a standard GitHub-hosted runner.
 *
 * The engine harness injects a deterministic gateway. A passing run proves the
 * transport, contract, lifecycle and CLI integration; it is not evidence that a
 * production model produced an answer.
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

async function cli(started, argv, { token = helpers?.OWNER_TOKEN } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "coderax-engine-int-"));
  const io = capture();
  const env = {
    CODERAX_ENGINE_URL: started.url,
    CODERAX_ENGINE_TOKEN: token,
    CODERAX_CONFIG_DIR: directory,
    CODERAX_CREDENTIAL_STORE: "file",
  };
  const code = await runCli(argv, optionsFor(env, io));
  return { code, out: io.out(), err: io.err(), json: () => JSON.parse(io.out()) };
}

test("the CLI negotiates the real engine contract and owner auth", { skip }, async () => {
  const started = await helpers.startTestApp();
  try {
    const health = await cli(started, ["engine", "health", "--json"]);
    assert.equal(health.code, 0, health.err);
    const healthData = health.json().data;
    assert.equal(healthData.health.contractVersion, "1.0.0");
    assert.equal(healthData.compatible, true);

    const ready = await cli(started, ["engine", "ready", "--json"]);
    assert.equal(ready.code, 0, ready.err);
    assert.equal(ready.json().data.readiness.ready, true);

    const denied = await cli(started, ["agents", "--json"], { token: "not-the-owner" });
    assert.equal(denied.code, 3);
    assert.equal(denied.json().error.code, "unauthorized");

    const agents = await cli(started, ["agents", "--json"]);
    assert.equal(agents.code, 0, agents.err);
    assert.equal(agents.json().data.agents.length, 3);

    const models = await cli(started, ["models", "--json"]);
    assert.equal(models.code, 0, models.err);
    assert.equal(models.json().data.allowPaid, false);
  } finally {
    await started.close();
  }
});

test("Chat and conversation history are shared by the engine", { skip }, async () => {
  const started = await helpers.startTestApp();
  try {
    const chat = await cli(started, [
      "chat", "Summarize the release",
      "--agent", "coderax",
      "--model", "free/coderax-small",
      "--json",
    ]);
    assert.equal(chat.code, 0, chat.err);
    const reply = chat.json().data.reply;
    assert.ok(reply.conversationId);
    assert.ok(reply.text.length > 0);

    const history = await cli(started, ["sessions", "show", reply.conversationId, "--json"]);
    assert.equal(history.code, 0, history.err);
    const conversation = history.json().data.conversation;
    assert.equal(conversation.conversationId, reply.conversationId);
    assert.ok(conversation.messages.length >= 2);
  } finally {
    await started.close();
  }
});

test("Work completes, persists status and emits notifications on the real engine", { skip }, async () => {
  const started = await helpers.startTestApp();
  try {
    const work = await cli(started, ["work", "prepare the release checklist", "--json"]);
    assert.equal(work.code, 0, work.err);
    const result = work.json().data;
    assert.equal(result.state, "completed");
    assert.equal(typeof result.task, "string", work.out);
    assert.ok(result.events.length >= 5);
    assert.equal(new Set(result.events.map((event) => event.seq)).size, result.events.length);

    const status = await cli(started, ["work", "status", result.task, "--json"]);
    assert.equal(status.code, 0, `${status.err}\n${status.out}`);
    assert.equal(status.json().data.status.state, "completed");

    const notifications = await cli(started, ["notifications", "--json"]);
    assert.equal(notifications.code, 0, notifications.err);
    const notificationData = notifications.json().data;
    assert.ok(notificationData.unread >= 1);
    assert.equal(notificationData.notifications[0].taskId, result.task);
  } finally {
    await started.close();
  }
});

test("the workflow control plane verifies and runs on the real engine", { skip }, async () => {
  const started = await helpers.startTestApp();
  try {
    const environment = await cli(started, ["workflow", "environments", "--json"]);
    assert.equal(environment.code, 0, environment.err);
    const data = environment.json().data;
    assert.equal(data.ready, true);
    assert.equal(data.trust, "unverified");
    assert.equal(data.deploymentIdentity.supported, false);
    assert.equal(data.repositoryIdentity.supported, false);
    assert.equal(data.authorization.owner, true);

    // The authoritative Native agent publishes `tools: false`. The CLI must
    // refuse repository engineering instead of pretending the engine can do it.
    assert.equal(data.engineering.available, false);
    assert.equal(data.engineering.selectedAgentTools, false);
    assert.deepEqual(data.engineering.toolCapableAgents, []);

    const kinds = await cli(started, ["workflow", "kinds", "--json"]);
    assert.equal(kinds.code, 0, kinds.err);
    assert.equal(kinds.json().data.kinds.find((entry) => entry.name === "inspect").available, false);

    const run = await cli(started, [
      "workflow", "run", "inspect", "report the release risks",
      "--repo", "acme/widgets", "--json",
    ]);
    assert.equal(run.code, 7, `${run.err}\n${run.out}`);
    assert.equal(run.json().error.code, "CAPABILITY_UNSUPPORTED");
    assert.deepEqual(run.json().error.details.toolCapableAgents, []);

    const pr = await cli(started, [
      "workflow", "pr", "--head", "feature/release", "--base", "main",
      "--confirm", "--allow-production", "--allow-destructive", "--json",
    ]);
    assert.equal(pr.code, 6, pr.out);
    assert.equal(pr.json().data.available, false);
    assert.equal(pr.json().data.sent, false);
    assert.equal(pr.json().data.operation, "createPullRequest");
    assert.equal(pr.json().data.request.merge, false);
  } finally {
    await started.close();
  }
});

test("the real engine refuses an unauthenticated workflow write", { skip }, async () => {
  const started = await helpers.startTestApp();
  try {
    const denied = await cli(started, ["workflow", "run", "fix", "a bug", "--json"], { token: "not-the-owner" });
    assert.equal(denied.code, 3, denied.out);
    assert.equal(denied.json().error.code, "unauthorized");
  } finally {
    await started.close();
  }
});
