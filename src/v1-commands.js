/**
 * Non-interactive access to the authoritative WorkflowEngine `/v1` contract.
 *
 * This is part of the single `coderax` binary, not a second CLI: it exists so the
 * canonical transport is usable from scripts and CI, where the interactive
 * terminal is not. Every operation is a thin wrapper over the shared SDK in
 * `packages/workflow-sdk/src/v1`; no request, retry or validation logic lives
 * here.
 *
 * Output contract:
 * - human mode renders prose and streams text to stdout;
 * - `--json` prints one complete JSON document for a query, and NDJSON (one
 *   event per line) for `chat` and `watch`, so a pipeline never has to parse
 *   pretty-printed JSON followed by more JSON.
 */

import { SdkError } from "../packages/workflow-sdk/src/index.js";
import {
  V1Client,
  buildTemplateObjective,
  buildWorkRequest,
  newSubmissionKey,
  resolveSubmission,
  submitWork,
  templateNames,
  WORK_TEMPLATES,
  watchTask,
} from "../packages/workflow-sdk/src/v1/index.js";
import { login as loginCommand } from "./product-commands.js";
import { createSubmissionLedger } from "./submissions.js";
import { mapExecutionEvent } from "./v1-transport.js";
import { VERSION } from "./version.js";
import { EXIT } from "./workflow-commands.js";

function requireAuth(ctx) {
  if (!ctx.settings.baseUrl) {
    throw new SdkError(
      "BASE_URL_REQUIRED",
      "no engine configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  if (!ctx.settings.token) {
    throw new SdkError("UNAUTHENTICATED", "not signed in; run `coderax login` first");
  }
}

function clientFor(ctx) {
  requireAuth(ctx);
  return new V1Client({
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    timeoutMs: ctx.settings.timeoutMs,
    fetchImpl: ctx.fetchImpl,
    clientVersion: VERSION,
    onDiagnostic: (entry) => ctx.err(`${entry.code}: ${entry.message}`),
  });
}

function ledgerFor(ctx) {
  return createSubmissionLedger({ baseUrl: ctx.settings.baseUrl, env: ctx.env });
}

function emit(ctx, value) {
  ctx.out(JSON.stringify(value, null, 2));
}

async function whoamiCommand(ctx) {
  const client = clientFor(ctx);
  await client.negotiate({ force: true });
  // /v1/agents is owner-protected. A successful read proves the bearer token
  // was accepted; the engine publishes no separate account name or role.
  const agents = await client.agents({ refresh: true });
  const payload = {
    authenticated: true,
    owner: true,
    method: "/v1/agents",
    agents: agents.agents.length,
  };
  if (ctx.json) {
    emit(ctx, payload);
  } else {
    ctx.out("Owner    verified by the /v1 owner-protected route");
    ctx.out(`Agents   ${payload.agents}`);
  }
  return EXIT.OK;
}

function numberFlag(ctx, name, { fallback = null, min = 0 } = {}) {
  const raw = ctx.flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new SdkError("USAGE", `--${name} must be an integer >= ${min}`);
  }
  return value;
}

function modelFlag(ctx) {
  return ctx.flags.get("model") || undefined;
}

function agentFlag(ctx) {
  return ctx.flags.get("agent") || undefined;
}

function conversationFlag(ctx) {
  return ctx.flags.get("conversation") || ctx.flags.get("resume") || undefined;
}

function dataMode(ctx) {
  return ctx.settings.dataMode === "private" ? "private" : "cloud";
}

