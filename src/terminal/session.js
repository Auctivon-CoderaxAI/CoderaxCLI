/**
 * Interactive Chat/Work session.
 *
 * The session is transport-agnostic: it consumes the SDK facade's event
 * vocabulary and drives a renderer, an editor and local metadata stores. It
 * never assembles a request body itself, never routes models and never persists
 * a response. Long sessions stay bounded because the only retained output is
 * the renderer's capped last block; tool events, permissions, completions and
 * history are all ring buffers or capped lists.
 */

import {
  applyCompletion,
  commandHelp,
  complete as completeInput,
} from "./completion.js";
import { AttachmentError, prepareAttachments } from "./attachments.js";
import { MarkdownRenderer } from "./markdown.js";
import { PermissionBroker } from "./permissions.js";
import { sanitizeOneLine, sanitizeTerminalText } from "./sanitize.js";

const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
const MAX_LAST_PROMPT = 10_000;
const MAX_TOOL_EVENTS = 200;
const MAX_PENDING_PERMISSIONS = 8;

function selectorValue(entry) {
  if (typeof entry === "string") return entry;
  return String(entry?.id ?? entry?.name ?? entry?.slug ?? "");
}

function selectorDescription(entry) {
  if (!entry || typeof entry !== "object") return "";
  return sanitizeOneLine(entry.description ?? entry.title ?? "", 80);
}

export class InteractiveSession {
  constructor({
    transport,
    renderer,
    editor,
    history = null,
    conversations = null,
    broker = null,
    mode = "chat",
    model = "",
    agent = "",
    conversationId = null,
    cwd = process.cwd(),
    confirmAttachment = null,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    logger = null,
    maxToolEvents = MAX_TOOL_EVENTS,
  } = {}) {
    this.transport = transport;
    this.renderer = renderer;
    this.editor = editor;
    this.history = history;
    this.conversations = conversations;
    this.now = now;
    this.cwd = cwd;
    this.confirmAttachment = confirmAttachment;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.logger = logger;
    this.maxToolEvents = Math.max(10, Math.min(1000, maxToolEvents));

    this.settings = {
      mode: mode === "work" ? "work" : "chat",
      model: model || "",
      agent: agent || "",
      conversationId: conversationId || null,
    };
    this.sessionConversationId = conversationId || null;
    this.broker = broker ?? new PermissionBroker({
      capabilities: transport.capabilities,
      channelVerified: transport.capabilities?.verifiedPermissions === true,
      respond: (payload) => transport.respondPermission(payload),
      now,
    });

    this.running = false;
    this.busy = false;
    this.controller = null;
    this.sendPromise = null;
    this.lastSend = null;
    this.toolEvents = [];
    this.toolCount = 0;
    this.receivedChars = 0;
    this.blockedPermissions = 0;
    this.permission = null;
    this.permissionQueue = [];
    this.menu = null;
    this.confirmRequest = null;
    this.spinnerTimer = null;
    this.spinnerFrame = 0;
    this.startedAt = 0;
    this.historyIndex = history?.size ?? 0;
    this.historyDraft = "";
    this.completionState = null;
    this.models = [];
    this.agents = [];
    this.exitCode = 0;
    this.markdown = null;
    this.cancelPresses = 0;
    this.outcome = "idle";
  }

  get promptLabel() {
    return this.settings.mode === "work" ? "work \u203a " : "chat \u203a ";
  }

  _note(text, style = "muted") {
    this.renderer.writeLines([[{ text: String(text), style }]], { record: false });
  }

  _noteLines(lines) {
    this.renderer.writeLines(lines, { record: false });
  }

  _setIdleStatus() {
    const parts = [];
    if (this.settings.model) parts.push(`model ${this.settings.model}`);
    if (this.settings.agent) parts.push(`agent ${this.settings.agent}`);
    this.renderer.setStatus(parts.length > 0 ? { label: "", detail: parts.join(" \u00b7 ") } : null);
    this.renderer.setPreview("");
  }

