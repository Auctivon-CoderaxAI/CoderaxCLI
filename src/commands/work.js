import { CoderaxError, CancelledError, EXIT, UsageError } from "../errors.js";
import { newSubmissionKey, resolveSubmission, submitWork } from "../engine/submit.js";
import { watchTask } from "../engine/stream.js";
import { buildTemplateObjective, getTemplate, templateNames, WORK_TEMPLATES } from "../work/templates.js";
import { WorkPresenter, renderTaskStatus } from "../ui/presenter.js";
import { PromptSession, Spinner } from "../ui/prompt.js";
import { renderTable } from "../ui/tables.js";
import { parseModelRef } from "../engine/submit.js";

const SUBCOMMANDS = new Set([
  "submit", "list", "status", "watch", "attach", "report", "cancel", "resume",
  "retry", "resolve", "uncertain", "templates",
]);

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function exitForTaskState(state) {
  if (state === "completed") return EXIT.OK;
  if (state === "cancelled") return EXIT.CANCELLED;
  if (state === "interrupted") return EXIT.ERROR;
  if (state === "failed") return EXIT.ERROR;
  return EXIT.OK;
}

function linkedController(runtime) {
  const controller = new AbortController();
  const outer = runtime.signal;
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
  }
  return controller;
}

function streamEnabled(runtime) {
  return !runtime.json;
}

async function createPrompt(runtime) {
  if (!runtime.isTTY) return null;
  return new PromptSession({
    input: runtime.stdin,
    output: runtime.stdoutStream,
    error: runtime.stderrStream,
    style: runtime.style,
  });
}

async function approvalHandler({ runtime, client, taskId, prompt, approveAll, denyAll }) {
  return async (event) => {
    if (approveAll || denyAll) {
      const decision = approveAll ? "approved" : "denied";
      await client.decidePermission(taskId, {
        requestId: event.requestId,
        decision,
        ...(approveAll ? {} : { reason: "denied by the owner's non-interactive policy" }),
      });
      if (!runtime.json && !runtime.ndjson) runtime.err(`${decision} ${event.tool} (${event.requestId})`);
      return { decision };
    }
    if (!prompt || runtime.json || runtime.ndjson) {
      const list = await client.permissions(taskId);
      const existing = list.requests.find((entry) => entry.requestId === event.requestId);
      if (existing && existing.decision !== "pending") return { decision: existing.decision };
      throw new CoderaxError(
        "PERMISSION_REQUIRED",
        `the task needs approval for ${event.tool}`,
        {
          details: { taskId, requestId: event.requestId, tool: event.tool },
          hint: `Decide with \`coderax permissions decide ${taskId} ${event.requestId} --approve\`, then attach again.`,
        },
      );
    }
    const list = await client.permissions(taskId);
    const request = list.requests.find((entry) => entry.requestId === event.requestId);
    if (request) {
      runtime.write("");
      runtime.write(runtime.style.bold("Permission request"));
      runtime.write(`  scope     ${request.scope}`);
      runtime.write(`  resource  ${request.resource}`);
      runtime.write(`  agent     ${request.agent}`);
      runtime.write(`  request   ${request.requestId}`);
      runtime.write(`  ${request.description}`);
    }
    const approved = await prompt.confirm(`Approve ${event.tool}?`, { defaultYes: false });
    const decision = approved ? "approved" : "denied";
    await client.decidePermission(taskId, { requestId: event.requestId, decision });
    runtime.write(`${approved ? runtime.style.green("\u2713") : runtime.style.red("\u2717")} ${decision}`);
    return { decision };
  };
}

function budgetFromFlags(runtime) {
  const requests = runtime.flags.get("budget-requests");
  const input = runtime.flags.get("budget-input");
  const output = runtime.flags.get("budget-output");
  if (requests === undefined && input === undefined && output === undefined) return undefined;
  if (requests === undefined || input === undefined || output === undefined) {
    throw new UsageError("a budget requires --budget-requests, --budget-input and --budget-output together");
  }
  const budget = {
    maxRequests: Number(requests),
    maxInputTokens: Number(input),
    maxOutputTokens: Number(output),
  };
  if (![budget.maxRequests, budget.maxInputTokens, budget.maxOutputTokens].every((value) => Number.isInteger(value) && value > 0)) {
    throw new UsageError("budget values must be positive integers");
  }
  return budget;
}

