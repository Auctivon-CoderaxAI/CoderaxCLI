import { UsageError } from "../errors.js";

/**
 * The engineering control plane is a catalogue of objectives and required
 * backend operations. It contains no planner, scheduler, task state machine or
 * permission policy: the WorkflowEngine owns all of that. Every entry either
 * maps to the published `submitWork` operation or names an operation the
 * contract does not publish, in which case the CLI refuses it.
 */

const CLOUD_RULES = [
  "Work only in the isolated cloud workspace the engine assigned to this task.",
  "Do not run anything on the owner's computer, and do not ask for local access.",
  "Do not push, force-push, merge, open a pull request or deploy.",
  "Report the exact commands you ran and their real results; never claim a check you did not run.",
].join(" ");

function repositoryLine(context) {
  if (!context?.repo) {
    return "Use the repository already mounted in your cloud workspace; the CLI did not name one.";
  }
  return [
    `Repository context: ${context.repo}.`,
    "Contract 1.0.0 publishes no repository lookup, so the CLI cannot verify an immutable repository id.",
    "Confirm the mounted repository matches this context before reading or changing anything; if it does not, stop and report the mismatch.",
  ].join(" ");
}

function objective(body, context) {
  return `${body} ${repositoryLine(context)} ${CLOUD_RULES}`;
}

export const WORKFLOW_KINDS = Object.freeze({
  inspect: Object.freeze({
    label: "Repository inspection",
    summary: "Read the cloud workspace and report structure, build/test entry points, CI and risks.",
    requiresTools: true,
    readOnly: true,
    objective: (input, context) => objective(
      [
        "Inspect the repository in your cloud workspace. Do not modify files.",
        "Report the top-level structure, languages and package managers, the build and test commands,",
        "the CI configuration, and the three highest-risk areas you found, citing paths you actually read.",
        input ? `Owner focus: ${input}` : "",
      ].filter(Boolean).join(" "),
      context,
    ),
  }),
  architecture: Object.freeze({
    label: "Architecture analysis",
    summary: "Explain module boundaries, data flow, integration points and architectural risks.",
    requiresTools: true,
    readOnly: true,
    objective: (input, context) => objective(
      [
        "Analyse the architecture of the repository in your cloud workspace. Do not modify files.",
        "Describe the major modules and their boundaries, the request and data flows, the persistence and",
        "integration points, and the decisions that would be expensive to reverse. Cite paths you read.",
        input ? `Scope: ${input}` : "",
      ].filter(Boolean).join(" "),
      context,
    ),
  }),
  generate: Object.freeze({
    label: "Software generation",
    summary: "Implement a scoped feature and run the focused verification.",
    requiresTools: true,
    readOnly: false,
    objective: (input, context) => objective(
      [
        "Implement the requested feature in the repository in your cloud workspace.",
        "Follow the existing conventions, keep the change scoped, and add or update tests where the change",
        "creates new behaviour. Run the focused tests or typecheck and report their real results.",
        input ? `Request: ${input}` : "Request: ask the owner for the feature before changing anything.",
      ].join(" "),
      context,
    ),
  }),
  fix: Object.freeze({
    label: "Bug fixing",
    summary: "Reproduce the defect, fix the root cause and verify with a regression test.",
    requiresTools: true,
    readOnly: false,
    objective: (input, context) => objective(
      [
        "Fix the reported defect in the repository in your cloud workspace.",
        "First reproduce it with the project's own command or a focused test. Identify the root cause,",
        "make the smallest correct change, add a regression test, and run the focused suite.",
        "If you cannot reproduce it, report the evidence instead of guessing.",
        input ? `Defect: ${input}` : "Defect: ask the owner for the failing behaviour before changing anything.",
      ].join(" "),
      context,
    ),
  }),
  refactor: Object.freeze({
    label: "Refactoring",
    summary: "Improve structure without changing behaviour, verified by the existing tests.",
    requiresTools: true,
    readOnly: false,
    objective: (input, context) => objective(
      [
        "Refactor the requested area in your cloud workspace without changing observable behaviour.",
        "Record the relevant test results before and after, keep public interfaces stable unless the owner",
        "asked for a breaking change, and explain why the new structure is safer or simpler.",
        input ? `Scope: ${input}` : "Scope: ask the owner which area to refactor.",
      ].join(" "),
      context,
    ),
  }),
  debug: Object.freeze({
    label: "Debugging",
    summary: "Diagnose a failure from evidence and apply a minimal verified fix.",
    requiresTools: true,
    readOnly: false,
    objective: (input, context) => objective(
      [
        "Debug the reported failure in your cloud workspace.",
        "Collect evidence (logs, failing tests, stack traces), state the hypotheses you tested, identify the",
        "root cause, and apply the smallest verified fix. Do not hide a failure by weakening a test.",
        input ? `Failure: ${input}` : "Failure: ask the owner for the symptom and any reproduction.",
      ].join(" "),
      context,
    ),
  }),
  tests: Object.freeze({
    label: "Test generation",
    summary: "Add focused tests for the requested behaviour and run them.",
    requiresTools: true,
    readOnly: false,
    objective: (input, context) => objective(
      [
        "Add focused automated tests for the requested behaviour in your cloud workspace.",
        "Match the project's test framework and conventions. Cover the success path and the failure or",
        "boundary cases that matter. Run the new tests and report the exact command and result.",
        input ? `Target: ${input}` : "Target: ask the owner what behaviour to cover.",
      ].join(" "),
      context,
    ),
  }),
  "test-run": Object.freeze({
    label: "Test execution",
    summary: "Run the repository's tests and report exact results without editing code.",
    requiresTools: true,
    readOnly: true,
    objective: (input, context) => objective(
      [
        "Run the repository's test suite in your cloud workspace using the project's own command.",
        "Do not modify source or test files. Report the exact command, passing and failing counts, the first",
        "useful failure output, and whether each failure is caused by the code, the environment or a missing service.",
        input ? `Scope: ${input}` : "",
      ].filter(Boolean).join(" "),
      context,
    ),
  }),
  review: Object.freeze({
    label: "Code review",
    summary: "Review the current change and report actionable findings by severity.",
    requiresTools: true,
    readOnly: true,
    objective: (input, context) => objective(
      [
        "Review the current change in your cloud workspace. Do not edit files.",
        "Report findings by severity with file and line references: correctness, security, data loss,",
        "compatibility, performance and test gaps. Distinguish a real defect from a style preference,",
        "and say explicitly when you found nothing in a category.",
        input ? `Review scope: ${input}` : "",
      ].filter(Boolean).join(" "),
      context,
    ),
  }),
  audit: Object.freeze({
    label: "Security audit",
    summary: "Audit the repository for security and dependency risks without exploiting anything.",
    requiresTools: true,
    readOnly: true,
    objective: (input, context) => objective(
      [
        "Perform a defensive security audit of the repository in your cloud workspace. Do not exploit,",
        "exfiltrate or modify anything. Look for committed secrets, injection and path traversal,",
        "authentication and authorization gaps, unsafe deserialization, dependency advisories and",
        "dangerous default configuration. Report each finding with severity, path, impact and a concrete fix.",
        input ? `Scope: ${input}` : "",
      ].filter(Boolean).join(" "),
      context,
    ),
  }),
});

