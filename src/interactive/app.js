import { CoderaxError, CancelledError, EXIT, UsageError } from "../errors.js";
import { parseModelRef, newSubmissionKey, submitWork } from "../engine/submit.js";
import { watchTask } from "../engine/stream.js";
import { buildTemplateObjective, getTemplate, templateNames } from "../work/templates.js";
import { WorkPresenter } from "../ui/presenter.js";
import { PromptSession, Spinner } from "../ui/prompt.js";
import { renderTable } from "../ui/tables.js";
import { configDir } from "../config.js";
import {
  cancelCommand,
  listCommand,
  statusCommand,
} from "../commands/work.js";
import { notificationsCommand } from "../commands/notifications.js";
import { permissionsCommand } from "../commands/permissions.js";
import { sessionsCommand } from "../commands/sessions.js";
import { doctor } from "../commands/engine.js";
import { status as statusCommandReport } from "../commands/auth.js";
import { VERSION } from "../version.js";

const SLASH_COMMANDS = [
  "/help", "/quit", "/exit", "/mode", "/chat", "/work", "/run", "/new",
  "/sessions", "/switch", "/tasks", "/status", "/report", "/attach", "/detach",
  "/cancel", "/resume", "/retry", "/agents", "/agent", "/models", "/model",
  "/notifications", "/permissions", "/templates", "/multiline", "/verbose",
  "/clear", "/doctor",
];

class InterruptWatcher {
  constructor({ input, onCancel, onDetach }) {
    this.input = input;
    this.onCancel = onCancel;
    this.onDetach = onDetach;
    this.handler = null;
    this.active = false;
  }

  start() {
    if (this.active) return;
    if (!this.input?.isTTY || typeof this.input.setRawMode !== "function") return;
    this.handler = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\u0003") {
          this.onCancel();
          return;
        }
        if (char === "\u0004") {
          this.onDetach();
          return;
        }
      }
    };
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on("data", this.handler);
    this.active = true;
  }

  pause() {
    if (!this.active) return;
    this.input.removeListener("data", this.handler);
    this.input.setRawMode(false);
    this.active = false;
  }

  resume() {
    this.start();
  }

  stop() {
    this.pause();
    this.input?.pause?.();
  }
}

export class InteractiveApp {
  constructor({ runtime, initialMode = null, now = () => Date.now() } = {}) {
    this.runtime = runtime;
    this.now = now;
    this.initialMode = initialMode;
    this.prompt = null;
    this.mode = initialMode ?? "chat";
    this.multiline = false;
    this.verbose = false;
    this.agents = null;
    this.models = null;
    this.conversations = null;
    this.unread = 0;
    this.running = false;
  }

  async start() {
    const runtime = this.runtime;
    const client = await runtime.getEngine();
    const health = await client.negotiate();
    const state = await runtime.state.load();
    this.mode = this.initialMode ?? state.active.mode ?? "chat";
    await this.refreshCatalog();
    await this.refreshUnread();

    const token = runtime.tokenInfo();
    runtime.write(runtime.style.bold(`Coderax CLI ${VERSION}`) + runtime.style.dim(`  contract ${health.contractVersion}`));
    runtime.write(`${runtime.style.dim("engine")} ${runtime.engineUrl}`);
    runtime.write(
      `${runtime.style.dim("auth")} ${token.configured ? `owner (${token.masked})` : runtime.style.yellow("not signed in")}`
      + `${runtime.style.dim("  mode")} ${this.mode}`
      + (this.unread > 0 ? `  ${runtime.style.yellow(`\u25cf ${this.unread} new`)}` : ""),
    );
    runtime.write(runtime.style.dim("Tab completes commands · Ctrl+C cancels a run · Ctrl+D detaches · /help"));
    runtime.write("");

    this.prompt = new PromptSession({
      input: runtime.stdin,
      output: runtime.stdoutStream,
      error: runtime.stderrStream,
      history: state.history[this.mode] ?? [],
      style: runtime.style,
      completer: (line) => this.complete(line),
    });

    try {
      for (;;) {
        if (runtime.signal?.aborted) break;
        let line;
        try {
          line = await this.prompt.message({
            prompt: this.promptLabel(),
            continuation: "\u2026 ",
            multiline: this.multiline,
          });
        } catch (error) {
          if (error?.code === "CANCELLED" || error?.code === "INPUT_CLOSED") break;
          throw error;
        }
        if (line === "") continue;
        await runtime.state.addHistory(this.mode, line);
        if (line.startsWith("/")) {
          const keep = await this.handleSlash(line);
          if (keep === false) break;
        } else {
          await this.handleText(line);
        }
      }
    } finally {
      this.prompt?.close();
      this.prompt = null;
    }
    return EXIT.OK;
  }

