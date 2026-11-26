import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import {
  BUILD_MODES,
  SdkError,
  TaskClient,
  TaskState,
  WorkflowClient,
  isTerminalStatus,
} from "../packages/workflow-sdk/src/index.js";
import { saveConfig } from "./config.js";
import { getSession, withSession, clearSession } from "./session.js";
import {
  diagnosticsForJson,
  renderRun,
  statusLabel,
  table,
  taskId,
  taskState,
  taskTitle,
  taskUpdated,
  truncate,
} from "./render.js";
import { APPROVAL_POLICIES, approveOrExplain } from "./approval.js";
import { createFileTaskStateStore, taskStatePath } from "./task-store.js";
import { VERSION } from "./version.js";

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  UNAUTHENTICATED: 3,
  NETWORK: 4,
  NOT_FOUND: 5,
  UNAVAILABLE: 6,
  CONTRACT: 7,
  CANCELLED: 130,
});

class StopMonitoring extends Error {
  constructor(action, run) {
    super(action);
    this.name = "StopMonitoring";
    this.action = action;
    this.run = run;
  }
}

function requireBase(ctx) {
  if (!ctx.settings.baseUrl) {
    throw new SdkError(
      "BASE_URL_REQUIRED",
      "no deployment configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
}

function requireAuth(ctx) {
  if (!ctx.settings.token) {
    throw new SdkError("UNAUTHENTICATED", "not signed in; run `coderax login` first");
  }
}

function parseMaxRetries(ctx) {
  const raw = ctx.flags.get("max-retries");
  if (raw === undefined) return 3;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new SdkError("USAGE", "--max-retries must be an integer between 0 and 10");
  }
  return value;
}

export function makeClient(ctx) {
  return new WorkflowClient({
    baseUrl: ctx.settings.baseUrl,
    token: ctx.settings.token,
    timeoutMs: ctx.settings.timeoutMs,
    fetchImpl: ctx.fetchImpl,
    clientVersion: VERSION,
    signal: ctx.signal,
    strict: ctx.flags.has("strict"),
    maxRetries: parseMaxRetries(ctx),
    onDiagnostic: (entry) => {
      // Diagnostics go to stderr even with --json so operators see degraded
      // contracts; stdout stays a single machine-readable document.
      ctx.err(`coderax: ${entry.severity ?? "warning"}: ${entry.code}: ${entry.message}`);
    },
  });
}

async function clientFor(ctx) {
  requireBase(ctx);
  requireAuth(ctx);
  return makeClient(ctx);
}

/**
 * The task layer is the only owner of persisted cursor/ack state. Every command
 * that follows, submits, approves or cancels goes through it so a reconnect and
 * a fresh process agree about what was already handled.
 */
async function taskFor(ctx) {
  const client = await clientFor(ctx);
  const store = createFileTaskStateStore(taskStatePath(ctx.env, ctx.settings.baseUrl));
  const state = new TaskState({
    persist: store.persist,
    onPersistError: (error) => {
      ctx.err(`coderax: warning: TASK_STATE_PERSIST: ${error.message}`);
    },
  });
  state.restore(await store.load());
  return {
    client,
    tasks: new TaskClient({ client, state, signal: ctx.signal }),
  };
}

function approvalPolicy(ctx) {
  const value = ctx.flags.get("approval") ?? "ask";
  if (!APPROVAL_POLICIES.includes(value)) {
    throw new SdkError("USAGE", `--approval must be one of ${APPROVAL_POLICIES.join(", ")}`);
  }
  return value;
}

function messageFrom(ctx, positionals) {
  const text = positionals.join(" ").trim();
  return text;
}

async function readPrompt(ctx, positionals) {
  let text = messageFrom(ctx, positionals);
  if (text === "" && !ctx.stdinIsTTY) {
    text = (await ctx.readSecret()).trim();
  }
  if (text === "") {
    throw new SdkError("USAGE", "no message provided");
  }
  return text;
}

async function persistSession(ctx, baseUrl, result) {
  const conversationId = result?.conversationId ?? null;
  if (!baseUrl || !conversationId) return;
  const sessions = withSession(ctx.settings.sessions, baseUrl, {
    conversationId,
    parentMessageId: result.responseMessageId ?? null,
  });
  ctx.settings.sessions = sessions;
  await saveConfig({ sessions }, { filePath: ctx.settings.configPath });
}

function resetSession(ctx, baseUrl) {
  ctx.settings.sessions = clearSession(ctx.settings.sessions, baseUrl);
}

function sessionFor(ctx, baseUrl) {
  const override = ctx.flags.get("conversation");
  if (override && override.trim() !== "") {
    return { conversationId: override.trim(), parentMessageId: null };
  }
  return getSession(ctx.settings, baseUrl);
}

async function streamTurn(ctx, client, mode, text, { session }) {
  const answer = [];
  const result = await client.chatStream({
    text,
    mode,
    conversationId: session.conversationId ?? undefined,
    parentMessageId: session.parentMessageId ?? undefined,
    agentId: ctx.flags.get("agent") ?? ctx.settings.agent ?? undefined,
    model: ctx.flags.get("model") ?? ctx.settings.model ?? undefined,
    endpoint: ctx.settings.endpoint,
    signal: ctx.signal,
    onEvent: (event) => {
      if (event.type === "delta") {
        answer.push(event.text);
        if (!ctx.json) ctx.raw(event.text);
      } else if (event.type === "replace") {
        answer.length = 0;
        answer.push(event.text);
        if (!ctx.json) ctx.raw(`\n[Revised response]\n${event.text}`);
      }
    },
  });

  await persistSession(ctx, ctx.settings.baseUrl, result);

  if (result.text === "") {
    const message = "The server accepted the request but streamed no text.";
    if (ctx.json) {
      ctx.out(
        JSON.stringify(
          {
            mode,
            text: "",
            events: 0,
            conversationId: result.conversationId ?? null,
            error: message,
            ...diagnosticsForJson(client.diagnostics),
          },
          null,
          2,
        ),
      );
    }
    ctx.err(message);
    return EXIT.ERROR;
  }

  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        {
          mode,
          text: result.text,
          events: result.events,
          conversationId: result.conversationId ?? null,
          responseMessageId: result.responseMessageId ?? null,
          ...diagnosticsForJson(client.diagnostics),
        },
        null,
        2,
      ),
    );
  } else {
    ctx.out("");
  }

  return EXIT.OK;
}