/** One line per engine event, so `--json` is NDJSON and text mode stays readable. */
function renderEvent(ctx, event) {
  if (ctx.json) {
    ctx.out(JSON.stringify(event));
    return;
  }
  switch (event.type) {
    case "delta":
    case "replace":
      ctx.raw(event.text ?? "");
      return;
    case "tool":
      ctx.err(`${event.status === "start" ? "tool" : "tool done"}: ${event.name}`);
      return;
    case "status":
      ctx.err(`status: ${event.text}`);
      return;
    case "activity":
      ctx.err(event.text);
      return;
    case "permission":
      ctx.err(
        `approval required: ${event.request?.tool ?? "tool"} — ${event.request?.description ?? ""}` +
          (event.request?.requestId ? ` (request ${event.request.requestId})` : ""),
      );
      ctx.err("Answer it in the interactive terminal; a non-interactive run never grants permission.");
      return;
    case "task":
      ctx.err(`task ${event.taskId} accepted (${event.state})`);
      return;
    case "usage":
      ctx.err(`usage: ${JSON.stringify(event.usage)}`);
      return;
    case "error":
      ctx.err(`failed: ${event.message}`);
      return;
    case "cancelled":
      ctx.err("task cancelled");
      return;
    case "interrupted":
      ctx.err(`task interrupted: ${event.detail}`);
      return;
    case "final":
      return;
    default:
      return;
  }
}

async function watch(ctx, client, taskId, after) {
  let text = "";
  const result = await watchTask({
    client,
    taskId,
    after,
    onEvent: async (event) => {
      const mapped = mapExecutionEvent(event, { taskId });
      for (const item of mapped) {
        if (item.type === "delta") text += item.text ?? "";
        if (item.type === "replace") text = item.text ?? "";
        renderEvent(ctx, item);
      }
    },
    onReconnect: (info) => ctx.err(`reconnecting (${info.reason}) from event ${info.lastSeq ?? 0}`),
  });
  if (!ctx.json && text !== "" && !text.endsWith("\n")) ctx.raw("\n");
  if (result.terminalEvent?.type === "task.failed") {
    const payload = result.terminalEvent.payload ?? {};
    throw new SdkError(
      "TASK_FAILED",
      `the Work task failed (${payload.code ?? "engine_failure"})${payload.detail ? `: ${payload.detail}` : ""}`,
    );
  }
  if (result.interrupted) {
    throw new SdkError("TASK_INTERRUPTED", `task ${taskId} was interrupted; it is resumable`);
  }
  if (result.status && result.status.state === "failed") {
    throw new SdkError("TASK_FAILED", `task ${taskId} failed`);
  }
  return result;
}

async function healthCommand(ctx) {
  const client = clientFor(ctx);
  const [health, ready] = await Promise.all([client.health(), client.readiness()]);
  const negotiation = await client.negotiate();
  if (ctx.json) {
    emit(ctx, { health, ready, contract: negotiation });
    return EXIT.OK;
  }
  ctx.out(`engine      ${health.status}`);
  ctx.out(`contract    ${negotiation.serverContract} (client mirrors ${negotiation.clientContract})`);
  ctx.out(`ready       ${ready.ready ? "yes" : "no"}${ready.missing.length > 0 ? ` — missing: ${ready.missing.join(", ")}` : ""}`);
  ctx.out(`uptime      ${health.uptimeMs} ms`);
  for (const engine of health.engines) {
    ctx.out(
      `engine ${engine.id.padEnd(10)} ${engine.availability.available ? "available" : `unavailable (${engine.availability.reason})`}`,
    );
  }
  return health.status === "failed" ? EXIT.UNAVAILABLE : EXIT.OK;
}

async function modelsCommand(ctx) {
  const client = clientFor(ctx);
  await client.negotiate();
  const value = await client.models();
  if (ctx.json) {
    emit(ctx, value);
    return EXIT.OK;
  }
  if (value.models.length === 0) {
    ctx.out("No models are published by this engine.");
    return EXIT.OK;
  }
  for (const model of value.models) {
    const state = model.availability.available ? "available" : `unavailable (${model.availability.reason})`;
    ctx.out(`${model.ref.providerId}/${model.ref.modelId}  ${model.costClass}  ${state}  ${model.label}`);
  }
  return EXIT.OK;
}

async function agentsCommand(ctx) {
  const client = clientFor(ctx);
  await client.negotiate();
  const value = await client.agents({ refresh: true });
  if (ctx.json) {
    emit(ctx, value);
    return EXIT.OK;
  }
  for (const agent of value.agents) {
    const state = agent.availability.available ? "available" : `unavailable (${agent.availability.reason})`;
    ctx.out(
      `${agent.id.padEnd(9)} ${agent.external ? "external" : "native  "} ${state}  tools=${agent.capabilities.tools ? "yes" : "no"}  durable=${agent.capabilities.durable ? "yes" : "no"}`,
    );
  }
  return EXIT.OK;
}