  promptLabel() {
    const runtime = this.runtime;
    const dot = this.unread > 0 ? runtime.style.yellow(` \u25cf${this.unread}`) : "";
    const label = this.mode === "work" ? runtime.style.magenta("work") : runtime.style.cyan("chat");
    return `${label}${dot} ${runtime.style.dim("\u203a")} `;
  }

  async refreshCatalog() {
    const client = await this.runtime.getEngine({ negotiate: false });
    try {
      this.agents = await client.agents({ refresh: true });
    } catch {
      this.agents = null;
    }
    try {
      this.models = await client.models();
    } catch {
      this.models = null;
    }
    try {
      this.conversations = (await client.conversations()).conversations;
    } catch {
      this.conversations = this.conversations ?? [];
    }
  }

  async refreshUnread() {
    try {
      const client = await this.runtime.getEngine({ negotiate: false });
      const notifications = await client.notifications();
      const state = await this.runtime.state.load();
      this.unread = notifications.notifications.filter(
        (entry) => !state.notifications.seen[`${entry.taskId}:${entry.state}:${entry.createdAt}`],
      ).length;
    } catch {
      this.unread = 0;
    }
  }

  complete(line) {
    const text = String(line);
    if (text.startsWith("/")) {
      const space = text.indexOf(" ");
      if (space === -1) {
        const hits = SLASH_COMMANDS.filter((command) => command.startsWith(text));
        return [hits.length ? hits : SLASH_COMMANDS, text];
      }
      const command = text.slice(0, space);
      const rest = text.slice(space + 1);
      let values = [];
      if (command === "/agent") {
        values = ["auto", ...(this.agents?.agents.map((agent) => agent.id) ?? [])];
      } else if (command === "/model") {
        values = ["auto", ...(this.models?.models.map((model) => `${model.ref.providerId}/${model.ref.modelId}`) ?? [])];
      } else if (command === "/switch") {
        values = this.conversations?.map((entry) => entry.conversationId) ?? [];
      } else if (["/attach", "/resume", "/retry", "/cancel", "/report", "/status", "/permissions"].includes(command)) {
        values = Object.keys(this.runtime.state.cached?.tasks ?? {});
      } else if (command === "/run" || command === "/work") {
        values = command === "/run" ? templateNames() : [];
      } else if (command === "/mode") {
        values = ["chat", "work"];
      }
      const hits = values.filter((value) => value.startsWith(rest));
      return [hits, text];
    }
    return [[], text];
  }

  async handleText(text) {
    if (this.mode === "work") {
      await this.workTurn(text);
    } else {
      await this.chatTurn(text);
    }
  }