export async function chatCommand(ctx, positionals) {
  const client = await clientFor(ctx);
  if (ctx.flags.has("new")) resetSession(ctx, ctx.settings.baseUrl);

  const text = messageFrom(ctx, positionals);
  if (text !== "") {
    return streamTurn(ctx, client, "chat", text, {
      session: sessionFor(ctx, ctx.settings.baseUrl),
    });
  }
  if (!ctx.stdinIsTTY) {
    const piped = await readPrompt(ctx, positionals);
    return streamTurn(ctx, client, "chat", piped, {
      session: sessionFor(ctx, ctx.settings.baseUrl),
    });
  }
  return interactiveChat(ctx, client);
}

async function interactiveChat(ctx, client) {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  let session = sessionFor(ctx, ctx.settings.baseUrl);

  ctx.out("Interactive chat. /help for commands, /exit to leave.");
  if (session.conversationId) ctx.out(`Continuing conversation ${session.conversationId}.`);

  try {
    while (true) {
      let line;
      try {
        line = await readline.question("coderax> ");
      } catch {
        return EXIT.CANCELLED;
      }
      const text = line.trim();
      if (text === "") continue;
      if (text === "/exit" || text === "/quit") return EXIT.OK;
      if (text === "/help") {
        ctx.out(
          [
            "/exit, /quit      leave the session",
            "/new              start a new conversation",
            "/model <id>       set the model for this session",
            "/agent <id>       set the agent for this session",
            "/conversation     show the current conversation id",
            "/help             show this help",
          ].join("\n"),
        );
        continue;
      }
      if (text === "/new") {
        session = { conversationId: null, parentMessageId: null };
        resetSession(ctx, ctx.settings.baseUrl);
        await saveConfig({ sessions: ctx.settings.sessions }, { filePath: ctx.settings.configPath });
        ctx.out("Started a new conversation.");
        continue;
      }
      if (text === "/conversation") {
        ctx.out(session.conversationId ?? "(no conversation yet)");
        continue;
      }
      if (text.startsWith("/model ")) {
        ctx.settings.model = text.slice("/model ".length).trim();
        ctx.out(`Model set to ${ctx.settings.model || "(default)"}.`);
        continue;
      }
      if (text.startsWith("/agent ")) {
        ctx.settings.agent = text.slice("/agent ".length).trim();
        ctx.out(`Agent set to ${ctx.settings.agent || "(default)"}.`);
        continue;
      }
      if (text.startsWith("/")) {
        ctx.err(`unknown command: ${text}. Type /help.`);
        continue;
      }

      try {
        const code = await streamTurn(ctx, client, "chat", text, { session });
        if (code !== EXIT.OK) continue;
        session = getSession(ctx.settings, ctx.settings.baseUrl);
      } catch (error) {
        if (error instanceof SdkError && error.code === "CANCELLED") return EXIT.CANCELLED;
        ctx.err(`coderax: ${error.code ?? "ERROR"}: ${error.message}`);
        if (error?.code === "UNAUTHENTICATED" || error?.code === "FORBIDDEN") return EXIT.UNAUTHENTICATED;
      }
    }
  } finally {
    readline.close();
  }
}

