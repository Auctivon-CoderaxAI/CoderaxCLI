/**
 * Terminal transport over the authoritative WorkflowEngine `/v1` contract.
 *
 * This adapter owns no protocol of its own: requests, validation, replay and
 * idempotency come from the shared SDK in `packages/workflow-sdk/src/v1`. Its
 * only job is to map `/v1` execution events onto the small event vocabulary the
 * terminal renderer consumes (`delta`, `replace`, `tool`, `status`, `permission`,
 * `final`), and to declare capabilities that are actually true.
 *
 * Capability honesty matters more here than completeness:
 *
 * - `permissions` is true because `/v1/work/{taskId}/permissions` exists and the
 *   engine issues approval requests itself, so an approval is never synthesised
 *   from model text;
 * - `attachments` is false because the contract publishes no upload operation;
 * - `conversations` is true because `/v1/conversations` is a real route.
 */

import { CoderaxError } from "./legacy-client.js";
import {
  CONTRACT_VERSION,
  V1Client,
  buildWorkRequest,
  createMemoryLedger,
  isTerminalEventType,
  newSubmissionKey,
  parseModelRef,
  resolveSubmission,
  submitWork,
  watchTask,
} from "../packages/workflow-sdk/src/v1/index.js";

export const V1_CAPABILITIES = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  contractVerified: true,
  stream: true,
  work: true,
  tools: true,
  attachments: false,
  conversations: true,
  permissions: ["workspace.read", "workspace.write", "command.execute", "network.access", "memory.read", "conversation.read"],
  verifiedPermissions: true,
  models: true,
  agents: true,
  modelSelection: true,
  agentSelection: true,
});

function textOf(event) {
  const value = event?.payload?.text;
  return typeof value === "string" ? value : "";
}

/**
 * Map one execution event to terminal events. Returning an array keeps the
 * mapping declarative and lets one engine event produce several UI signals
 * (for example a terminal event also ends the markdown block).
 */
export function mapExecutionEvent(event, { taskId = null } = {}) {
  if (event === null || typeof event !== "object") return [];
  switch (event.type) {
    case "text.delta":
      return [{ type: "delta", text: textOf(event) }];
    case "text.replace":
      return [{ type: "replace", text: textOf(event) }];
    case "tool.call":
      return [{
        type: "tool",
        name: event.payload?.tool ?? "tool",
        status: "start",
        input: event.payload?.input,
        taskId,
      }];
    case "tool.result":
      return [{
        type: "tool",
        name: event.payload?.tool ?? "tool",
        status: event.payload?.ok === true ? "ok" : "error",
        output: event.payload?.output,
        taskId,
      }];
    case "step.started":
      return [{ type: "status", text: `step: ${event.payload?.title ?? event.payload?.stepId ?? ""}` }];
    case "step.completed":
      return [{ type: "status", text: `step done: ${event.payload?.title ?? event.payload?.stepId ?? ""}` }];
    case "file.edit":
      return [{ type: "activity", text: `edited ${event.payload?.path ?? "a file"}` }];
    case "approval.required":
      return [{
        type: "permission",
        channelVerified: true,
        request: {
          serverIssued: true,
          requestId: event.payload?.requestId ?? null,
          taskId: event.taskId ?? taskId,
          tool: event.payload?.tool ?? null,
          description: event.payload?.description ?? "",
          scope: event.payload?.scope ?? null,
        },
      }];
    case "usage":
      return [{ type: "usage", usage: { ...event.payload } }];
    case "task.completed":
      return [{
        type: "final",
        summary: event.payload?.summary ?? "",
        usage: event.payload?.usage ?? null,
      }];
    case "task.failed":
      return [{
        type: "error",
        code: event.payload?.code ?? "engine_failure",
        message: event.payload?.detail ?? "the Work task failed",
        retryable: event.payload?.retryable === true,
      }];
    case "task.cancelled":
      return [{ type: "cancelled", reason: event.payload?.reason ?? null }];
    case "task.interrupted":
      return [{ type: "interrupted", detail: event.payload?.detail ?? "" }];
    case "task.queued":
    case "task.started":
      return [{ type: "status", text: event.type === "task.queued" ? "queued" : "started" }];
    default:
      return [];
  }
}

