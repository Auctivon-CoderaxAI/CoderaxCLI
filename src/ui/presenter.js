import { CoderaxError } from "../errors.js";
import { formatElapsed } from "./prompt.js";
import { truncate } from "./ansi.js";
import { MarkdownRenderer } from "./markdown.js";
import { TextAssembler } from "./text-assembler.js";

function oneLine(value, limit = 160) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return truncate(String(text).replace(/\s+/g, " ").trim(), limit);
}

function tokenSummary(usage) {
  if (!usage) return null;
  const input = Number.isInteger(usage.inputTokens) ? usage.inputTokens : null;
  const output = Number.isInteger(usage.outputTokens) ? usage.outputTokens : null;
  if (input === null && output === null) return null;
  return `${input ?? "?"} in / ${output ?? "?"} out`;
}

/**
 * Renders a durable Work run as it happens. Text is Markdown-rendered
 * incrementally; tools, steps and file edits are compact one-line progress;
 * approvals pause the stream until the owner decides.
 */
export class WorkPresenter {
  constructor({
    out = (text) => process.stdout.write(text),
    style,
    width = 100,
    verbose = false,
    quiet = false,
    onApproval = null,
    onProgress = null,
    now = () => Date.now(),
  } = {}) {
    this.out = out;
    this.style = style;
    this.width = width;
    this.verbose = verbose;
    this.quiet = quiet;
    this.onApproval = onApproval;
    this.onProgress = onProgress;
    this.now = now;
    this.markdown = null;
    this.assembler = new TextAssembler();
    this.assistantText = "";
    this.textSeen = false;
    this.usage = null;
    this.startedAt = this.now();
    this.steps = [];
    this.toolCalls = new Map();
    this.files = [];
    this.started = false;
    this.lastLineWasText = false;
  }

