/**
 * Legacy transport adapter.
 *
 * This is the only place that knows how to talk to the current deployment's
 * SSE endpoints. It exposes the same small surface the presentation layer uses
 * for the canonical SDK, so the interactive UI does not need to change when the
 * gateway moves. It deliberately contains no model routing, workflow
 * execution, memory or persistence: those belong to the shared engine.
 */

import { CoderaxError, request, streamRequest } from "./client.js";
import { discoverOpenApi, findOperation } from "./discover.js";

export const LEGACY_CAPABILITIES = Object.freeze({
  contractVersion: "legacy/sse-1",
  stream: true,
  work: true,
  tools: true,
  attachments: true,
  conversations: false,
  permissions: false,
  models: true,
  agents: true,
  modelSelection: true,
  agentSelection: true,
  verifiedPermissions: false,
});

function listFrom(payload) {
  if (!payload || typeof payload !== "object") return [];
  const source = Array.isArray(payload.models)
    ? payload.models
    : Array.isArray(payload.agents)
      ? payload.agents
      : Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.items)
          ? payload.items
          : [];
  return source
    .map((item) => (typeof item === "string" ? item : item?.id ?? item?.name ?? item?.slug ?? ""))
    .filter((item) => typeof item === "string" && item !== "");
}

function normalizeToolEvent(payload) {
  const candidate = payload?.tool ?? payload?.toolCall ?? payload;
  if (!candidate || typeof candidate !== "object") return null;
  const name = candidate.name ?? candidate.tool ?? candidate.toolName;
  if (typeof name !== "string" || name === "") return null;
  return {
    type: "tool",
    name,
    status: typeof candidate.status === "string" ? candidate.status : "running",
    detail: typeof candidate.detail === "string" ? candidate.detail : "",
    id: typeof candidate.id === "string" ? candidate.id : null,
  };
}

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string|null} options.token
 * @param {number} options.timeoutMs
 * @param {string} options.chatPath
 * @param {string} options.endpoint
 * @param {Function} [options.fetchImpl]
 */
export function createLegacyTransport({
  baseUrl,
  token,
  timeoutMs = 15000,
  chatPath,
  endpoint,
  fetchImpl = fetch,
  discoverImpl = discoverOpenApi,
  requestImpl = request,
  streamImpl = streamRequest,
} = {}) {
  let discoveryCache = null;

  async function discover() {
    if (!discoveryCache) {
      discoveryCache = await discoverImpl({ baseUrl, token, timeoutMs, fetchImpl });
    }
    return discoveryCache;
  }

  async function listResource(kind) {
    const matcher = kind === "models" ? /\/models\/?$/i : /\/agents\/?$/i;
    try {
      const discovery = await discover();
      const operation = findOperation(discovery.operations, matcher);
      if (!operation) return [];
      const response = await requestImpl({
        baseUrl,
        token,
        path: operation.path,
        timeoutMs,
        fetchImpl,
      });
      return listFrom(response.json);
    } catch (error) {
      if (error?.code === "OPENAPI_NOT_FOUND" || error?.code === "OPERATION_NOT_FOUND") return [];
      throw error;
    }
  }

  return {
    kind: "legacy",
    capabilities: { ...LEGACY_CAPABILITIES },

    async stream({ mode = "chat", text, model, agent, conversationId, attachments, signal, onEvent } = {}) {
      const body = { text, mode, endpoint };
      if (model) body.model = model;
      if (agent) body.agent = agent;
      if (conversationId) body.conversationId = conversationId;
      if (Array.isArray(attachments) && attachments.length > 0) body.attachments = attachments;

      let finalConversationId = conversationId ?? null;
      const answer = await streamImpl({
        baseUrl,
        token,
        path: mode === "work" ? "/api/work/chat" : chatPath,
        timeoutMs,
        fetchImpl,
        signal,
        body,
        onEvent: (event) => {
          if (event.type === "delta") {
            onEvent?.({ type: "delta", text: event.text });
            return;
          }
          if (event.type === "replace") {
            onEvent?.({ type: "replace", text: event.text });
            return;
          }

          const payload = event.payload;
          if (event.type === "final") {
            onEvent?.({ type: "final" });
            return;
          }
          if (payload === null || typeof payload !== "object") return;

          if (typeof payload.conversationId === "string") {
            finalConversationId = payload.conversationId;
            onEvent?.({ type: "conversation", id: payload.conversationId });
          }
          if (payload.type === "progress" && typeof payload.message === "string") {
            onEvent?.({
              type: "progress",
              message: payload.message,
              percent: Number.isFinite(payload.percent) ? payload.percent : null,
            });
            return;
          }
          if (payload.type === "tool" || payload.type === "tool_call" || payload.type === "tool_result" || payload.tool) {
            const tool = normalizeToolEvent(payload);
            if (tool) onEvent?.(tool);
            return;
          }
          if (payload.type === "permission_request" || payload.permissionRequest) {
            const raw = payload.permissionRequest ?? payload.request ?? payload;
            // This transport has no server-verified approval channel. The
            // session treats the request as unverified and fails closed; it is
            // surfaced so the operator can see that execution was blocked.
            onEvent?.({
              type: "permission",
              channelVerified: false,
              request: raw !== null && typeof raw === "object" ? { ...raw, serverIssued: raw.serverIssued === true } : raw,
            });
          }
        },
      });
      return { text: answer, conversationId: finalConversationId };
    },

    async respondPermission() {
      throw new CoderaxError(
        "PERMISSION_CHANNEL_UNAVAILABLE",
        "this deployment does not provide a verified permission approval channel",
      );
    },

    async listModels() {
      return listResource("models");
    },

    async listAgents() {
      return listResource("agents");
    },

    async listConversations() {
      return [];
    },

    async close() {},
  };
}