function failureFor(event) {
  const payload = event?.payload ?? {};
  const code = typeof payload.code === "string" ? payload.code : "engine_failure";
  return new CoderaxError(
    "TASK_FAILED",
    `the Work task failed (${code})${payload.detail ? `: ${payload.detail}` : ""}`,
  );
}

/**
 * @param {object} options
 * @param {object} options.settings resolved CLI settings
 * @param {object} [options.client] inject an already constructed V1Client
 * @param {object} [options.ledger] durable submission ledger; defaults to memory
 * @param {(entry: object) => void} [options.onDiagnostic]
 */
export function createV1Transport({ settings = {}, client = null, ledger = null, onDiagnostic = () => {} } = {}) {
  const workflow = client ?? new V1Client({
    baseUrl: settings.baseUrl,
    token: settings.token,
    timeoutMs: settings.timeoutMs,
    fetchImpl: settings.fetchImpl,
    clientVersion: settings.clientVersion,
    onDiagnostic,
  });
  const store = ledger ?? createMemoryLedger();
  const dataMode = settings.dataMode === "private" ? "private" : "cloud";
  let negotiated = null;
  let activeTaskId = null;

  async function ensureNegotiated() {
    if (negotiated !== null) return negotiated;
    negotiated = workflow.negotiate();
    return negotiated;
  }

  function modelRef(value) {
    if (!value) return undefined;
    try {
      return parseModelRef(value);
    } catch {
      throw new CoderaxError("USAGE", `model ${JSON.stringify(value)} is not a provider/model reference`);
    }
  }

  return {
    kind: "workflow-v1",
    capabilities: { ...V1_CAPABILITIES },
    client: workflow,
    ledger: store,

    /** Exposed for `coderax doctor` and diagnostics; never required for a turn. */
    async negotiate() {
      return ensureNegotiated();
    },

    async stream({ mode = "chat", text, model, agent, conversationId, attachments, signal, onEvent } = {}) {
      if (Array.isArray(attachments) && attachments.length > 0) {
        throw new CoderaxError(
          "CAPABILITY_UNAVAILABLE",
          "the /v1 contract publishes no attachment upload; remove the attachment or use the Web client",
        );
      }
      await ensureNegotiated();

      if (mode === "work") {
        return runWork({ text, model, agent, conversationId, signal, onEvent });
      }

      const reply = await workflow.chat(
        {
          message: text,
          ...(conversationId ? { conversationId } : {}),
          ...(agent ? { agent } : {}),
          ...(modelRef(model) ? { model: modelRef(model) } : {}),
          mode: dataMode,
        },
        {
          signal,
          onDelta: (delta) => onEvent?.(delta),
        },
      );
      onEvent?.({ type: "conversation", id: reply.conversationId });
      return { text: reply.text, conversationId: reply.conversationId };
    },

    async respondPermission(payload = {}) {
      const requestId = payload.requestId ?? payload.id ?? null;
      const taskId = payload.taskId ?? activeTaskId;
      if (!requestId || !taskId) {
        throw new CoderaxError(
          "PERMISSION_CHANNEL_UNAVAILABLE",
          "a permission decision needs the server-issued requestId and its taskId",
        );
      }
      const decision = payload.decision === "denied" || payload.approved === false ? "denied" : "approved";
      return workflow.decidePermission(taskId, {
        requestId,
        decision,
        ...(typeof payload.reason === "string" && payload.reason ? { reason: payload.reason.slice(0, 500) } : {}),
      });
    },

    async listModels() {
      try {
        const value = await workflow.models();
        return value.models.map((entry) => ({
          id: `${entry.ref.providerId}/${entry.ref.modelId}`,
          label: entry.label,
          providerId: entry.ref.providerId,
          modelId: entry.ref.modelId,
          costClass: entry.costClass,
          available: entry.availability.available,
          reason: entry.availability.reason,
        }));
      } catch {
        // Discovery is advisory; a failed menu must not break an otherwise
        // usable session.
        return [];
      }
    },

    async listAgents() {
      try {
        const value = await workflow.agents();
        return value.agents.map((entry) => ({
          id: entry.id,
          label: entry.label,
          external: entry.external,
          available: entry.availability.available,
          reason: entry.availability.reason,
          capabilities: { ...entry.capabilities },
        }));
      } catch {
        return [];
      }
    },

    async listConversations() {
      try {
        const value = await workflow.conversations();
        return value.conversations;
      } catch {
        return [];
      }
    },

    async listTasks() {
      return typeof store.listTasks === "function" ? store.listTasks() : [];
    },

    async task(taskId) {
      return workflow.task(taskId);
    },

    async cancel(taskId, reason) {
      return workflow.cancel(taskId, reason);
    },

    async resume(taskId, generation) {
      return workflow.resume(taskId, generation);
    },

    async retry(taskId, generation, model) {
      return workflow.retry(taskId, generation, model);
    },

    /** Bind an ambiguous submission key to a task that exists. */
    async resolve(submissionKey, taskId) {
      return resolveSubmission({ client: workflow, ledger: store, key: submissionKey, taskId });
    },

    async close() {
      // The shared client keeps no socket between requests.
    },
  };

  async function runWork({ text, model, agent, conversationId, signal, onEvent }) {
    const request = buildWorkRequest({
      objective: text,
      conversationId,
      agent: agent || undefined,
      model: model || undefined,
      mode: dataMode,
      requireApproval: true,
    });
    const key = settings.submissionKey || newSubmissionKey();
    const { accepted, task, submissionKey, reused } = await submitWork({
      client: workflow,
      ledger: store,
      request,
      idempotencyKey: key,
      retryUncertain: settings.retryUncertain === true,
      signal,
    });

    const taskId = accepted?.taskId ?? task.taskId;
    activeTaskId = taskId;
    const resolvedConversationId = accepted?.conversationId ?? task.conversationId ?? conversationId ?? null;
    onEvent?.({
      type: "task",
      taskId,
      conversationId: resolvedConversationId,
      state: accepted?.state ?? task.state ?? "queued",
      submissionKey,
      reused,
    });

    let rendered = "";
    let finalEvent = null;
    const result = await watchTask({
      client: workflow,
      taskId,
      after: Number.isInteger(settings.after) ? settings.after : 0,
      signal,
      onEvent: async (event) => {
        for (const mapped of mapExecutionEvent(event, { taskId })) {
          if (mapped.type === "delta") rendered += mapped.text;
          if (mapped.type === "replace") rendered = mapped.text;
          if (mapped.type === "final") finalEvent = event;
          onEvent?.(mapped);
        }
      },
      onCheckpoint: async (seq) => {
        const record = await store.task(taskId);
        await store.upsertTask({
          ...(record ?? {}),
          taskId,
          conversationId: resolvedConversationId,
          state: "running",
          lastSeq: seq,
          updatedAt: new Date().toISOString(),
        });
      },
      onReconnect: (info) => {
        onEvent?.({
          type: "status",
          text: `reconnecting (${info.reason})${info.lastSeq ? ` from event ${info.lastSeq}` : ""}`,
        });
      },
      onUnknown: (raw) => {
        onEvent?.({ type: "unknown", event: raw?.type ?? null });
      },
    });

    if (result.terminalEvent && isTerminalEventType(result.terminalEvent.type)) {
      if (result.terminalEvent.type === "task.failed") throw failureFor(result.terminalEvent);
    }
    if (result.interrupted) {
      throw new CoderaxError(
        "TASK_INTERRUPTED",
        `task ${taskId} was interrupted; it is still resumable`,
      );
    }
    const summary = finalEvent?.payload?.summary;
    const answer = typeof summary === "string" && summary !== "" ? summary : rendered;
    return { text: answer, conversationId: resolvedConversationId, taskId, state: result.status?.state ?? null };
  }
}