export function getWorkflowKind(name) {
  return WORKFLOW_KINDS[String(name ?? "").toLowerCase()] ?? null;
}

export function workflowKindNames() {
  return Object.keys(WORKFLOW_KINDS);
}

export function buildWorkflowObjective(name, input, context = {}) {
  const kind = getWorkflowKind(name);
  if (!kind) throw new UsageError(`unknown workflow kind: ${name}. Choose one of ${workflowKindNames().join(", ")}`);
  return kind.objective(String(input ?? "").trim(), context);
}

/**
 * Operations the engineering control plane needs but contract 1.0.0 does not
 * publish. They are named, never given an invented path or payload. A command
 * whose operation is absent reports `unavailable` and sends no request.
 */
export const DELIVERY_ACTIONS = Object.freeze({
  diff: Object.freeze({
    operation: "getTaskDiff",
    mutation: false,
    requiresConfirmation: false,
    summary: "Read the reviewed task's diff from the engine.",
  }),
  branch: Object.freeze({
    operation: "createBranch",
    mutation: true,
    requiresConfirmation: true,
    summary: "Create a branch for the reviewed change.",
  }),
  commit: Object.freeze({
    operation: "prepareCommit",
    mutation: true,
    requiresConfirmation: true,
    summary: "Prepare a commit for the reviewed change.",
  }),
  pr: Object.freeze({
    operation: "createPullRequest",
    mutation: true,
    requiresConfirmation: true,
    summary: "Open a pull request from the reviewed branch.",
  }),
  ci: Object.freeze({
    operation: "getCiStatus",
    mutation: false,
    requiresConfirmation: false,
    summary: "Read continuous-integration status for the reviewed change.",
  }),
  remediate: Object.freeze({
    operation: "remediateReviewFindings",
    mutation: true,
    requiresConfirmation: true,
    summary: "Apply review remediation and report the result.",
  }),
});