async function chatCommand(ctx, rest) {
  const client = clientFor(ctx);
  await client.negotiate();
  const text = rest.join(" ").trim();
  if (text === "") throw new SdkError("USAGE", "usage: coderax v1 chat <message>");
  let streamed = false;
  const deltas = [];
  const reply = await client.chat(
    {
      message: text,
      ...(conversationFlag(ctx) ? { conversationId: conversationFlag(ctx) } : {}),
      ...(agentFlag(ctx) ? { agent: agentFlag(ctx) } : {}),
      ...(modelFlag(ctx) ? { model: parseModel(modelFlag(ctx)) } : {}),
      mode: dataMode(ctx),
    },
    {
      onDelta: (delta) => {
        streamed = true;
        deltas.push(delta);
        // JSON mode collects the deltas and prints one document, so stdout is
        // never a mix of NDJSON fragments and a pretty-printed object.
        if (!ctx.json) ctx.raw(delta.text ?? "");
      },
    },
  );
  if (ctx.json) {
    emit(ctx, { reply, deltas, streamed });
  } else {
    if (!streamed && reply.text !== "") ctx.raw(reply.text);
    if (!reply.text.endsWith("\n")) ctx.raw("\n");
    ctx.err(`conversation ${reply.conversationId}`);
  }
  return EXIT.OK;
}

function parseModel(value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new SdkError("USAGE", "a model must be written as provider/model");
  }
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

async function submitCommand(ctx, rest) {
  const client = clientFor(ctx);
  await client.negotiate();
  const template = ctx.flags.get("template");
  let objective;
  if (template) {
    objective = buildTemplateObjective(template, rest.join(" ").trim());
    if (objective === null) {
      throw new SdkError("USAGE", `unknown template ${template}; known: ${templateNames().join(", ")}`);
    }
    const definition = WORK_TEMPLATES[template.toLowerCase()];
    if (definition?.requiresTools === true) {
      const agents = await client.agents();
      const agentId = agentFlag(ctx) ?? "coderax";
      const selected = agents.agents.find((entry) => entry.id === agentId);
      if (selected && selected.capabilities.tools !== true) {
        throw new SdkError(
          "CAPABILITY_UNAVAILABLE",
          `agent ${agentId} does not publish tool support, so it cannot run the ${template} template`,
        );
      }
    }
  } else {
    objective = rest.join(" ").trim();
    if (objective === "") throw new SdkError("USAGE", "usage: coderax v1 submit <objective>");
  }

  const request = buildWorkRequest({
    objective,
    conversationId: conversationFlag(ctx),
    agent: agentFlag(ctx),
    model: modelFlag(ctx),
    mode: dataMode(ctx),
    requireApproval: true,
  });
  const ledger = ledgerFor(ctx);
  const key = ctx.settings.submissionKey || newSubmissionKey();
  const submitted = await submitWork({
    client,
    ledger,
    request,
    idempotencyKey: key,
    retryUncertain: ctx.flags.has("retry-submission"),
  });
  const taskId = submitted.accepted?.taskId ?? submitted.task.taskId;
  const conversationId = submitted.accepted?.conversationId ?? submitted.task.conversationId ?? null;
  if (ctx.json) {
    // One line so a following event stream is valid NDJSON.
    ctx.out(JSON.stringify({
      taskId,
      conversationId,
      submissionKey: submitted.submissionKey,
      reused: submitted.reused,
    }));
  } else {
    ctx.out(`task ${taskId}  ${submitted.accepted?.state ?? submitted.task.state ?? "queued"}`);
    if (conversationId) ctx.out(`conversation ${conversationId}`);
    ctx.out(`submission ${submitted.submissionKey}${submitted.reused ? " (already accepted; nothing was resent)" : ""}`);
  }
  if (!ctx.flags.has("detach")) {
    await watch(ctx, client, taskId, 0);
  }
  return EXIT.OK;
}

