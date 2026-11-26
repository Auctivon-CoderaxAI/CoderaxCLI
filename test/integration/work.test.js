import test from "node:test";
import assert from "node:assert/strict";
import { startFixtureEngine } from "../fixtures/engine-server.js";
import { runCli } from "../../src/cli.js";
import { capture, optionsFor, tempDir } from "../helpers.js";

async function withEngine(options, run) {
  const engine = await startFixtureEngine(options);
  const dir = await tempDir("coderax-int-");
  const env = {
    CODERAX_ENGINE_URL: engine.url,
    CODERAX_ENGINE_TOKEN: engine.token,
    CODERAX_CONFIG_DIR: dir,
    CODERAX_CREDENTIAL_STORE: "file",
  };
  try {
    return await run({ engine, env, dir });
  } finally {
    await engine.close();
  }
}

async function cli(env, argv) {
  const io = capture();
  const code = await runCli(argv, optionsFor(env, io));
  return { code, io, json: () => JSON.parse(io.out()) };
}

test("an explicit task id works from a fresh terminal with no local state", async () => {
  await withEngine({}, async ({ env }) => {
    const detached = await cli(env, ["work", "run", "Fresh terminal task", "--detach", "--json"]);
    assert.equal(detached.code, 0, detached.io.err());
    const taskId = detached.json().data.task.taskId;
    const fresh = await tempDir("coderax-fresh-");
    const freshEnv = {
      CODERAX_ENGINE_URL: env.CODERAX_ENGINE_URL,
      CODERAX_ENGINE_TOKEN: env.CODERAX_ENGINE_TOKEN,
      CODERAX_CONFIG_DIR: fresh,
      CODERAX_CREDENTIAL_STORE: "file",
    };
    const status = await cli(freshEnv, ["work", "status", taskId, "--json"]);
    assert.equal(status.code, 0, `${status.io.err()}\n${status.io.out()}`);
    assert.equal(status.json().data.status.taskId, taskId);
  });
});

test("work run completes, renders Markdown and returns a machine result", async () => {
  await withEngine({}, async ({ env }) => {
    const { code, io, json } = await cli(env, ["work", "run", "Inspect the repository", "--json"]);
    assert.equal(code, 0, io.err());
    const data = json().data;
    assert.equal(data.state, "completed");
    assert.match(data.summary, /Fixture result/);
    assert.equal(data.status?.result?.summary, undefined);
    assert.equal(data.artifacts[0].path, "src/index.js");
    assert.ok(data.events.some((event) => event.type === "file.edit"));
    assert.equal(io.out().includes("owner-token"), false);
  });
});

test("human output renders Markdown, tools, steps and a terminal summary", async () => {
  await withEngine({}, async ({ env }) => {
    const { code, io } = await cli(env, ["work", "run", "Inspect the repository"]);
    assert.equal(code, 0, io.err());
    const output = io.out();
    assert.match(output, /queued/);
    assert.match(output, /Inspect the cloud workspace/);
    assert.match(output, /read/);
    assert.match(output, /src\/index\.js/);
    assert.match(output, /completed in/);
    assert.match(output, /usage: 120 in \/ 30 out/);
  });
});

test("--ndjson emits ordered events and one final result", async () => {
  await withEngine({}, async ({ env }) => {
    const { code, io } = await cli(env, ["work", "run", "Inspect", "--ndjson"]);
    assert.equal(code, 0, io.err());
    const lines = io.out().trim().split("\n").map((line) => JSON.parse(line));
    const events = lines.filter((line) => line.type === "event");
    const results = lines.filter((line) => line.type === "result");
    assert.ok(events.length >= 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].data.state, "completed");
    const seqs = events.map((line) => line.event.seq);
    assert.deepEqual(seqs, [...new Set(seqs)]);
  });
});

test("an approval is enforced unless the owner grants it", async () => {
  await withEngine({ requireApproval: true }, async ({ env, engine }) => {
    const denied = await cli(env, ["work", "run", "Run tests", "--json"]);
    assert.equal(denied.code, 8);
    assert.equal(denied.json().error.code, "PERMISSION_REQUIRED");
    const task = [...engine.tasks.values()][0];
    assert.equal(task.state, "awaiting_approval");

    const list = await cli(env, ["permissions", task.taskId, "--json"]);
    assert.equal(list.code, 0);
    assert.equal(list.json().data.requests[0].decision, "pending");

    const decide = await cli(env, ["permissions", "decide", task.taskId, "req_fixture", "--approve", "--json"]);
    assert.equal(decide.code, 0);
    assert.equal(decide.json().data.permissions.requests[0].decision, "approved");

    const attach = await cli(env, ["work", "attach", task.taskId, "--json"]);
    assert.equal(attach.code, 0, attach.io.err());
    assert.equal(attach.json().data.state, "completed");
  });
});

test("--approve-all decides approvals without a prompt", async () => {
  await withEngine({ requireApproval: true }, async ({ env }) => {
    const { code, io, json } = await cli(env, ["work", "run", "Run tests", "--approve-all", "--json"]);
    assert.equal(code, 0, io.err());
    assert.equal(json().data.state, "completed");
  });
});

test("a detached task can be reattached and replayed without duplicate events", async () => {
  await withEngine({ disconnectAfter: 3 }, async ({ env, engine }) => {
    const detached = await cli(env, ["work", "run", "Detached task", "--detach", "--json"]);
    assert.equal(detached.code, 0, detached.io.err());
    const taskId = detached.json().data.task.taskId;
    assert.ok(engine.tasks.has(taskId));

    const attached = await cli(env, ["work", "attach", taskId, "--json"]);
    assert.equal(attached.code, 0, attached.io.err());
    const data = attached.json().data;
    assert.equal(data.state, "completed");
    const seqs = data.events.map((event) => event.seq);
    assert.deepEqual(seqs, [...new Set(seqs)]);
  });
});

