import { CoderaxError, EXIT, UsageError } from "../errors.js";
import {
  DELIVERY_ACTIONS,
  DELIVERY_POLICY,
  PAUSE_OPERATION,
  REPOSITORY_OPERATION,
  WORKFLOW_KINDS,
  buildWorkflowObjective,
  getWorkflowKind,
  requiredDeliveryOperations,
  validateDelivery,
  validateRepository,
  workflowKindNames,
} from "../workflow/catalog.js";
import { assertWorkflowEnvironment, verifyEnvironment } from "../workflow/environment.js";
import { renderTable } from "../ui/tables.js";
import { submitCommand, taskAgent, workCommand } from "./work.js";

export const WORKFLOW_ACTIONS = Object.freeze([
  "environments",
  "kinds",
  "repos",
  "run",
  "status",
  "watch",
  "attach",
  "takeover",
  "cancel",
  "resume",
  "retry",
  "pause",
  "diff",
  "branch",
  "commit",
  "pr",
  "ci",
  "remediate",
  "help",
]);

const WORKFLOW_USAGE = `Usage: coderax workflow <command>

  environments                 Verify the engine, contract and owner session
  kinds                        List engineering kinds and delivery availability
  repos                        Repository discovery (not published by contract 1.0.0)
  run <kind> "<request>"       Submit a durable cloud engineering task
  status|watch|attach <task>   Inspect or reattach to a task
  takeover <task>              Take owner control: attach and decide approvals
  cancel|resume|retry <task>   Control a durable task
  pause <task>                 Pause (not published by contract 1.0.0)
  diff|ci|remediate <task>     Delivery operations (not published by contract 1.0.0)
  branch <name>|commit|pr      Delivery operations (not published by contract 1.0.0)

Kinds: ${workflowKindNames().join(", ")}

Options:
  --repo <owner/name>          Repository context for the objective (identity is not verifiable in contract 1.0.0)
  --agent <id>                 coderax | opencode | freebuff
  --model <provider/model>     Model for this task
  --detach                     Return after the engine accepts the task
  --confirm                    Confirm a delivery mutation (server authorization is still required)
  --base <branch> --head <branch> [--no-draft]
  --allow-production           Local intent only; never overrides owner approval or server authorization
  --allow-destructive          Local intent only; never overrides owner approval or server authorization

Policy: pull-request-only; no direct push, force push, merge or protected-branch write.
Every engineering task runs in the engine's cloud workspace; nothing runs on this computer.`;

function engineLabel(runtime) {
  return runtime.engineUrl ?? "(no engine configured)";
}

function environmentHuman(runtime, environment) {
  runtime.write(
    `${environment.ready ? runtime.style.green("\u2713") : runtime.style.red("\u2717")} engine ${environment.health.status}`
      + `  contract ${environment.contract.server}`
      + `  ${environment.readiness.ready ? "ready" : "not ready"}`,
  );
  runtime.write(`  ${runtime.style.dim("url")}         ${engineLabel(runtime)}`);
  runtime.write(`  ${runtime.style.dim("owner")}       authenticated (${environment.authorization.proof})`);
  runtime.write(`  ${runtime.style.dim("agent")}       ${environment.agent.id}  ${environment.agent.published ? "published" : environment.agent.reason}`);
  const engineering = environment.engineering;
  runtime.write(
    `  ${runtime.style.dim("engineering")} ${engineering.available ? "available" : "unavailable"}`
      + (engineering.toolCapableAgents.length > 0
        ? `  tool-capable agents: ${engineering.toolCapableAgents.join(", ")}`
        : "  no available tool-capable agent"),
  );
  runtime.write(`  ${runtime.style.dim("identity")}    deployment id not published by contract 1.0.0`);
  runtime.write(`  ${runtime.style.dim("repository")}  repository id not published by contract 1.0.0`);
  runtime.write(`  ${runtime.style.dim("trust")}       ${environment.trust}; server flags are never treated as authorization`);
  if (!environment.readiness.ready && environment.readiness.missing.length > 0) {
    runtime.write(`  ${runtime.style.yellow("missing")}     ${environment.readiness.missing.join(", ")}`);
  }
}

