import {
  API_VERSION,
  BUILD_MODES,
  CAPABILITY,
  PROBES,
  ROUTE,
  RUN_STATUSES,
  isTerminalStatus,
  OWNER_ROLE,
} from "./contract.js";
import { SdkError, diagnostic } from "./errors.js";
import { assertCompatibleVersion, createTransport, detailText } from "./http.js";
import { EventSequencer, SseDecoder } from "./sse.js";
import { redact, redactValue, StreamTextRedactor } from "./redact.js";
import {
  assertRunSnapshot,
  classifyChatPayload,
  cursorFromFrame,
  workflowFrameEvent,
} from "./task-events.js";

const INFERRED = Object.freeze({
  [CAPABILITY.builds]: CAPABILITY.workflows,
  [CAPABILITY.runs]: CAPABILITY.workflows,
  [CAPABILITY.runStream]: CAPABILITY.workflows,
  [CAPABILITY.approve]: CAPABILITY.workflows,
  [CAPABILITY.pause]: CAPABILITY.workflows,
  [CAPABILITY.resume]: CAPABILITY.workflows,
  [CAPABILITY.cancel]: CAPABILITY.workflows,
  [CAPABILITY.workCancel]: CAPABILITY.workTasks,
  [CAPABILITY.workModels]: CAPABILITY.workTasks,
  [CAPABILITY.workAgents]: CAPABILITY.workTasks,
});

const RETRYABLE_CODES = new Set(["NETWORK", "TIMEOUT", "STREAM_INCOMPLETE", "UNAVAILABLE", "RATE_LIMITED"]);

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function normalizeCapabilities(declared) {
  const set = new Set();
  if (Array.isArray(declared)) {
    for (const entry of declared) {
      if (typeof entry === "string") set.add(entry);
    }
    return { set, known: true };
  }
  if (declared !== null && typeof declared === "object") {
    for (const [name, value] of Object.entries(declared)) {
      if (value === true || value === "available" || value === "supported") set.add(name);
    }
    return { set, known: true };
  }
  return { set, known: false };
}

export class WorkflowClient {
  constructor({
    baseUrl,
    token,
    timeoutMs = 15000,
    fetchImpl = fetch,
    signal,
    clientVersion = "0.0.0",
    maxRetries = 3,
    retryDelayMs = 200,
    strict = false,
    onDiagnostic,
  } = {}) {
    this.transport = createTransport({ baseUrl, token, timeoutMs, fetchImpl, clientVersion });
    this.token = token ?? null;
    this.signal = signal;
    this.strict = strict;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
    this.onDiagnostic = onDiagnostic;
    this.diagnostics = [];
    this.reported = new Set();
    this.negotiation = null;
    this.cursorWarning = false;
  }