async function taskCommand(ctx, rest) {
  const client = clientFor(ctx);
  if (rest.length === 0) throw new SdkError("USAGE", "usage: coderax v1 task <taskId>");
  const status = await client.task(rest[0]);
  if (ctx.json) {
    emit(ctx, status);
  } else {
    ctx.out(`task ${status.taskId}  ${status.state}`);
    ctx.out(`conversation ${status.conversationId}`);
    if (status.result?.summary) ctx.out(status.result.summary);
    for (const step of status.steps) ctx.out(`  [${step.state}] ${step.title}`);
  }
  return status.state === "failed" ? EXIT.ERROR : EXIT.OK;
}

async function watchCommand(ctx, rest) {
  const client = clientFor(ctx);
  if (rest.length === 0) throw new SdkError("USAGE", "usage: coderax v1 watch <taskId> [--after <seq>]");
  await watch(ctx, client, rest[0], numberFlag(ctx, "after", { fallback: 0 }));
  return EXIT.OK;
}

async function tasksCommand(ctx) {
  const ledger = ledgerFor(ctx);
  const tasks = await ledger.listTasks();
  if (ctx.json) {
    emit(ctx, { tasks });
    return EXIT.OK;
  }
  if (tasks.length === 0) {
    ctx.out("No Work tasks submitted from this machine.");
    return EXIT.OK;
  }
  for (const task of tasks) {
    ctx.out(`${task.taskId}  ${task.state ?? "unknown"}  ${task.updatedAt ?? ""}  seq=${task.lastSeq ?? 0}`);
  }
  return EXIT.OK;
}

async function controlCommand(ctx, rest, operation) {
  const client = clientFor(ctx);
  if (rest.length === 0) throw new SdkError("USAGE", `usage: coderax v1 ${operation} <taskId>`);
  const taskId = rest[0];
  let outcome;
  if (operation === "cancel") {
    outcome = await client.cancel(taskId, rest.slice(1).join(" ") || undefined);
  } else {
    const generation = numberFlag(ctx, "generation", { fallback: undefined });
    if (generation === undefined) {
      throw new SdkError("USAGE", `--generation is required for ${operation}`);
    }
    outcome = operation === "resume"
      ? await client.resume(taskId, generation)
      : await client.retry(taskId, generation, modelFlag(ctx) ? parseModel(modelFlag(ctx)) : undefined);
  }
  if (ctx.json) emit(ctx, outcome);
  else ctx.out(`${outcome.taskId}  ${outcome.outcome}  ${outcome.state}  generation ${outcome.generation}`);
  return EXIT.OK;
}

async function resolveCommand(ctx, rest) {
  if (rest.length !== 2) {
    throw new SdkError("USAGE", "usage: coderax v1 resolve <submissionKey> <taskId>");
  }
  const client = clientFor(ctx);
  const result = await resolveSubmission({
    client,
    ledger: ledgerFor(ctx),
    key: rest[0],
    taskId: rest[1],
  });
  if (ctx.json) emit(ctx, result);
  else ctx.out(`${rest[0]} -> ${result.status.taskId}  ${result.status.state}`);
  return EXIT.OK;
}

async function notificationsCommand(ctx) {
  const client = clientFor(ctx);
  const value = await client.notifications();
  if (ctx.json) {
    emit(ctx, value);
    return EXIT.OK;
  }
  ctx.out(`${value.unread} unread`);
  for (const item of value.notifications) {
    ctx.out(`${item.read ? " " : "*"} ${item.taskId}  ${item.state}  ${item.summary ?? ""}`);
  }
  return EXIT.OK;
}

async function conversationsCommand(ctx, rest) {
  const client = clientFor(ctx);
  if (rest.length > 0) {
    const value = await client.conversation(rest[0]);
    if (ctx.json) emit(ctx, value);
    else {
      ctx.out(`conversation ${value.conversationId}  ${value.agent}  ${value.mode}`);
      for (const message of value.messages) ctx.out(`${message.role}: ${message.text}`);
    }
    return EXIT.OK;
  }
  const value = await client.conversations();
  if (ctx.json) emit(ctx, value);
  else {
    for (const item of value.conversations) {
      ctx.out(`${item.conversationId}  ${item.agent}  ${item.isWork ? "work" : "chat"}  ${item.updatedAt}`);
    }
  }
  return EXIT.OK;
}