async function environmentsCommand(runtime) {
  const client = await runtime.getEngine({ negotiate: false });
  const environment = await verifyEnvironment(client, { agent: taskAgent(runtime) });
  runtime.emit("workflow.environments", environment, () => environmentHuman(runtime, environment));
  return environment.ready ? EXIT.OK : EXIT.UNAVAILABLE;
}

function kindRows(environment) {
  const tools = environment?.agent?.capabilities?.tools === true;
  return workflowKindNames().map((name) => {
    const kind = WORKFLOW_KINDS[name];
    return {
      name,
      label: kind.label,
      operation: "submitWork",
      available: Boolean(environment?.ready && tools),
      readOnly: kind.readOnly,
      summary: kind.summary,
    };
  });
}

function deliveryRows() {
  return Object.entries(DELIVERY_ACTIONS).map(([name, spec]) => ({
    name,
    operation: spec.operation,
    available: false,
    mutation: spec.mutation,
    reason: `contract 1.0.0 does not publish ${spec.operation}`,
    summary: spec.summary,
  }));
}

async function kindsCommand(runtime) {
  const client = await runtime.getEngine({ negotiate: false });
  const environment = await verifyEnvironment(client, { agent: taskAgent(runtime) });
  const data = {
    environment,
    kinds: kindRows(environment),
    delivery: deliveryRows(),
    policy: DELIVERY_POLICY,
    requiredDeliveryOperations: requiredDeliveryOperations(),
  };
  runtime.emit("workflow.kinds", data, () => {
    runtime.write(runtime.style.bold("engineering kinds (cloud Work)"));
    runtime.write(renderTable({
      headers: ["KIND", "AVAILABLE", "ACCESS", "PURPOSE"],
      rows: data.kinds.map((entry) => [
        entry.name,
        entry.available ? "yes" : "no",
        entry.readOnly ? "read-only" : "writes",
        entry.summary,
      ]),
      style: runtime.style,
      width: runtime.width,
      maxColumnWidth: 46,
    }));
    runtime.write("");
    runtime.write(runtime.style.bold("delivery operations (required from the engine)"));
    runtime.write(renderTable({
      headers: ["ACTION", "OPERATION", "AVAILABLE", "MUTATION"],
      rows: data.delivery.map((entry) => [entry.name, entry.operation, "no", entry.mutation ? "yes" : "no"]),
      style: runtime.style,
      width: runtime.width,
      maxColumnWidth: 34,
    }));
    runtime.write("");
    runtime.write(runtime.style.dim("Delivery is refused, not simulated, until the engine publishes these operations."));
  });
  return EXIT.OK;
}

function unavailable(runtime, command, { operation, detail, request = null }) {
  const data = {
    available: false,
    operation,
    sent: false,
    detail,
    policy: DELIVERY_POLICY,
    ...(request ? { request } : {}),
  };
  runtime.emit(command, data, () => {
    runtime.write(`${runtime.style.red("\u2717")} unavailable: ${operation}`);
    runtime.write(`  ${detail}`);
    runtime.write(`  ${runtime.style.dim("no request was sent; the CLI does not simulate this operation")}`);
    if (request?.requiresConfirmation) {
      runtime.write(`  ${runtime.style.dim(`confirmation ${request.confirmed ? "supplied" : "not supplied"}; server authorization is still required`)}`);
    }
    runtime.write(`  ${runtime.style.dim("policy: pull-request-only; no direct push, force push, merge or protected-branch write")}`);
  });
  return EXIT.UNAVAILABLE;
}

function repositoryCommand(runtime) {
  return unavailable(runtime, "workflow.repos", {
    operation: REPOSITORY_OPERATION,
    detail: "contract 1.0.0 publishes no repository listing operation, so the CLI cannot discover or verify repositories",
  });
}

function pauseCommand(runtime, positionals) {
  if (positionals[0]) {
    try {
      // Validate the id before reporting, so a malformed id is a usage error.
      validateDelivery("diff", { taskId: positionals[0] });
    } catch (error) {
      throw error;
    }
  }
  return unavailable(runtime, "workflow.pause", {
    operation: PAUSE_OPERATION,
    detail: "contract 1.0.0 publishes no pause operation; cancel or resume are the supported controls",
  });
}