export const REPOSITORY_OPERATION = "listRepositories";
export const PAUSE_OPERATION = "pauseTask";

export const DELIVERY_POLICY = Object.freeze({
  delivery: "pull-request-only",
  directPush: false,
  forcePush: false,
  merge: false,
  reviewRequired: true,
  authorization: "enforced by the engine from the authenticated owner identity; CLI flags express intent only",
});

export function requiredDeliveryOperations() {
  return Object.values(DELIVERY_ACTIONS).map((entry) => entry.operation);
}

const PROTECTED_EXACT = new Set([
  "main",
  "master",
  "trunk",
  "develop",
  "development",
  "staging",
  "production",
  "prod",
  "gh-pages",
]);

const PROTECTED_PREFIXES = ["release/", "hotfix/"];

export function isProtectedBranch(name) {
  const branch = String(name ?? "");
  return PROTECTED_EXACT.has(branch) || PROTECTED_PREFIXES.some((prefix) => branch.startsWith(prefix));
}

/**
 * A conservative subset of `git check-ref-format`, applied before a branch name
 * could reach a request or a command. This is input validation, not the
 * authorization decision; the engine remains authoritative.
 */
export function validateBranchName(raw, { field = "branch" } = {}) {
  const name = String(raw ?? "");
  if (name.length === 0 || name.length > 255) {
    throw new UsageError(`--${field} must contain 1-255 characters`);
  }
  if (
    /[\s~^:?*[\\\u0000-\u001f\u007f]/.test(name)
    || name.includes("..")
    || name.includes("@{")
    || name.includes("//")
    || name.startsWith("/")
    || name.endsWith("/")
    || name.endsWith(".")
    || name.endsWith(".lock")
    || name === "@"
  ) {
    throw new UsageError(`--${field} is not a valid git branch name`);
  }
  return name;
}

export function assertUnprotectedBranch(name, { field = "branch" } = {}) {
  if (isProtectedBranch(name)) {
    throw new UsageError(
      `--${field} ${name} is a protected branch; the CLI never writes to a protected branch`,
      { hint: "Use a feature branch and deliver through a reviewed pull request." },
    );
  }
  return name;
}

export function validateRepository(raw) {
  const repo = String(raw ?? "").trim();
  if (repo.length === 0 || repo.length > 200) {
    throw new UsageError("--repo must be owner/name");
  }
  if (repo.includes("..") || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})$/.test(repo)) {
    throw new UsageError("--repo must be a plain owner/name repository reference");
  }
  return repo;
}

export function validateTaskId(raw) {
  const taskId = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskId)) {
    throw new UsageError("a task id is required and must be 1-128 characters of letters, digits, '.', '_', ':' or '-'");
  }
  return taskId;
}

export function validateDelivery(action, input = {}) {
  const spec = DELIVERY_ACTIONS[action];
  if (!spec) throw new UsageError(`unknown delivery action: ${action}`);

  const request = {
    action,
    operation: spec.operation,
    mutation: spec.mutation,
    requiresConfirmation: spec.requiresConfirmation,
    confirmed: Boolean(input.confirmed),
    policy: DELIVERY_POLICY,
  };

  if (input.repo !== undefined && input.repo !== null && input.repo !== "") {
    request.repository = validateRepository(input.repo);
    request.repositoryVerification = "unverified";
  }
  if (input.allowProduction) request.allowProductionRequested = true;
  if (input.allowDestructive) request.allowDestructiveRequested = true;

  if (action === "branch") {
    const name = input.branch ?? input.head;
    if (!name) throw new UsageError("workflow branch requires a branch name");
    request.branch = assertUnprotectedBranch(validateBranchName(name), { field: "branch" });
  }

  if (action === "commit") {
    if (input.branch) {
      request.branch = assertUnprotectedBranch(validateBranchName(input.branch), { field: "branch" });
    }
    if (input.head) {
      request.head = assertUnprotectedBranch(validateBranchName(input.head, { field: "head" }), { field: "head" });
    }
  }

  if (action === "pr") {
    if (input.head) {
      request.head = assertUnprotectedBranch(validateBranchName(input.head, { field: "head" }), { field: "head" });
    }
    if (input.base) {
      request.base = validateBranchName(input.base, { field: "base" });
    }
    if (request.head && request.base && request.head === request.base) {
      throw new UsageError("--head and --base must name different branches");
    }
    request.draft = input.draft !== false;
    request.merge = false;
    request.forcePush = false;
    request.directPush = false;
  }

  if (action === "diff" || action === "ci" || action === "remediate") {
    request.taskId = validateTaskId(input.taskId);
  }

  return request;
}