function objectiveFrom(runtime, positionals) {
  const pieces = positionals.slice();
  const flagObjective = runtime.flags.get("objective");
  if (flagObjective) pieces.push(flagObjective);
  return pieces.join(" ").trim();
}

async function resolveObjective(runtime, positionals) {
  const templateName = runtime.flags.get("template");
  let input = objectiveFrom(runtime, positionals);
  if (!input && !runtime.isTTY) input = (await runtime.readStdin()).trim();
  if (templateName) {
    if (!getTemplate(templateName)) {
      throw new UsageError(`unknown template: ${templateName}. Choose one of ${templateNames().join(", ")}`);
    }
    return { text: buildTemplateObjective(templateName, input), template: getTemplate(templateName), input };
  }
  if (!input) {
    throw new UsageError("no objective provided; usage: coderax work \"your objective\"");
  }
  return { text: input, template: null, input };
}

function taskAgent(runtime, status = null) {
  return runtime.flags.get("agent") || status?.agent || runtime.config.agent || "coderax";
}

function taskModel(runtime, status = null) {
  const value = runtime.flags.get("model") ?? (runtime.config.model || undefined) ?? (status?.model ? `${status.model.providerId}/${status.model.modelId}` : undefined);
  return parseModelRef(value);
}

async function activeConversation(runtime) {
  if (runtime.flags.has("new")) return null;
  if (runtime.flags.has("conversation")) return runtime.flags.get("conversation");
  const state = await runtime.state.load();
  return state.active.workConversationId ?? null;
}

async function ensureCapabilities(client, { agent, template, detach, model }) {
  const descriptor = await client.requireCapability(agent, template?.requiresTools ? "tools" : null);
  if (detach && descriptor.capabilities.durable !== true) {
    throw new CoderaxError("CAPABILITY_UNSUPPORTED", `agent ${agent} does not support durable tasks, so the task cannot be detached`, {
      details: { agent, capability: "durable" },
    });
  }
  if (model && descriptor.capabilities.modelSelection !== true) {
    throw new CoderaxError("CAPABILITY_UNSUPPORTED", `agent ${agent} does not support model selection`, {
      details: { agent, capability: "modelSelection" },
    });
  }
  return descriptor;
}

