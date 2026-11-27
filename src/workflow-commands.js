import { spawn } from "node:child_process";
import {
  BUILD_MODES,
  SdkError,
  WorkflowClient,
  isTerminalStatus,
} from "../packages/workflow-sdk/src/index.js";
import { saveConfig } from "./legacy-config.js";
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
  APPROVAL: 8,
  UNCERTAIN: 9,
  CONFLICT: 10,
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
  let result;
  try {
    result = await client.chatStream({
      text,
      mode,
      conversationId: session.conversationId ?? undefined,
      parentMessageId: session.parentMessageId ?? undefined,
      agentId: ctx.flags.get("agent") ?? ctx.settings.agent ?? undefined,
      model: ctx.flags.get("model") ?? ctx.settings.model ?? undefined,
      endpoint: ctx.settings.endpoint,
      path: ctx.flags.get("url") ?? ctx.settings.chatPath,
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
  } catch (error) {
    // The POST is never retried. If a conversation was already identified,
    // surface it so the operator can inspect the existing task instead of
    // submitting the same generation a second time.
    const isSafeId = (id) =>
      typeof id === "string" && id.trim() !== "" &&
      (!ctx.settings.token || !id.includes(ctx.settings.token));
    const { conversationId: reportedId, streamId, ...details } = error?.details ?? {};
    const conversationId = [reportedId, streamId, session.conversationId].find(isSafeId);
    if (error instanceof SdkError && (error.details || conversationId)) {
      error.details = {
        ...details,
        ...(conversationId ? { conversationId } : {}),
        ...(isSafeId(streamId) ? { streamId } : {}),
      };
    }
    if (conversationId) {
      // Persist the accepted turn before reporting the failure so the next
      // invocation continues it instead of silently starting a new one.
      try {
        const sessions = withSession(ctx.settings.sessions, ctx.settings.baseUrl, {
          conversationId,
          parentMessageId: isSafeId(session.parentMessageId) ? session.parentMessageId : null,
        });
        ctx.settings.sessions = sessions;
        await saveConfig({ sessions }, { filePath: ctx.settings.configPath });
      } catch {
        ctx.err(`coderax: warning: could not save conversation ${conversationId}`);
      }
      if (error instanceof SdkError) {
        if (!error.message.includes(conversationId)) {
          error.message +=
            `; conversation ${conversationId}. Inspect it with \`coderax tasks\`; the message was not resent.`;
        }
      }
    }
    throw error;
  }

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

/**
 * Start the one interactive terminal implementation. Non-interactive commands
 * keep using the shared WorkflowClient transport directly; the terminal builds
 * its own bounded, sanitising presentation layer on top of the same settings.
 */
async function runTerminal(ctx, mode) {
  if (!ctx.stdinIsTTY) {
    throw new SdkError("USAGE", "interactive mode requires a terminal; start a terminal session or pass a prompt");
  }
  if (typeof ctx.interactiveRunner !== "function") {
    throw new SdkError("USAGE", "the interactive terminal is not available in this build");
  }
  const resume = ctx.flags.get("resume");
  const code = await ctx.interactiveRunner({
    settings: ctx.settings,
    mode,
    env: ctx.env,
    accessible: ctx.flags.has("accessible") === true,
    noColor: ctx.flags.has("no-color") === true,
    resume: resume ?? false,
    noHistory: ctx.flags.has("no-history") === true,
    fetchImpl: ctx.fetchImpl,
    signal: ctx.signal,
  });
  return Number.isInteger(code) ? code : EXIT.OK;
}

export async function chatCommand(ctx, positionals) {
  if (ctx.flags.has("interactive")) return runTerminal(ctx, "chat");

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
  return runTerminal(ctx, "chat");
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
  if (ctx.flags.has("interactive")) return runTerminal(ctx, "work");
  if (ctx.stdinIsTTY && messageFrom(ctx, positionals) === "") {
    return runTerminal(ctx, "work");
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
  const client = await clientFor(ctx);
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
  const follow = ctx.flags.has("follow") && !ctx.flags.has("detach");

  const result = await client.submitBuild({
    request,
    agentId,
    mode,
    repository,
    workspace,
  });

  if (ctx.json) {
    const summary = {
      run: result.run,
      workflow: result.workflow,
      build: result.build,
      ...diagnosticsForJson(client.diagnostics),
    };
    // `--follow` makes this invocation an NDJSON stream; keep the submission
    // record on one line instead of emitting pretty JSON followed by NDJSON.
    ctx.out(JSON.stringify(summary, null, follow ? 0 : 2));
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

  if (follow) {
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
      // Notification commands are user-supplied and detached; never hand them
      // the deployment bearer token through the inherited environment. Windows
      // environment variable names are case-insensitive.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => (process.platform === "win32" ? key.toUpperCase() : key) !== "CODERAX_TOKEN",
        ),
      );
      const child = spawn(expanded, {
        shell: true,
        detached: true,
        stdio: "ignore",
        env,
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
  const client = await clientFor(ctx);
  const follow = !ctx.flags.has("no-follow");
  const policy = approvalPolicy(ctx);

  if (!follow) {
    const run = await client.getRun(runId);
    if (ctx.json) {
      ctx.out(JSON.stringify({ run, ...diagnosticsForJson(client.diagnostics) }, null, 2));
    } else {
      renderRun(run, ctx.out);
    }
    notifyTerminal(ctx, run);
    return exitForRun(run);
  }

  const controller = new AbortController();
  const state = { interrupted: false };
  const remove = installSigint(ctx, controller, state);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  let lastStatus = null;
  let lastRun = null;

  try {
    const result = await client.watchRun(runId, {
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
            client,
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

    const run = result.run ?? lastRun;
    if (!ctx.json && run && lastStatus !== "waiting_approval") {
      ctx.out("");
      renderRun(run, ctx.out);
    }
    notifyTerminal(ctx, run);
    return exitForRun(run);
  } catch (error) {
    if (error instanceof StopMonitoring) {
      notifyTerminal(ctx, error.run);
      return EXIT.UNAVAILABLE;
    }
    if (error instanceof SdkError && error.code === "CANCELLED" && state.interrupted) {
      notifyTerminal(ctx, lastRun ?? { id: runId, status: "detached" });
      if (ctx.flags.has("cancel-on-interrupt")) {
        try {
          await client.cancelRun(runId);
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
      return EXIT.CANCELLED;
    }
    if (isTerminalStatus(lastRun?.status)) {
      notifyTerminal(ctx, lastRun);
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
  const client = await clientFor(ctx);
  await client.requireOwner();

  if (ctx.flags.has("task")) {
    const result = await client.cancelTask(id);
    if (ctx.json) ctx.out(JSON.stringify({ task: id, result }, null, 2));
    else ctx.out(`Cancellation requested for Work task ${id}.`);
    return EXIT.OK;
  }

  const run = await client.cancelRun(id);
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
  const client = await clientFor(ctx);
  await client.requireOwner();
  const { previous, run } = await client.retryRun(id);
  const follow = ctx.flags.has("follow");
  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        { previous, run, ...diagnosticsForJson(client.diagnostics) },
        null,
        follow ? 0 : 2,
      ),
    );
  } else {
    ctx.out(`Retried ${previous.id} (${statusLabel(previous.status)}) as run ${run.id}  ${statusLabel(run.status)}`);
  }
  if (follow) return runCommand(ctx, [run.id]);
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
  const client = await clientFor(ctx);
  await client.requireOwner();
  const run = await client.approveStep(id, stepIndex);
  if (ctx.json) ctx.out(JSON.stringify({ run, ...diagnosticsForJson(client.diagnostics) }, null, 2));
  else ctx.out(`Approved step ${stepIndex} for run ${run.id}; status ${statusLabel(run.status)}.`);
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