async function permissionsCommand(ctx, rest) {
  const client = clientFor(ctx);
  if (rest.length === 0) throw new SdkError("USAGE", "usage: coderax v1 permissions <taskId>");
  const value = await client.permissions(rest[0]);
  if (ctx.json) {
    emit(ctx, value);
    return EXIT.OK;
  }
  if (value.requests.length === 0) {
    ctx.out("No permission requests.");
    return EXIT.OK;
  }
  for (const request of value.requests) {
    ctx.out(`${request.requestId}  ${request.decision}  ${request.scope}  ${request.description}`);
  }
  return EXIT.OK;
}

function templatesCommand(ctx) {
  const entries = templateNames().map((name) => ({
    name,
    label: WORK_TEMPLATES[name].label,
    summary: WORK_TEMPLATES[name].summary,
    requiresTools: WORK_TEMPLATES[name].requiresTools,
  }));
  if (ctx.json) {
    emit(ctx, { templates: entries });
    return EXIT.OK;
  }
  for (const entry of entries) {
    ctx.out(`${entry.name.padEnd(10)} ${entry.label} — ${entry.summary}`);
  }
  return EXIT.OK;
}

const USAGE = `coderax v1 - canonical WorkflowEngine /v1 surface

  coderax v1 login [--token-file <path>] [--json]
                                              verify the owner through /v1/agents, then store the token
  coderax v1 whoami [--json]
  coderax v1 health [--json]                 contract, readiness and engines
  coderax v1 models [--json]
  coderax v1 agents [--json]
  coderax v1 chat <message> [--conversation <id>] [--model <provider/id>] [--agent <id>] [--json]
  coderax v1 submit <objective> [--template <name>] [--agent <id>] [--model <provider/id>]
                                 [--conversation <id>] [--detach] [--json]
  coderax v1 task <taskId> [--json]
  coderax v1 watch <taskId> [--after <seq>] [--json]
  coderax v1 tasks [--json]                  tasks submitted from this machine
  coderax v1 cancel <taskId> [reason] [--json]
  coderax v1 resume <taskId> --generation <n> [--json]
  coderax v1 retry <taskId> --generation <n> [--model <provider/id>] [--json]
  coderax v1 resolve <submissionKey> <taskId> [--json]
  coderax v1 notifications [--json]
  coderax v1 conversations [conversationId] [--json]
  coderax v1 permissions <taskId> [--json]
  coderax v1 templates [--json]

chat prints one JSON document under --json. watch, and submit without --detach,
stream NDJSON: one engine event per line after any submission line.`;

export async function v1Command(ctx, args) {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
      ctx.out(USAGE);
      return EXIT.OK;
    case "login":
      // Reuse the one login path, with the canonical verification route. The
      // token is read from the same secure sources and is never an argument.
      return loginCommand({ ...ctx, env: { ...ctx.env, CODERAX_SDK: "v1" } });
    case "whoami":
      return whoamiCommand(ctx);
    case "health":
      return healthCommand(ctx);
    case "models":
      return modelsCommand(ctx);
    case "agents":
      return agentsCommand(ctx);
    case "chat":
      return chatCommand(ctx, rest);
    case "submit":
      return submitCommand(ctx, rest);
    case "task":
      return taskCommand(ctx, rest);
    case "watch":
      return watchCommand(ctx, rest);
    case "tasks":
      return tasksCommand(ctx);
    case "cancel":
      return controlCommand(ctx, rest, "cancel");
    case "resume":
      return controlCommand(ctx, rest, "resume");
    case "retry":
      return controlCommand(ctx, rest, "retry");
    case "resolve":
      return resolveCommand(ctx, rest);
    case "notifications":
      return notificationsCommand(ctx);
    case "conversations":
      return conversationsCommand(ctx, rest);
    case "permissions":
      return permissionsCommand(ctx, rest);
    case "templates":
      return templatesCommand(ctx);
    default:
      throw new SdkError("USAGE", `unknown v1 command: ${sub}. Run \`coderax v1\` for the list.`);
  }
}
