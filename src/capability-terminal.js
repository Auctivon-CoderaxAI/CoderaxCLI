/**
 * The interactive terminal client.
 *
 * This is the surviving terminal surface from `feat/terminal-client-completion`:
 * its ANSI renderer, incremental Markdown, prompt/spinner and Work presenter are
 * reused unchanged. The branch's private `src/engine/*` transport and second SDK
 * are not: every request goes through `src/engine.js` and the canonical
 * `@coderax/sdk`, so chat frames, task events and artifacts are parsed once.
 *
 * The REPL intentionally exposes only operations the deployment publishes:
 * chat, durable Work, task inspection/cancellation, artifacts, permissions,
 * models, agents and readiness. It never simulates an unavailable feature.
 */

import { randomUUID } from "node:crypto";
import { CoderaxError, redact } from "./client.js";
import {
  cancelTask,
  createEngineClient,
  decidePermission,
  engineHealth,
  followTask,
  getTask,
  listArtifacts,
  listPermissions,
  listTasks,
  negotiate,
  submitWork,
} from "./engine.js";
import { createStyle, supportsColor, termWidth } from "./ui/ansi.js";
import { MarkdownRenderer } from "./ui/markdown.js";
import { formatElapsed, PromptSession, Spinner } from "./ui/prompt.js";
import { renderTaskStatus, WorkPresenter } from "./ui/presenter.js";
import { renderTable } from "./ui/tables.js";
import { VERSION } from "./version.js";

const HELP = `Interactive commands
  /help                     this help
  /quit, /exit              leave the session (Ctrl+C also exits)
  /clear                    clear the screen
  /mode [chat|work]         show or change the default mode
  /chat <message>           one Chat turn
  /work <objective>         submit one durable Work task
  /task <taskId>            show an authoritative task record
  /tasks [limit]            list recent tasks
  /cancel <taskId>          ask the engine to cancel a task
  /artifacts <taskId>       list the task's artifacts
  /permissions <taskId>     list permission requests
  /doctor                   health, readiness and contract summary
  /models                   list models the deployment publishes
  /agents                   list agents the deployment publishes
  /caps                     handshake summary
  /version                  CLI and SDK versions

Anything that is not a slash command is sent in the current mode. Nothing is
planned, inferred or generated on this machine; the deployment does the work.`;

export function interactiveHelp() {
  return HELP;
}