async function startWatch({
  runtime,
  client,
  task,
  fromSeq = 0,
  prompt,
  approveAll,
  denyAll,
  command = "work",
  context = null,
}) {
  const attachCommand = command.startsWith("workflow.") ? "coderax workflow attach" : "coderax work attach";
  const controller = linkedController(runtime);
  const spinner = new Spinner({
    stream: runtime.stderrStream,
    style: runtime.style,
    text: `task ${task.taskId}`,
  });
  const events = [];
  const presenter = new WorkPresenter({
    out: runtime.json || runtime.ndjson ? () => {} : (text) => runtime.raw(text),
    style: runtime.style,
    width: runtime.width,
    verbose: runtime.flags.has("verbose"),
    quiet: runtime.json || runtime.ndjson,
    onApproval: await approvalHandler({ runtime, client, taskId: task.taskId, prompt, approveAll, denyAll }),
    onProgress: (progress) => {
      if (runtime.json || runtime.ndjson || !runtime.stdoutIsTTY) return;
      if (progress === null) {
        spinner.stop();
        return;
      }
      if (!spinner.active) spinner.start(progress.step ?? `task ${task.taskId}`);
      if (progress.step) spinner.setText(progress.step);
      else if (progress.tool) spinner.setText(`${progress.tool}  task ${task.taskId}`);
    },
    now: () => Date.now(),
  });
  if (!runtime.json && !runtime.ndjson && runtime.stdoutIsTTY) spinner.start(`task ${task.taskId} queued`);

  const onEvent = async (event) => {
    events.push(event);
    if (events.length > 1000) events.shift();
    runtime.emitEvent(command, event);
    // Persist the cursor before rendering or prompting. If a render or an
    // approval prompt throws, a later attach can still resume after this event.
    await runtime.state.upsertTask({
      taskId: task.taskId,
      state: event.type === "task.queued" ? "queued" : event.type === "task.started" ? "running" : undefined,
      lastSeq: event.seq,
      updatedAt: new Date().toISOString(),
    });
    await presenter.onEvent(event);
  };

  try {
    const result = await watchTask({
      client,
      taskId: task.taskId,
      after: fromSeq,
      signal: controller.signal,
      onEvent,
      onCheckpoint: async (lastSeq) => {
        await runtime.state.upsertTask({ taskId: task.taskId, lastSeq, updatedAt: new Date().toISOString() });
      },
      onStatus: async (status) => {
        await runtime.state.upsertTask({
          taskId: task.taskId,
          state: status.state,
          generation: status.generation,
          conversationId: status.conversationId,
          updatedAt: new Date().toISOString(),
        });
      },
      onReconnect: ({ attempt, delayMs, reason }) => {
        if (runtime.flags.has("verbose")) runtime.err(`reconnecting (${reason}) attempt ${attempt} in ${delayMs}ms`);
      },
      onUnknown: (event) => {
        if (runtime.flags.has("verbose")) runtime.err(`ignored unknown event type: ${event?.type ?? "unknown"}`);
      },
      maxReconnects: Number(runtime.flags.get("max-reconnects") ?? 12),
    });
    spinner.stop();
    // A terminal event carries the outcome, but the task resource carries the
    // authoritative artifacts and any server-side final state. Read it once; a
    // failed status read must not discard a completed stream.
    let finalStatus = result.status ?? null;
    if (!finalStatus && result.terminalEvent) {
      finalStatus = await client.task(task.taskId, { signal: controller.signal }).catch(() => null);
    }
    const summary = presenter.finish({ ...result, status: finalStatus });
    await runtime.state.upsertTask({
      taskId: task.taskId,
      state: summary.state,
      lastSeq: result.lastSeq,
      updatedAt: new Date().toISOString(),
      lastSummary: summary.summary ?? null,
    });
    const data = {
      task: task.taskId,
      conversationId: task.conversationId,
      state: summary.state,
      ...summary,
      events,
      status: finalStatus,
      ...(context ? { workflow: context } : {}),
    };
    runtime.emit(command, data);
    return exitForTaskState(summary.state);
  } catch (error) {
    spinner.stop();
    if (error instanceof CancelledError) {
      const reason = controller.signal.reason;
      if (reason === "detach") {
        await runtime.state.upsertTask({ taskId: task.taskId, detached: true, updatedAt: new Date().toISOString() });
        runtime.write("");
        runtime.write(`Detached. Task ${task.taskId} keeps running in the cloud.`);
        runtime.write(runtime.style.dim(`Reattach with: ${attachCommand} ${task.taskId}`));
        return EXIT.OK;
      }
      if (reason === "cancel" || runtime.flags.has("cancel-on-interrupt")) {
        const result = await client.cancel(task.taskId, "cancelled from the terminal").catch((cancelError) => {
          runtime.err(`could not cancel: ${cancelError.message}`);
          return null;
        });
        await runtime.state.upsertTask({ taskId: task.taskId, state: result?.state ?? "cancelled", updatedAt: new Date().toISOString() });
        runtime.write("");
        runtime.write(`Cancelled task ${task.taskId}${result ? ` (${result.outcome})` : ""}.`);
        return EXIT.CANCELLED;
      }
      throw error;
    }
    throw error;
  } finally {
    spinner.stop();
  }
}

