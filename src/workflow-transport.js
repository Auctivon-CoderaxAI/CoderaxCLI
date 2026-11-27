/**
 * Interactive transport over the shared `packages/workflow-sdk`.
 *
 * The terminal must not own a second SSE implementation. This adapter maps the
 * shared client's `delta`/`replace`/`final` events onto the small event
 * vocabulary the presentation layer consumes, and declares capabilities
 * honestly: the legacy deployment contract exposes no verified permission
 * channel, no attachment upload and no conversation enumeration.
 *
 * Model or agent discovery failures degrade to an empty menu; they never make a
 * chat session unusable.
 */

import { WorkflowClient } from "../packages/workflow-sdk/src/index.js";
import { CoderaxError } from "./legacy-client.js";

function collection(value, key) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object" && Array.isArray(value[key])) return value[key];
  return [];
}

export const WORKFLOW_CAPABILITIES = Object.freeze({
  contractVersion: "workflow-sdk/1",
  contractVerified: true,
  stream: true,
  work: true,
  tools: false,
  attachments: false,
  conversations: false,
  permissions: false,
  verifiedPermissions: false,
  models: true,
  agents: true,
  modelSelection: true,
  agentSelection: true,
});

/**
 * @param {object} options
 * @param {object} options.settings resolved CLI settings
 * @param {object} [options.client] inject an already constructed WorkflowClient
 */
export function createWorkflowTransport({ settings = {}, client = null } = {}) {
  const workflow = client ?? new WorkflowClient({
    baseUrl: settings.baseUrl,
    token: settings.token,
    timeoutMs: settings.timeoutMs,
    fetchImpl: settings.fetchImpl,
    signal: settings.signal,
    strict: settings.strict === true,
  });

  return {
    kind: "workflow-sdk",
    capabilities: { ...WORKFLOW_CAPABILITIES },
    client: workflow,

    async stream({ mode = "chat", text, model, agent, conversationId, signal, onEvent } = {}) {
      const result = await workflow.chatStream({
        text,
        mode,
        model: model || undefined,
        agentId: agent || undefined,
        conversationId: conversationId || undefined,
        signal,
        onEvent: (event) => {
          if (!event || typeof event !== "object") return;
          if (event.type === "delta") {
            onEvent?.({ type: "delta", text: event.text });
            return;
          }
          if (event.type === "replace") {
            onEvent?.({ type: "replace", text: event.text });
            return;
          }
          if (event.type === "final") onEvent?.({ type: "final" });
        },
      });
      if (result?.conversationId) {
        onEvent?.({ type: "conversation", id: result.conversationId });
      }
      return {
        text: typeof result?.text === "string" ? result.text : "",
        conversationId: result?.conversationId ?? conversationId ?? null,
      };
    },

    async respondPermission() {
      // The deployment contract has no server-issued approval channel. Failing
      // closed here is what keeps a model-authored "approval" from being sent.
      throw new CoderaxError(
        "PERMISSION_CHANNEL_UNAVAILABLE",
        "this transport has no verified server-issued permission channel",
      );
    },

    async listModels() {
      try {
        return collection(await workflow.listWorkModels(), "models");
      } catch {
        return [];
      }
    },

    async listAgents() {
      try {
        return collection(await workflow.listWorkAgents(), "agents");
      } catch {
        return [];
      }
    },

    async listConversations() {
      return [];
    },

    async close() {
      // The shared client owns no socket between requests.
    },
  };
}
