import { CoderaxError, formatJson, redactValue } from "./client.js";
import {
  CONTRACT_FINGERPRINT,
  CONTRACT_VERSION,
  DATA_MODES,
  KNOWN_AGENTS,
  contractBanner,
  isTerminalTaskState,
} from "./engine-contract.js";
import { EngineClient } from "./engine-client.js";
import {
  EngineTaskSynchronizer,
  createEngineStateStore,
  enginePartition,
  engineStatePath,
} from "./engine-sync.js";
import { VERSION } from "./version.js";

/**
 * `coderax engine` — durable task control over the authoritative
 * WorkflowEngine /v1 contract.
 *
 * This command group is additive: it does not read or write the legacy
 * `/api/workflows` task state and does not share a client with the legacy
 * adapter. Every task it reports comes from the engine's own read model.
 */

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_CANCELLED = 130;

function usage(message) {
  return new CoderaxError("USAGE", message);
}

function setting(ctx, name) {
  const value = ctx.flags.get(name) ?? ctx.settings?.[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function engineClient(ctx) {
  return new EngineClient({
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    timeoutMs: ctx.settings.timeoutMs,
    fetchImpl: ctx.fetchImpl ?? fetch,
    clientVersion: VERSION,
  });
}

function requireEngine(ctx) {
  if (!ctx.settings.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no deployment configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  if (!ctx.settings.token) {
    throw new CoderaxError("UNAUTHENTICATED", "no owner token configured; run `coderax login` first");
  }
}

async function synchronizerFor(ctx) {
  requireEngine(ctx);
  const partition = enginePartition({
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    environment: ctx.flags.get("environment"),
    env: ctx.env,
  });
  const store = createEngineStateStore(engineStatePath(ctx.env, partition));
  const sync = new EngineTaskSynchronizer({
    client: engineClient(ctx),
    store,
    partition,
    onDiagnostic: (entry) => {
      if (!ctx.json) ctx.err(`warning: ${entry.code}: ${entry.message}`);
    },
  });
  await sync.load();
  return { sync, partition };
}

function parseModelRef(value) {
  if (value === null || value === undefined) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw usage("--model must be <provider>/<model>, for example openrouter/coderax:free");
  }
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function selection(ctx) {
  const agent = ctx.flags.has("agent") ? ctx.flags.get("agent") : setting(ctx, "agent");
  if (agent !== null && !KNOWN_AGENTS.includes(agent)) {
    throw usage(`unknown agent: ${agent}. Choose one of ${KNOWN_AGENTS.join(", ")}`);
  }
  const mode = ctx.flags.has("mode") ? ctx.flags.get("mode") : "cloud";
  if (mode !== null && !DATA_MODES.includes(mode)) {
    throw usage(`unknown data mode: ${mode}. Choose private or cloud`);
  }
  return {
    agent: agent ?? undefined,
    mode: mode ?? "cloud",
    model: parseModelRef(ctx.flags.has("model") ? ctx.flags.get("model") : setting(ctx, "model")),
  };
}

function taskFromFlag(ctx) {
  const taskId = ctx.args[1];
  if (typeof taskId !== "string" || taskId.trim() === "") {
    throw usage("this command requires a task id");
  }
  return taskId.trim();
}

function integerFlag(ctx, name) {
  if (!ctx.flags.has(name)) return undefined;
  const raw = ctx.flags.get(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw usage(`--${name} must be a non-negative integer`);
  }
  return value;
}

function renderEvent(ctx, taskId, event) {
  if (ctx.json) {
    ctx.out(formatJson(redactValue(event, ctx.settings.token)));
    return;
  }
  if (event.type === "text.delta") {
    ctx.raw(event.payload.text);
    return;
  }
  if (event.type === "text.replace") {
    ctx.raw(`\n[revised response]\n${event.payload.text}\n`);
    return;
  }
  if (event.type === "step.started" || event.type === "step.completed") {
    const title = event.payload?.title ?? event.payload?.stepId ?? "step";
    ctx.err(`${event.type === "step.started" ? "\u25b8" : "\u2713"} ${title}`);
    return;
  }
  if (event.type === "approval.required") {
    const request = event.payload ?? {};
    ctx.err(
      [
        "",
        "approval required before the task can continue:",
        `  scope       ${request.scope ?? "(unknown)"}`,
        `  resource    ${request.resource ?? "(unknown)"}`,
        `  description ${request.description ?? ""}`.trimEnd(),
        `  request     ${request.requestId ?? "(unknown)"}`,
        `  approve     coderax engine approve ${taskId} ${request.requestId ?? "<requestId>"}`,
        `  deny        coderax engine deny ${taskId} ${request.requestId ?? "<requestId>"}`,
        "",
      ].join("\n"),
    );
  }
}

async function followTask(ctx, sync, taskId, { after } = {}) {
  if (after !== undefined) {
    if (after === 0) delete sync.state.cursor[taskId];
    else sync.state.cursor[taskId] = after;
    await sync.persist();
  }
  const result = await sync.follow(taskId, {
    signal: ctx.signal,
    onEvent: (event) => renderEvent(ctx, taskId, event),
  });
  const state = result.terminal?.state ?? result.task?.state ?? "unknown";
  if (ctx.json) {
    ctx.out(
      formatJson({
        taskId,
        state,
        confirmed: result.confirmed ?? null,
        cursor: result.cursor,
        truncated: result.truncated,
        detached: result.detached,
      }),
    );
  } else {
    ctx.out(`\n${taskId}: ${state}${result.confirmed === false ? " (receipt unconfirmed)" : ""}`);
  }
  if (result.terminal === null) return EXIT_OK;
  if (result.terminal.state === "completed") return EXIT_OK;
  if (result.terminal.state === "cancelled") return EXIT_CANCELLED;
  return EXIT_FAILURE;
}

function printTable(ctx, rows) {
  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => String(row[index] ?? "").length)),
  );
  for (const row of rows) {
    ctx.out(row.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ").trimEnd());
  }
}

async function status(ctx) {
  const { sync, partition } = await synchronizerFor(ctx);
  const report = await sync.client.compatibility();
  const payload = {
    contractVersion: CONTRACT_VERSION,
    fingerprint: CONTRACT_FINGERPRINT,
    server: report.server,
    compatible: report.compatible,
    problems: report.problems,
    negotiatedContractVersion: report.negotiatedContractVersion,
    eventSchemaVersion: report.eventSchemaVersion,
    chatStreamVersion: report.chatStreamVersion,
    capabilities: report.caps,
    limits: report.limits,
    environment: partition.environment,
    trackedTasks: Object.keys(sync.state.tasks).length,
    statePath: sync.store.path,
  };
  if (ctx.json) {
    ctx.out(formatJson(payload));
    return EXIT_OK;
  }
  ctx.out(`engine:     ${report.server?.name ?? "Coderax WorkflowEngine"} ${report.server?.version ?? ""}`.trimEnd());
  ctx.out(`contract:   ${report.contractVersion} (negotiated ${report.negotiatedContractVersion})`);
  ctx.out(`events:     v${report.eventSchemaVersion}, chat v${report.chatStreamVersion}`);
  ctx.out(`fingerprint ${report.server?.contractFingerprint ?? "(not reported)"}`);
  ctx.out(`compatible: ${report.compatible ? "yes" : "NO"}`);
  ctx.out(`environment ${partition.environment}`);
  for (const problem of report.problems) ctx.out(`problem:    ${problem}`);
  return report.compatible ? EXIT_OK : EXIT_FAILURE;
}

async function handshake(ctx) {
  const { sync } = await synchronizerFor(ctx);
  const document = await sync.client.handshake();
  if (ctx.json) {
    ctx.out(formatJson(document));
    return EXIT_OK;
  }
  ctx.out(`${contractBanner()}`);
  ctx.out(`server:      ${document.server?.name ?? "?"} ${document.server?.version ?? ""}`.trimEnd());
  ctx.out(`fingerprint: ${document.contractFingerprint}`);
  ctx.out(`negotiation: ${document.negotiation} (${document.negotiatedContractVersion})`);
  ctx.out(`operations:  ${document.operations.length}`);
  const capabilities = Object.entries(document.capabilities)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  ctx.out(`capabilities ${capabilities.join(", ")}`);
  return document.compatible ? EXIT_OK : EXIT_FAILURE;
}

async function submit(ctx) {
  const objective = ctx.args.slice(1).join(" ").trim();
  if (objective === "") {
    throw usage('usage: coderax engine submit "<objective>" [--agent <id>] [--detach]');
  }
  const { sync } = await synchronizerFor(ctx);
  const { agent, mode, model } = selection(ctx);
  const resumeKey = ctx.flags.get("resume-key") ?? undefined;
  const idempotencyKey = ctx.flags.get("idempotency-key") ?? undefined;
  if (resumeKey !== undefined && idempotencyKey !== undefined) {
    throw usage("pass either --resume-key or --idempotency-key, not both");
  }
  const result = await sync.submit({
    objective,
    ...(resumeKey === undefined ? {} : { resumeKey }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    agent,
    mode,
    model,
  });

  if (ctx.json) {
    ctx.out(formatJson(result));
  } else {
    const accepted = result.accepted;
    ctx.out(
      `${accepted.taskId} ${accepted.state} generation ${accepted.generation}` +
        `${result.replayed ? " (replayed submission)" : ""}`,
    );
    ctx.out(`submission-key ${result.submissionKey}`);
  }

  if (ctx.flags.has("detach") || ctx.flags.has("no-follow")) return EXIT_OK;
  return followTask(ctx, sync, result.accepted.taskId);
}

async function tasks(ctx) {
  const { sync } = await synchronizerFor(ctx);
  const query = {};
  if (ctx.flags.has("state")) query.state = ctx.flags.get("state");
  const limit = integerFlag(ctx, "limit");
  if (limit !== undefined) query.limit = limit;
  const list = await sync.client.tasks(query);
  if (ctx.json) {
    ctx.out(formatJson(list));
    return EXIT_OK;
  }
  if (list.tasks.length === 0) {
    ctx.out("no tasks");
    return EXIT_OK;
  }
  printTable(ctx, [
    ["TASK", "STATE", "AGENT", "GEN", "UPDATED"],
    ...list.tasks.map((task) => [
      task.taskId,
      task.state,
      task.agent,
      task.generation,
      task.updatedAt,
    ]),
  ]);
  return EXIT_OK;
}

async function task(ctx) {
  const taskId = taskFromFlag(ctx);
  const { sync } = await synchronizerFor(ctx);
  const current = await sync.reconcile(taskId);
  if (ctx.json) {
    ctx.out(formatJson(current));
    return EXIT_OK;
  }
  ctx.out(`${current.taskId} ${current.state} generation ${current.generation}`);
  ctx.out(`agent ${current.agent} mode ${current.mode} updated ${current.updatedAt}`);
  if (current.cancelRequested) ctx.out("cancellation requested");
  for (const step of current.steps ?? []) ctx.out(`  ${step.state.padEnd(12)} ${step.title}`);
  if (current.failure) ctx.out(`failure: ${current.failure.code} ${current.failure.detail ?? ""}`.trimEnd());
  if (current.result?.summary) ctx.out(current.result.summary);
  return isTerminalTaskState(current.state) ? EXIT_OK : EXIT_OK;
}

async function events(ctx) {
  const taskId = taskFromFlag(ctx);
  const { sync } = await synchronizerFor(ctx);
  return followTask(ctx, sync, taskId, { after: integerFlag(ctx, "after") });
}

async function control(ctx, action) {
  const taskId = taskFromFlag(ctx);
  const { sync } = await synchronizerFor(ctx);
  const generation = integerFlag(ctx, "generation");
  let result;
  if (action === "cancel") {
    result = await sync.cancel(taskId, ctx.flags.get("reason"));
  } else if (action === "resume") {
    result = await sync.resume(taskId, { generation });
  } else {
    result = await sync.retry(taskId, { generation, model: parseModelRef(ctx.flags.get("model")) });
  }
  if (ctx.json) {
    ctx.out(formatJson(result));
  } else {
    ctx.out(`${result.taskId} ${result.state} generation ${result.generation}: ${result.outcome}`);
  }
  return result.outcome === "accepted" || result.outcome === "already_terminal" ? EXIT_OK : EXIT_FAILURE;
}

async function permissions(ctx) {
  const taskId = taskFromFlag(ctx);
  const { sync } = await synchronizerFor(ctx);
  const list = await sync.client.permissions(taskId);
  if (ctx.json) {
    ctx.out(formatJson(list));
    return EXIT_OK;
  }
  if (list.requests.length === 0) {
    ctx.out("no permission requests");
    return EXIT_OK;
  }
  printTable(ctx, [
    ["REQUEST", "SCOPE", "DECISION", "RESOURCE"],
    ...list.requests.map((request) => [
      request.requestId,
      request.scope,
      request.decision,
      request.resource,
    ]),
  ]);
  return EXIT_OK;
}

async function decide(ctx, decision) {
  const taskId = taskFromFlag(ctx);
  const requestId = ctx.args[2];
  if (typeof requestId !== "string" || requestId.trim() === "") {
    throw usage(`usage: coderax engine ${decision} <taskId> <requestId> [--reason <text>]`);
  }
  const { sync } = await synchronizerFor(ctx);
  const result = await sync.decidePermission(taskId, {
    requestId: requestId.trim(),
    decision: decision === "approve" ? "approved" : "denied",
    reason: ctx.flags.get("reason"),
  });
  if (ctx.json) {
    ctx.out(formatJson(result));
  } else {
    const request = result.requests.find((entry) => entry.requestId === requestId.trim());
    ctx.out(`${requestId.trim()} ${request?.decision ?? decision}`);
  }
  return EXIT_OK;
}

async function notifications(ctx) {
  const { sync } = await synchronizerFor(ctx);
  const list = await sync.notifications();
  if (ctx.json) {
    ctx.out(formatJson(list));
    return EXIT_OK;
  }
  ctx.out(`${list.unread} unread`);
  for (const notification of list.notifications) {
    ctx.out(
      `${notification.read ? " " : "*"} ${notification.taskId} ${notification.state}` +
        `${notification.summary ? `  ${notification.summary}` : ""}`,
    );
  }
  return EXIT_OK;
}

async function acknowledge(ctx) {
  const taskId = taskFromFlag(ctx);
  const { sync } = await synchronizerFor(ctx);
  const result = await sync.acknowledge(taskId);
  if (ctx.json) {
    ctx.out(formatJson(result));
  } else {
    ctx.out(`${taskId} acknowledged; ${result.unread} unread`);
  }
  return EXIT_OK;
}

async function reconcile(ctx) {
  const taskId = taskFromFlag(ctx);
  const { sync } = await synchronizerFor(ctx);
  const current = await sync.reconcile(taskId);
  if (ctx.json) {
    ctx.out(formatJson(current));
  } else {
    ctx.out(`${current.taskId} ${current.state} generation ${current.generation}`);
  }
  return EXIT_OK;
}

const SUBCOMMANDS = new Set([
  "status",
  "handshake",
  "submit",
  "tasks",
  "task",
  "events",
  "cancel",
  "resume",
  "retry",
  "permissions",
  "approve",
  "deny",
  "notifications",
  "ack",
  "reconcile",
]);

export async function engineCommand(ctx) {
  const action = ctx.args[0];
  if (action === undefined) {
    throw usage(
      "usage: coderax engine <status|handshake|submit|tasks|task|events|cancel|resume|retry|permissions|approve|deny|notifications|ack|reconcile>",
    );
  }
  if (!SUBCOMMANDS.has(action)) {
    throw usage(`unknown engine command: ${action}`);
  }
  switch (action) {
    case "status":
      return status(ctx);
    case "handshake":
      return handshake(ctx);
    case "submit":
      return submit(ctx);
    case "tasks":
      return tasks(ctx);
    case "task":
      return task(ctx);
    case "events":
      return events(ctx);
    case "cancel":
      return control(ctx, "cancel");
    case "resume":
      return control(ctx, "resume");
    case "retry":
      return control(ctx, "retry");
    case "permissions":
      return permissions(ctx);
    case "approve":
      return decide(ctx, "approve");
    case "deny":
      return decide(ctx, "deny");
    case "notifications":
      return notifications(ctx);
    case "ack":
      return acknowledge(ctx);
    case "reconcile":
      return reconcile(ctx);
    default:
      throw usage(`unknown engine command: ${action}`);
  }
}

export { EXIT_OK, EXIT_FAILURE, EXIT_CANCELLED };