  #line(text = "") {
    this.out(`${text}\n`);
    this.lastLineWasText = false;
    this.onProgress?.(null);
  }

  #startText() {
    if (this.markdown) return;
    this.onProgress?.(null);
    if (this.lastLineWasText) this.out("\n");
    this.markdown = new MarkdownRenderer({
      write: (text) => this.out(text),
      width: this.width,
      style: this.style,
    });
    this.lastLineWasText = true;
  }

  #renderText(text) {
    this.#startText();
    this.assistantText += text;
    this.markdown.write(text);
  }

  #onDelta(value) {
    const outcome = this.assembler.delta(value);
    if (outcome.kind === "delta") this.#renderText(outcome.text);
  }

  #onSnapshot(value) {
    const outcome = this.assembler.snapshot(value);
    if (outcome.kind === "delta") this.#renderText(outcome.text);
    else if (outcome.kind === "replace") this.#replaceText(outcome.text);
  }

  #replaceText(text) {
    if (this.markdown) {
      this.markdown.end();
      this.markdown = null;
    }
    this.assistantText = text;
    this.textSeen = true;
    this.#line(this.style?.yellow("\u21ba response revised") ?? "\u21ba response revised");
    this.#startText();
    this.markdown.write(text);
  }

  async onEvent(event) {
    const payload = event.payload ?? {};
    switch (event.type) {
      case "task.queued":
        this.#line(this.style?.dim(`\u25cb queued  ${event.taskId}`) ?? `\u25cb queued  ${event.taskId}`);
        break;
      case "task.started":
        this.started = true;
        this.startedAt = this.now();
        this.#line(
          this.style?.cyan(`\u25b8 started  ${event.agent}  generation ${event.generation}`)
            ?? `\u25b8 started  ${event.agent}  generation ${event.generation}`,
        );
        if (payload.sessionId && this.verbose) this.#line(this.style?.dim(`  session ${payload.sessionId}`));
        break;
      case "step.started":
        this.steps.push({ id: payload.stepId, title: payload.title, state: "running" });
        this.#line(`${this.style?.cyan("\u25b8") ?? "\u25b8"} ${payload.title}`);
        this.onProgress?.({ step: payload.title, startedAt: this.startedAt });
        break;
      case "step.completed": {
        const step = this.steps.find((entry) => entry.id === payload.stepId);
        if (step) step.state = "completed";
        this.#line(`${this.style?.green("\u2713") ?? "\u2713"} ${payload.title}`);
        break;
      }
      case "text.delta":
        this.#onDelta(payload.text);
        break;
      case "text.replace":
        this.#onSnapshot(payload.text);
        break;
      case "tool.call": {
        this.toolCalls.set(payload.callId, payload);
        const input = payload.input === undefined ? "" : ` ${oneLine(payload.input, this.verbose ? 400 : 120)}`;
        this.#line(`${this.style?.magenta("\u2699") ?? "\u2699"} ${this.style?.bold(payload.tool) ?? payload.tool}${this.style?.dim(input) ?? input}`);
        this.onProgress?.({ tool: payload.tool, startedAt: this.startedAt });
        break;
      }
      case "tool.result": {
        const call = this.toolCalls.get(payload.callId);
        this.toolCalls.delete(payload.callId);
        const marker = payload.ok ? (this.style?.green("\u2713") ?? "\u2713") : (this.style?.red("\u2717") ?? "\u2717");
        const detail = payload.output ? ` ${oneLine(payload.output, this.verbose ? 400 : 140)}` : "";
        this.#line(`${marker} ${payload.tool}${this.style?.dim(detail) ?? detail}${call ? "" : ""}`);
        break;
      }
      case "file.edit":
        this.files.push(payload.path);
        this.#line(`${this.style?.cyan("\u270e") ?? "\u270e"} ${payload.path}`);
        break;
      case "approval.required": {
        const request = payload;
        this.#line(
          `${this.style?.yellow("\u26a0") ?? "\u26a0"} approval required: ${this.style?.bold(request.tool) ?? request.tool}`,
        );
        this.#line(`  ${request.description}`);
        if (!this.onApproval) {
          throw new CoderaxError(
            "PERMISSION_REQUIRED",
            `task ${event.taskId} needs approval for ${request.tool}`,
            {
              details: { taskId: event.taskId, requestId: request.requestId, tool: request.tool },
              hint: `Run \`coderax permissions ${event.taskId}\` to decide, then reattach with \`coderax work attach ${event.taskId}\`.`,
            },
          );
        }
        const decision = await this.onApproval(request, event);
        if (!decision) {
          throw new CoderaxError(
            "PERMISSION_REQUIRED",
            `approval for ${request.tool} was not granted`,
            { details: { taskId: event.taskId, requestId: request.requestId } },
          );
        }
        break;
      }
      case "usage":
        this.usage = payload;
        if (this.verbose) {
          const summary = tokenSummary(payload);
          if (summary) this.#line(this.style?.dim(`  usage ${summary}`) ?? `  usage ${summary}`);
        }
        break;
      case "task.completed":
        this.terminal = event;
        break;
      case "task.failed":
        this.terminal = event;
        break;
      case "task.cancelled":
        this.terminal = event;
        break;
      case "task.interrupted":
        this.terminal = event;
        break;
      default:
        if (this.verbose) this.#line(this.style?.dim(`  ${event.type}`) ?? `  ${event.type}`);
        break;
    }
  }

  /**
   * Print the terminal block and return a machine-readable summary. The
   * authoritative task status is used when the stream ended without a terminal
   * event (a truncated replay).
   */
  finish({ terminalEvent = null, status = null, lastSeq = 0 } = {}) {
    if (this.markdown) {
      this.markdown.end();
      this.markdown = null;
    }
    const event = terminalEvent ?? this.terminal ?? null;
    const state = status?.state ?? event?.type?.replace("task.", "") ?? "unknown";
    const elapsed = formatElapsed(this.now() - this.startedAt);
    const summary = event?.payload?.summary ?? status?.result?.summary ?? null;
    const artifacts = status?.result?.artifacts ?? [];
    const usage = event?.payload?.usage ?? status?.usage ?? this.usage;
    const failure = event?.payload?.code
      ? { code: event.payload.code, detail: event.payload.detail, retryable: event.payload.retryable }
      : status?.failure
        ? { code: status.failure.code, detail: status.failure.detail, retryable: false }
        : null;

    if (!this.quiet) {
      this.out("\n");
      if (state === "completed") {
        this.#line(`${this.style?.green("\u2714") ?? "\u2714"} completed in ${elapsed}`);
      } else if (state === "cancelled") {
        this.#line(`${this.style?.yellow("\u25a0") ?? "\u25a0"} cancelled in ${elapsed}`);
      } else if (state === "interrupted") {
        this.#line(`${this.style?.yellow("\u26a0") ?? "\u26a0"} interrupted in ${elapsed}`);
        this.#line(this.style?.dim(`  resume with: coderax work resume ${status?.taskId ?? ""}`) ?? "");
      } else if (state === "failed") {
        this.#line(
          `${this.style?.red("\u2716") ?? "\u2716"} failed${failure?.code ? ` (${failure.code})` : ""} in ${elapsed}`,
        );
        if (failure?.detail) this.#line(`  ${failure.detail}`);
        if (failure?.retryable) this.#line(this.style?.dim("  this failure is marked retryable") ?? "");
      } else {
        this.#line(`${this.style?.yellow("\u25cb") ?? "\u25cb"} ${state} in ${elapsed}`);
      }

      if (summary && !this.assistantText.trim()) {
        this.out("\n");
        const renderer = new MarkdownRenderer({ write: (text) => this.out(text), width: this.width, style: this.style });
        renderer.write(summary);
        renderer.end();
      }
      if (artifacts.length > 0) {
        this.#line(`\n${this.style?.bold("artifacts") ?? "artifacts"}`);
        for (const artifact of artifacts) {
          const bytes = Number.isInteger(artifact.bytes) ? ` (${artifact.bytes} bytes)` : "";
          this.#line(`  ${artifact.path}${bytes}`);
        }
      }
      if (this.files.length > 0 && this.verbose) {
        this.#line(`\n${this.style?.bold("files touched") ?? "files touched"}`);
        for (const file of [...new Set(this.files)]) this.#line(`  ${file}`);
      }
      const tokens = tokenSummary(usage);
      if (tokens) this.#line(this.style?.dim(`\nusage: ${tokens}`) ?? `\nusage: ${tokens}`);
    }

    return {
      taskId: event?.taskId ?? status?.taskId ?? null,
      state,
      summary,
      artifacts,
      usage: usage ?? null,
      failure,
      steps: status?.steps ?? this.steps,
      files: [...new Set(this.files)],
      lastSeq,
      elapsedMs: this.now() - this.startedAt,
    };
  }
}