async function runCommand(runtime, positionals) {
  const kindName = positionals[0];
  const kind = getWorkflowKind(kindName);
  if (!kind) {
    throw new UsageError(`workflow run requires a kind: ${workflowKindNames().join(", ")}`);
  }

  let request = positionals.slice(1).join(" ").trim();
  if (!request) request = String(runtime.flags.get("objective") ?? "").trim();
  if (!request && !runtime.isTTY) request = (await runtime.readStdin()).trim();
  if (!request) throw new UsageError(`workflow run ${kindName} requires a request`);

  const mode = runtime.flags.get("mode") ?? "cloud";
  if (mode !== "cloud") {
    throw new UsageError("workflow execution is cloud-only; --mode private is not supported");
  }

  const repo = runtime.flags.has("repo") ? validateRepository(runtime.flags.get("repo")) : null;
  const client = await runtime.getEngine({ negotiate: false });
  const environment = await verifyEnvironment(client, { agent: taskAgent(runtime) });
  assertWorkflowEnvironment(environment, {
    kind,
    model: runtime.flags.has("model") || Boolean(runtime.config.model),
    detach: runtime.flags.has("detach"),
  });

  const objective = buildWorkflowObjective(kindName, request, { repo });
  return submitCommand(runtime, [], {
    command: "workflow.run",
    objectiveOverride: objective,
    template: { requiresTools: kind.requiresTools, label: kind.label, summary: kind.summary },
    client,
    context: {
      kind: kindName,
      label: kind.label,
      repository: repo,
      repositoryVerification: repo ? "unverified" : "not_specified",
      delivery: DELIVERY_POLICY,
    },
  });
}

function deliveryCommand(runtime, action, positionals) {
  const spec = DELIVERY_ACTIONS[action];
  if (!spec) throw new UsageError(`unknown delivery action: ${action}`);
  const positional = positionals[0];
  const input = {
    confirmed: runtime.flags.has("confirm"),
    repo: runtime.flags.get("repo"),
    base: runtime.flags.get("base"),
    head: runtime.flags.get("head"),
    branch: runtime.flags.get("branch"),
    taskId: runtime.flags.get("task"),
    draft: !runtime.flags.has("no-draft"),
    allowProduction: runtime.flags.has("allow-production"),
    allowDestructive: runtime.flags.has("allow-destructive"),
  };
  if (action === "branch") input.branch = positional ?? input.branch;
  if (action === "diff" || action === "ci" || action === "remediate") input.taskId = positional ?? input.taskId;

  const request = validateDelivery(action, input);
  return unavailable(runtime, `workflow.${action}`, {
    operation: spec.operation,
    detail: `contract 1.0.0 does not publish ${spec.operation}; the CLI will not invent a route or simulate the result`,
    request,
  });
}

function workflowHelp(runtime) {
  runtime.raw(`${WORKFLOW_USAGE}\n`);
  return EXIT.OK;
}

export async function workflowCommand(runtime, positionals) {
  const action = positionals[0] ?? "help";
  const rest = positionals.slice(1);
  switch (action) {
    case "environments":
      return environmentsCommand(runtime);
    case "kinds":
      return kindsCommand(runtime);
    case "repos":
      return repositoryCommand(runtime);
    case "run":
      return runCommand(runtime, rest);
    case "status":
    case "watch":
    case "attach":
    case "cancel":
    case "resume":
    case "retry":
      return workCommand(runtime, [action, ...rest]);
    case "takeover":
      return workCommand(runtime, ["attach", ...rest]);
    case "pause":
      return pauseCommand(runtime, rest);
    case "diff":
    case "branch":
    case "commit":
    case "pr":
    case "ci":
    case "remediate":
      return deliveryCommand(runtime, action, rest);
    case "help":
      return workflowHelp(runtime);
    default:
      throw new UsageError(`unknown workflow command: ${action}. Run \`coderax workflow help\`.`);
  }
}

export { WORKFLOW_USAGE };
