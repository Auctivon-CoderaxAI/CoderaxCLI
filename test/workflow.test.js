import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { startWorkflowEngine } from "./harness/workflow-engine.js";

function capture() {
  const out = [];
  const err = [];
  return {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

async function invocation(engine, argv, { env: extraEnv = {}, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "coderax-workflow-"));
  const env = {
    CODERAX_CONFIG: join(directory, "config.json"),
    CODERAX_BASE_URL: engine.baseUrl,
    CODERAX_TOKEN: engine.token,
    ...extraEnv,
  };
  const io = capture();
  const code = await runCli(argv, { env, stdout: io.stdout, stderr: io.stderr, ...options });
  const stdout = io.out();
  const stderr = io.err();
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  let error = null;
  try {
    error = stderr.trim() === "" ? null : JSON.parse(stderr);
  } catch {
    error = null;
  }
  return { code, stdout, stderr, json, error };
}

async function withEngine(options, run) {
  const engine = await startWorkflowEngine(options);
  try {
    await run(engine);
  } finally {
    await engine.close();
  }
}

test("capabilities binds every catalog command to a published operation", async () => {
  await withEngine({}, async (engine) => {
    const result = await invocation(engine, ["capabilities", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.contract, "/openapi.json");
    assert.ok(result.json.operationCount > 20);
    assert.equal(result.json.server.features.artifacts, true);

    const schedules = result.json.capabilities.find((entry) => entry.capability === "schedules");
    assert.equal(schedules.status, "ready");
    const cancel = result.json.capabilities
      .find((entry) => entry.capability === "tasks")
      .commands.find((entry) => entry.command === "tasks cancel");
    assert.equal(cancel.available, true);
    assert.equal(cancel.operation.path, "/api/tasks/{taskId}/cancel");
    assert.equal(cancel.operation.operationId, "cancelTask");

    const identity = result.json.capabilities.find((entry) => entry.capability === "identity");
    assert.equal(identity.commands[0].binding, "fixed");
    assert.equal(result.json.builtins.some((entry) => entry.command === "chat"), true);
  });
});

test("conversations list and show use discovered operations and validate queries", async () => {
  await withEngine({}, async (engine) => {
    const list = await invocation(engine, ["conversations", "--json"]);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(list.json.command, "conversations list");
    assert.equal(list.json.operation.method, "GET");
    assert.equal(list.json.operation.path, "/api/conversations");
    assert.equal(list.json.data.conversations.length, 2);
    assert.equal(list.json.meta.count, 2);
    assert.equal(list.json.meta.total, 2);

    const limited = await invocation(engine, ["conversations", "list", "--param", "limit=1", "--json"]);
    assert.equal(limited.code, 0, limited.stderr);
    assert.equal(limited.json.data.conversations.length, 1);

    const human = await invocation(engine, ["conversations"]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /conv-1/);
    assert.match(human.stdout, /Repository review/);

    const shown = await invocation(engine, ["conversations", "show", "conv-2", "--json"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(shown.json.data.title, "Release plan");

    const undeclared = await invocation(engine, ["conversations", "list", "--status", "open", "--json"]);
    assert.equal(undeclared.code, 2);
    assert.equal(undeclared.error.error.code, "USAGE");
    assert.match(undeclared.error.error.message, /does not accept the query parameter "status"/);

    const badLimit = await invocation(engine, ["conversations", "list", "--limit", "many", "--json"]);
    assert.equal(badLimit.code, 2);
    assert.match(badLimit.error.error.message, /must be an integer/);
  });
});

test("task actions require --yes and mutate server state", async () => {
  await withEngine({}, async (engine) => {
    const refused = await invocation(engine, ["tasks", "cancel", "task-1", "--json"]);
    assert.equal(refused.code, 2);
    assert.equal(refused.error.error.code, "CONFIRMATION_REQUIRED");

    const cancelled = await invocation(engine, ["cancel", "task-1", "--yes", "--json"]);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(cancelled.json.operation.path, "/api/tasks/{taskId}/cancel");
    assert.equal(engine.state.tasks[0].status, "cancelled");

    assert.equal((await invocation(engine, ["retry", "task-2", "--json"])).code, 0);
    assert.equal(engine.state.tasks[1].status, "running");

    assert.equal((await invocation(engine, ["tasks", "resume", "task-3", "--json"])).code, 0);
    assert.equal(engine.state.tasks[2].status, "running");

    assert.equal((await invocation(engine, ["detach", "task-1", "--json"])).code, 0);
    assert.equal(engine.state.tasks[0].status, "detached");

    const shown = await invocation(engine, ["tasks", "show", "task-1", "--json"]);
    assert.equal(shown.json.data.status, "detached");

    const filtered = await invocation(engine, ["tasks", "list", "--status", "running", "--json"]);
    assert.equal(filtered.code, 0, filtered.stderr);
    assert.equal(filtered.json.data.tasks.length, 2);
  });
});

test("schedules support create, inspect, modify, pause, resume and cancel", async () => {
  await withEngine({}, async (engine) => {
    const missing = await invocation(engine, ["schedules", "create", "--cron", "0 9 * * *", "--json"]);
    assert.equal(missing.code, 2);
    assert.match(missing.error.error.message, /requires --prompt/);

    const created = await invocation(engine, [
      "schedules", "create",
      "--cron", "0 9 * * 1-5",
      "--prompt", "Review open pull requests",
      "--name", "weekday-review",
      "--json",
    ]);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.json.operation.path, "/api/schedules");
    assert.equal(created.json.data.id, "sched-1");
    assert.equal(engine.state.schedules.length, 1);

    const listed = await invocation(engine, ["schedules", "--json"]);
    assert.equal(listed.json.data.schedules.length, 1);

    const shown = await invocation(engine, ["schedules", "show", "sched-1", "--json"]);
    assert.equal(shown.json.data.cron, "0 9 * * 1-5");

    const updated = await invocation(engine, [
      "schedules", "update", "sched-1", "--name", "renamed", "--enabled", "false", "--json",
    ]);
    assert.equal(updated.code, 0, updated.stderr);
    assert.equal(updated.json.data.name, "renamed");
    assert.equal(updated.json.data.enabled, false);

    const emptyUpdate = await invocation(engine, ["schedules", "update", "sched-1", "--json"]);
    assert.equal(emptyUpdate.code, 2);
    assert.match(emptyUpdate.error.error.message, /at least one field flag/);

    const paused = await invocation(engine, ["schedules", "pause", "sched-1", "--json"]);
    assert.equal(paused.code, 0, paused.stderr);
    assert.equal(paused.json.data.status, "paused");

    const resumed = await invocation(engine, ["schedules", "resume", "sched-1", "--json"]);
    assert.equal(resumed.json.data.status, "active");

    const cancelled = await invocation(engine, ["schedules", "cancel", "sched-1", "--yes", "--json"]);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(cancelled.json.status, 204);
    assert.equal(engine.state.schedules.length, 0);
  });
});

test("artifacts upload, download securely and delete", async () => {
  await withEngine({}, async (engine) => {
    const directory = await mkdtemp(join(tmpdir(), "coderax-artifact-"));
    const source = join(directory, "report.txt");
    const payload = Buffer.from("artifact payload \u2713\n");
    await writeFile(source, payload);

    const uploaded = await invocation(engine, ["artifacts", "upload", source, "--json"]);
    assert.equal(uploaded.code, 0, uploaded.stderr);
    assert.equal(uploaded.json.data.id, "art-1");
    assert.equal(uploaded.json.meta.file.bytes, payload.length);
    assert.equal(engine.state.artifacts.get("art-1").bytes.toString(), payload.toString());

    const listed = await invocation(engine, ["artifacts", "--json"]);
    assert.equal(listed.json.data.artifacts.length, 1);

    const metadata = await invocation(engine, ["artifacts", "show", "art-1", "--json"]);
    assert.equal(metadata.json.data.name, "report.txt");

    const destination = join(directory, "downloaded.txt");
    const downloaded = await invocation(engine, ["artifacts", "download", "art-1", "--output", destination, "--json"]);
    assert.equal(downloaded.code, 0, downloaded.stderr);
    assert.equal(downloaded.json.meta.file.mode, "0600");
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal((await readFile(destination)).toString(), payload.toString());

    const overwrite = await invocation(engine, ["artifacts", "download", "art-1", "--output", destination, "--json"]);
    assert.equal(overwrite.code, 2);
    assert.equal(overwrite.error.error.code, "FILE_INVALID");

    const forced = await invocation(engine, [
      "artifacts", "download", "art-1", "--output", destination, "--force", "--json",
    ]);
    assert.equal(forced.code, 0, forced.stderr);

    const noOutput = await invocation(engine, ["artifacts", "download", "art-1", "--json"]);
    assert.equal(noOutput.code, 2);
    assert.match(noOutput.error.error.message, /requires --output/);

    const directoryUpload = await invocation(engine, ["artifacts", "upload", directory, "--json"]);
    assert.equal(directoryUpload.code, 2);
    assert.equal(directoryUpload.error.error.code, "FILE_INVALID");

    const refused = await invocation(engine, ["artifacts", "delete", "art-1", "--json"]);
    assert.equal(refused.code, 2);

    const deleted = await invocation(engine, ["artifacts", "delete", "art-1", "--yes", "--json"]);
    assert.equal(deleted.code, 0, deleted.stderr);

    const gone = await invocation(engine, ["artifacts", "download", "art-1", "--output", destination, "--json"]);
    assert.equal(gone.code, 5);
    assert.equal(gone.error.error.code, "HTTP_404");
  });
});

test("memory, notifications, permissions, plugins and tools are authoritative", async () => {
  await withEngine({}, async (engine) => {
    const memory = await invocation(engine, ["memory", "--json"]);
    assert.equal(memory.json.data.memory.length, 2);

    const forgotten = await invocation(engine, ["memory", "delete", "mem-1", "--yes", "--json"]);
    assert.equal(forgotten.code, 0, forgotten.stderr);
    assert.equal(engine.state.memory.length, 1);

    const read = await invocation(engine, ["notifications", "read", "note-1", "--json"]);
    assert.equal(read.code, 0, read.stderr);
    assert.equal(read.json.data.read, true);
    assert.equal(engine.state.notifications[0].read, true);

    const permissions = await invocation(engine, ["permissions", "--json"]);
    assert.equal(permissions.json.data.permissions.length, 2);

    const plugin = await invocation(engine, ["plugins", "show", "plugin-2", "--json"]);
    assert.equal(plugin.json.data.name, "jira");

    const tools = await invocation(engine, ["tools", "--json"]);
    assert.equal(tools.json.data.tools[0].id, "tool-1");

    const invoked = await invocation(engine, [
      "tools", "invoke", "tool-1", "--data", '{"path":"README.md"}', "--json",
    ]);
    assert.equal(invoked.code, 0, invoked.stderr);
    assert.deepEqual(invoked.json.data.input, { path: "README.md" });
    assert.equal(invoked.json.data.result, "ok");
  });
});

test("unpublished capabilities fail loudly without guessing a route", async () => {
  await withEngine({ only: ["/api/conversations", "/api/user"] }, async (engine) => {
    const result = await invocation(engine, ["tasks", "list", "--json"]);
    assert.equal(result.code, 1);
    assert.equal(result.error.error.code, "OPERATION_NOT_FOUND");
    assert.equal(result.error.error.command, "tasks list");
    assert.match(result.error.error.message, /Nothing was sent/);

    assert.equal(engine.requests.some((request) => request.path === "/api/tasks"), false);

    const report = await invocation(engine, ["capabilities", "--json"]);
    assert.equal(report.code, 0, report.stderr);
    const tasks = report.json.capabilities.find((entry) => entry.capability === "tasks");
    assert.equal(tasks.status, "unavailable");
    assert.equal(tasks.commands.every((entry) => entry.available === false), true);

    const identity = await invocation(engine, ["whoami", "--json"]);
    assert.equal(identity.code, 0, identity.stderr);
    assert.equal(identity.json.data.email, "harness@coderax.test");
  });
});

test("--operation binds a command to an intentional operation", async () => {
  const extraRoutes = [
    {
      method: "GET",
      path: "/api/work-items/{workItemId}",
      operationId: "getWorkItem",
      summary: "Show a work item",
      parameters: [{ name: "workItemId", in: "path", required: true, schema: { type: "string" } }],
      handler: ({ params }) => ({ json: { id: params.workItemId, status: "running" } }),
    },
  ];
  await withEngine(
    { only: ["/api/conversations", "/api/user", "/api/work-items"], extraRoutes },
    async (engine) => {
      const missing = await invocation(engine, ["tasks", "show", "work-1", "--json"]);
      assert.equal(missing.code, 1);
      assert.equal(missing.error.error.code, "OPERATION_NOT_FOUND");

      const bound = await invocation(engine, [
        "tasks", "show", "work-1", "--operation", "getWorkItem", "--json",
      ]);
      assert.equal(bound.code, 0, bound.stderr);
      assert.equal(bound.json.data.id, "work-1");
      assert.equal(bound.json.operation.operationId, "getWorkItem");
    },
  );
});

test("whoami reports identity and an absent token is an auth error", async () => {
  await withEngine({}, async (engine) => {
    const who = await invocation(engine, ["whoami", "--json"]);
    assert.equal(who.code, 0, who.stderr);
    assert.equal(who.json.data.username, "harness");

    const anonymous = await invocation(engine, ["whoami", "--json"], {
      env: { CODERAX_TOKEN: "" },
    });
    assert.equal(anonymous.code, 3);
    assert.equal(anonymous.error.error.code, "UNAUTHENTICATED");
  });
});

test("argument and option validation fails before any request", async () => {
  await withEngine({}, async (engine) => {
    const before = engine.requests.length;

    const noId = await invocation(engine, ["tasks", "show", "--json"]);
    assert.equal(noId.code, 2);
    assert.match(noId.error.error.message, /expects 1 path argument/);

    const extraId = await invocation(engine, ["tasks", "show", "a", "b", "--json"]);
    assert.equal(extraId.code, 2);

    const unknownOption = await invocation(engine, ["schedules", "create", "--cron", "x", "--bogus", "y"]);
    assert.equal(unknownOption.code, 2);
    assert.match(unknownOption.stderr, /unknown option: --bogus/);

    assert.equal(engine.requests.length, before);
  });
});

test("work streams over a real HTTP socket", async () => {
  await withEngine({}, async (engine) => {
    const result = await invocation(engine, ["work", "implement the fix", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.text, "harness accepted and verified");
    assert.equal(result.json.events, 2);
    assert.equal(engine.requests.some((request) => request.path === "/api/work/chat"), true);
  });
});

test("projects fall back to the legacy notice only when the deployment has no route", async () => {
  await withEngine({}, async (engine) => {
    const listed = await invocation(engine, ["projects", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.json.command, "projects list");
    assert.equal(listed.json.data.projects[0].name, "Coderax");
  });

  await withEngine({ only: ["/api/conversations", "/api/user"] }, async (engine) => {
    const fallback = await invocation(engine, ["projects", "--json"]);
    assert.equal(fallback.code, 6);
    assert.equal(fallback.json.unavailable, true);
    assert.equal(engine.requests.some((request) => request.path === "/api/projects"), false);
  });
});

test("shell completion is generated from the catalog", async () => {
  await withEngine({}, async (engine) => {
    const bash = await invocation(engine, ["completion", "bash", "--json"]);
    assert.equal(bash.code, 0, bash.stderr);
    assert.equal(bash.json.shell, "bash");
    assert.match(bash.json.script, /complete -F _coderax coderax/);
    assert.match(bash.json.script, /schedules\) opts="cancel create delete list pause resume show update"/);

    const zsh = await invocation(engine, ["completion", "zsh"]);
    assert.match(zsh.stdout, /#compdef coderax/);
    assert.match(zsh.stdout, /schedules/);

    const fish = await invocation(engine, ["completion"], { env: { SHELL: "/usr/bin/fish" } });
    assert.equal(fish.code, 0, fish.stderr);
    assert.match(fish.stdout, /complete -c coderax/);
    assert.match(fish.stdout, /-n '__fish_seen_subcommand_from schedules'/);

    const invalid = await invocation(engine, ["completion", "powershell"]);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /unsupported shell/);
  });
});