export async function workCommand(ctx, positionals) {
  if (positionals[0] === "submit") {
    return submitCommand(ctx, positionals.slice(1));
  }
  if (ctx.flags.has("repo") || ctx.flags.has("base-ref") || ctx.flags.has("mode")) {
    throw new SdkError(
      "USAGE",
      "autonomous Work requires `coderax work submit <prompt> --repo <owner/name> --agent <id>`; " +
        "`coderax work <prompt>` is the interactive streaming alias",
    );
  }
  const client = await clientFor(ctx);
  if (ctx.flags.has("new")) resetSession(ctx, ctx.settings.baseUrl);
  const text = await readPrompt(ctx, positionals);
  return streamTurn(ctx, client, "work", text, {
    session: sessionFor(ctx, ctx.settings.baseUrl),
  });
}

function parseRepo(ctx) {
  const value = ctx.flags.get("repo");
  if (value === undefined) return null;
  const parts = value.split("/");
  if (parts.length !== 2 || parts[0].trim() === "" || parts[1].trim() === "") {
    throw new SdkError("USAGE", "--repo must be <owner>/<name>");
  }
  const baseRef = ctx.flags.get("base-ref");
  return {
    owner: parts[0].trim(),
    name: parts[1].trim(),
    ...(baseRef ? { baseRef } : {}),
  };
}

function defaultWorkspace(repository) {
  const stamp = Date.now().toString(36);
  const raw = `coderax-${repository.owner}-${repository.name}-${stamp}`;
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
}