function parseModelRef(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && typeof value.providerId === "string" && typeof value.modelId === "string") {
    return { providerId: value.providerId, modelId: value.modelId };
  }
  const text = String(value);
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    throw new CoderaxError("USAGE", "a model must be written as provider/model; run /models to list references");
  }
  return { providerId: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

function lineWriter(stream) {
  return (text = "") => {
    const value = String(text);
    stream.write(value.endsWith("\n") ? value : `${value}\n`);
  };
}

function isInteractive(stream) {
  return Boolean(stream?.isTTY);
}

/**
 * Start the interactive client.
 *
 * @param {object} ctx resolved CLI context (`settings`, `env`, `cwd`, `signal`)
 * @param {object} [deps] injectable streams and clock for tests
 */
export async function runInteractive(ctx, deps = {}) {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? ctx.env ?? process.env;
  const signal = deps.signal ?? ctx.signal;

  if (!isInteractive(stdin) || !isInteractive(stdout)) {
    throw new CoderaxError(
      "USAGE",
      "interactive mode requires a terminal; pass a prompt, pipe stdin, or run in a real terminal",
    );
  }

  const settings = ctx.settings;
  const client = createEngineClient({
    baseUrl: settings.baseUrl,
    token: settings.token,
    timeoutMs: settings.timeoutMs,
    fetchImpl: deps.fetchImpl ?? ctx.fetchImpl ?? fetch,
  });

  const style = createStyle({
    enabled: !env.NO_COLOR && supportsColor({ stream: stdout, env }),
    stream: stdout,
  });
  const width = termWidth(stdout, env, 100);
  const out = lineWriter(stdout);
  const error = lineWriter(stderr);
  const prompt = new PromptSession({ input: stdin, output: stdout, error: stderr, history: [], style });

  let state = {
    mode: deps.mode === "work" ? "work" : "chat",
    model: settings.model || "",
    agent: "",
    conversationId: null,
  };
  let exitCode = 0;

  const handshake = await negotiate(client);
  out(style.dim(`coderax ${VERSION} · contract ${handshake.contractVersion} · ${handshake.operations?.length ?? 0} operations`));
  out(style.dim("type /help for commands, /quit to leave"));

  const ui = { stdout, stderr, style, width, out, error, signal };

  try {
    for (;;) {
      if (signal?.aborted) break;
      let message;
      try {
        message = (await prompt.message({ prompt: style.cyan("coderax › "), multiline: false })).trim();
      } catch (caught) {
        if (caught?.code === "CANCELLED" || caught?.code === "INPUT_CLOSED") break;
        throw caught;
      }
      if (message === "") continue;
      if (message.startsWith("/")) {
        const result = await slash(client, message, state, ui, prompt);
        if (result.done) break;
        if (result.state) state = { ...state, ...result.state };
        continue;
      }
      try {
        if (state.mode === "work") {
          await workTurn(client, message, state, ui, prompt, signal);
        } else {
          await chatTurn(client, message, state, ui, signal);
        }
      } catch (caught) {
        report(error, caught, settings.token);
      }
    }
  } finally {
    prompt.close();
  }
  return exitCode;
}

async function slash(client, input, state, ui, prompt) {
  const [rawCommand, ...rest] = input.slice(1).split(/\s+/);
  const command = rawCommand.toLowerCase();
  const argument = rest.join(" ").trim();

  switch (command) {
    case "help":
      ui.out(HELP);
      return {};
    case "quit":
    case "exit":
      return { done: true };
    case "clear":
      ui.stdout.write("\u001b[2J\u001b[H");
      return {};
    case "mode": {
      if (argument === "") {
        ui.out(`mode: ${state.mode}`);
        return {};
      }
      if (argument !== "chat" && argument !== "work") {
        ui.out("usage: /mode chat|work");
        return {};
      }
      return { state: { mode: argument } };
    }
    case "version":
      ui.out(`coderax-cli ${VERSION}`);
      return {};
    case "chat":
      if (argument === "") ui.out("usage: /chat <message>");
      else await chatTurn(client, argument, state, ui, ui.signal);
      return {};
    case "work":
      if (argument === "") ui.out("usage: /work <objective>");
      else await workTurn(client, argument, state, ui, prompt, ui.signal);
      return {};
    case "task": {
      if (argument === "") {
        ui.out("usage: /task <taskId>");
        return {};
      }
      const task = await getTask(client, argument);
      ui.out(renderTaskStatus(task, { style: ui.style, out: (text) => ui.stdout.write(text), width: ui.width }));
      return {};
    }
    case "tasks": {
      const limit = Number(argument) || 10;
      const list = await listTasks(client, { limit: Math.max(1, Math.min(50, limit)) });
      ui.out(table(ui, ["task", "state", "agent", "updated"], list.tasks.map((task) => [
        task.taskId,
        task.state,
        task.agent,
        task.updatedAt,
      ])));
      return {};
    }
    case "cancel": {
      if (argument === "") {
        ui.out("usage: /cancel <taskId>");
        return {};
      }
      const result = await cancelTask(client, argument, "cancelled from the interactive client");
      ui.out(`${argument}: ${result.outcome ?? "cancel requested"}`);
      return {};
    }
    case "artifacts": {
      if (argument === "") {
        ui.out("usage: /artifacts <taskId>");
        return {};
      }
      const list = await listArtifacts(client, argument);
      if (list.artifacts.length === 0) ui.out("no artifacts");
      else ui.out(table(ui, ["artifact", "path", "bytes", "digest"], list.artifacts.map((artifact) => [
        artifact.artifactId,
        artifact.path,
        artifact.bytes ?? "",
        artifact.digest ?? "",
      ])));
      return {};
    }
    case "permissions": {
      if (argument === "") {
        ui.out("usage: /permissions <taskId>");
        return {};
      }
      const list = await listPermissions(client, argument);
      const pending = list.requests.filter((request) => request.decision === "pending");
      if (pending.length === 0) ui.out("no pending permission requests");
      else ui.out(table(ui, ["request", "scope", "resource", "description"], pending.map((request) => [
        request.requestId,
        request.scope,
        request.resource,
        request.description,
      ])));
      return {};
    }
    case "doctor": {
      const report = await engineHealth(client);
      ui.out(`health       ${report.health?.status ?? "ok"}`);
      ui.out(`readiness    ${report.readinessError ? `error: ${report.readinessError}` : (report.readiness?.ready ? "ready" : "not ready")}`);
      ui.out(`contract     ${report.handshake?.contractVersion ?? "unknown"}`);
      return {};
    }
    case "models": {
      const models = await client.models();
      ui.out(table(ui, ["provider", "model"], (models.models ?? []).map((model) => [
        model.providerId ?? model.provider ?? "",
        model.modelId ?? model.id ?? "",
      ])));
      return {};
    }
    case "agents": {
      const agents = await client.agents();
      ui.out(table(ui, ["agent", "name"], (agents.agents ?? []).map((agent) => [
        agent.agentId ?? agent.id ?? "",
        agent.name ?? agent.label ?? "",
      ])));
      return {};
    }
    case "caps": {
      const handshake = await negotiate(client);
      const families = handshake.capabilities ?? [];
      const available = families.filter((family) => family.state === "available").length;
      ui.out(`contract ${handshake.contractVersion}; ${handshake.operations?.length ?? 0} operations; ${available}/${families.length} capability families available`);
      return {};
    }
    default:
      ui.out(`unknown command: /${command}. Type /help.`);
      return {};
  }
}

function table(ui, headers, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "nothing to show";
  return renderTable({ headers, rows, style: ui.style, width: ui.width });
}

async function chatTurn(client, message, state, ui, signal) {
  const markdown = new MarkdownRenderer({
    write: (text) => ui.stdout.write(text),
    width: ui.width,
    style: ui.style,
  });
  const request = { message, mode: "private" };
  if (state.conversationId) request.conversationId = state.conversationId;
  if (state.model) request.model = parseModelRef(state.model);
  if (state.agent) request.agent = state.agent;

  let failed = null;
  for await (const frame of client.chatStream(request, signal ? { signal } : {})) {
    if (frame.type === "chat.started") {
      state.conversationId = frame.conversationId;
      if (state.model === "" && frame.model) state.model = `${frame.model.providerId}/${frame.model.modelId}`;
    } else if (frame.type === "chat.delta") {
      markdown.write(frame.text);
    } else if (frame.type === "chat.replace") {
      markdown.end();
      ui.out(ui.style.yellow("↺ response revised"));
      markdown.write(frame.text);
    } else if (frame.type === "chat.failed") {
      failed = frame;
    }
  }
  markdown.end();
  if (failed) {
          throw new CoderaxError(
        "CHAT_FAILED",
        failed.message ?? failed.detail ?? failed.code ?? "the deployment reported a failed chat turn",
      );
  }
  ui.out("");
}

async function workTurn(client, objective, state, ui, prompt, signal) {
  const request = {
    objective,
    mode: "cloud",
    requireApproval: true,
    idempotencyKey: `cli:${Date.now()}:${randomUUID()}`,
  };
  if (state.conversationId) request.conversationId = state.conversationId;
  if (state.model) request.model = parseModelRef(state.model);
  if (state.agent) request.agent = state.agent;

  const spinner = new Spinner({ stream: ui.stderr, style: ui.style, text: "submitting" });
  spinner.start();
  let accepted;
  try {
    accepted = await submitWork(client, request);
  } finally {
    spinner.stop();
  }
  ui.out(ui.style.dim(`accepted ${accepted.taskId}`));
  state.conversationId = accepted.conversationId ?? state.conversationId;

  const presenter = new WorkPresenter({
    out: (text) => ui.stdout.write(text),
    style: ui.style,
    width: ui.width,
    onApproval: async (request_) => {
      const choice = await prompt.select({
        title: `approval required: ${request_.tool ?? request_.scope}`,
        items: [
          { id: "approved", label: "approve once" },
          { id: "denied", label: "deny" },
        ],
      });
      if (!choice) return false;
      await decidePermission(client, accepted.taskId, {
        requestId: request_.requestId,
        decision: choice.id,
      });
      return choice.id === "approved";
    },
  });

  const result = await followTask(client, accepted, {
    signal,
    onEvent: (event) => presenter.onEvent(event),
  });
  const summary = presenter.finish({ status: result.task, lastSeq: result.lastSeq });
  if (summary.state !== "completed") {
    ui.out(ui.style.yellow(`task ${summary.taskId} ${summary.state} after ${formatElapsed(summary.elapsedMs)}`));
  }
}

function report(error, caught, token) {
  const known = caught instanceof CoderaxError;
  const detail = known ? `${caught.code}: ${caught.message}` : "unexpected failure";
  error(`coderax: ${redact(detail, token)}`);
  if (!known && process.env.CODERAX_DEBUG) error(redact(caught?.stack ?? String(caught), token));
}
