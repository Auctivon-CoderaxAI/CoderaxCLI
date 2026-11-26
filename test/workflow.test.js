import test from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERY_ACTIONS,
  DELIVERY_POLICY,
  WORKFLOW_KINDS,
  assertUnprotectedBranch,
  buildWorkflowObjective,
  getWorkflowKind,
  isProtectedBranch,
  requiredDeliveryOperations,
  validateBranchName,
  validateDelivery,
  validateRepository,
  validateTaskId,
  workflowKindNames,
} from "../src/workflow/catalog.js";
import { assertWorkflowEnvironment, verifyEnvironment } from "../src/workflow/environment.js";
import { UsageError } from "../src/errors.js";

const REPO = "acme/widgets";

function agent(overrides = {}) {
  return {
    id: "coderax",
    engine: "native",
    label: "Coderax Native",
    external: false,
    capabilities: {
      streaming: true,
      tools: true,
      cancellation: true,
      resume: true,
      modelSelection: true,
      durable: true,
    },
    availability: { available: true, reason: "ready", detail: "fixture" },
    isolation: { workspace: "isolated", memory: "none", credentials: "none", conversations: "none" },
    ...overrides,
  };
}

function fakeClient({ agents = [agent()], ready = true, missing = [] } = {}) {
  return {
    baseUrl: "https://engine.example",
    async negotiate() {
      return {
        status: "ok",
        contractVersion: "1.0.0",
        startedAt: new Date().toISOString(),
        uptimeMs: 1,
        checks: [],
        engines: [],
      };
    },
    async readiness() {
      return { ready, missing, checks: [] };
    },
    async agents() {
      return { agents };
    },
  };
}

test("every engineering kind is declarative and maps to submitWork", () => {
  assert.equal(workflowKindNames().length, 10);
  for (const name of workflowKindNames()) {
    const kind = getWorkflowKind(name);
    assert.ok(kind, name);
    assert.equal(typeof kind.objective, "function");
    assert.equal(kind.requiresTools, true, `${name} must require engine tools`);
    const objective = buildWorkflowObjective(name, "the requested change", { repo: REPO });
    assert.match(objective, /isolated cloud workspace/);
    assert.match(objective, /Do not push, force-push, merge/);
    assert.match(objective, new RegExp(REPO.replace("/", "\\/")));
    assert.match(objective, /the requested change/);
    assert.doesNotMatch(objective, /localhost|127\.0\.0\.1|run locally/i);
  }
});

test("an unknown kind is a usage error, not a silent fallback", () => {
  assert.equal(getWorkflowKind("deploy-everything"), null);
  assert.throws(() => buildWorkflowObjective("deploy-everything", "x"), UsageError);
});

test("protected branches are recognised exactly and by prefix", () => {
  for (const name of ["main", "master", "trunk", "develop", "staging", "production", "prod", "gh-pages", "release/1.2", "hotfix/urgent"]) {
    assert.equal(isProtectedBranch(name), true, name);
  }
  for (const name of ["feature/parser", "fix-123", "release-notes", "mainline"]) {
    assert.equal(isProtectedBranch(name), false, name);
  }
});

test("branch names are validated before they can reach a request", () => {
  assert.equal(validateBranchName("feature/parser-fix"), "feature/parser-fix");
  for (const name of ["", "../main", "feature//x", "/feature", "feature/", "feature/x.lock", "feature x", "feature~x", "feature@{x}", "a".repeat(256)]) {
    assert.throws(() => validateBranchName(name), UsageError, name);
  }
  assert.throws(() => assertUnprotectedBranch("main"), UsageError);
});

test("repository references are plain owner/name and reject traversal", () => {
  assert.equal(validateRepository(REPO), REPO);
  for (const value of ["", "acme", "acme/widgets/extra", "../widgets", "acme/../widgets", "acme/wid gets", "-acme/widgets"]) {
    assert.throws(() => validateRepository(value), UsageError, value);
  }
});

test("task ids cannot traverse a path", () => {
  assert.equal(validateTaskId("task_01HZX:abc-1"), "task_01HZX:abc-1");
  for (const value of ["", "../../etc/passwd", "task/1", "task id", "-task"]) {
    assert.throws(() => validateTaskId(value), UsageError, value);
  }
});

test("delivery operations are named but never given an invented route", () => {
  const operations = requiredDeliveryOperations();
  assert.deepEqual(operations.sort(), [
    "createBranch",
    "createPullRequest",
    "getCiStatus",
    "getTaskDiff",
    "prepareCommit",
    "remediateReviewFindings",
  ]);
  for (const spec of Object.values(DELIVERY_ACTIONS)) {
    assert.equal(Object.hasOwn(spec, "path"), false);
    assert.equal(Object.hasOwn(spec, "method"), false);
  }
  assert.equal(DELIVERY_POLICY.directPush, false);
  assert.equal(DELIVERY_POLICY.forcePush, false);
  assert.equal(DELIVERY_POLICY.merge, false);
  assert.equal(DELIVERY_POLICY.reviewRequired, true);
});