export async function submitCommand(ctx, positionals) {
  const { client, tasks } = await taskFor(ctx);
  await client.requireOwner();

  const request = await readPrompt(ctx, positionals);
  const repository = parseRepo(ctx);
  if (repository === null) {
    throw new SdkError(
      "USAGE",
      "autonomous Work needs a repository: `coderax work submit <prompt> --repo <owner/name> --agent <id>`",
    );
  }
  const agentId = ctx.flags.get("agent") ?? ctx.settings.agent ?? "";
  if (agentId === "") {
    throw new SdkError(
      "USAGE",
      "autonomous Work needs an agent: pass --agent <id> (list eligible agents with `coderax agents --work`)",
    );
  }
  const mode = ctx.flags.get("mode") ?? "autonomous";
  if (!BUILD_MODES.includes(mode)) {
    throw new SdkError("USAGE", `--mode must be one of ${BUILD_MODES.join(", ")}`);
  }
  const workspace = ctx.flags.get("workspace") ?? defaultWorkspace(repository);

  let result;
  try {
    result = await tasks.submit({
      request,
      agentId,
      mode,
      repository,
      workspace,
    });
  } catch (error) {
    if (error instanceof SdkError && error.code === "SUBMISSION_UNKNOWN") {
      // The POST may have created a run. Retrying, with this key or a new one,
      // could create a second run and a second workspace checkout.
      if (ctx.json) {
        ctx.out(JSON.stringify({ error: "SUBMISSION_UNKNOWN", ...error.details }, null, 2));
      }
      ctx.err(`coderax: SUBMISSION_UNKNOWN: ${error.message}`);
      return EXIT.NETWORK;
    }
    throw error;
  }

  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        {
          run: result.run,
          workflow: result.workflow,
          build: result.build,
          ...diagnosticsForJson(client.diagnostics),
        },
        null,
        2,
      ),
    );
  } else {
    ctx.out(`Submitted run ${result.run.id}  ${statusLabel(result.run.status)}`);
    if (result.workflow?.id) {
      ctx.out(`workflow  ${result.workflow.id}  ${result.workflow.name ?? ""}`.trimEnd());
    }
    if (result.build) {
      ctx.out(
        `plan  ${result.build.mode ?? mode}  ${result.build.taskCount ?? "?"} task(s)` +
          (result.build.degraded ? `  degraded: ${result.build.reason ?? "no reason reported"}` : ""),
      );
    }
    ctx.out(`Next: coderax run ${result.run.id}`);
  }

  if (ctx.flags.has("follow") && !ctx.flags.has("detach")) {
    return runCommand(ctx, [result.run.id]);
  }
  return EXIT.OK;
}

export async function tasksCommand(ctx, positionals) {
  const client = await clientFor(ctx);
  if (positionals.length > 0) {
    const task = await client.getTask(positionals[0]);
    if (ctx.json) {
      ctx.out(JSON.stringify({ task, ...diagnosticsForJson(client.diagnostics) }, null, 2));
    } else {
      ctx.out(`task ${taskId(task)}  ${statusLabel(taskState(task))}`);
      if (taskTitle(task)) ctx.out(`title  ${taskTitle(task)}`);
      if (taskUpdated(task)) ctx.out(`updated  ${taskUpdated(task)}`);
    }
    return taskState(task) === "failed" ? EXIT.ERROR : EXIT.OK;
  }

  const result = await client.listTasks();
  const tasks = result.tasks;
  if (ctx.json) {
    ctx.out(JSON.stringify({ tasks, ...diagnosticsForJson(client.diagnostics) }, null, 2));
    return EXIT.OK;
  }
  if (tasks.length === 0) {
    ctx.out("No Work tasks are visible to this owner.");
    return EXIT.OK;
  }
  const rows = tasks.map((task) => [
    taskId(task),
    statusLabel(taskState(task)),
    truncate(taskUpdated(task), 24),
    truncate(taskTitle(task), 48),
  ]);
  ctx.out(table(rows, ["ID", "STATE", "UPDATED", "TITLE"]));
  return EXIT.OK;
}

export async function workflowsCommand(ctx) {
  const client = await clientFor(ctx);
  const result = await client.listWorkflows();
  if (ctx.json) {
    ctx.out(
      JSON.stringify({ workflows: result.workflows, ...diagnosticsForJson(client.diagnostics) }, null, 2),
    );
    return EXIT.OK;
  }
  if (result.workflows.length === 0) {
    ctx.out("No workflows are visible to this owner.");
    return EXIT.OK;
  }
  const rows = result.workflows.map((workflow) => [
    workflow.id ?? "(unknown)",
    truncate(workflow.name ?? "", 32),
    truncate(workflow.agentId ?? "", 20),
    String(Array.isArray(workflow.steps) ? workflow.steps.length : 0),
  ]);
  ctx.out(table(rows, ["ID", "NAME", "AGENT", "STEPS"]));
  return EXIT.OK;
}