  async chatTurn(text) {
    const runtime = this.runtime;
    const client = await runtime.getEngine();
    const state = await runtime.state.load();
    const agent = state.active.agent ?? runtime.config.agent ?? "coderax";
    const modelValue = state.active.model ?? (runtime.config.model || undefined);
    const model = parseModelRef(modelValue);
    try {
      await client.requireCapability(agent, null);
    } catch (error) {
      this.printError(error);
      return;
    }
    const request = {
      message: text,
      agent,
      mode: "private",
    };
    if (state.active.chatConversationId) request.conversationId = state.active.chatConversationId;
    if (model) request.model = model;

    const spinner = new Spinner({
      stream: runtime.stderrStream,
      style: runtime.style,
      text: `thinking with ${agent}`,
    });
    spinner.start();
    let reply;
    try {
      reply = await client.chat(request, { signal: runtime.signal ?? undefined });
    } catch (error) {
      spinner.stop();
      this.printError(error);
      return;
    }
    spinner.stop();
    await runtime.state.setActive({
      mode: "chat",
      chatConversationId: reply.conversationId,
      agent: reply.agent,
    });
    runtime.write("");
    runtime.write(runtime.style.dim(`${reply.agent}  ${reply.model.providerId}/${reply.model.modelId}  ${reply.createdAt}`));
    const { MarkdownRenderer } = await import("../ui/markdown.js");
    const renderer = new MarkdownRenderer({
      write: (chunk) => runtime.raw(chunk),
      width: runtime.width,
      style: runtime.style,
      indent: 2,
    });
    renderer.write(reply.text);
    renderer.end();
    runtime.write("");
    await this.refreshCatalog();
  }

  async submitTask(text, { templateName = null } = {}) {
    const runtime = this.runtime;
    const client = await runtime.getEngine();
    const state = await runtime.state.load();
    const agent = state.active.agent ?? runtime.config.agent ?? "coderax";
    const model = parseModelRef(state.active.model ?? (runtime.config.model || undefined));
    const template = templateName ? getTemplate(templateName) : null;
    if (templateName && !template) {
      this.printError(new UsageError(`unknown template: ${templateName}`));
      return null;
    }
    try {
      await client.requireCapability(agent, template?.requiresTools ? "tools" : null);
    } catch (error) {
      this.printError(error);
      return null;
    }
    const request = {
      objective: template ? buildTemplateObjective(templateName, text) : text,
      mode: "cloud",
      requireApproval: true,
      agent,
    };
    if (state.active.workConversationId) request.conversationId = state.active.workConversationId;
    if (model) request.model = model;
    const key = newSubmissionKey();
    let submitted;
    try {
      submitted = await submitWork({
        client,
        state: runtime.state,
        request,
        idempotencyKey: key,
      });
    } catch (error) {
      this.printError(error);
      return null;
    }
    await runtime.state.setActive({ mode: "work", workConversationId: submitted.task.conversationId });
    await runtime.state.addHistory("work", text);
    return submitted.task;
  }

  async workTurn(text, { templateName = null } = {}) {
    const task = await this.submitTask(text, { templateName });
    if (!task) return;
    await this.runTask(task);
  }