export async function submitCommand(runtime, positionals, {
  command = "work.submit",
  objectiveOverride = null,
  template = null,
  client: providedClient = null,
  context = null,
} = {}) {
  const resolved = objectiveOverride
    ? { text: objectiveOverride, template }
    : await resolveObjective(runtime, positionals);
  const { text } = resolved;
  const activeTemplate = resolved.template;
  const client = providedClient ?? await runtime.getEngine();
  const agent = taskAgent(runtime);
  const model = taskModel(runtime);
  const detach = runtime.flags.has("detach");
  await ensureCapabilities(client, { agent, template: activeTemplate, detach, model });
  const conversationId = await activeConversation(runtime);
  const mode = runtime.flags.get("mode") ?? "cloud";

  const request = {
    objective: text,
    mode,
    requireApproval: !runtime.flags.has("approve-all"),
  };
  if (conversationId) request.conversationId = conversationId;
  if (agent) request.agent = agent;
  if (model) request.model = model;
  const budget = budgetFromFlags(runtime);
  if (budget) request.budget = budget;

  const idempotencyKey = runtime.flags.get("idempotency-key") ?? newSubmissionKey();
  const submitted = await submitWork({
    client,
    state: runtime.state,
    request,
    idempotencyKey,
    retryUncertain: runtime.flags.has("retry-submission"),
    signal: runtime.signal ?? undefined,
  });
  const task = submitted.task;
  if (!task.conversationId && submitted.accepted?.conversationId) task.conversationId = submitted.accepted.conversationId;
  await runtime.state.setActive({ mode: "work", workConversationId: task.conversationId ?? null });
  if (runtime.ndjson) runtime.emitEvent(command, { type: "accepted", task });
  await runtime.state.addHistory("work", text);

  if (detach) {
    const data = {
      accepted: submitted.accepted,
      task: { ...task, submissionKey: submitted.submissionKey },
      detached: true,
      ...(context ? { workflow: context } : {}),
    };
    runtime.emit(command, data, () => {
      runtime.write(`${runtime.style.green("\u2713")} task ${task.taskId} accepted`);
      runtime.write(`  conversation ${task.conversationId}`);
      runtime.write(`  submission   ${submitted.submissionKey}`);
      const attachCommand = command.startsWith("workflow.") ? "coderax workflow attach" : "coderax work attach";
      runtime.write(runtime.style.dim(`Attach with: ${attachCommand} ${task.taskId}`));
    });
    return EXIT.OK;
  }

  const prompt = await createPrompt(runtime);
  try {
    return await startWatch({
      runtime,
      client,
      task,
      prompt,
      approveAll: runtime.flags.has("approve-all"),
      denyAll: runtime.flags.has("deny-all"),
      command,
      context,
    });
  } finally {
    prompt?.close();
  }
}

