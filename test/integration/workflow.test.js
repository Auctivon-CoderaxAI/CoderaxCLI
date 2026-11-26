import test from "node:test";
import assert from "node:assert/strict";
import { startFixtureEngine } from "../fixtures/engine-server.js";
import { runCli } from "../../src/cli.js";
import { capture, optionsFor, tempDir } from "../helpers.js";

async function withEngine(options, run) {
  const engine = await startFixtureEngine(options);
  const dir = await tempDir("coderax-workflow-");
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

function posts(engine) {
  return engine.requests.filter((request) => request.method === "POST");
}

test("environments verifies health, contract, readiness and the owner session without claiming trust", async () => {
  await withEngine({}, async ({ engine, env }) => {
    const result = await cli(env, ["workflow", "environments", "--json"]);
    assert.equal(result.code, 0, result.io.err());
    const data = result.json().data;
    assert.equal(data.ready, true);
    assert.equal(data.trust, "unverified");
    assert.equal(data.deploymentIdentity.supported, false);
    assert.equal(data.repositoryIdentity.supported, false);
    assert.equal(data.authorization.owner, true);
    assert.equal(data.agent.published, true);
    assert.ok(engine.requests.some((request) => request.path === "/v1/agents"));
    assert.equal(posts(engine).length, 0);
  });
});

test("a server that asserts verified and authorized is rejected as contract drift", async () => {
  await withEngine({ healthExtra: { verified: true, authorized: true } }, async ({ engine, env }) => {
    const result = await cli(env, ["workflow", "environments", "--json"]);
    assert.equal(result.code, 7, result.io.out());
    assert.equal(result.json().error.code, "CONTRACT_MISMATCH");
    assert.equal(posts(engine).length, 0);
  });
});

test("a contract mismatch is refused before any owner request", async () => {
  await withEngine({ contractVersion: "2.0.0" }, async ({ engine, env }) => {
    const result = await cli(env, ["workflow", "environments", "--json"]);
    assert.equal(result.code, 7);
    assert.equal(result.json().error.code, "CONTRACT_UNSUPPORTED");
    assert.equal(engine.requests.filter((request) => request.path === "/v1/agents").length, 0);
    assert.equal(posts(engine).length, 0);
  });
});

test("not-ready is unavailable and no work is submitted", async () => {
  await withEngine({ readiness: { ready: false, missing: ["workspace"], checks: [] } }, async ({ engine, env }) => {
    const environment = await cli(env, ["workflow", "environments", "--json"]);
    assert.equal(environment.code, 6);
    assert.equal(environment.json().data.ready, false);

    const run = await cli(env, ["workflow", "run", "inspect", "report risks", "--json"]);
    assert.equal(run.code, 6);
    assert.equal(run.json().error.code, "UNAVAILABLE");
    assert.equal(posts(engine).length, 0);
  });
});

test("engineering kinds map to submitWork and report delivery gaps honestly", async () => {
  await withEngine({}, async ({ engine, env }) => {
    const result = await cli(env, ["workflow", "kinds", "--json"]);
    assert.equal(result.code, 0, result.io.err());
    const data = result.json().data;
    const inspect = data.kinds.find((entry) => entry.name === "inspect");
    assert.equal(inspect.operation, "submitWork");
    assert.equal(inspect.available, true);
    const pr = data.delivery.find((entry) => entry.name === "pr");
    assert.equal(pr.available, false);
    assert.equal(pr.operation, "createPullRequest");
    assert.match(pr.reason, /contract 1\.0\.0/);
    assert.equal(posts(engine).length, 0);
  });
});

test("workflow run submits a cloud objective and streams the durable task", async () => {
  await withEngine({}, async ({ engine, env }) => {
    const result = await cli(env, [
      "workflow", "run", "inspect", "report the riskiest modules",
      "--repo", "acme/widgets", "--json",
    ]);
    assert.equal(result.code, 0, result.io.err());
    const data = result.json().data;
    assert.equal(data.state, "completed");
    assert.equal(data.workflow.kind, "inspect");
    assert.equal(data.workflow.repository, "acme/widgets");
    assert.equal(data.workflow.repositoryVerification, "unverified");

    const submits = posts(engine).filter((request) => request.path === "/v1/work");
    assert.equal(submits.length, 1);
    assert.equal(submits[0].headers["idempotency-key"].length > 10, true);

    const body = engine.conversations.get(data.conversationId).messages[0].text;
    assert.match(body, /Inspect the repository/);
    assert.match(body, /acme\/widgets/);
    assert.match(body, /isolated cloud workspace/);
  });
});

test("workflow execution is cloud-only", async () => {
  await withEngine({}, async ({ engine, env }) => {
    const result = await cli(env, ["workflow", "run", "fix", "a bug", "--mode", "private", "--json"]);
    assert.equal(result.code, 2);
    assert.equal(result.json().error.code, "USAGE");
    assert.equal(posts(engine).length, 0);
  });
});

test("an agent without tools refuses the task instead of running it locally", async () => {
  await withEngine({ tools: false }, async ({ engine, env }) => {
    const result = await cli(env, ["workflow", "run", "fix", "a bug", "--json"]);
    assert.equal(result.code, 7);
    assert.equal(result.json().error.code, "CAPABILITY_UNSUPPORTED");
    assert.equal(posts(engine).length, 0);
  });
});

test("an unauthenticated owner write is refused and creates no task", async () => {
  await withEngine({}, async ({ engine, env }) => {
    const wrong = { ...env, CODERAX_ENGINE_TOKEN: "not-the-owner-token" };
    const result = await cli(wrong, ["workflow", "run", "inspect", "report risks", "--json"]);
    assert.equal(result.code, 3, result.io.out());
    assert.equal(result.json().error.status, 401);
    assert.equal(result.json().error.code, "unauthorized");
    assert.equal(posts(engine).length, 0);
  });
});

test("a backend 403 on the only write path is surfaced, not retried or bypassed", async () => {
  await withEngine({ workSubmitStatus: 403 }, async ({ engine, env }) => {
    const result = await cli(env, [
      "workflow", "run", "generate", "add validation",
      "--confirm", "--allow-production", "--allow-destructive", "--json",
    ]);
    assert.equal(result.code, 3, result.io.out());
    assert.equal(result.json().error.status, 403);
    assert.equal(result.json().error.code, "forbidden");
    assert.equal(posts(engine).filter((request) => request.path === "/v1/work").length, 1);
  });
});

test("a local approve-all flag cannot override a backend permission denial", async () => {
  await withEngine({ requireApproval: true, permissionDecisionStatus: 403 }, async ({ engine, env }) => {
    const result = await cli(env, ["workflow", "run", "fix", "a bug", "--approve-all", "--json"]);
    assert.equal(result.code, 3, result.io.out());
    assert.equal(result.json().error.status, 403);
    assert.equal(result.json().error.code, "forbidden");
    assert.equal(posts(engine).filter((request) => request.path === "/v1/work").length, 1);
    assert.equal(posts(engine).filter((request) => request.path.endsWith("/permissions")).length, 1);
  });
});

test("delivery operations are unavailable, send nothing and cannot be unlocked by local flags", async () => {
  await withEngine({}, async ({ engine, env }) => {
    const cases = [
      [["workflow", "pr", "--head", "feature/x", "--base", "main", "--confirm", "--allow-production", "--allow-destructive", "--json"], "createPullRequest", "pr"],
      [["workflow", "branch", "feature/x", "--confirm", "--json"], "createBranch", "branch"],
      [["workflow", "commit", "--head", "feature/x", "--confirm", "--json"], "prepareCommit", "commit"],
      [["workflow", "diff", "task_1", "--json"], "getTaskDiff", "diff"],
      [["workflow", "ci", "task_1", "--json"], "getCiStatus", "ci"],
      [["workflow", "remediate", "task_1", "--confirm", "--json"], "remediateReviewFindings", "remediate"],
    ];
    for (const [argv, operation, action] of cases) {
      const result = await cli(env, argv);
      assert.equal(result.code, 6, `${action}: ${result.io.out()}`);
      const data = result.json().data;
      assert.equal(data.available, false, action);
      assert.equal(data.sent, false, action);
      assert.equal(data.operation, operation, action);
      if (action === "pr") {
        assert.equal(data.request.merge, false);
        assert.equal(data.request.directPush, false);
        assert.equal(data.request.forcePush, false);
        assert.equal(data.request.draft, true);
        assert.equal(data.request.allowProductionRequested, true);
        assert.equal(data.request.allowDestructiveRequested, true);
      }
    }
    assert.equal(posts(engine).length, 0);
  });
});

test("protected branch delivery is a usage error before any request", async () => {
  await withEngine({}, async ({ engine, env }) => {
    for (const argv of [
      ["workflow", "branch", "main", "--confirm", "--json"],
      ["workflow", "branch", "release/2.0", "--confirm", "--json"],
      ["workflow", "pr", "--head", "main", "--confirm", "--json"],
      ["workflow", "pr", "--head", "release/2.0", "--confirm", "--json"],
    ]) {
      const result = await cli(env, argv);
      assert.equal(result.code, 2, `${argv.join(" ")}: ${result.io.out()}`);
      assert.equal(result.json().error.code, "USAGE");
    }
    assert.equal(engine.requests.length, 0);
  });
});

test("direct push, force push and merge switches do not exist", async () => {
  await withEngine({}, async ({ engine, env }) => {
    for (const flag of ["--force", "--merge", "--push"]) {
      const result = await cli(env, ["workflow", "pr", flag, "--json"]);
      assert.equal(result.code, 2, flag);
      assert.equal(result.json().error.code, "USAGE");
    }
    assert.equal(engine.requests.length, 0);
  });
});

test("repository discovery and pause are unavailable instead of simulated", async () => {
  await withEngine({}, async ({ engine, env }) => {
    const repos = await cli(env, ["workflow", "repos", "--json"]);
    assert.equal(repos.code, 6);
    assert.equal(repos.json().data.operation, "listRepositories");
    assert.equal(repos.json().data.sent, false);

    const pause = await cli(env, ["workflow", "pause", "task_1", "--json"]);
    assert.equal(pause.code, 6);
    assert.equal(pause.json().data.operation, "pauseTask");
    assert.equal(pause.json().data.sent, false);

    assert.equal(engine.requests.length, 0);
  });
});

test("status, cancel and takeover remain owner controls over the same durable task", async () => {
  await withEngine({}, async ({ engine, env }) => {
    const submitted = await cli(env, ["workflow", "run", "inspect", "report risks", "--detach", "--json"]);
    assert.equal(submitted.code, 0, submitted.io.err());
    const taskId = submitted.json().data.task.taskId;

    const status = await cli(env, ["workflow", "status", taskId, "--json"]);
    assert.equal([0, 1].includes(status.code), true, status.io.out());
    assert.equal(status.json().data.status.taskId, taskId);

    const cancel = await cli(env, ["workflow", "cancel", taskId, "--json"]);
    assert.equal([0, 130].includes(cancel.code), true, cancel.io.out());
    assert.ok(engine.requests.some((request) => request.path === `/v1/work/${taskId}/cancel`));
  });
});