  async runTask(task, { fromSeq = null, command = "work.attach", reattach = false } = {}) {
    const runtime = this.runtime;
    const client = await runtime.getEngine({ negotiate: false });
    const state = await runtime.state.task(task.taskId);
    const after = Number(fromSeq ?? state?.lastSeq ?? 0);
    const controller = new AbortController();
    const watcher = new InterruptWatcher({
      input: runtime.stdin,
      onCancel: () => {
        runtime.write("\n");
        runtime.write(runtime.style.yellow("cancelling\u2026"));
        controller.abort("cancel");
      },
      onDetach: () => {
        runtime.write("\n");
        runtime.write(runtime.style.dim("detaching\u2026"));
        controller.abort("detach");
      },
    });
    const spinner = new Spinner({
      stream: runtime.stderrStream,
      style: runtime.style,
      text: `task ${task.taskId}`,
    });
    const presenter = new WorkPresenter({
      out: (chunk) => runtime.raw(chunk),
      style: runtime.style,
      width: runtime.width,
      verbose: this.verbose,
      onApproval: async (request) => this.approve(task.taskId, request, watcher),
      onProgress: (progress) => {
        if (!runtime.stdoutIsTTY) return;
        if (progress === null) {
          spinner.stop();
          return;
        }
        if (!spinner.active) spinner.start(progress.step ?? `task ${task.taskId}`);
        spinner.setText(progress.step ?? (progress.tool ? `${progress.tool}  task ${task.taskId}` : `task ${task.taskId}`));
      },
      now: () => Date.now(),
    });

    this.prompt?.pause();
    runtime.write("");
    runtime.write(runtime.style.dim(`task ${task.taskId}  ${reattach ? "attaching" : "running"}  \u00b7  Ctrl+C cancel  \u00b7  Ctrl+D detach`));
    if (runtime.stdoutIsTTY) spinner.start(`task ${task.taskId} running`);
    watcher.start();
    this.running = true;

    try {
      const result = await watchTask({
        client,
        taskId: task.taskId,
        after,
        signal: controller.signal,
        onEvent: async (event) => {
          await runtime.state.upsertTask({
            taskId: task.taskId,
            lastSeq: event.seq,
            state: event.type === "task.queued" ? "queued" : event.type === "task.started" ? "running" : undefined,
            updatedAt: new Date().toISOString(),
          });
          await presenter.onEvent(event);
        },
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
        onUnknown: (event) => {
          if (this.verbose) runtime.err(`ignored unknown event: ${event?.type ?? "unknown"}`);
        },
      });
      spinner.stop();
      const finalStatus = result.status
        ?? (result.terminalEvent ? await client.task(task.taskId, { signal: controller.signal }).catch(() => null) : null);
      const summary = presenter.finish({ ...result, status: finalStatus });
      await runtime.state.upsertTask({
        taskId: task.taskId,
        state: summary.state,
        lastSeq: result.lastSeq,
        detached: false,
        updatedAt: new Date().toISOString(),
        lastSummary: summary.summary ?? null,
      });
      await this.refreshUnread();
      return summary;
    } catch (error) {
      spinner.stop();
      if (error instanceof CancelledError) {
        const reason = controller.signal.reason;
        if (reason === "detach") {
          await runtime.state.upsertTask({ taskId: task.taskId, detached: true, updatedAt: new Date().toISOString() });
          runtime.write("");
          runtime.write(`${runtime.style.yellow("\u21b7")} detached: ${task.taskId}`);
          runtime.write(runtime.style.dim(`  reattach with /attach ${task.taskId} or coderax work attach ${task.taskId}`));
          return null;
        }
        const cancelled = await client.cancel(task.taskId, "cancelled from the interactive terminal").catch(() => null);
        await runtime.state.upsertTask({
          taskId: task.taskId,
          state: cancelled?.state ?? "cancelled",
          updatedAt: new Date().toISOString(),
        });
        runtime.write("");
        runtime.write(`${runtime.style.yellow("\u25a0")} cancelled ${task.taskId}${cancelled ? ` (${cancelled.outcome})` : ""}`);
        return null;
      }
      this.printError(error);
      return null;
    } finally {
      this.running = false;
      watcher.stop();
      spinner.stop();
      this.prompt?.resume();
    }
  }

  async approve(taskId, request, watcher) {
    const runtime = this.runtime;
    const client = await runtime.getEngine({ negotiate: false });
    watcher.pause();
    this.prompt?.resume();
    try {
      const list = await client.permissions(taskId);
      const full = list.requests.find((entry) => entry.requestId === request.requestId);
      if (full) {
        runtime.write("");
        runtime.write(runtime.style.bold("Permission request"));
        runtime.write(`  scope     ${full.scope}`);
        runtime.write(`  resource  ${full.resource}`);
        runtime.write(`  agent     ${full.agent}`);
        runtime.write(`  expires   ${full.expiresAt}`);
        runtime.write(`  ${full.description}`);
      }
      const approved = await this.prompt.confirm(`Approve ${request.tool}?`, { defaultYes: false });
      const decision = approved ? "approved" : "denied";
      await client.decidePermission(taskId, { requestId: request.requestId, decision });
      runtime.write(`${approved ? runtime.style.green("\u2713") : runtime.style.red("\u2717")} ${decision}`);
      return { decision };
    } finally {
      this.prompt?.pause();
      watcher.resume();
    }
  }