export async function listCommand(runtime) {
  const limit = Math.max(1, Math.min(200, Number(runtime.flags.get("limit") ?? 30)));
  const tasks = await runtime.state.listTasks({ limit });
  let notifications = null;
  try {
    const client = await runtime.getEngine({ negotiate: false });
    notifications = await client.notifications();
  } catch {
    notifications = null;
  }
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  for (const notification of notifications?.notifications ?? []) {
    if (!byId.has(notification.taskId)) {
      byId.set(notification.taskId, {
        taskId: notification.taskId,
        conversationId: notification.conversationId,
        state: notification.state,
        agent: notification.agent,
        objective: notification.summary ?? "(from a notification)",
        updatedAt: notification.createdAt,
        lastSeq: 0,
        fromNotification: true,
      });
    }
  }
  let entries = [...byId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (runtime.flags.has("refresh")) {
    const client = await runtime.getEngine();
    const selected = entries.slice(0, Math.min(limit, 20));
    const refreshed = await Promise.all(selected.map(async (task) => {
      try {
        const status = await client.task(task.taskId);
        return { ...task, state: status.state, agent: status.agent, conversationId: status.conversationId, updatedAt: status.updatedAt, steps: status.steps };
      } catch {
        return task;
      }
    }));
    const refreshedById = new Map(refreshed.map((task) => [task.taskId, task]));
    entries = entries.map((task) => refreshedById.get(task.taskId) ?? task);
  }
  runtime.emit("work.list", { tasks: entries.slice(0, limit) }, () => {
    if (entries.length === 0) {
      runtime.write("No known tasks. Start one with `coderax work \"...\"`.");
      return;
    }
    runtime.write(renderTable({
      headers: ["", "TASK", "STATE", "AGENT", "UPDATED", "OBJECTIVE"],
      rows: entries.slice(0, limit).map((task) => [
        task.detached ? "\u21b7" : " ",
        task.taskId,
        task.state ?? "unknown",
        task.agent ?? "",
        task.updatedAt ?? "",
        task.objective ?? "",
      ]),
      style: runtime.style,
      width: runtime.width,
      maxColumnWidth: 44,
    }));
    runtime.write("");
    runtime.write(runtime.style.dim("The engine has no task-list operation; this merges the local journal with durable notifications."));
  });
  return EXIT.OK;
}

async function pickTask(runtime, positionals, index = 0) {
  const explicit = positionals[index] ?? runtime.flags.get("task");
  if (explicit) return explicit;
  const state = await runtime.state.load();
  const tasks = Object.values(state.tasks).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const forConversation = tasks.find((task) => task.conversationId === state.active.workConversationId);
  if (forConversation) return forConversation.taskId;
  if (tasks[0]) return tasks[0].taskId;
  throw new UsageError("no task id supplied and no task is recorded for this terminal");
}

export async function statusCommand(runtime, positionals, { command = "work.status", report = false } = {}) {
  const taskId = await pickTask(runtime, positionals);
  const client = await runtime.getEngine();
  const status = await client.task(taskId);
  runtime.emit(command, { status }, () => {
    runtime.write(renderTaskStatus(status, { style: runtime.style, out: (text) => runtime.raw(text), width: runtime.width }));
    if (report) {
      runtime.write("");
      runtime.write(runtime.style.dim(`agent ${status.agent}  mode ${status.mode}  generation ${status.generation}`));
    }
  });
  return exitForTaskState(status.state);
}

async function watchCommand(runtime, positionals, { command = "work.watch" } = {}) {
  const taskId = await pickTask(runtime, positionals);
  const client = await runtime.getEngine();
  const status = await client.task(taskId);
  if (TERMINAL.has(status.state)) {
    runtime.emit(command, { status }, () => {
      runtime.write(renderTaskStatus(status, { style: runtime.style, out: (text) => runtime.raw(text), width: runtime.width }));
    });
    return exitForTaskState(status.state);
  }
  const task = await runtime.state.task(taskId) ?? {
    taskId,
    conversationId: status.conversationId,
    agent: status.agent,
    state: status.state,
    lastSeq: 0,
  };
  const after = Number(runtime.flags.get("after") ?? task.lastSeq ?? 0);
  await runtime.state.setActive({ mode: "work", workConversationId: status.conversationId });
  const prompt = await createPrompt(runtime);
  try {
    return await startWatch({
      runtime,
      client,
      task,
      fromSeq: after,
      prompt,
      approveAll: runtime.flags.has("approve-all"),
      denyAll: runtime.flags.has("deny-all"),
      command,
    });
  } finally {
    prompt?.close();
  }
}

export async function cancelCommand(runtime, positionals) {
  const taskId = await pickTask(runtime, positionals);
  const client = await runtime.getEngine();
  const status = await client.task(taskId);
  const descriptor = await client.requireCapability(status.agent, "cancellation");
  if (!descriptor.capabilities.cancellation) {
    throw new CoderaxError("CAPABILITY_UNSUPPORTED", `agent ${status.agent} does not support cancellation`, {
      details: { agent: status.agent, capability: "cancellation" },
    });
  }
  const reason = runtime.flags.get("reason");
  const result = await client.cancel(taskId, reason);
  await runtime.state.upsertTask({ taskId, state: result.state, updatedAt: new Date().toISOString() });
  runtime.emit("work.cancel", { result }, () => {
    runtime.write(`${result.outcome === "accepted" ? runtime.style.green("\u2713") : runtime.style.yellow("\u25cb")} cancellation ${result.outcome}; state ${result.state}`);
    if (result.outcome === "already_terminal") runtime.write("The task had already finished.");
  });
  return result.state === "cancelled" ? EXIT.CANCELLED : EXIT.OK;
}

async function resumeCommand(runtime, positionals, { retry = false } = {}) {
  const taskId = await pickTask(runtime, positionals);
  const client = await runtime.getEngine();
  const status = await client.task(taskId);
  const descriptor = await client.requireCapability(status.agent, "resume");
  if (!descriptor.capabilities.resume) {
    throw new CoderaxError("CAPABILITY_UNSUPPORTED", `agent ${status.agent} does not support ${retry ? "retry" : "resume"}`, {
      details: { agent: status.agent, capability: "resume" },
    });
  }
  const generation = Number(runtime.flags.get("generation") ?? status.generation);
  if (!Number.isInteger(generation) || generation < 0) throw new UsageError("--generation must be a non-negative integer");
  const model = runtime.flags.has("model") ? parseModelRef(runtime.flags.get("model")) : undefined;
  const result = retry
    ? await client.retry(taskId, generation, model)
    : await client.resume(taskId, generation);
  await runtime.state.upsertTask({ taskId, state: result.state, generation: result.generation, updatedAt: new Date().toISOString() });
  const action = retry ? "work.retry" : "work.resume";
  if (runtime.flags.has("no-watch")) {
    runtime.emit(action, { result }, () => runtime.write(`${action.split(".")[1]} ${result.outcome}; state ${result.state}`));
    return EXIT.OK;
  }
  if (runtime.json || runtime.ndjson) {
    runtime.emit(action, { result });
    return EXIT.OK;
  }
  runtime.write(`${result.outcome === "accepted" ? runtime.style.green("\u2713") : runtime.style.yellow("\u25cb")} ${retry ? "retry" : "resume"} ${result.outcome}; generation ${result.generation}`);
  const task = await runtime.state.task(taskId) ?? { taskId, conversationId: status.conversationId, agent: status.agent, lastSeq: 0 };
  const prompt = await createPrompt(runtime);
  try {
    return await startWatch({
      runtime,
      client,
      task,
      fromSeq: task.lastSeq ?? 0,
      prompt,
      approveAll: runtime.flags.has("approve-all"),
      denyAll: runtime.flags.has("deny-all"),
      command: action,
    });
  } finally {
    prompt?.close();
  }
}

async function resolveCommand(runtime, positionals) {
  const [key, taskId] = positionals;
  if (!key || !taskId) throw new UsageError("work resolve requires <submission-key> <task-id>");
  const client = await runtime.getEngine();
  const result = await resolveSubmission({ client, state: runtime.state, key, taskId, signal: linkedController(runtime).signal });
  runtime.emit("work.resolve", { submission: result.submission, task: result.status }, () => {
    runtime.write(`${runtime.style.green("\u2713")} submission ${key} bound to ${taskId}`);
    runtime.write(`  state ${result.status.state}  agent ${result.status.agent}`);
  });
  return EXIT.OK;
}

async function uncertainCommand(runtime) {
  const state = await runtime.state.load();
  const entries = Object.values(state.submissions)
    .filter((entry) => entry.status === "uncertain")
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  runtime.emit("work.uncertain", { submissions: entries }, () => {
    if (entries.length === 0) {
      runtime.write("No uncertain submissions.");
      return;
    }
    runtime.write(renderTable({
      headers: ["KEY", "CREATED", "CONVERSATION", "OBJECTIVE"],
      rows: entries.map((entry) => [entry.key, entry.createdAt ?? "", entry.conversationId ?? "", entry.objective ?? ""]),
      style: runtime.style,
      width: runtime.width,
      maxColumnWidth: 36,
    }));
    runtime.write("");
    runtime.write(runtime.style.dim("Check the conversation in Coderax Web, then bind it with `coderax work resolve <key> <taskId>`."));
  });
  return EXIT.OK;
}

function templatesCommand(runtime) {
  const entries = templateNames().map((name) => ({
    name,
    label: WORK_TEMPLATES[name].label,
    requiresTools: WORK_TEMPLATES[name].requiresTools,
    summary: WORK_TEMPLATES[name].summary,
  }));
  runtime.emit("work.templates", { templates: entries }, () => {
    runtime.write(renderTable({
      headers: ["TEMPLATE", "LABEL", "TOOLS", "PURPOSE"],
      rows: entries.map((entry) => [entry.name, entry.label, entry.requiresTools ? "required" : "not required", entry.summary]),
      style: runtime.style,
      width: runtime.width,
      maxColumnWidth: 42,
    }));
  });
  return EXIT.OK;
}

export async function workCommand(runtime, positionals, { interactive = null } = {}) {
  const action = positionals[0];
  if (action && SUBCOMMANDS.has(action)) {
    const rest = positionals.slice(1);
    switch (action) {
      case "submit": return submitCommand(runtime, rest, { command: "work.submit" });
      case "list": return listCommand(runtime);
      case "status": return statusCommand(runtime, rest, { command: "work.status" });
      case "watch": return watchCommand(runtime, rest, { command: "work.watch" });
      case "attach": return watchCommand(runtime, rest, { command: "work.attach" });
      case "report": return statusCommand(runtime, rest, { command: "work.report", report: true });
      case "cancel": return cancelCommand(runtime, rest);
      case "resume": return resumeCommand(runtime, rest);
      case "retry": return resumeCommand(runtime, rest, { retry: true });
      case "resolve": return resolveCommand(runtime, rest);
      case "uncertain": return uncertainCommand(runtime);
      case "templates": return templatesCommand(runtime);
      default: break;
    }
  }
  if (action === undefined || action === "run") {
    if (runtime.isTTY && interactive) {
      return interactive("work");
    }
    if (runtime.isTTY && !positionals.slice(1).length && !runtime.flags.has("template")) {
      throw new UsageError("work requires an objective; run `coderax` for the interactive terminal");
    }
    return submitCommand(runtime, action === "run" ? positionals.slice(1) : positionals, { command: "work.run" });
  }
  return submitCommand(runtime, positionals, { command: "work.run" });
}

export { activeConversation, taskAgent, taskModel, createPrompt, approvalHandler, linkedController };