test("cancellation is explicit and resume uses the generation", async () => {
  await withEngine({}, async ({ env, engine }) => {
    const detached = await cli(env, ["work", "run", "Cancel me", "--detach", "--json"]);
    const taskId = detached.json().data.task.taskId;
    const cancelled = await cli(env, ["work", "cancel", taskId, "--reason", "owner aborted", "--json"]);
    assert.equal(cancelled.code, 130);
    assert.equal(cancelled.json().data.result.outcome, "accepted");
    assert.equal(engine.getTask(taskId).state, "cancelled");

    const resumed = await cli(env, ["work", "resume", taskId, "--json"]);
    assert.equal(resumed.code, 0, resumed.io.err());
    assert.equal(resumed.json().data.result.generation >= 1, true);
    const status = await cli(env, ["work", "status", taskId, "--json"]);
    assert.equal(status.code, 0);
    assert.equal(status.json().data.status.taskId, taskId);
  });
});

test("contract mismatch fails explicitly before any work is submitted", async () => {
  await withEngine({ contractVersion: "2.0.0" }, async ({ env, engine }) => {
    const { code, json, io } = await cli(env, ["work", "run", "Anything", "--json"]);
    assert.equal(code, 7);
    assert.equal(json().error.code, "CONTRACT_UNSUPPORTED");
    assert.equal(engine.tasks.size, 0);
    assert.equal(io.out().includes("owner-token"), false);
  });
});

test("a template that needs tools is refused when the agent reports tools:false", async () => {
  await withEngine({ tools: false }, async ({ env }) => {
    const { code, json } = await cli(env, ["work", "--template", "inspect", "README", "--json"]);
    assert.equal(code, 7);
    assert.equal(json().error.code, "CAPABILITY_UNSUPPORTED");
    assert.equal(json().error.details.capability, "tools");

    const freeform = await cli(env, ["work", "run", "Summarize the repository", "--json"]);
    assert.equal(freeform.code, 0, freeform.io.err());
  });
});

test("notifications and task listing merge the durable journal", async () => {
  await withEngine({}, async ({ env }) => {
    const work = await cli(env, ["work", "run", "Notify me", "--json"]);
    assert.equal(work.code, 0);
    const notes = await cli(env, ["notifications", "--json"]);
    assert.equal(notes.code, 0);
    assert.equal(notes.json().data.unread >= 1, true);
    assert.ok(notes.json().data.notifications.some((entry) => entry.state === "completed"));

    const list = await cli(env, ["work", "list", "--json"]);
    assert.equal(list.code, 0);
    assert.ok(list.json().data.tasks.some((task) => task.state === "completed"));
  });
});

test("sessions list and show use the engine conversation surface", async () => {
  await withEngine({}, async ({ env }) => {
    const work = await cli(env, ["work", "run", "A durable session", "--json"]);
    const conversationId = work.json().data.conversationId;
    const list = await cli(env, ["sessions", "list", "--json"]);
    assert.equal(list.code, 0);
    assert.ok(list.json().data.conversations.some((entry) => entry.conversationId === conversationId));
    const show = await cli(env, ["sessions", "show", conversationId, "--json"]);
    assert.equal(show.code, 0);
    assert.equal(show.json().data.conversation.isWork, true);
  });
});

test("agents and models expose availability and the zero-cost route", async () => {
  await withEngine({}, async ({ env }) => {
    const agents = await cli(env, ["agents", "--json"]);
    assert.equal(agents.code, 0);
    assert.equal(agents.json().data.agents[0].id, "coderax");
    const models = await cli(env, ["models", "--json"]);
    assert.equal(models.code, 0);
    assert.equal(models.json().data.allowPaid, false);
    assert.equal(models.json().data.route[0].providerId, "fixture");
    const health = await cli(env, ["engine", "health", "--json"]);
    assert.equal(health.code, 0);
    assert.equal(health.json().data.compatible, true);
    const ready = await cli(env, ["engine", "ready", "--json"]);
    assert.equal(ready.code, 0);
  });
});

test("chat keeps a conversation and returns the engine's answer", async () => {
  await withEngine({ chatReply: "Hi from the fixture." }, async ({ env }) => {
    const first = await cli(env, ["chat", "hello", "--json"]);
    assert.equal(first.code, 0, first.io.err());
    assert.equal(first.json().data.reply.text, "Hi from the fixture.");
    const conversationId = first.json().data.reply.conversationId;
    const second = await cli(env, ["chat", "again", "--conversation", conversationId, "--json"]);
    assert.equal(second.code, 0);
    assert.equal(second.json().data.reply.conversationId, conversationId);
    const show = await cli(env, ["sessions", "show", conversationId, "--json"]);
    assert.equal(show.code, 0);
    assert.equal(show.json().data.conversation.messages.length, 4);
  });
});

test("a missing token is an authentication error, not an anonymous request", async () => {
  await withEngine({}, async ({ env }) => {
    const withoutToken = { ...env };
    delete withoutToken.CODERAX_ENGINE_TOKEN;
    const { code, json } = await cli(withoutToken, ["work", "run", "No token", "--json"]);
    assert.equal(code, 3);
    assert.equal(json().error.code, "UNAUTHENTICATED");
  });
});