  report(entry) {
    const key = `${entry.code}:${entry.message}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diagnostics.push(entry);
    this.onDiagnostic?.(entry);
  }

  #track(entries) {
    for (const entry of entries) this.report(entry);
  }

  #failure(error, context) {
    if (error instanceof SdkError && context) {
      error.details = { ...(error.details ?? {}), ...context };
    }
    return error;
  }

  async #json(path, options = {}) {
    try {
      return await this.transport.json(path, { ...options, signal: options.signal ?? this.signal });
    } catch (error) {
      throw this.#failure(error, options.context);
    }
  }

  async whoami() {
    const response = await this.#json(ROUTE.user);
    const user = response.json;
    if (user === null || typeof user !== "object" || Array.isArray(user)) {
      throw new SdkError("CONTRACT_VIOLATION", `${ROUTE.user} did not return a user object`);
    }
    const role = typeof user.role === "string" ? user.role : null;
    return {
      user,
      role,
      owner: role === OWNER_ROLE,
      account: user.email ?? user.username ?? user.name ?? null,
    };
  }

  /** Reject any authenticated identity that is not the deployment owner. */
  async requireOwner() {
    const identity = await this.whoami();
    if (identity.role === null) {
      throw new SdkError(
        "OWNER_UNVERIFIABLE",
        `${ROUTE.user} did not report a role; owner-only access cannot be verified. ` +
          "The deployment must return the authenticated user's role.",
        { details: { endpoint: ROUTE.user } },
      );
    }
    if (!identity.owner) {
      throw new SdkError(
        "FORBIDDEN",
        `this account has role ${identity.role}; Coderax CLI operations require the deployment owner (${OWNER_ROLE})`,
        { status: 403, details: { role: identity.role } },
      );
    }
    return identity;
  }

  /**
   * Resolve API version and capabilities without a single write probe. A
   * deployment without metadata is reported as unverified, not assumed.
   */
  async negotiate() {
    if (this.negotiation === null) {
      this.negotiation = this.#negotiate().catch((error) => {
        this.negotiation = null;
        throw error;
      });
    }
    return this.negotiation;
  }

  async #negotiate() {
    let meta = null;
    const attempts = [];
    for (const path of ROUTE.meta) {
      try {
        const response = await this.#json(path);
        meta = { path, document: response.json };
        break;
      } catch (error) {
        if (error.code === "NOT_FOUND" || error.code === "HTTP_405" || error.code === "HTTP_404") {
          attempts.push(`${path}: ${error.code}`);
          continue;
        }
        throw error;
      }
    }

    let apiVersion = null;
    let capabilities = new Set();
    let declared = false;

    if (meta !== null) {
      const document = meta.document;
      if (document !== null && typeof document === "object" && !Array.isArray(document)) {
        const raw =
          document.apiVersion ??
          document.api_version ??
          document.version ??
          document.api?.version ??
          null;
        if (raw !== null) {
          if (this.strict) assertCompatibleVersion(String(raw), meta.path);
          else {
            try {
              assertCompatibleVersion(String(raw), meta.path);
            } catch (error) {
              throw error;
            }
          }
          apiVersion = String(raw);
        }
        const normalized = normalizeCapabilities(document.capabilities ?? document.features);
        capabilities = normalized.set;
        declared = normalized.known;
      }
    } else {
      this.report(
        diagnostic(
          "API_VERSION_UNVERIFIED",
          `the deployment publishes no API metadata (${attempts.join("; ")}); ` +
            `this client sends x-coderax-api-version: ${API_VERSION} and cannot verify compatibility`,
        ),
      );
    }

    if (apiVersion === null && meta !== null) {
      this.report(
        diagnostic(
          "API_VERSION_UNVERIFIED",
          `${meta.path} does not report an apiVersion; compatibility is unverified`,
        ),
      );
    }

    if (declared) {
      for (const probe of PROBES) {
        if (capabilities.has(probe.capability)) continue;
        // A declared capability list is authoritative: absence is meaningful.
      }
    }

    // Safe GET probes fill gaps. A 404 means the route is absent; 503 means it
    // exists but is temporarily unavailable, which is not a contract failure.
    const probes = {};
    for (const probe of PROBES) {
      if (declared && capabilities.has(probe.capability)) {
        probes[probe.capability] = true;
        continue;
      }
      try {
        await this.#json(probe.path);
        probes[probe.capability] = true;
        capabilities.add(probe.capability);
      } catch (error) {
        if (error.code === "NOT_FOUND") {
          probes[probe.capability] = false;
          continue;
        }
        if (error.code === "UNAVAILABLE" || error.status === 503) {
          probes[probe.capability] = true;
          capabilities.add(probe.capability);
          this.report(
            diagnostic(
              "CAPABILITY_DEGRADED",
              `${probe.path} exists but reported HTTP 503; the feature is unavailable right now`,
            ),
          );
          continue;
        }
        throw error;
      }
    }

    if (this.strict && apiVersion === null) {
      throw new SdkError(
        "API_VERSION_UNVERIFIED",
        "strict mode requires a deployment API version, but none was published",
        { details: { attempts } },
      );
    }

    return { apiVersion, capabilities, declared, probes, metaPath: meta?.path ?? null, attempts };
  }

  async requireCapability(capability, { hint } = {}) {
    const state = await this.negotiate();
    if (state.capabilities.has(capability)) return state;

    const inferred = INFERRED[capability];
    if (inferred !== undefined && state.capabilities.has(inferred)) {
      this.report(
        diagnostic(
          "CAPABILITY_INFERRED",
          `${capability} is inferred from ${inferred}; the deployment does not declare it explicitly`,
        ),
      );
      return state;
    }

    throw new SdkError(
      "CAPABILITY_UNAVAILABLE",
      `this deployment does not provide ${capability}${hint ? `. ${hint}` : ""}`,
      { details: { capability, probes: state.probes } },
    );
  }

  async #getCollection(path, key, options = {}) {
    const response = await this.#json(path, options);
    const value = response.json;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new SdkError("CONTRACT_VIOLATION", `${path} did not return a JSON object`);
    }
    const items = value[key];
    if (!Array.isArray(items)) {
      throw new SdkError("CONTRACT_VIOLATION", `${path} did not return a ${key} array`, {
        details: { keys: Object.keys(value) },
      });
    }
    return { ...value, [key]: items };
  }

  async listWorkModels() {
    await this.requireCapability(CAPABILITY.workModels);
    return this.#getCollection(ROUTE.workModels, "models");
  }

  async listWorkAgents() {
    await this.requireCapability(CAPABILITY.workAgents);
    return this.#getCollection(ROUTE.workAgents, "agents");
  }

  async readiness() {
    await this.requireCapability(CAPABILITY.workTasks);
    const response = await this.#json(ROUTE.workReadiness);
    return response.json;
  }

  async listTasks() {
    await this.requireCapability(CAPABILITY.workTasks);
    return this.#getCollection(ROUTE.workTasks, "tasks");
  }

  async getTask(id) {
    await this.requireCapability(CAPABILITY.workTasks);
    const response = await this.#json(ROUTE.workTask(id));
    if (!response.json || typeof response.json !== "object" || response.json.task == null) {
      throw new SdkError("CONTRACT_VIOLATION", `${ROUTE.workTask(id)} did not return { task }`);
    }
    return response.json.task;
  }

  async cancelTask(id) {
    await this.requireCapability(CAPABILITY.workCancel);
    const response = await this.#json(ROUTE.workCancel(id), { method: "POST", body: {} });
    return response.json;
  }

  async listWorkflows() {
    await this.requireCapability(CAPABILITY.workflows);
    return this.#getCollection(ROUTE.workflows, "workflows");
  }

  async listRuns(workflowId) {
    await this.requireCapability(CAPABILITY.runs);
    return this.#getCollection(ROUTE.workflowRuns(workflowId), "runs");
  }

  #validateRun(run, source) {
    // One validator for the whole SDK (task-events.js), so the durable task
    // layer and the direct client cannot disagree about a run snapshot.
    return assertRunSnapshot(run, source);
  }

  #runFrom(response, source) {
    const run = response.json?.run;
    return this.#validateRun(run, source);
  }

  async getRun(runId) {
    await this.requireCapability(CAPABILITY.runs);
    const path = ROUTE.run(runId);
    const response = await this.#json(path);
    return this.#runFrom(response, path);
  }

  /**
   * Submit an autonomous, durable Work build. The backend compiles the request
   * into a workflow run; the CLI never plans or executes steps itself.
   */
  async submitBuild({
    request,
    agentId,
    mode = "autonomous",
    repository,
    workspace,
    roleAgents,
  } = {}) {
    if (typeof request !== "string" || request.trim() === "") {
      throw new SdkError("USAGE", "a build request is required");
    }
    if (repository === null || typeof repository !== "object" || !repository.owner || !repository.name) {
      throw new SdkError("USAGE", "a repository { owner, name } is required for autonomous Work");
    }
    if (!BUILD_MODES.includes(mode)) {
      throw new SdkError(
        "USAGE",
        `mode must be one of ${BUILD_MODES.join(", ")}; received ${JSON.stringify(mode)}`,
      );
    }
    if (typeof workspace !== "string" || workspace.trim() === "") {
      throw new SdkError("USAGE", "a workspace name is required for an autonomous build");
    }
    await this.requireCapability(CAPABILITY.builds);
    const body = {
      request,
      mode,
      agentId,
      repository,
      workspace,
      ...(roleAgents === undefined ? {} : { roleAgents }),
    };
    let response;
    try {
      response = await this.#json(ROUTE.builds, { method: "POST", body });
    } catch (error) {
      if (error.code === "NOT_FOUND") {
        throw new SdkError(
          "CAPABILITY_UNAVAILABLE",
          "the deployment exposes /api/workflows but not /api/workflows/builds; autonomous Work submission is unavailable",
          { status: 404, details: { endpoint: ROUTE.builds } },
        );
      }
      throw error;
    }
    const run = this.#runFrom(response, ROUTE.builds);
    return { run, workflow: response.json?.workflow ?? null, build: response.json?.build ?? null };
  }

  async startRun(workflowId, { input } = {}) {
    await this.requireCapability(CAPABILITY.runs);
    const path = ROUTE.workflowRuns(workflowId);
    const body = input === undefined ? {} : { input };
    const response = await this.#json(path, { method: "POST", body });
    return this.#runFrom(response, path);
  }

  async approveStep(runId, stepIndex) {
    await this.requireCapability(CAPABILITY.approve);
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      throw new SdkError("USAGE", "approve requires a non-negative integer step index");
    }
    const path = ROUTE.approve(runId);
    const response = await this.#json(path, { method: "POST", body: { stepIndex } });
    return this.#runFrom(response, path);
  }

  async pauseRun(runId) {
    await this.requireCapability(CAPABILITY.pause);
    const path = ROUTE.pause(runId);
    const response = await this.#json(path, { method: "POST", body: {} });
    return this.#runFrom(response, path);
  }

  async resumeRun(runId) {
    await this.requireCapability(CAPABILITY.resume);
    const path = ROUTE.resume(runId);
    const response = await this.#json(path, { method: "POST", body: {} });
    return this.#runFrom(response, path);
  }

  async cancelRun(runId) {
    await this.requireCapability(CAPABILITY.cancel);
    const path = ROUTE.cancel(runId);
    const response = await this.#json(path, { method: "POST", body: {} });
    return this.#runFrom(response, path);
  }

  /**
   * Retry a terminal run by starting a fresh run of the same workflow with the
   * same input. There is no backend "retry run" route; this is orchestration of
   * two published endpoints, not a second runner.
   */
  async retryRun(runId) {
    const run = await this.getRun(runId);
    if (!isTerminalStatus(run.status)) {
      throw new SdkError(
        "CONFLICT",
        `run ${runId} is ${run.status}; retry is only valid for completed, failed, or cancelled runs`,
        { details: { runId, status: run.status } },
      );
    }
    if (run.status === "completed") {
      throw new SdkError(
        "CONFLICT",
        `run ${runId} completed; start a new run only if you intend to repeat it`,
        { details: { runId, status: run.status } },
      );
    }
    if (typeof run.workflowId !== "string" || run.workflowId === "") {
      throw new SdkError("CONTRACT_VIOLATION", `run ${runId} has no workflowId to retry`);
    }
    const next = await this.startRun(run.workflowId, { input: run.input });
    return { previous: run, run: next };
  }

  async listRepos() {
    const state = await this.negotiate();
    if (!state.capabilities.has(CAPABILITY.repos)) {
      throw new SdkError(
        "CAPABILITY_UNAVAILABLE",
        "this deployment does not advertise a repository inventory (repos.list); " +
          "pass --repo <owner/name> to `coderax work submit` instead",
        { details: { capability: CAPABILITY.repos } },
      );
    }
    return this.#getCollection(ROUTE.repos, "repositories");
  }

  /**
   * Consume one streaming Work turn.
   *
   * The POST is deliberately not retried: re-sending it would start a second
   * generation. An interrupted turn surfaces as STREAM_INCOMPLETE with its
   * conversationId so the caller can monitor the durable task instead.
   */
  async chatStream({
    text,
    mode = "chat",
    conversationId,
    parentMessageId,
    agentId,
    model,
    endpoint = "agents",
    promptPrefix,
    onEvent,
    signal = this.signal,
  } = {}) {
    if (typeof text !== "string" || text.trim() === "") {
      throw new SdkError("USAGE", "a non-empty message is required");
    }

    // Preserve the legacy body shape exactly when no optional field is set:
    // deployments in the field already accept { text, mode, endpoint }.
    const body = { text, mode, endpoint };
    if (conversationId) body.conversationId = conversationId;
    if (parentMessageId) body.parentMessageId = parentMessageId;
    if (agentId) {
      body.agent_id = agentId;
      body.endpoint = "agents";
    }
    if (model) body.model = model;
    if (promptPrefix) body.promptPrefix = promptPrefix;

    const stream = await this.transport.stream(ROUTE.chat, {
      method: "POST",
      body,
      signal,
    });

    const redactor = new StreamTextRedactor(this.token);
    const sequencer = new EventSequencer();
    let assembled = "";
    let lastSnapshot = null;
    let deltas = 0;
    let terminal = false;
    let resolvedConversationId = conversationId ?? null;
    let requestMessageId = null;
    let responseMessageId = null;

    const emitReplace = (value) => {
      assembled = value;
      redactor.reset();
      onEvent?.({ type: "replace", text: assembled });
    };

    const emitDelta = (delta, payload) => {
      const safe = redactor.push(delta);
      if (safe === "") return;
      assembled += safe;
      deltas += 1;
      onEvent?.({
        type: "delta",
        text: safe,
        payload: payload === undefined ? undefined : redactValue(payload, this.token),
      });
    };

    const applySnapshot = (snapshot, payload) => {
      if (snapshot === lastSnapshot) return;
      if (lastSnapshot === null || snapshot.startsWith(lastSnapshot)) {
        const delta = snapshot.slice(lastSnapshot?.length ?? 0);
        lastSnapshot = snapshot;
        emitDelta(delta, payload);
        return;
      }
      // A revised answer, not an append. The final frame is authoritative.
      lastSnapshot = snapshot;
      emitReplace(redact(snapshot, this.token));
      onEvent?.({ type: "replace", text: assembled });
    };

    const handleFrame = (frame) => {
      if (frame.done) {
        terminal = true;
        return;
      }
      if (frame.id !== null) requestMessageId = requestMessageId ?? null;

      const payload = frame.data;
      if (payload === null || typeof payload !== "object") return;
      if (Array.isArray(payload)) return;

      if (typeof payload.conversationId === "string") resolvedConversationId = payload.conversationId;
      if (typeof payload.streamId === "string") resolvedConversationId = payload.streamId;
      if (payload.created === true && typeof payload.message?.messageId === "string") {
        requestMessageId = payload.message.messageId;
      }

      if (payload.error !== undefined && payload.final !== true) {
        throw new SdkError(
          "STREAM_ERROR",
          redact(detailText(payload.error) || "the stream reported an error", this.token),
          { details: { conversationId: resolvedConversationId } },
        );
      }
      if (payload.type === "error") {
        throw new SdkError(
          "STREAM_ERROR",
          redact(detailText(payload.error ?? payload.message ?? payload) || "the stream reported an error", this.token),
          { details: { conversationId: resolvedConversationId } },
        );
      }

      if (payload.final === true) {
        terminal = true;
        const finalText = payload.responseMessage?.text;
        if (typeof finalText === "string") {
          lastSnapshot = finalText;
          const safe = redact(finalText, this.token);
          if (safe !== assembled) emitReplace(safe);
        }
        if (typeof payload.responseMessage?.messageId === "string") {
          responseMessageId = payload.responseMessage.messageId;
        }
        if (typeof payload.responseMessage?.conversationId === "string") {
          resolvedConversationId = payload.responseMessage.conversationId;
        }
        const failure = payload.error ?? payload.responseMessage?.error;
        if (failure !== undefined && failure !== null && failure !== false) {
          throw new SdkError(
            "STREAM_ERROR",
            redact(detailText(failure) || "the turn failed", this.token),
            {
              details: {
                conversationId: resolvedConversationId,
                terminalStatus: payload.terminalStatus ?? null,
              },
            },
          );
        }
        onEvent?.({ type: "final", payload: redactValue(payload, this.token) });
        return;
      }

      // Legacy `/api/work/chat` compatibility: cumulative snapshots, explicit
      // deltas and a final frame. The classifier is shared with the SDK's
      // LegacyChatAdapter so the compatibility rules live in exactly one place.
      const classified = classifyChatPayload(payload);
      if (classified.kind === "snapshot") {
        applySnapshot(classified.text, payload);
      } else if (classified.kind === "delta") {
        emitDelta(classified.text, payload);
      }
    };

    try {
      const decoder = new SseDecoder();
      let sawSnapshotOnly = false;
      while (true) {
        const { value, done } = await stream.next();
        if (done) break;
        for (const frame of decoder.push(stream.text(value))) {
          if (!terminal && frame.id === null && !sequencer.sawCursor) {
            sawSnapshotOnly = true;
          }
          const verdict = sequencer.accept(frame);
          this.#track(verdict.diagnostics);
          for (const accepted of verdict.frames ?? []) handleFrame(accepted);
          if (terminal) break;
        }
        if (terminal) break;
      }

      if (!terminal) {
        const flushed = sequencer.flush();
        this.#track(flushed.diagnostics);
        for (const frame of flushed.frames) {
          handleFrame(frame);
          if (terminal) break;
        }
      }

      // Release any suffix the redactor held back while checking it against the
      // token. A final authoritative snapshot resets the redactor, so this is
      // empty in the snapshot path and exactly the held token prefix in the
      // delta path.
      const tail = redactor.flush();
      if (tail !== "") {
        // Bypass push(): the redactor just proved this suffix is not part of the
        // token, and pushing it again would hold it forever as a token prefix.
        assembled += tail;
        deltas += 1;
        onEvent?.({ type: "delta", text: tail });
      }

      if (sawSnapshotOnly && !this.cursorWarning) {
        this.cursorWarning = true;
        this.report(
          diagnostic(
            "CURSOR_UNSUPPORTED",
            "the chat stream emits cumulative snapshots without SSE event ids; " +
              "a dropped connection cannot be replayed",
          ),
        );
      }

      if (!terminal) {
        throw new SdkError(
          "STREAM_INCOMPLETE",
          "the chat stream ended before a final event; the turn may still be running server-side",
          { details: { conversationId: resolvedConversationId } },
        );
      }
    } catch (error) {
      stream.close();
      throw this.#failure(error, { conversationId: resolvedConversationId });
    } finally {
      stream.close();
    }

    return {
      text: assembled,
      events: deltas,
      terminal,
      conversationId: resolvedConversationId,
      requestMessageId,
      responseMessageId,
      diagnostics: this.diagnostics,
    };
  }

  /**
   * Monitor a durable workflow run. Reconnection is safe because the stream is
   * a full snapshot; event replay is used when the deployment supplies cursors.
   */
  async watchRun(
    runId,
    { onRun, onHandled, signal = this.signal, maxRetries = this.maxRetries } = {},
  ) {
    await this.requireCapability(CAPABILITY.runStream);
    const sequencer = new EventSequencer();
    let lastRun = null;
    let lastSerialized = null;
    let cursor = null;
    let sentCursor = false;
    let attempt = 0;
    let announcedCursorUnsupported = false;
    let handlerFailed = false;

    const record = async (run, frameCursor) => {
      const serialized = JSON.stringify(run);
      if (serialized === lastSerialized) return false;
      if (
        lastRun !== null &&
        Array.isArray(lastRun.events) &&
        Array.isArray(run.events) &&
        run.events.length < lastRun.events.length
      ) {
        this.report(
          diagnostic(
            "OUT_OF_ORDER_EVENT",
            `run ${runId} returned ${run.events.length} events after ${lastRun.events.length}; keeping the newest snapshot`,
          ),
        );
      }
      // Handle first, commit second. If the renderer or an approval fails, the
      // snapshot is not marked applied and a reconnect re-delivers it instead
      // of silently dropping it.
      try {
        await onRun?.(run);
      } catch (error) {
        handlerFailed = true;
        throw error;
      }
      if (frameCursor !== null && frameCursor !== undefined) {
        cursor = frameCursor.value;
      }
      lastSerialized = serialized;
      lastRun = run;
      await onHandled?.(run, frameCursor ?? null);
      return true;
    };

    while (true) {
      let stream = null;
      let completed = lastRun !== null && isTerminalStatus(lastRun.status);
      let failure = null;

      try {
        const headers = cursor === null ? undefined : { "last-event-id": cursor };
        if (cursor !== null) sentCursor = true;
        stream = await this.transport.stream(ROUTE.runStream(runId), { signal, headers });
        const decoder = new SseDecoder();
        let frameCount = 0;

        while (!completed) {
          const { value, done } = await stream.next();
          if (done) break;
          for (const frame of decoder.push(stream.text(value))) {
            frameCount += 1;
            if (frame.done) {
              completed = lastRun !== null && isTerminalStatus(lastRun.status);
              break;
            }
            const replayBefore = sequencer.cursorReplayDetected;
            const verdict = sequencer.accept(frame);
            this.#track(verdict.diagnostics);
            if (
              sentCursor &&
              sequencer.cursorReplayDetected &&
              !replayBefore &&
              !this.cursorWarning
            ) {
              this.cursorWarning = true;
              this.report(
                diagnostic(
                  "CURSOR_IGNORED",
                  "the deployment ignored Last-Event-ID and replayed events this client had already seen",
                ),
              );
            }
            for (const accepted of verdict.frames ?? []) {
              const classified = workflowFrameEvent(accepted);
              if (classified.kind === "stream-error") {
                throw new SdkError(
                  "STREAM_ERROR",
                  redact(detailText(classified.error) || "run stream failed", this.token),
                );
              }
              if (classified.kind !== "run-snapshot") {
                throw new SdkError(
                  "CONTRACT_VIOLATION",
                  `${ROUTE.runStream(runId)} emitted a frame without a run snapshot`,
                  { details: { event: accepted.event ?? null } },
                );
              }
              const run = this.#validateRun(classified.run, ROUTE.runStream(runId));
              // Each buffered frame carries its own cursor; never apply the id
              // of the frame that happened to fill a gap.
              await record(run, cursorFromFrame(accepted));
              if (isTerminalStatus(run.status)) {
                completed = true;
                break;
              }
            }
            if (completed) break;
          }
          if (
            frameCount > 0 &&
            !sequencer.sawCursor &&
            !announcedCursorUnsupported
          ) {
            announcedCursorUnsupported = true;
            this.report(
              diagnostic(
                "CURSOR_UNSUPPORTED",
                "the run stream emits snapshots without SSE event ids; " +
                  "reconnection re-reads state but individual events cannot be replayed",
              ),
            );
          }
        }

        if (!completed) {
          const flushed = sequencer.flush();
          this.#track(flushed.diagnostics);
          for (const frame of flushed.frames) {
            const classified = workflowFrameEvent(frame);
            if (classified.kind === "run-snapshot") {
              const run = this.#validateRun(classified.run, ROUTE.runStream(runId));
              await record(run, cursorFromFrame(frame));
              if (isTerminalStatus(run.status)) completed = true;
            }
          }
        }

        if (!completed) {
          failure = new SdkError(
            "STREAM_INCOMPLETE",
            `run ${runId} stream ended before a terminal status`,
            { retryable: true },
          );
        }
      } catch (error) {
        failure = error;
      } finally {
        stream?.close();
      }

      if (completed && lastRun !== null && isTerminalStatus(lastRun.status)) {
        return { run: lastRun, diagnostics: this.diagnostics };
      }
      // A handler failure is never retried internally: the frame dedupe set
      // already saw the frame, so a silent retry would skip it entirely.
      if (handlerFailed) throw failure;
      if (failure !== null && !this.#retryable(failure)) throw failure;
      if (attempt >= maxRetries) {
        throw new SdkError(
          "STREAM_INCOMPLETE",
          `run ${runId} could not be monitored after ${attempt + 1} attempts${failure ? `: ${failure.message}` : ""}`,
          { details: { runId, lastStatus: lastRun?.status ?? null }, retryable: false },
        );
      }
      if (signal?.aborted) throw new SdkError("CANCELLED", "run monitoring cancelled");
      attempt += 1;
      await sleep(Math.min(5000, this.retryDelayMs * 2 ** (attempt - 1)));
    }
  }

  #retryable(error) {
    if (!(error instanceof SdkError)) return false;
    if (error.code === "CANCELLED" || error.code === "CONTRACT_VIOLATION") return false;
    if (error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN" || error.code === "NOT_FOUND") {
      return false;
    }
    if (error.code === "UNKNOWN_RUN_STATUS") return false;
    return error.retryable === true || RETRYABLE_CODES.has(error.code);
  }
}

export { API_VERSION, CAPABILITY, ROUTE, RUN_STATUSES, isTerminalStatus };