  async handleSlash(line) {
    const runtime = this.runtime;
    const space = line.indexOf(" ");
    const command = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? "" : line.slice(space + 1).trim();
    switch (command) {
      case "/quit":
      case "/exit":
        return false;
      case "/help":
        this.printHelp();
        return true;
      case "/clear":
        runtime.raw("\u001b[2J\u001b[H");
        return true;
      case "/mode": {
        if (!["chat", "work"].includes(rest)) throw new UsageError("usage: /mode chat|work");
        this.mode = rest;
        await runtime.state.setActive({ mode: rest });
        runtime.write(`mode: ${rest}`);
        return true;
      }
      case "/chat":
        this.mode = "chat";
        if (rest) await this.chatTurn(rest);
        else runtime.write("mode: chat");
        return true;
      case "/work":
        this.mode = "work";
        if (rest) await this.workTurn(rest);
        else runtime.write("mode: work");
        return true;
      case "/run": {
        const [name, ...tail] = rest.split(/\s+/);
        if (!name) {
          runtime.write(`templates: ${templateNames().join(", ")}`);
          return true;
        }
        this.mode = "work";
        await this.workTurn(tail.join(" "), { templateName: name });
        return true;
      }
      case "/new": {
        await runtime.state.setActive({ [`${this.mode}ConversationId`]: null });
        await runtime.state.setActive({ mode: this.mode });
        runtime.write(`Started a new ${this.mode} session.`);
        return true;
      }
      case "/sessions": {
        await sessionsCommand(runtime, ["list"], { prompt: null });
        const choice = await this.prompt.select({
          title: "Switch to a conversation",
          items: this.conversations ?? [],
          render: (entry) => `${entry.isWork ? "[work]" : "[chat]"} ${entry.title ?? entry.conversationId}  ${entry.updatedAt}`,
          allowCancel: true,
        });
        if (choice) await this.switchConversation(choice.conversationId);
        return true;
      }
      case "/switch":
        await this.switchConversation(rest || null);
        return true;
      case "/tasks":
        await listCommand(runtime);
        return true;
      case "/status":
        if (rest) await statusCommand(runtime, [rest], { command: "work.status" });
        else await statusCommandReport(runtime);
        return true;
      case "/report":
        await statusCommand(runtime, rest ? [rest] : [], { command: "work.report", report: true });
        return true;
      case "/attach": {
        const taskId = rest || (await this.pickTask());
        if (!taskId) return true;
        const client = await runtime.getEngine({ negotiate: false });
        const status = await client.task(taskId);
        if (["completed", "failed", "cancelled", "interrupted"].includes(status.state)) {
          await statusCommand(runtime, [taskId], { command: "work.status" });
          return true;
        }
        const task = await runtime.state.task(taskId) ?? { taskId, conversationId: status.conversationId, agent: status.agent, lastSeq: 0 };
        await this.runTask(task, { fromSeq: task.lastSeq ?? 0, command: "work.attach", reattach: true });
        return true;
      }
      case "/detach":
        runtime.write("Ctrl+D detaches a running task. Use /attach <taskId> to reattach.");
        return true;
      case "/cancel": {
        const taskId = rest || (await this.pickTask());
        if (!taskId) return true;
        await cancelCommand(runtime, [taskId]);
        return true;
      }
      case "/resume":
      case "/retry": {
        const taskId = rest || (await this.pickTask());
        if (!taskId) return true;
        const client = await runtime.getEngine({ negotiate: false });
        const status = await client.task(taskId);
        try {
          await client.requireCapability(status.agent, "resume");
        } catch (error) {
          this.printError(error);
          return true;
        }
        const result = command === "/retry"
          ? await client.retry(taskId, status.generation)
          : await client.resume(taskId, status.generation);
        runtime.write(`${result.outcome}  generation ${result.generation}`);
        const task = await runtime.state.task(taskId) ?? { taskId, conversationId: status.conversationId, agent: status.agent, lastSeq: 0 };
        await this.runTask(task, { fromSeq: task.lastSeq ?? 0, command: command === "/retry" ? "work.retry" : "work.resume", reattach: true });
        return true;
      }
      case "/agents": {
        await this.refreshCatalog();
        if (!this.agents) {
          runtime.write("Agent discovery is unavailable.");
          return true;
        }
        runtime.write(renderTable({
          headers: ["AGENT", "AVAILABLE", "REASON", "CAPABILITIES"],
          rows: this.agents.agents.map((agent) => [
            agent.id,
            agent.availability.available ? "yes" : "no",
            agent.availability.reason,
            Object.entries(agent.capabilities).filter(([, value]) => value).map(([key]) => key).join(","),
          ]),
          style: runtime.style,
          width: runtime.width,
        }));
        return true;
      }
      case "/agent":
        await this.chooseAgent(rest);
        return true;
      case "/models": {
        await this.refreshCatalog();
        if (!this.models) {
          runtime.write("Model discovery is unavailable.");
          return true;
        }
        runtime.write(renderTable({
          headers: ["MODEL", "COST", "TOOLS", "AVAILABLE"],
          rows: this.models.models.map((model) => [
            `${model.ref.providerId}/${model.ref.modelId}`,
            model.costClass,
            model.toolCalling ? "yes" : "no",
            model.availability.available ? "yes" : model.availability.reason,
          ]),
          style: runtime.style,
          width: runtime.width,
        }));
        return true;
      }
      case "/model":
        await this.chooseModel(rest);
        return true;
      case "/notifications":
        await notificationsCommand(runtime);
        return true;
      case "/permissions": {
        const taskId = rest || (await this.pickTask());
        if (taskId) await permissionsCommand(runtime, ["list", taskId], { prompt: this.prompt });
        return true;
      }
      case "/templates":
        runtime.write(renderTable({
          headers: ["TEMPLATE", "PURPOSE"],
          rows: templateNames().map((name) => [name, getTemplate(name).summary]),
          style: runtime.style,
          width: runtime.width,
        }));
        return true;
      case "/multiline":
        this.multiline = !this.multiline;
        runtime.write(`multiline ${this.multiline ? "on (blank line submits)" : "off (trailing \\\\ continues)"}`);
        return true;
      case "/verbose":
        this.verbose = !this.verbose;
        runtime.write(`verbose ${this.verbose ? "on" : "off"}`);
        return true;
      case "/doctor":
        await doctor(runtime);
        return true;
      default:
        runtime.write(`unknown command: ${command}. Type /help.`);
        return true;
    }
  }