export function renderTaskStatus(status, { style, out = (text) => process.stdout.write(text), width = 100 } = {}) {
  const lines = [
    `${style?.bold("task") ?? "task"}      ${status.taskId}`,
    `${style?.dim("state") ?? "state"}     ${status.state}`,
    `${style?.dim("agent") ?? "agent"}     ${status.agent}  ${style?.dim(status.mode) ?? status.mode}`,
    `${style?.dim("generation") ?? "generation"} ${status.generation}`,
    `${style?.dim("created") ?? "created"}   ${status.createdAt}`,
    `${style?.dim("updated") ?? "updated"}   ${status.updatedAt}`,
    `${style?.dim("cancel") ?? "cancel"}    ${status.cancelRequested ? "requested" : "not requested"}`,
  ];
  if (status.model) lines.push(`${style?.dim("model") ?? "model"}     ${status.model.providerId}/${status.model.modelId}`);
  if (status.steps.length > 0) {
    lines.push("", style?.bold("steps") ?? "steps");
    for (const step of status.steps) {
      const marker = step.state === "completed" ? "\u2713" : step.state === "running" ? "\u25b8" : "\u25cb";
      lines.push(`  ${marker} ${step.title} ${style?.dim(`(${step.state})`) ?? `(${step.state})`}`);
    }
  }
  if (status.result?.summary) {
    lines.push("", style?.bold("summary") ?? "summary");
    const renderer = new MarkdownRenderer({ write: (text) => out(text), width, style, indent: 2 });
    renderer.write(status.result.summary);
    renderer.end();
  }
  if (status.result?.artifacts?.length) {
    lines.push("", style?.bold("artifacts") ?? "artifacts");
    for (const artifact of status.result.artifacts) lines.push(`  ${artifact.path}`);
  }
  if (status.failure) {
    lines.push("", `${style?.red("failure") ?? "failure"} ${status.failure.code}${status.failure.detail ? `: ${status.failure.detail}` : ""}`);
  }
  return lines.join("\n");
}

export function renderPermissionRequest(request, { style } = {}) {
  return [
    `${style?.bold(request.scope) ?? request.scope}  ${request.decision}`,
    `  request  ${request.requestId}`,
    `  agent    ${request.agent}`,
    `  resource ${request.resource}`,
    `  ${request.description}`,
    `  expires  ${request.expiresAt}`,
  ].join("\n");
}