export async function runsCommand(ctx) {
  const workflowId = ctx.flags.get("workflow");
  if (!workflowId) {
    throw new SdkError(
      "USAGE",
      "the deployment has no global run list. Pass --workflow <id> (find ids with `coderax workflows`).",
    );
  }
  const client = await clientFor(ctx);
  const result = await client.listRuns(workflowId);
  if (ctx.json) {
    ctx.out(JSON.stringify({ runs: result.runs, ...diagnosticsForJson(client.diagnostics) }, null, 2));
    return EXIT.OK;
  }
  if (result.runs.length === 0) {
    ctx.out(`Workflow ${workflowId} has no runs.`);
    return EXIT.OK;
  }
  const rows = result.runs.map((run) => [
    run.id,
    statusLabel(run.status),
    truncate(run.createdAt ?? "", 24),
    truncate(run.workflowName ?? "", 32),
  ]);
  ctx.out(table(rows, ["RUN", "STATUS", "CREATED", "WORKFLOW"]));
  return EXIT.OK;
}

function installSigint(ctx, controller, state) {
  if (ctx.signal || !process.stdin.isTTY) return null;
  const handler = () => {
    state.interrupted = true;
    controller.abort();
  };
  process.once("SIGINT", handler);
  return () => process.removeListener("SIGINT", handler);
}