  async switchConversation(idOrIndex) {
    const runtime = this.runtime;
    let id = idOrIndex;
    if (!id) {
      const choice = await this.prompt.select({
        title: "Switch conversation",
        items: this.conversations ?? [],
        render: (entry) => `${entry.isWork ? "[work]" : "[chat]"} ${entry.title ?? entry.conversationId}`,
      });
      id = choice?.conversationId;
      if (!id) return;
    }
    if (/^\d+$/.test(id) && this.conversations?.[Number(id) - 1]) {
      id = this.conversations[Number(id) - 1].conversationId;
    }
    const client = await runtime.getEngine({ negotiate: false });
    const conversation = await client.conversation(id);
    this.mode = conversation.isWork ? "work" : "chat";
    await runtime.state.setActive({
      mode: this.mode,
      [`${this.mode}ConversationId`]: conversation.conversationId,
      agent: conversation.agent,
    });
    runtime.write(`switched to ${this.mode} ${conversation.conversationId}`);
    if (conversation.title) runtime.write(conversation.title);
    runtime.write(runtime.style.dim(`${conversation.messages.length} messages`));
  }

  async chooseAgent(value) {
    const runtime = this.runtime;
    await this.refreshCatalog();
    const state = await runtime.state.load();
    if (value === "auto") {
      await runtime.state.setActive({ agent: null });
      runtime.write("agent: engine default");
      return;
    }
    let agent = value;
    if (!agent) {
      if (!this.agents) {
        runtime.write("Agent discovery is unavailable.");
        return;
      }
      const choice = await this.prompt.select({
        title: "Agent",
        items: this.agents.agents,
        render: (entry) => `${entry.id}  ${entry.availability.available ? "ready" : entry.availability.reason}  ${Object.entries(entry.capabilities).filter(([, enabled]) => enabled).map(([key]) => key).join(",")}`,
        defaultIndex: Math.max(0, this.agents.agents.findIndex((entry) => entry.id === state.active.agent)),
      });
      agent = choice?.id;
    }
    if (!agent) return;
    const found = this.agents?.agents.find((entry) => entry.id === agent);
    if (!found) {
      runtime.write(`unknown agent: ${agent}`);
      return;
    }
    if (!found.availability.available) {
      runtime.write(runtime.style.yellow(`agent ${agent} is unavailable (${found.availability.reason}); it will be refused, not substituted`));
    }
    await runtime.state.setActive({ agent });
    runtime.write(`agent: ${agent}`);
  }