  beginPrompt() {
    this._setIdleStatus();
    this.renderer.beginInput({ prompt: this.promptLabel, editor: this.editor });
  }

  _updatePrompt() {
    if (this.busy || this.menu || this.permission || this.confirmRequest) return;
    this.renderer.updateInput({ prompt: this.promptLabel, editor: this.editor });
  }

  async run({ nextEvent } = {}) {
    if (typeof nextEvent !== "function") throw new Error("InteractiveSession.run requires nextEvent()");
    this.running = true;
    const transportKind = this.transport.kind ?? "legacy";
    this._note(
      `Coderax ${this.settings.mode} \u00b7 ${transportKind} transport${this.transport.capabilities?.verifiedPermissions ? " \u00b7 verified approvals" : ""} \u00b7 /help`,
    );
    this.beginPrompt();

    while (this.running) {
      let event;
      try {
        event = await nextEvent();
      } catch {
        break;
      }
      if (event === null || event === undefined) {
        if (this.busy) this.abortCurrent("input closed");
        break;
      }
      await this.handleEvent(event);
    }

    await this.shutdown();
    return this.exitCode;
  }

  async handleEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "resize") {
      this.renderer.resize(event.columns ?? this.renderer.width);
      this._updatePrompt();
      return;
    }

    const key = event.type === "key" ? event : null;
    const isCancel = key && (key.name === "escape" || (key.ctrl && key.name === "c"));

    if (this.confirmRequest) {
      await this._handleConfirmKey(event);
      return;
    }
    if (this.permission) {
      await this._handlePermissionKey(event);
      return;
    }
    if (this.menu) {
      await this._handleMenuKey(event);
      return;
    }

    if (this.busy) {
      if (isCancel) this.abortCurrent("cancelled by operator");
      return;
    }

    if (isCancel) {
      if (!this.editor.isEmpty) {
        this.editor.clear();
        this.completionState = null;
        this.cancelPresses = 0;
        this._updatePrompt();
        return;
      }
      this.cancelPresses += 1;
      if (this.cancelPresses >= 2) {
        this.running = false;
        return;
      }
      this._note("Nothing to cancel. Press Ctrl+C again or Ctrl+D to exit.");
      return;
    }
    this.cancelPresses = 0;

    if (this.completionState && !(event.type === "key" && event.name === "tab")) {
      this.completionState = null;
    }

    const result = this.editor.handleKey(event);
    if (result.action === "submit") {
      const text = this.editor.value.trim();
      if (text === "") {
        this._updatePrompt();
        return;
      }
      this.editor.clear();
      this.renderer.endInput();
      this.completionState = null;
      if (text.startsWith("/")) {
        await this.handleCommand(text);
        if (this.running && !this.menu && !this.permission && !this.confirmRequest && !this.busy) {
          this.beginPrompt();
        }
      } else {
        this.startSend(text);
      }
      return;
    }
    if (result.action === "complete") {
      await this.handleCompletion();
      return;
    }
    if (result.action === "eof") {
      this.running = false;
      return;
    }
    if (result.action === "redraw") {
      this.renderer.clearScreen();
      this._updatePrompt();
      return;
    }
    if (result.action === "history-prev" || result.action === "history-next") {
      this.navigateHistory(result.action === "history-prev" ? -1 : 1);
      return;
    }
    if (result.action === "search") {
      this._note("History search is not available in this build; use Up/Down.");
      return;
    }
    if (result.action === "too-large") {
      this._note("Input is too large for the editor; the excess was not inserted.");
      return;
    }

    this._updatePrompt();
  }

  navigateHistory(direction) {
    if (!this.history || this.history.size === 0) {
      this._note("No prompt history.");
      return;
    }
    const entries = this.history.list();
    if (direction < 0) {
      if (this.historyIndex >= entries.length) {
        this.historyDraft = this.editor.value;
        this.historyIndex = entries.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex -= 1;
      }
      this.editor.setValue(entries[this.historyIndex]?.text ?? "");
    } else {
      if (this.historyIndex >= entries.length - 1) {
        this.historyIndex = entries.length;
        this.editor.setValue(this.historyDraft);
      } else {
        this.historyIndex += 1;
        this.editor.setValue(entries[this.historyIndex]?.text ?? "");
      }
    }
    this._updatePrompt();
  }

  completionContext() {
    return {
      models: this.models,
      agents: this.agents,
      conversations: this.conversations?.list() ?? [],
    };
  }

  async handleCompletion() {
    // Repeated Tab cycles the same candidate list. Recomputing from the text
    // after the first insertion would collapse the list to one option.
    if (this.completionState) {
      const state = this.completionState;
      const index = (state.index + 1) % state.options.length;
      const applied = applyCompletion(state.baseText, state.cursor, state.completion, state.options[index].value);
      this.editor.setValue(applied.text);
      this.editor.setCursor(0, applied.cursor);
      this.completionState = { ...state, index };
      this._updatePrompt();
      return;
    }

    const text = this.editor.value;
    const cursor = this._cursorOffset();
    const completion = completeInput(text, cursor, this.completionContext());
    if (!completion) {
      this._note("No completions.");
      return;
    }
    const applied = applyCompletion(text, cursor, completion, completion.options[0].value);
    this.editor.setValue(applied.text);
    this.editor.setCursor(0, applied.cursor);
    this.completionState = { completion, options: completion.options, index: 0, baseText: text, cursor };
    if (completion.options.length > 1) {
      this._note(`completions: ${completion.options.map((option) => option.value).join("  ")}`);
    }
    this._updatePrompt();
  }

  _cursorOffset() {
    const lines = this.editor.lines;
    let offset = 0;
    for (let row = 0; row < this.editor.row; row += 1) offset += lines[row].length + 1;
    return offset + this.editor.col;
  }

  startSend(text) {
    if (this.busy) {
      this._note("A response is already in progress; press Esc to cancel it.");
      return;
    }
    const prompt = String(text ?? "").trim();
    if (prompt === "") return;
    this.busy = true;
    this.outcome = "pending";
    this.controller = new AbortController();
    this.startedAt = this.now();
    this.receivedChars = 0;
    this.toolEvents = [];
    this.toolCount = 0;
    this.permission = null;
    this.permissionQueue = [];
    this.lastSend = {
      text: prompt.slice(0, MAX_LAST_PROMPT),
      mode: this.settings.mode,
      model: this.settings.model,
      agent: this.settings.agent,
    };
    this.markdown = new MarkdownRenderer({ width: this.renderer.width });
    this.renderer.startResponse();
    this.renderer.setStatus({ busy: true, label: "Thinking", frame: SPINNER[0] });
    this.spinnerFrame = 0;
    this._startSpinner();
    if (!this.renderer.interactive) this._note("Waiting for a response\u2026");
    this._drawBusy();
    this.sendPromise = this.transmit(prompt, this.controller)
      .catch((error) => this._handleSendFailure(error))
      .finally(() => this._finishSend());
  }

  _startSpinner() {
    if (!this.setIntervalFn) return;
    this.spinnerTimer = this.setIntervalFn(() => {
      if (!this.busy) return;
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      if (this.renderer.interactive && !this.permission) {
        this.renderer.setStatus({
          ...(this.renderer.status ?? {}),
          busy: true,
          frame: SPINNER[this.spinnerFrame],
        });
        this._drawBusy();
      }
    }, 120);
    this.spinnerTimer?.unref?.();
  }

  _stopSpinner() {
    if (this.spinnerTimer && this.clearIntervalFn) this.clearIntervalFn(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  _drawBusy() {
    if (!this.renderer.interactive) return;
    this.renderer.drawPrompt({ prompt: this.promptLabel, editor: this.editor });
  }

  _status(label, detail = "") {
    if (!this.busy) return;
    this.renderer.setStatus({ busy: true, label, detail, frame: SPINNER[this.spinnerFrame] });
    this._drawBusy();
  }

  async transmit(rawText, controller) {
    let prompt = rawText;
    let attachments = [];

    if (/(^|\s)@"?[^"\s]+/.test(rawText)) {
      this._status("Reviewing attachments");
      try {
        const prepared = await prepareAttachments({
          text: rawText,
          cwd: this.cwd,
          confirm: this.confirmAttachment ?? ((info) => this.askConfirm(info)),
        });
        prompt = prepared.text;
        attachments = prepared.files;
        if (attachments.length > 0) {
          this._note(
            `Attached ${attachments.length} file(s) with explicit approval: ${attachments
              .map((file) => `${file.name} (${file.bytes} bytes)`)
              .join(", ")}`,
          );
        }
      } catch (error) {
        if (error instanceof AttachmentError && error.code === "ATTACHMENT_DECLINED") {
          this._note("Attachment not approved. Nothing was read or sent.");
          this.outcome = "not-sent";
          return;
        }
        throw error;
      }
    }

    if (this.history) {
      const stored = await this.history.add(rawText, { mode: this.settings.mode });
      if (stored.stored === false && stored.reason === "sensitive") {
        this._note("Prompt not saved to history because it looks sensitive.");
      } else if (stored.stored === false && stored.reason === "write-failed") {
        this._note("Prompt history could not be written securely; it was not saved.", "warn");
      }
    }

    this._status("Thinking");
    const result = await this.transport.stream({
      mode: this.settings.mode,
      text: prompt,
      model: this.settings.model,
      agent: this.settings.agent,
      conversationId: this.sessionConversationId,
      attachments,
      signal: controller.signal,
      onEvent: (event) => this._handleStreamEvent(event),
    });

    if (this.markdown) {
      const tail = this.markdown.flush();
      if (tail.length > 0) this.renderer.writeLines(tail);
      if (this.receivedChars === 0 && typeof result?.text === "string" && result.text !== "") {
        this.renderer.writeLines(this.markdown.feed(result.text));
        this.renderer.writeLines(this.markdown.flush());
      }
    }
    if (result?.conversationId) this.sessionConversationId = result.conversationId;

    if (this.conversations) {
      await this.conversations.upsert({
        conversationId: this.sessionConversationId,
        mode: this.settings.mode,
        model: this.settings.model,
        agent: this.settings.agent,
        prompt: rawText,
      });
    }
    this.outcome = "ok";
  }

  _handleStreamEvent(event) {
    if (!event || typeof event !== "object") return;
    const markdown = this.markdown;
    switch (event.type) {
      case "delta": {
        const text = String(event.text ?? "");
        this.receivedChars += text.length;
        if (markdown) {
          const lines = markdown.feed(text);
          if (lines.length > 0) this.renderer.writeLines(lines);
          this.renderer.setPreview(markdown.preview());
        }
        this._status("Streaming", `${this.receivedChars} chars`);
        return;
      }
      case "replace": {
        const text = String(event.text ?? "");
        this.receivedChars = text.length;
        if (markdown) {
          const lines = markdown.replace(text);
          if (lines.length > 0) this.renderer.writeLines(lines);
          this.renderer.setPreview(markdown.preview());
        }
        return;
      }
      case "tool": {
        this.toolCount += 1;
        this.toolEvents.push({
          name: sanitizeOneLine(event.name, 60),
          status: sanitizeOneLine(event.status ?? "running", 20),
          detail: sanitizeOneLine(event.detail ?? "", 120),
        });
        if (this.toolEvents.length > this.maxToolEvents) this.toolEvents.shift();
        const tool = this.toolEvents[this.toolEvents.length - 1];
        this.renderer.writeLines(
          [[{ text: `\u2699 ${tool.name}${tool.status ? ` \u00b7 ${tool.status}` : ""}${tool.detail ? ` \u00b7 ${tool.detail}` : ""}`, style: "tool" }]],
          { record: true },
        );
        this._status("Working", `${tool.name}`);
        return;
      }
      case "progress": {
        this._status("Working", sanitizeOneLine(event.message ?? "", 60));
        return;
      }
      case "permission": {
        this._handlePermissionEvent(event);
        return;
      }
      case "conversation": {
        if (typeof event.id === "string" && event.id !== "") this.sessionConversationId = event.id;
        return;
      }
      default:
        return;
    }
  }

  _handlePermissionEvent(event) {
    const verdict = this.broker.consider(event.request);
    if (verdict.status === "denied") {
      this.blockedPermissions += 1;
      this._note(`Permission blocked (${verdict.reason}): ${verdict.detail || "request not verified"}.`, "warn");
      return;
    }
    if (verdict.status === "session-granted") {
      this._note(
        `Permission re-approved for the same action and resource in this session: ${verdict.entry.request.action} ${verdict.entry.request.displayResource}`,
      );
      void this._resolvePermission(verdict.entry, "once", { automatic: true });
      return;
    }
    this.permissionQueue.push(verdict);
    if (this.permissionQueue.length > MAX_PENDING_PERMISSIONS) {
      const dropped = this.permissionQueue.shift();
      this.broker.pending.delete(dropped.entry.request.requestId);
    }
    if (!this.permission) this._showNextPermission();
  }

  _showNextPermission() {
    const next = this.permissionQueue.shift();
    if (!next) {
      this.permission = null;
      if (this.busy) this._drawBusy();
      return;
    }
    this.permission = { ...next, selected: 0 };
    this.renderer.showPermission(this.permission);
  }

  async _handlePermissionKey(event) {
    if (event.type === "resize") {
      this.renderer.showPermission(this.permission);
      return;
    }
    const key = event.type === "key" ? event : null;
    if (key && (key.name === "escape" || (key.ctrl && key.name === "c"))) {
      await this._resolvePermission(this.permission.entry, "deny");
      return;
    }
    if (key && (key.name === "up" || key.name === "down")) {
      const delta = key.name === "up" ? -1 : 1;
      const total = this.permission.options.length;
      this.permission.selected = (this.permission.selected + delta + total) % total;
      this.renderer.showPermission(this.permission);
      return;
    }
    if (key && key.name === "enter") {
      await this._resolvePermission(
        this.permission.entry,
        this.permission.options[this.permission.selected].decision,
      );
      return;
    }
    if (event.type === "text") {
      const text = event.text.trim();
      const option = this.permission.options.find((item) => item.key === text);
      if (option) {
        await this._resolvePermission(this.permission.entry, option.decision);
        return;
      }
    }
  }

  async _resolvePermission(entry, decision, { automatic = false } = {}) {
    const result = await this.broker.respond(entry.request.requestId, decision);
    if (!result.ok) {
      this.permission = null;
      this._note(
        `Approval could not be delivered (${result.reason}); treating the request as denied and cancelling the response.`,
        "error",
      );
      this.abortCurrent("approval channel failed");
      this._showNextPermission();
      return;
    }
    this.permission = null;
    if (decision === "deny") this._note("Permission denied.");
    else if (!automatic) this._note("Permission approved.");
    this._showNextPermission();
  }

  askConfirm(info) {
    return new Promise((resolve) => {
      this.confirmRequest = { info, resolve };
      const rows = [
        [{ text: "\u26a0 Send a local file to the cloud deployment?", style: "permission" }],
        [{ text: `  file    ${sanitizeOneLine(info.name, 100)}`, style: null }],
        [{ text: `  path    ${sanitizeOneLine(info.path, 200)}`, style: "muted" }],
        [{ text: `  size    ${info.bytes} bytes`, style: null }],
        [{ text: `  sha256  ${info.sha256.slice(0, 16)}\u2026`, style: "muted" }],
      ];
      if (info.symlinkTarget) rows.push([{ text: `  symlink ${sanitizeOneLine(info.symlinkTarget, 200)}`, style: "warn" }]);
      rows.push([{ text: "", style: null }]);
      rows.push([{ text: "  y) Send this file   n) Do not send", style: null }]);
      this.renderer.writeLines(rows, { record: false });
    });
  }

  async _handleConfirmKey(event) {
    const key = event.type === "key" ? event : null;
    const text = event.type === "text" ? event.text.trim().toLowerCase() : "";
    let answer = null;
    if (key && (key.name === "escape" || (key.ctrl && key.name === "c"))) answer = false;
    else if (key && key.name === "enter") answer = true;
    else if (text === "y" || text === "yes") answer = true;
    else if (text === "n" || text === "no") answer = false;
    if (answer === null) return;
    const pending = this.confirmRequest;
    this.confirmRequest = null;
    this._note(answer ? "File approved for this send." : "File not sent.");
    pending.resolve(answer);
  }

  abortCurrent(reason = "cancelled") {
    if (!this.busy) return;
    this._note(`Cancelling response\u2026`);
    this.broker.denyAllPending();
    this.permission = null;
    this.permissionQueue = [];
    this.controller?.abort(reason);
  }

  _handleSendFailure(error) {
    if (this.markdown) {
      const tail = this.markdown.flush();
      if (tail.length > 0) this.renderer.writeLines(tail);
    }
    if (error?.code === "CANCELLED") {
      this.outcome = "cancelled";
      this._note("Response cancelled. /retry resends the last prompt.", "warn");
      return;
    }
    this.outcome = "error";
    const code = error?.code ?? "ERROR";
    const message = sanitizeOneLine(error?.message ?? "unexpected failure", 300);
    this._note(`error: ${code}: ${message}`, "error");
    this.exitCode = this.exitCode || 0;
  }

  async _finishSend() {
    this.broker.denyAllPending();
    this.permission = null;
    this.permissionQueue = [];
    this._stopSpinner();
    this.renderer.setPreview("");
    if (this.busy) {
      const elapsed = Math.max(0, this.now() - this.startedAt);
      this.renderer.setStatus(null);
      if (this.outcome === "ok" || this.outcome === "pending") {
        this._note(
          `\u2713 done \u00b7 ${(elapsed / 1000).toFixed(1)}s \u00b7 ${this.receivedChars} chars`,
          "success",
        );
      }
    }
    this.busy = false;
    this.controller = null;
    this.markdown = null;
    this.renderer.endResponse();
    if (!this.renderer.interactive) this._note("Response complete.");
    this.beginPrompt();
  }

  async handleCommand(text) {
    const [rawName, ...rest] = text.trim().split(/\s+/);
    const name = rawName.slice(1).toLowerCase();
    const argument = rest.join(" ").trim();

    switch (name) {
      case "help": {
        const lines = [
          [{ text: "Commands", style: "heading" }],
          ...commandHelp().map((entry) => [
            { text: `  ${entry.usage.padEnd(26)} ${entry.description}`, style: null },
          ]),
          [{ text: "", style: null }],
          [{ text: "Keys", style: "heading" }],
          [{ text: "  Enter submit   Ctrl+J / Alt+Enter newline   Tab complete", style: null }],
          [{ text: "  Up/Down history   Ctrl+A/E line start/end   Ctrl+W delete word", style: null }],
          [{ text: "  Ctrl+K/U kill to end/start   Ctrl+L redraw   Esc cancel", style: null }],
          [{ text: "  Ctrl+C cancel response (or clear input; twice at an empty prompt exits)", style: null }],
          [{ text: "  Ctrl+D exit on an empty prompt", style: null }],
          [{ text: "", style: null }],
          [{ text: "Modes: /mode chat|work \u00b7 /model selects a model \u00b7 /agent selects an agent", style: "muted" }],
        ];
        this._noteLines(lines);
        return;
      }
      case "quit":
      case "exit":
      case "q":
        this.running = false;
        return;
      case "clear":
        this.editor.clear();
        this._note("Input cleared.");
        return;
      case "new":
        this.sessionConversationId = null;
        this.lastSend = null;
        this._note("Started a new conversation.");
        return;
      case "mode": {
        const value = argument.toLowerCase();
        if (value !== "chat" && value !== "work") {
          this._note(`Mode is ${this.settings.mode}. Usage: /mode chat|work`);
          return;
        }
        this.settings.mode = value;
        this._note(`Mode set to ${value}.`);
        return;
      }
      case "model": {
        if (argument) {
          this.settings.model = argument;
          this._note(`Model set to ${sanitizeOneLine(argument, 80)}.`);
          return;
        }
        await this.openSelection("model");
        return;
      }
      case "agent": {
        if (argument) {
          this.settings.agent = argument;
          this._note(`Agent set to ${sanitizeOneLine(argument, 80)}.`);
          return;
        }
        await this.openSelection("agent");
        return;
      }
      case "resume": {
        if (argument) {
          this.resumeConversation(argument);
          return;
        }
        await this.openSelection("conversation");
        return;
      }
      case "retry": {
        if (!this.lastSend) {
          this._note("Nothing to retry yet.");
          return;
        }
        if (this.busy) {
          this._note("A response is already in progress.");
          return;
        }
        this.settings.mode = this.lastSend.mode;
        this.settings.model = this.lastSend.model;
        this.settings.agent = this.lastSend.agent;
        this.startSend(this.lastSend.text);
        return;
      }
      case "cancel":
        if (this.busy) this.abortCurrent();
        else this._note("No response is in progress.");
        return;
      case "history": {
        if (!this.history) {
          this._note("History is not configured.");
          return;
        }
        if (argument === "clear") {
          await this.history.clear();
          this._note("Prompt history cleared.");
        } else if (argument === "off") {
          await this.history.setEnabled(false);
          if (this.conversations) {
            this.conversations.enabled = false;
            await this.conversations.clear();
          }
          this._note("History disabled for this session and cleared. Run `coderax history off` to persist this.");
        } else if (argument === "on") {
          await this.history.setEnabled(true);
          if (this.conversations) this.conversations.enabled = true;
          this._note("History enabled for this session. Run `coderax history on` to persist this.");
        } else if (argument.startsWith("retention ")) {
          const days = Number(argument.slice("retention ".length));
          if (!Number.isInteger(days) || days < 1 || days > 3650) {
            this._note("Usage: /history retention <days> (1-3650)");
            return;
          }
          this.history.setRetentionDays(days);
          this._note(`History retention set to ${days} day(s) for this session.`);
        } else {
          this._note(
            `History ${this.history.enabled ? "enabled" : "disabled"} \u00b7 ${this.history.size} prompt(s) \u00b7 retention ${this.history.retentionDays} day(s)`,
          );
        }
        return;
      }
      case "permissions": {
        const grants = this.broker.grants();
        if (grants.length === 0) {
          this._note(`No session permission grants. Approval channel: ${this.broker.channelAvailable ? "verified" : "unavailable (fails closed)"}.`);
          return;
        }
        this._noteLines([
          [{ text: "Session permission grants (exact action and resource only)", style: "heading" }],
          ...grants.map((grant) => [
            { text: `  ${grant.action} ${grant.resource} \u00b7 ${grant.executionId}`, style: null },
          ]),
        ]);
        return;
      }
      case "status": {
        this._noteLines([
          [{ text: `transport   ${this.transport.kind ?? "legacy"}`, style: null }],
          [{ text: `mode        ${this.settings.mode}`, style: null }],
          [{ text: `model       ${this.settings.model || "(deployment default)"}`, style: null }],
          [{ text: `agent       ${this.settings.agent || "(deployment default)"}`, style: null }],
          [{ text: `conversation ${this.sessionConversationId ?? "(new)"}`, style: "muted" }],
          [{ text: `history     ${this.history ? `${this.history.enabled ? "on" : "off"}, ${this.history.size} prompts` : "off"}`, style: null }],
          [{ text: `approvals   ${this.broker.channelAvailable ? "verified server channel" : "unavailable; requests are denied"}`, style: null }],
        ]);
        return;
      }
      default:
        this._note(`Unknown command: /${sanitizeOneLine(name, 40)}. Type /help.`);
    }
  }

  async openSelection(kind) {
    try {
      let options = [];
      let title = "";
      if (kind === "model") {
        this.models = (await this.transport.listModels?.()) ?? [];
        options = this.models.map((entry) => ({
          value: selectorValue(entry),
          description: selectorDescription(entry),
        }));
        title = "Select a model";
      } else if (kind === "agent") {
        this.agents = (await this.transport.listAgents?.()) ?? [];
        options = this.agents.map((entry) => ({
          value: selectorValue(entry),
          description: selectorDescription(entry),
        }));
        title = "Select an agent";
      } else if (kind === "conversation") {
        const conversations = this.conversations?.list() ?? [];
        options = conversations.map((entry) => ({
          value: entry.id,
          description: `${entry.mode} \u00b7 ${entry.title} \u00b7 ${new Date(entry.updatedAt).toISOString().slice(0, 10)}`,
        }));
        title = "Select a conversation";
      }
      options = options.filter((option) => option.value !== "").slice(0, 50);
      if (options.length === 0) {
        this._note(
          kind === "conversation"
            ? "No saved conversations."
            : `The deployment did not expose any ${kind}s. Use /${kind} <id> to set one explicitly.`,
        );
        return;
      }
      this.menu = { kind, title, options, selected: 0 };
      this.renderer.showMenu(this.menu);
    } catch (error) {
      this._note(`Could not list ${kind}s: ${sanitizeOneLine(error?.message ?? "request failed", 200)}`, "error");
    }
  }

  resumeConversation(id) {
    const entry = this.conversations?.find(id);
    if (!entry) {
      this._note(`No saved conversation with id ${sanitizeOneLine(id, 80)}.`, "warn");
      return;
    }
    this.settings.mode = entry.mode;
    this.settings.model = entry.model;
    this.settings.agent = entry.agent;
    this.sessionConversationId = entry.conversationId ?? entry.id;
    const serverResume = this.transport.capabilities?.conversations === true;
    this._note(
      `Selected ${entry.title} (${entry.mode}).${
        serverResume
          ? " The next message resumes this conversation."
          : " This transport cannot resume a server transcript; settings were restored and the next message starts a new server conversation."
      }`,
      serverResume ? "success" : "warn",
    );
  }

  async _handleMenuKey(event) {
    const key = event.type === "key" ? event : null;
    if (key && (key.name === "escape" || (key.ctrl && key.name === "c"))) {
      this.menu = null;
      this._note("Selection cancelled.");
      this.beginPrompt();
      return;
    }
    if (key && (key.name === "up" || key.name === "down")) {
      const total = this.menu.options.length;
      const delta = key.name === "up" ? -1 : 1;
      this.menu.selected = (this.menu.selected + delta + total) % total;
      this.renderer.showMenu(this.menu);
      return;
    }
    if (key && key.name === "enter") {
      await this._applyMenuSelection();
      return;
    }
    if (event.type === "text") {
      const number = Number(event.text.trim());
      if (Number.isInteger(number) && number >= 1 && number <= this.menu.options.length) {
        this.menu.selected = number - 1;
        await this._applyMenuSelection();
      }
    }
  }

  async _applyMenuSelection() {
    const menu = this.menu;
    if (!menu) return;
    const option = menu.options[menu.selected];
    this.menu = null;
    if (!option) {
      this.beginPrompt();
      return;
    }
    if (menu.kind === "model") {
      this.settings.model = option.value;
      this._note(`Model set to ${option.value}.`);
    } else if (menu.kind === "agent") {
      this.settings.agent = option.value;
      this._note(`Agent set to ${option.value}.`);
    } else if (menu.kind === "conversation") {
      this.resumeConversation(option.value);
    }
    this.beginPrompt();
  }

  async shutdown() {
    this.running = false;
    this.broker.denyAllPending();
    this._stopSpinner();
    if (this.confirmRequest) this.confirmRequest.resolve(false);
    this.confirmRequest = null;
    this.controller?.abort("session closed");
    try {
      await this.sendPromise;
    } catch {
      // Already reported.
    }
    try {
      await this.transport.close?.();
    } catch {
      // Closing is best effort.
    }
    this.renderer.endInput?.();
  }
}

export { SPINNER };