function notifyTerminal(ctx, run) {
  const command = ctx.flags.get("notify-command");
  if (!ctx.flags.has("notify") && command === undefined) return;
  if (!ctx.json) ctx.err("\u0007");
  if (command !== undefined) {
    const expanded = command
      .replaceAll("{id}", run.id)
      .replaceAll("{status}", run.status);
    try {
      const child = spawn(expanded, {
        shell: true,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch {
      ctx.err("coderax: warning: NOTIFY_FAILED: the notification command could not start");
    }
  }
  ctx.err(`[notify] run ${run.id} ${statusLabel(run.status)}`);
}

function exitForRun(run) {
  if (run?.status === "failed") return EXIT.ERROR;
  if (run?.status === "waiting_approval") return EXIT.UNAVAILABLE;
  return EXIT.OK;
}

export async function runCommand(ctx, positionals) {
  const runId = positionals[0];
  if (runId === undefined || runId.trim() === "") {
    throw new SdkError("USAGE", "run requires a run id: `coderax run <runId>`");
  }
  const { client, tasks } = await taskFor(ctx);
  const follow = !ctx.flags.has("no-follow");
  const policy = approvalPolicy(ctx);
  const wantsNotification = ctx.flags.has("notify") || ctx.flags.has("notify-command");

  if (!follow) {
    const run = await client.getRun(runId);
    if (ctx.json) {
      ctx.out(JSON.stringify({ run, ...diagnosticsForJson(client.diagnostics) }, null, 2));
    } else {
      renderRun(run, ctx.out);
    }
    if (wantsNotification) {
      // Completion notifications are emitted only after the authoritative run
      // read confirms a terminal state, and only once per settlement.
      const settled = await tasks.settle(runId);
      if (settled.settled && settled.newlyAcknowledged) notifyTerminal(ctx, settled.run);
    }
    return exitForRun(run);
  }

  const controller = new AbortController();
  const state = { interrupted: false };
  const remove = installSigint(ctx, controller, state);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  let lastStatus = null;
  let lastRun = null;

  // Approval is addressed by step index, exactly as parseApproveWorkflowStep
  // requires. TaskClient reconciles a 409 by reading the run once.
  const approvalClient = {
    approveStep: async (id, index) => (await tasks.approve(id, index)).run,
  };

  try {
    const result = await tasks.follow(runId, {
      signal,
      maxRetries: parseMaxRetries(ctx),
      onRun: async (run) => {
        lastRun = run;
        if (ctx.json) {
          ctx.out(JSON.stringify({ run }));
        } else if (lastStatus === null) {
          renderRun(run, ctx.out);
        } else if (lastStatus !== run.status) {
          ctx.out(`run ${run.id}  ${statusLabel(run.status)}`);
        }
        lastStatus = run.status;

        if (run.status === "waiting_approval") {
          const decision = await approveOrExplain({
            ctx,
            client: approvalClient,
            run,
            policy,
            apply: (updated) => {
              lastRun = updated;
              lastStatus = updated.status;
            },
          });
          if (decision.action === "unavailable" || decision.action === "denied" || decision.action === "declined") {
            throw new StopMonitoring(decision.action, run);
          }
        }
      },
    });

    const outcome = result.outcome;
    if (outcome.kind === "detached") {
      if (ctx.flags.has("cancel-on-interrupt")) {
        try {
          const canceled = await tasks.cancelRun(runId);
          if (wantsNotification) notifyTerminal(ctx, canceled.run);
          ctx.err(`Cancelled run ${runId}.`);
          return EXIT.OK;
        } catch (cancelError) {
          ctx.err(`coderax: ${cancelError.code ?? "ERROR"}: ${cancelError.message}`);
          return EXIT.ERROR;
        }
      }
      ctx.err(
        `Detached from run ${runId}; the run continues server-side. ` +
          `Resume with: coderax run ${runId}`,
      );
      if (lastRun?.conversationId) ctx.err(`conversation ${lastRun.conversationId}`);
      if (wantsNotification) notifyTerminal(ctx, lastRun ?? { id: runId, status: "detached" });
      return EXIT.CANCELLED;
    }

    if (outcome.kind === "disconnected") {
      // A transport failure is not a run failure: the deployment may still be
      // executing. Report it separately from a terminal failed/cancelled run.
      ctx.err(
        `coderax: STREAM_INCOMPLETE: ${outcome.error ?? "the run stream ended before a terminal status"}`,
      );
      if (lastRun?.conversationId) ctx.err(`conversation ${lastRun.conversationId}`);
      return EXIT.CONTRACT;
    }

    const run = result.run ?? lastRun;
    if (!ctx.json && run && lastStatus !== "waiting_approval") {
      ctx.out("");
      renderRun(run, ctx.out);
    }
    if (wantsNotification) {
      const settled = await tasks.settle(runId);
      if (settled.settled && settled.newlyAcknowledged) notifyTerminal(ctx, settled.run);
    }
    return exitForRun(run);
  } catch (error) {
    if (error instanceof StopMonitoring) {
      if (wantsNotification) notifyTerminal(ctx, error.run);
      return EXIT.UNAVAILABLE;
    }
    if (isTerminalStatus(lastRun?.status)) {
      if (wantsNotification) notifyTerminal(ctx, lastRun);
      return exitForRun(lastRun);
    }
    throw error;
  } finally {
    remove?.();
  }
}

export async function cancelCommand(ctx, positionals) {
  const id = positionals[0];
  if (!id) throw new SdkError("USAGE", "cancel requires an id");
  const { client, tasks } = await taskFor(ctx);
  await client.requireOwner();

  if (ctx.flags.has("task")) {
    const outcome = await tasks.cancelTask(id);
    if (ctx.json) {
      ctx.out(JSON.stringify({ task: id, ...outcome }, null, 2));
    } else if (outcome.canceled) {
      ctx.out(`Cancellation requested for Work task ${id}.`);
    } else if (outcome.alreadyFinished) {
      ctx.out(`Work task ${id} is already finished; nothing was cancelled.`);
    } else {
      ctx.out(`Work task ${id} has no running turn to cancel.`);
    }
    return EXIT.OK;
  }

  const { run } = await tasks.cancelRun(id);
  if (ctx.json) ctx.out(JSON.stringify({ run, ...diagnosticsForJson(client.diagnostics) }, null, 2));
  else ctx.out(`Cancellation requested for run ${run.id}; status ${statusLabel(run.status)}.`);
  return EXIT.OK;
}

export async function resumeCommand(ctx, positionals) {
  const id = positionals[0];
  if (!id) throw new SdkError("USAGE", "resume requires a run id");
  const client = await clientFor(ctx);
  await client.requireOwner();
  const run = await client.resumeRun(id);
  if (ctx.json) ctx.out(JSON.stringify({ run, ...diagnosticsForJson(client.diagnostics) }, null, 2));
  else ctx.out(`Resumed run ${run.id}; status ${statusLabel(run.status)}.`);
  return EXIT.OK;
}

export async function retryCommand(ctx, positionals) {
  const id = positionals[0];
  if (!id) throw new SdkError("USAGE", "retry requires a run id");
  const { client, tasks } = await taskFor(ctx);
  await client.requireOwner();
  const { previous, run } = await tasks.retry(id);
  if (ctx.json) {
    ctx.out(JSON.stringify({ previous, run, ...diagnosticsForJson(client.diagnostics) }, null, 2));
  } else {
    ctx.out(`Retried ${previous.id} (${statusLabel(previous.status)}) as run ${run.id}  ${statusLabel(run.status)}`);
  }
  if (ctx.flags.has("follow")) return runCommand(ctx, [run.id]);
  return EXIT.OK;
}

export async function approveCommand(ctx, positionals) {
  const [id, rawStep] = positionals;
  if (!id || rawStep === undefined) {
    throw new SdkError("USAGE", "approve requires <runId> <stepIndex>");
  }
  const stepIndex = Number(rawStep);
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    throw new SdkError("USAGE", "stepIndex must be a non-negative integer");
  }
  const { client, tasks } = await taskFor(ctx);
  await client.requireOwner();
  const outcome = await tasks.approve(id, stepIndex);
  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        { run: outcome.run, applied: outcome.applied, alreadySettled: outcome.alreadySettled, ...diagnosticsForJson(client.diagnostics) },
        null,
        2,
      ),
    );
  } else if (outcome.applied) {
    ctx.out(`Approved step ${stepIndex} for run ${outcome.run.id}; status ${statusLabel(outcome.run.status)}.`);
  } else {
    ctx.out(
      `Step ${stepIndex} for run ${outcome.run.id} was already settled; status ${statusLabel(outcome.run.status)}.`,
    );
  }
  return EXIT.OK;
}