test("a pull request never targets a protected head and never merges", () => {
  assert.throws(() => validateDelivery("pr", { head: "main" }), UsageError);
  assert.throws(() => validateDelivery("pr", { head: "release/2.0" }), UsageError);
  assert.throws(() => validateDelivery("pr", { head: "feature/x", base: "feature/x" }), UsageError);
  const request = validateDelivery("pr", { head: "feature/x", base: "main", confirmed: true });
  assert.equal(request.head, "feature/x");
  assert.equal(request.base, "main");
  assert.equal(request.draft, true);
  assert.equal(request.merge, false);
  assert.equal(request.directPush, false);
  assert.equal(request.forcePush, false);
  assert.equal(request.confirmed, true);
  assert.equal(validateDelivery("pr", { head: "feature/x", draft: false }).draft, false);
});

test("a branch delivery cannot create a protected branch", () => {
  assert.throws(() => validateDelivery("branch", { branch: "main" }), UsageError);
  assert.throws(() => validateDelivery("branch", { branch: "hotfix/x" }), UsageError);
  assert.equal(validateDelivery("branch", { branch: "feature/x" }).branch, "feature/x");
});

test("delivery mutations carry local intent but no authorization claim", () => {
  const request = validateDelivery("commit", {
    branch: "feature/x",
    confirmed: true,
    allowProduction: true,
    allowDestructive: true,
  });
  assert.equal(request.allowProductionRequested, true);
  assert.equal(request.allowDestructiveRequested, true);
  assert.equal(request.policy.authorization, "enforced by the engine from the authenticated owner identity; CLI flags express intent only");
});

test("the environment verifier reports what is actually proven", async () => {
  const environment = await verifyEnvironment(fakeClient(), { agent: "coderax" });
  assert.equal(environment.ready, true);
  assert.equal(environment.trust, "unverified");
  assert.equal(environment.deploymentIdentity.supported, false);
  assert.equal(environment.repositoryIdentity.supported, false);
  assert.equal(environment.authorization.owner, true);
  assert.match(environment.authorization.proof, /GET \/v1\/agents/);
  assert.equal(environment.agent.published, true);
  assert.equal(environment.agent.capabilities.tools, true);
});

test("a server-supplied verified flag is not consulted and does not grant trust", async () => {
  const client = fakeClient();
  client.negotiate = async () => ({
    status: "ok",
    contractVersion: "1.0.0",
    startedAt: new Date().toISOString(),
    uptimeMs: 1,
    checks: [],
    engines: [],
    verified: true,
    authorized: true,
  });
  const environment = await verifyEnvironment(client);
  assert.equal(environment.trust, "unverified");
  assert.equal(environment.deploymentIdentity.supported, false);
  assert.equal(Object.hasOwn(environment, "verified"), false);
});

test("work is refused when readiness or the agent capability is absent", async () => {
  const notReady = await verifyEnvironment(fakeClient({ ready: false, missing: ["workspace"] }));
  assert.throws(() => assertWorkflowEnvironment(notReady, { kind: WORKFLOW_KINDS.inspect }), /not ready/);

  const noTools = await verifyEnvironment(fakeClient({
    agents: [agent({ capabilities: { ...agent().capabilities, tools: false } })],
  }));
  assert.throws(() => assertWorkflowEnvironment(noTools, { kind: WORKFLOW_KINDS.fix }), /tools/);

  const noDurable = await verifyEnvironment(fakeClient({
    agents: [agent({ capabilities: { ...agent().capabilities, durable: false } })],
  }));
  assert.throws(() => assertWorkflowEnvironment(noDurable, { kind: WORKFLOW_KINDS.inspect, detach: true }), /durable/);

  const noModel = await verifyEnvironment(fakeClient({
    agents: [agent({ capabilities: { ...agent().capabilities, modelSelection: false } })],
  }));
  assert.throws(() => assertWorkflowEnvironment(noModel, { kind: WORKFLOW_KINDS.inspect, model: true }), /model selection/);
});

test("an unpublished or unavailable agent is refused, never substituted", async () => {
  const missing = await verifyEnvironment(fakeClient({ agents: [] }));
  assert.equal(missing.ready, false);
  assert.throws(() => assertWorkflowEnvironment(missing, { kind: WORKFLOW_KINDS.inspect }), /not published/);

  const unavailable = await verifyEnvironment(fakeClient({
    agents: [agent({ availability: { available: false, reason: "not_configured", detail: "no token" } })],
  }));
  assert.equal(unavailable.ready, false);
  assert.throws(() => assertWorkflowEnvironment(unavailable, { kind: WORKFLOW_KINDS.inspect }), /not_configured/);
});
