import { statSync } from "node:fs";
import { dirname } from "node:path";
import { CoderaxError, formatJson } from "./client.js";
import { configDir, loadConfig, maskToken, saveConfig } from "./config.js";
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  DATA_MODES,
  KNOWN_AGENTS,
  contractBanner,
} from "./contract.js";
import { followTaskEvents } from "./events.js";
import { EngineClient } from "./engine.js";
import { VERSION } from "./version.js";

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  UNAUTHENTICATED: 3,
  NETWORK: 4,
  NOT_FOUND: 5,
  UNAVAILABLE: 6,
  CANCELLED: 130,
});

function usage(message) {
  return new CoderaxError("USAGE", message);
}

function table(rows, headers) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)),
  );
  const line = (cells) =>
    cells
      .map((cell, index) => String(cell ?? "").padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((width) => "\u2500".repeat(width))), ...rows.map(line)];
}

function emit(ctx, human, machine) {
  ctx.out(ctx.json ? formatJson(machine) : human);
}

export function requireBase(ctx) {
  if (!ctx.settings.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no engine configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
}

export function requireAuth(ctx) {
  if (!ctx.settings.token) {
    throw new CoderaxError("unauthorized", "no owner token configured; run `coderax login` first");
  }
}

export function engineFor(ctx) {
  return new EngineClient({
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    timeoutMs: ctx.settings.timeoutMs,
    eventTimeoutMs: ctx.settings.eventTimeoutMs,
    fetchImpl: ctx.fetchImpl,
  });
}

export function parseModelRef(value, flag = "--model") {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw usage(`${flag} must be <provider>/<model>, for example openrouter/coderax:free`);
  }
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function selection(ctx) {
  // An unset config value is "", not undefined: it means the engine default,
  // not an agent literally named "".
  const agentValue = ctx.flags.get("agent") ?? ctx.settings.agent;
  const agent = agentValue === "" || agentValue === undefined ? undefined : agentValue;
  if (agent !== undefined && !KNOWN_AGENTS.includes(agent)) {
    throw usage(`unknown agent: ${agent}. Choose one of ${KNOWN_AGENTS.join(", ")}`);
  }
  const modeValue = ctx.flags.get("mode") ?? ctx.settings.mode;
  const mode = modeValue === "" || modeValue === undefined ? undefined : modeValue;
  if (mode !== undefined && !DATA_MODES.includes(mode)) {
    throw usage(`unknown data mode: ${mode}. Choose private or cloud`);
  }
  const model = parseModelRef(ctx.flags.get("model") ?? ctx.settings.model);
  const conversationId = ctx.flags.get("conversation");
  if (conversationId !== undefined && conversationId.trim() === "") {
    throw usage("--conversation requires a conversation id");
  }
  return { agent, mode, model, conversationId };
}

async function promptText(ctx, mode) {
  let text = ctx.args.join(" ").trim();
  if (!text && !ctx.stdinIsTTY) text = String(await ctx.readSecret()).trim();
  if (!text) {
    throw usage(`no message provided; usage: coderax ${mode} "your message"`);
  }
  return text;
}

function exitForState(state) {
  if (state === "completed") return EXIT.OK;
  if (state === "cancelled") return EXIT.CANCELLED;
  return EXIT.ERROR;
}

function renderTaskEvent(ctx, event, outcome) {
  switch (outcome.kind) {
    case "delta":
      // Stream exactly the unseen text. The assembler has already removed any
      // overlap between a cumulative snapshot and its incremental delta.
      if (!ctx.json) ctx.raw(outcome.text);
      break;
    case "replace":
      if (!ctx.json) ctx.raw(`\n[revised response]\n${outcome.text}\n`);
      break;
    case "step": {
      if (ctx.json) break;
      const step = event.payload ?? {};
      ctx.err(`${event.type === "step.started" ? "\u25b8" : "\u2713"} ${step.title ?? step.stepId ?? "step"}`);
      break;
    }
    case "approval": {
      const request = outcome.request ?? {};
      ctx.err(
        [
          "",
          "approval required before the task can continue:",
          `  scope       ${request.scope ?? "(unknown)"}`,
          `  resource    ${request.resource ?? "(unknown)"}`,
          `  description ${request.description ?? ""}`.trimEnd(),
          `  request     ${request.requestId ?? "(unknown)"}`,
          `  approve     coderax approve ${event.taskId ?? "<taskId>"} ${request.requestId ?? "<requestId>"}`,
          `  deny        coderax deny ${event.taskId ?? "<taskId>"} ${request.requestId ?? "<requestId>"}`,
          `  continue    coderax events ${event.taskId ?? "<taskId>"}`,
          "",
        ].join("\n"),
      );
      break;
    }
    case "terminal": {
      if (ctx.json) break;
      const summary = event.payload?.summary;
      if (summary && !outcome.text) ctx.out("");
      break;
    }
    default:
      break;
  }
}

export async function login(ctx) {
  requireBase(ctx);
  const token = ctx.flags.get("token") || ctx.env.CODERAX_TOKEN || String(await ctx.readSecret()).trim();
  if (!token) {
    throw usage("no token provided; use `coderax login --token <token>` or pipe it on stdin");
  }

  const engine = new EngineClient({
    baseUrl: ctx.settings.baseUrl,
    token,
    timeoutMs: ctx.settings.timeoutMs,
    fetchImpl: ctx.fetchImpl,
  });
  // verifyOwner calls an owner-only operation: a valid token proves the caller
  // is the single owner, and a rejected one is never written to disk.
  const agents = await engine.agents();
  await saveConfig(
    { token, baseUrl: ctx.settings.baseUrl, account: null },
    { filePath: ctx.settings.configPath },
  );

  const payload = {
    authenticated: true,
    owner: true,
    token: maskToken(token),
    baseUrl: ctx.settings.baseUrl,
    contractVersion: CONTRACT_VERSION,
    agents: agents.agents.length,
  };
  emit(
    ctx,
    `Signed in as the owner. Token stored with 0600 permissions. ${contractBanner()}.`,
    payload,
  );
  return EXIT.OK;
}

export async function logout(ctx) {
  const stored = await loadConfig({ env: {}, filePath: ctx.settings.configPath });
  const removed = Boolean(stored.token);
  const environmentTokenActive = Boolean(ctx.env.CODERAX_TOKEN?.trim());
  await saveConfig({ token: null, account: null }, { filePath: ctx.settings.configPath });
  const message = environmentTokenActive
    ? "Stored credentials cleared. CODERAX_TOKEN is still set; unset it to sign out of this environment."
    : removed
      ? "Signed out."
      : "No stored credentials.";
  emit(ctx, message, { removed, environmentTokenActive, message });
  return EXIT.OK;
}

export async function status(ctx) {
  const settings = ctx.settings;
  const payload = {
    version: VERSION,
    contractVersion: CONTRACT_VERSION,
    baseUrl: settings.baseUrl || null,
    authenticated: Boolean(settings.token),
    ownerOnly: true,
    token: maskToken(settings.token),
    tokenSource: ctx.env.CODERAX_TOKEN ? "environment" : settings.token ? "config file" : "none",
    configPath: settings.configPath,
    configDir: configDir(ctx.env),
    agent: settings.agent || null,
    model: settings.model || null,
    mode: settings.mode || null,
  };
  if (ctx.json) {
    ctx.out(formatJson(payload));
    return EXIT.OK;
  }
  ctx.out(`Coderax CLI       ${VERSION}`);
  ctx.out(`WorkflowEngine    ${CONTRACT_VERSION} (events v1)`);
  ctx.out(`API               ${payload.baseUrl ?? "(not configured)"}`);
  ctx.out(
    `Authentication    ${payload.authenticated ? `owner token (${payload.token}, via ${payload.tokenSource})` : "no \u2014 run `coderax login`"}`,
  );
  if (payload.agent) ctx.out(`Agent             ${payload.agent}`);
  if (payload.model) ctx.out(`Model             ${payload.model}`);
  ctx.out(`Config            ${payload.configPath}`);
  return EXIT.OK;
}

export async function health(ctx) {
  requireBase(ctx);
  const report = await engineFor(ctx).health();
  const lines = [
    `health: ${report.status} \u2022 ${report.contractVersion} \u2022 up ${Math.round(report.uptimeMs / 1000)}s`,
    ...report.checks.map(
      (check) => `  ${check.status === "ok" ? "\u2713" : "\u2717"} ${check.name}${check.detail ? ` \u2014 ${check.detail}` : ""}`,
    ),
  ];
  emit(ctx, `${lines.join("\n")}\n`, report);
  return report.status === "ok" ? EXIT.OK : EXIT.ERROR;
}

export async function ready(ctx) {
  requireBase(ctx);
  const report = await engineFor(ctx).ready();
  const human = [`ready: ${report.ready ? "yes" : "no"}`, ...report.missing.map((item) => `  missing: ${item}`)].join("\n");
  emit(ctx, `${human}\n`, report);
  return report.ready ? EXIT.OK : EXIT.UNAVAILABLE;
}

export async function agents(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const list = await engineFor(ctx).agents();
  const rows = list.agents.map((agent) => [
    agent.id,
    agent.engine,
    agent.availability.available ? "available" : `unavailable (${agent.availability.reason})`,
    agent.external ? "external" : "native",
    Object.entries(agent.capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(","),
  ]);
  emit(ctx, `${table(rows, ["agent", "engine", "availability", "kind", "capabilities"]).join("\n")}\n`, list);
  return EXIT.OK;
}

export async function models(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const list = await engineFor(ctx).models();
  const rows = list.models.map((model) => [
    `${model.ref.providerId}/${model.ref.modelId}`,
    model.costClass,
    model.availability.available ? "available" : `unavailable (${model.availability.reason})`,
    model.streaming ? "yes" : "no",
    model.toolCalling ? "yes" : "no",
  ]);
  const human = [
    ...table(rows, ["model", "cost", "availability", "streams", "tools"]),
    "",
    `zero-cost route: ${list.route.length > 0 ? list.route.map((ref) => `${ref.providerId}/${ref.modelId}`).join(" -> ") : "(none)"}`,
    "paid models: refused",
  ].join("\n");
  emit(ctx, `${human}\n`, list);
  return EXIT.OK;
}

export async function capabilities(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const engine = engineFor(ctx);
  const [report, agentList, modelList] = await Promise.all([engine.health(), engine.agents(), engine.models()]);
  if (report.contractVersion !== CONTRACT_VERSION) {
    throw new CoderaxError(
      "CONTRACT_MISMATCH",
      `the engine serves contract ${report.contractVersion}; this CLI is built for ${CONTRACT_VERSION}`,
    );
  }
  const payload = {
    contractVersion: report.contractVersion,
    engines: report.engines,
    agents: agentList.agents.map((agent) => ({
      id: agent.id,
      available: agent.availability.available,
      reason: agent.availability.reason,
      capabilities: agent.capabilities,
    })),
    models: modelList.models.map((model) => ({
      ref: `${model.ref.providerId}/${model.ref.modelId}`,
      costClass: model.costClass,
      available: model.availability.available,
    })),
    cli: { ...CAPABILITIES, eventSchemaVersion: 1 },
  };
  const engineRows = report.engines.map((item) => [
    item.id,
    item.availability.available ? "available" : item.availability.reason,
    Object.entries(item.capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(","),
  ]);
  const human = [
    `${contractBanner()}`,
    ...table(engineRows, ["engine", "availability", "capabilities"]),
    "",
    `streaming events   ${CAPABILITIES.streaming ? "yes" : "no"}`,
    `file transfers     ${CAPABILITIES.fileTransfers ? "yes" : "no (not in contract 1.0.0; artifact metadata only)"}`,
  ].join("\n");
  emit(ctx, `${human}\n`, payload);
  return EXIT.OK;
}

export async function chat(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const message = await promptText(ctx, "chat");
  const { agent, mode, model, conversationId } = selection(ctx);
  const request = { message };
  if (agent !== undefined) request.agent = agent;
  if (mode !== undefined) request.mode = mode;
  if (model !== undefined) request.model = model;
  if (conversationId !== undefined) request.conversationId = conversationId;

  const reply = await engineFor(ctx).chat(request);
  if (ctx.json) {
    ctx.out(formatJson(reply));
  } else {
    ctx.out(reply.text);
    ctx.err(`conversation ${reply.conversationId}`);
  }
  return EXIT.OK;
}

export async function work(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const objective = await promptText(ctx, "work");
  const { agent, mode, model, conversationId } = selection(ctx);
  const engine = engineFor(ctx);

  const request = {
    objective,
    requireApproval: !ctx.flags.has("no-approval"),
  };
  if (agent !== undefined) request.agent = agent;
  if (mode !== undefined) request.mode = mode;
  if (model !== undefined) request.model = model;
  if (conversationId !== undefined) request.conversationId = conversationId;

  const accepted = await engine.submitWork(request);
  if (!ctx.json) ctx.err(`task ${accepted.taskId} (${accepted.state}) conversation ${accepted.conversationId}`);

  if (ctx.flags.has("detach")) {
    emit(
      ctx,
      `detached; task ${accepted.taskId} continues on the engine.\n  follow  coderax events ${accepted.taskId}\n  status  coderax task ${accepted.taskId}\n  cancel  coderax cancel ${accepted.taskId}\n`,
      { ...accepted, detached: true },
    );
    return EXIT.OK;
  }

  const after = Number(ctx.flags.get("after") ?? 0);
  if (!Number.isInteger(after) || after < 0) throw usage("--after must be a non-negative integer");

  let assembler;
  try {
    assembler = await followTaskEvents({
      client: engine,
      taskId: accepted.taskId,
      after,
      signal: ctx.signal,
      onEvent: (event, outcome) => {
        if (outcome.kind === "approval") {
          renderTaskEvent(ctx, event, outcome);
          // The task is deliberately paused until the owner decides. Following
          // the stream would wait forever, so detach and leave the exact
          // approval commands in front of the owner.
          throw new CoderaxError("DETACHED", "task is awaiting an owner approval decision");
        }
        renderTaskEvent(ctx, event, outcome);
      },
    });
  } catch (error) {
    if (error?.code === "DETACHED") {
      if (!ctx.json) {
        ctx.err(`detached; task ${accepted.taskId} is awaiting an approval decision.`);
        ctx.err(`  approve/deny or follow: coderax events ${accepted.taskId}`);
      } else {
        ctx.out(formatJson({ ...accepted, detached: true, state: "awaiting_approval" }));
      }
      return EXIT.OK;
    }
    if (error?.code === "CANCELLED") {
      if (!ctx.json) {
        ctx.err(`detached; task ${accepted.taskId} continues on the engine.`);
        ctx.err(`  follow  coderax events ${accepted.taskId}`);
        ctx.err(`  cancel  coderax cancel ${accepted.taskId}`);
      } else {
        ctx.out(formatJson({ ...accepted, detached: true }));
      }
      return EXIT.CANCELLED;
    }
    if (error?.code === "STREAM_DISCONNECTED" || error?.code === "REQUEST_TIMEOUT" || error?.code === "REQUEST_FAILED") {
      throw new CoderaxError(
        error.code,
        `${error.message}\n  task ${accepted.taskId} may still be running; follow it with \`coderax events ${accepted.taskId}\``,
      );
    }
    throw error;
  }

  // Task status is authoritative; the stream is a rendering of it. The
  // completion summary is the engine's final answer, while the stream shows
  // progress, so the summary wins for machine output.
  const status = await engine.task(accepted.taskId);
  const text = status.result?.summary || assembler.text || "";
  if (ctx.json) {
    ctx.out(
      formatJson({
        taskId: status.taskId,
        conversationId: status.conversationId,
        state: status.state,
        generation: status.generation,
        text,
        streamedText: assembler.text,
        summary: status.result?.summary ?? null,
        artifacts: status.result?.artifacts ?? [],
        usage: status.usage ?? assembler.usage ?? null,
        events: assembler.eventCount,
      }),
    );
  } else {
    // The streamed text was already written live. Printing the completion
    // summary as well would duplicate every word on screen; only a task with no
    // streamed text needs the authoritative summary printed here.
    if (!assembler.text && text) ctx.out(text);
    ctx.out("");
    const artifacts = status.result?.artifacts ?? [];
    if (artifacts.length > 0) {
      ctx.out(`artifacts (metadata only in contract ${CONTRACT_VERSION}):`);
      for (const artifact of artifacts) {
        ctx.out(`  ${artifact.path}${artifact.bytes !== undefined ? ` (${artifact.bytes} bytes)` : ""}${artifact.digest ? ` ${artifact.digest}` : ""}`);
      }
    }
    ctx.err(`task ${status.taskId} ${status.state} (generation ${status.generation})`);
    if (status.failure) ctx.err(`failure ${status.failure.code}${status.failure.detail ? `: ${status.failure.detail}` : ""}`);
  }
  return exitForState(status.state);
}

export async function task(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const taskId = ctx.args[0];
  if (!taskId) throw usage("task requires a task id");
  const status = await engineFor(ctx).task(taskId);

  if (ctx.json) {
    ctx.out(formatJson(status));
    return EXIT.OK;
  }
  ctx.out(`task      ${status.taskId}`);
  ctx.out(`state     ${status.state}`);
  ctx.out(`agent     ${status.agent} (${status.mode})`);
  if (status.model) ctx.out(`model     ${status.model.providerId}/${status.model.modelId}`);
  ctx.out(`generation ${status.generation}`);
  ctx.out(`updated   ${status.updatedAt}`);
  if (status.leaseExpiresAt) ctx.out(`lease     ${status.leaseExpiresAt}`);
  if (status.cancelRequested) ctx.out("cancel    requested");
  if (status.steps.length > 0) {
    ctx.out("steps:");
    for (const step of status.steps) ctx.out(`  ${step.state.padEnd(10)} ${step.title || step.id}`);
  }
  if (status.result?.summary) ctx.out(`summary   ${status.result.summary}`);
  if (status.result?.artifacts?.length) {
    ctx.out("artifacts:");
    for (const artifact of status.result.artifacts) ctx.out(`  ${artifact.path}`);
  }
  if (status.failure) ctx.out(`failure   ${status.failure.code}${status.failure.detail ? `: ${status.failure.detail}` : ""}`);
  return EXIT.OK;
}

/**
 * Task discovery. Contract 1.0.0 has no "list tasks" operation, so durable
 * completions are discovered through notifications. `task <id>` is the
 * authoritative status read; this command never invents state.
 */
export async function tasks(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const list = await engineFor(ctx).notifications();
  if (ctx.json) {
    ctx.out(formatJson(list));
    return EXIT.OK;
  }
  if (list.notifications.length === 0) {
    ctx.out("no durable tasks reported yet.");
    ctx.out("use `coderax conversations` for Chat/Work history, or `coderax task <id>` with a known id.");
    return EXIT.OK;
  }
  const rows = list.notifications.map((item) => [
    item.taskId,
    item.state,
    item.summary ?? "",
    item.createdAt,
  ]);
  ctx.out(`${table(rows, ["task", "state", "summary", "created"]).join("\n")}`);
  ctx.out("");
  ctx.out(`${list.unread} unread \u2022 this list is derived from durable notifications (contract ${CONTRACT_VERSION} has no task-list operation)`);
  return EXIT.OK;
}

export async function events(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const taskId = ctx.args[0];
  if (!taskId) throw usage("events requires a task id");
  const after = Number(ctx.flags.get("after") ?? 0);
  if (!Number.isInteger(after) || after < 0) throw usage("--after must be a non-negative integer");
  const engine = engineFor(ctx);
  const once = ctx.flags.has("once");

  if (once) {
    const { EventAssembler } = await import("./events.js");
    const assembler = new EventAssembler();
    for await (const event of engine.events(taskId, { after, signal: ctx.signal })) {
      const outcome = assembler.apply(event);
      if (outcome.kind === "duplicate") continue;
      if (ctx.json) ctx.out(`${JSON.stringify(event)}\n`);
      else renderTaskEvent(ctx, event, outcome);
      if (assembler.terminal) break;
    }
    if (!ctx.json) {
      if (assembler.text) ctx.out("");
      ctx.err(`replayed ${assembler.eventCount} event(s); stopped at seq ${assembler.lastSeq}`);
    }
    return EXIT.OK;
  }

  const assembler = await followTaskEvents({
    client: engine,
    taskId,
    after,
    signal: ctx.signal,
    onEvent: (event, outcome) => {
      if (ctx.json) ctx.out(`${JSON.stringify(event)}\n`);
      else renderTaskEvent(ctx, event, outcome);
    },
  });
  if (!ctx.json) {
    if (assembler.text) ctx.out("");
    ctx.err(`task ${taskId} ${assembler.terminal?.state ?? "stream ended"} (seq ${assembler.lastSeq})`);
  } else {
    ctx.out(
      `${JSON.stringify({
        taskId,
        state: assembler.terminal?.state ?? null,
        text: assembler.text,
        seq: assembler.lastSeq,
        events: assembler.eventCount,
      })}\n`,
    );
  }
  return EXIT.OK;
}

export async function cancel(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const taskId = ctx.args[0];
  if (!taskId) throw usage("cancel requires a task id");
  const reason = ctx.flags.get("reason");
  const result = await engineFor(ctx).cancel(taskId, reason);
  emit(
    ctx,
    `cancel ${result.outcome}: task ${result.taskId} is ${result.state} (generation ${result.generation})`,
    result,
  );
  return EXIT.OK;
}

async function control(ctx, kind) {
  requireBase(ctx);
  requireAuth(ctx);
  const taskId = ctx.args[0];
  if (!taskId) throw usage(`${kind} requires a task id`);
  const engine = engineFor(ctx);
  let generation = ctx.flags.has("generation") ? Number(ctx.flags.get("generation")) : undefined;
  if (generation !== undefined && (!Number.isInteger(generation) || generation < 0)) {
    throw usage("--generation must be a non-negative integer");
  }
  if (generation === undefined) {
    const status = await engine.task(taskId);
    generation = status.generation;
  }
  const model = kind === "retry" ? parseModelRef(ctx.flags.get("model")) : undefined;
  const result = kind === "retry"
    ? await engine.retry(taskId, generation, model)
    : await engine.resume(taskId, generation);
  emit(
    ctx,
    `${kind} ${result.outcome}: task ${result.taskId} is ${result.state} (generation ${result.generation})`,
    result,
  );
  return EXIT.OK;
}

export function resume(ctx) {
  return control(ctx, "resume");
}

export function retry(ctx) {
  return control(ctx, "retry");
}

function renderPermissions(ctx, taskId, list) {
  if (ctx.json) {
    ctx.out(formatJson(list));
    return;
  }
  if (list.requests.length === 0) {
    ctx.out(`no permission requests for ${taskId}.`);
    return;
  }
  const pending = list.requests.filter((request) => request.decision === "pending");
  const rows = list.requests.map((request) => [
    request.decision,
    request.scope,
    request.resource,
    request.requestId,
    request.description,
  ]);
  ctx.out(`${table(rows, ["decision", "scope", "resource", "request", "description"]).join("\n")}`);
  if (pending.length > 0) {
    ctx.out("");
    for (const request of pending) {
      ctx.out(`approve  coderax approve ${taskId} ${request.requestId}`);
      ctx.out(`deny     coderax deny ${taskId} ${request.requestId}`);
    }
  }
}

export async function permissions(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const taskId = ctx.args[0];
  if (!taskId) throw usage("permissions requires a task id");
  renderPermissions(ctx, taskId, await engineFor(ctx).permissions(taskId));
  return EXIT.OK;
}

async function decide(ctx, decision) {
  requireBase(ctx);
  requireAuth(ctx);
  const [taskId, requestId] = ctx.args;
  if (!taskId || !requestId) {
    throw usage(`${decision === "approved" ? "approve" : "deny"} requires <taskId> <requestId>`);
  }
  const request = { requestId, decision };
  const reason = ctx.flags.get("reason");
  if (reason !== undefined) request.reason = reason;
  const list = await engineFor(ctx).decidePermission(taskId, request);
  const decided = list.requests.find((item) => item.requestId === requestId);
  if (ctx.json) {
    ctx.out(formatJson(list));
  } else if (decided) {
    ctx.out(`${decided.decision}: ${decided.scope} ${decided.resource} for task ${taskId}`);
    if (decided.decision === "pending") ctx.out("the decision was not recorded; the request may have expired.");
  } else {
    ctx.out(`decision recorded for request ${requestId}; the engine no longer lists it.`);
  }
  return decided && decided.decision === "pending" ? EXIT.ERROR : EXIT.OK;
}

export function approve(ctx) {
  return decide(ctx, "approved");
}

export function deny(ctx) {
  return decide(ctx, "denied");
}

export async function notifications(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const list = await engineFor(ctx).notifications();
  if (ctx.json) {
    ctx.out(formatJson(list));
    return EXIT.OK;
  }
  if (list.notifications.length === 0) {
    ctx.out("no notifications.");
    return EXIT.OK;
  }
  const rows = list.notifications.map((item) => [
    item.read ? "read" : "unread",
    item.state,
    item.taskId,
    item.summary ?? "",
    item.createdAt,
  ]);
  ctx.out(`${table(rows, ["", "state", "task", "summary", "created"]).join("\n")}`);
  ctx.out("");
  ctx.out(`${list.unread} unread`);
  return EXIT.OK;
}

export async function conversations(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const list = await engineFor(ctx).conversations();
  if (ctx.json) {
    ctx.out(formatJson(list));
    return EXIT.OK;
  }
  if (list.conversations.length === 0) {
    ctx.out("no conversations.");
    return EXIT.OK;
  }
  const rows = list.conversations.map((conversation) => [
    conversation.conversationId,
    conversation.isWork ? "work" : "chat",
    conversation.agent,
    conversation.title ?? "",
    conversation.updatedAt,
  ]);
  ctx.out(`${table(rows, ["conversation", "mode", "agent", "title", "updated"]).join("\n")}`);
  return EXIT.OK;
}

export async function conversation(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const conversationId = ctx.args[0];
  if (!conversationId) throw usage("conversation requires a conversation id");
  const result = await engineFor(ctx).conversation(conversationId);
  if (ctx.json) {
    ctx.out(formatJson(result));
    return EXIT.OK;
  }
  ctx.out(`conversation ${result.conversationId} (${result.isWork ? "work" : "chat"}, ${result.agent})`);
  if (result.title) ctx.out(`title ${result.title}`);
  ctx.out("");
  for (const message of result.messages) {
    ctx.out(`[${message.role}${message.agent ? `:${message.agent}` : ""}]${message.unfinished ? " (unfinished)" : ""}`);
    ctx.out(message.text);
    ctx.out("");
  }
  return EXIT.OK;
}

export async function memory(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const mode = ctx.flags.get("mode") ?? "private";
  if (!DATA_MODES.includes(mode)) throw usage("--mode must be private or cloud");
  const list = await engineFor(ctx).memory(mode);
  if (ctx.json) {
    ctx.out(formatJson(list));
    return EXIT.OK;
  }
  if (list.entries.length === 0) {
    ctx.out(`no ${mode} memory entries.`);
    return EXIT.OK;
  }
  const rows = list.entries.map((entry) => [entry.key, entry.mode, entry.updatedAt, entry.value]);
  ctx.out(`${table(rows, ["key", "mode", "updated", "value"]).join("\n")}`);
  return EXIT.OK;
}

export async function artifacts(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  const taskId = ctx.args[0];
  if (!taskId) throw usage("artifacts requires a task id");
  const status = await engineFor(ctx).task(taskId);
  const list = status.result?.artifacts ?? [];
  const payload = {
    taskId,
    artifacts: list,
    transferSupported: false,
    note: `contract ${CONTRACT_VERSION} exposes artifact metadata only; no upload or download operation exists`,
  };
  if (ctx.json) {
    ctx.out(formatJson(payload));
    return EXIT.OK;
  }
  if (list.length === 0) ctx.out(`no artifacts recorded for ${taskId}.`);
  else {
    for (const artifact of list) {
      ctx.out(`${artifact.path}${artifact.bytes !== undefined ? ` (${artifact.bytes} bytes)` : ""}${artifact.digest ? ` ${artifact.digest}` : ""}`);
    }
  }
  ctx.out("");
  ctx.out(payload.note);
  return EXIT.OK;
}

export async function doctor(ctx) {
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    ok: major >= 24,
    detail: process.versions.node,
    hint: major >= 24 ? "" : "Node 24 or newer is required.",
  });

  const directory = dirname(ctx.settings.configPath);
  let dirMode = null;
  try {
    dirMode = statSync(directory).mode & 0o777;
  } catch {
    dirMode = null;
  }
  checks.push({
    name: "config-dir",
    ok: process.platform === "win32" || dirMode === null || dirMode === 0o700,
    detail: dirMode === null ? `${directory} (not created yet)` : `${directory} (${dirMode.toString(8)})`,
    hint:
      process.platform === "win32" || dirMode === null || dirMode === 0o700
        ? ""
        : "Run `chmod 700` on the config directory.",
  });

  checks.push({
    name: "base-url",
    ok: Boolean(ctx.settings.baseUrl),
    detail: ctx.settings.baseUrl || "(unset)",
    hint: ctx.settings.baseUrl ? "" : "Run `coderax config set --base-url https://your-engine`.",
  });
  checks.push({
    name: "owner-token",
    ok: Boolean(ctx.settings.token),
    detail: ctx.settings.token
      ? `${maskToken(ctx.settings.token)} via ${ctx.env.CODERAX_TOKEN ? "environment" : "config file"}`
      : "no token",
    hint: ctx.settings.token ? "" : "Run `coderax login`.",
  });

  let contractVersion = null;
  if (ctx.settings.baseUrl) {
    const engine = engineFor(ctx);
    try {
      const report = await engine.health();
      contractVersion = report.contractVersion;
      checks.push({
        name: "health",
        ok: report.status === "ok",
        detail: `${report.status} \u2022 contract ${report.contractVersion} \u2022 up ${Math.round(report.uptimeMs / 1000)}s`,
        hint: report.status === "ok" ? "" : "Inspect the engine's failing checks.",
      });
      checks.push({
        name: "contract",
        ok: report.contractVersion === CONTRACT_VERSION,
        detail: `client ${CONTRACT_VERSION}, engine ${report.contractVersion}`,
        hint:
          report.contractVersion === CONTRACT_VERSION
            ? ""
            : "Install the CLI built for the engine's contract version.",
      });
      const readiness = await engine.ready();
      checks.push({
        name: "readiness",
        ok: readiness.ready,
        detail: readiness.ready ? "ready" : `missing: ${readiness.missing.join(", ")}`,
        hint: readiness.ready ? "" : "Resolve the missing startup configuration.",
      });
    } catch (error) {
      checks.push({
        name: "health",
        ok: false,
        detail: error.message,
        hint: "Confirm the engine URL and that it is running.",
      });
    }

    if (ctx.settings.token) {
      try {
        const list = await engine.agents();
        checks.push({
          name: "owner-auth",
          ok: true,
          detail: `owner token accepted; ${list.agents.length} agents discovered`,
          hint: "",
        });
      } catch (error) {
        checks.push({
          name: "owner-auth",
          ok: false,
          detail: error.message,
          hint: "The token was rejected; run `coderax login` again.",
        });
      }
    }
  }

  const ok = checks.every((check) => check.ok);
  if (ctx.json) {
    ctx.out(formatJson({ ok, version: VERSION, contractVersion, checks }));
    return ok ? EXIT.OK : EXIT.ERROR;
  }
  for (const check of checks) {
    ctx.out(`${check.ok ? "\u2713" : "\u2717"} ${check.name.padEnd(14)} ${check.detail}`);
    if (!check.ok && check.hint) ctx.out(`  \u2192 ${check.hint}`);
  }
  return ok ? EXIT.OK : EXIT.ERROR;
}