export async function reposCommand(ctx) {
  const client = await clientFor(ctx);
  const result = await client.listRepos();
  if (ctx.json) {
    ctx.out(JSON.stringify({ repositories: result.repositories }, null, 2));
    return EXIT.OK;
  }
  if (result.repositories.length === 0) {
    ctx.out("No repositories are connected to this deployment.");
    return EXIT.OK;
  }
  const rows = result.repositories.map((repo) => [
    `${repo.owner ?? ""}/${repo.name ?? ""}`,
    repo.defaultBranch ?? repo.baseRef ?? "",
    repo.private ? "private" : "public",
  ]);
  ctx.out(table(rows, ["REPOSITORY", "DEFAULT BRANCH", "VISIBILITY"]));
  return EXIT.OK;
}

export async function workModelsCommand(ctx) {
  const client = await clientFor(ctx);
  const result = await client.listWorkModels();
  if (ctx.json) {
    ctx.out(JSON.stringify({ models: result.models }, null, 2));
    return EXIT.OK;
  }
  const rows = result.models.map((model) => [
    model.id ?? model.model ?? model.name ?? "(unknown)",
    model.label ?? model.name ?? "",
    model.provider ?? "",
    model.isDefault || model.default ? "default" : "",
  ]);
  ctx.out(table(rows, ["ID", "LABEL", "PROVIDER", ""]));
  return EXIT.OK;
}

export async function workAgentsCommand(ctx) {
  const client = await clientFor(ctx);
  const result = await client.listWorkAgents();
  if (ctx.json) {
    ctx.out(JSON.stringify({ agents: result.agents }, null, 2));
    return EXIT.OK;
  }
  const rows = result.agents.map((agent) => [
    agent.id ?? agent.agentId ?? agent._id ?? "(unknown)",
    truncate(agent.name ?? "", 32),
    agent.model ?? "",
    agent.provider ?? "",
  ]);
  ctx.out(table(rows, ["ID", "NAME", "MODEL", "PROVIDER"]));
  return EXIT.OK;
}

export async function whoamiCommand(ctx) {
  const client = await clientFor(ctx);
  const identity = await client.whoami();
  const payload = {
    account: identity.account,
    role: identity.role,
    owner: identity.owner,
  };
  if (ctx.json) {
    ctx.out(JSON.stringify(payload, null, 2));
  } else {
    ctx.out(`Account  ${identity.account ?? "(unknown)"}`);
    ctx.out(`Role     ${identity.role ?? "(not reported)"}`);
    ctx.out(`Owner    ${identity.owner ? "yes" : "no"}`);
  }
  return identity.owner ? EXIT.OK : EXIT.UNAUTHENTICATED;
}