  async chooseModel(value) {
    const runtime = this.runtime;
    await this.refreshCatalog();
    if (value === "auto") {
      await runtime.state.setActive({ model: null });
      runtime.write("model: engine default");
      return;
    }
    let model = value;
    if (!model) {
      if (!this.models) {
        runtime.write("Model discovery is unavailable.");
        return;
      }
      const choice = await this.prompt.select({
        title: "Model",
        items: this.models.models.map((entry) => ({
          ...entry,
          id: `${entry.ref.providerId}/${entry.ref.modelId}`,
        })),
        render: (entry) => `${entry.id}  ${entry.costClass}  ${entry.availability.available ? "ready" : entry.availability.reason}`,
      });
      model = choice?.id;
    }
    if (!model) return;
    try {
      parseModelRef(model);
    } catch (error) {
      this.printError(error);
      return;
    }
    await runtime.state.setActive({ model });
    runtime.write(`model: ${model}`);
  }

  async pickTask() {
    const state = await this.runtime.state.load();
    const tasks = Object.values(state.tasks).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (tasks.length === 0) {
      this.runtime.write("No known tasks.");
      return null;
    }
    const choice = await this.prompt.select({
      title: "Tasks",
      items: tasks,
      render: (task) => `${task.taskId}  ${task.state ?? "unknown"}  ${task.objective ?? ""}`,
    });
    return choice?.taskId ?? null;
  }

  printHelp() {
    this.runtime.write([
      "Chat and Work",
      "  <text>                 send a Chat turn, or submit Work when the mode is work",
      "  /mode chat|work        switch mode",
      "  /chat [text]           switch to Chat and optionally send a turn",
      "  /work [text]           switch to Work and optionally submit a task",
      "  /run <template> [text] submit an engineering workflow template",
      "  /new                   start a new conversation in this mode",
      "",
      "Sessions and tasks",
      "  /sessions              list and switch conversations",
      "  /switch [id]           switch to a conversation",
      "  /tasks                 list known durable tasks",
      "  /status [taskId]       task status, or CLI status",
      "  /report [taskId]       full task report",
      "  /attach [taskId]       reattach to a running task",
      "  /cancel [taskId]       cancel a task",
      "  /resume [taskId]       resume an interrupted task",
      "  /retry [taskId]        retry a failed task",
      "  /permissions [taskId]  inspect pending approvals",
      "",
      "Selection and notifications",
      "  /agents  /agent [id]   list or select an agent",
      "  /models  /model [ref]  list or select a model",
      "  /notifications         durable completion notifications",
      "  /templates             engineering workflow presets",
      "",
      "Terminal",
      "  /multiline             toggle blank-line submission",
      "  /verbose               toggle event detail",
      "  /doctor                run diagnostics",
      "  /clear                 clear the screen",
      "  /quit                  exit",
      "",
      "Keys: Tab completes, Ctrl+C cancels a running task, Ctrl+D detaches it.",
    ].join("\n"));
  }

  printError(error) {
    const runtime = this.runtime;
    const code = error?.code ?? "ERROR";
    runtime.write(runtime.style.red(`\u2716 ${code}`) + ` ${runtime.redact(error?.message ?? "unexpected failure")}`);
    if (error?.hint) runtime.write(runtime.style.dim(`  \u2192 ${error.hint}`));
    if (error instanceof CoderaxError && error.requestId) runtime.write(runtime.style.dim(`  request ${error.requestId}`));
  }
}

export async function runInteractive(runtime, { initialMode = null } = {}) {
  const app = new InteractiveApp({ runtime, initialMode });
  return app.start();
}
