/**
 * Shared SDK facade.
 *
 * The presentation layer talks only to this facade. Today the canonical
 * `@coderax/sdk` is not the authoritative transport, so the default is the
 * legacy SSE adapter. `CODERAX_SDK=canonical` requires a verified contract;
 * `CODERAX_SDK=auto` uses the canonical SDK only after its own contract
 * handshake succeeds and otherwise keeps the legacy transport.
 *
 * Nothing here routes models, executes workflows, stores memory or decides
 * permissions: those are engine responsibilities. This module maps the shared
 * contract onto the terminal's event vocabulary and verifies declared
 * capabilities.
 */

import { CoderaxError } from "./client.js";
import { createLegacyTransport } from "./sdk-legacy.js";
import { createSubmissionLedger } from "./submissions.js";
import { createV1Transport } from "./v1-transport.js";
import { createWorkflowTransport } from "./workflow-transport.js";

export const SDK_CONTRACT_VERSION = "coderax-sdk/1";
export const SUPPORTED_SDK_CONTRACTS = Object.freeze([SDK_CONTRACT_VERSION]);
export const SDK_MODES = Object.freeze(["v1", "workflow", "legacy", "auto", "canonical"]);

async function defaultLoadModule() {
  return import("@coderax/sdk");
}

function normalizePermissions(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.filter((action) => typeof action === "string");
  return false;
}

export function normalizeCapabilities(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  return {
    contractVersion: typeof source.contractVersion === "string" ? source.contractVersion : null,
    contractVerified: source.contractVerified === true,
    stream: source.stream === true,
    work: source.work === true,
    tools: source.tools === true,
    attachments: source.attachments === true,
    conversations: source.conversations === true,
    permissions: normalizePermissions(source.permissions),
    verifiedPermissions: normalizePermissions(source.permissions) !== false && source.verifiedPermissions === true,
    models: source.models === true,
    agents: source.agents === true,
    modelSelection: source.modelSelection === true,
    agentSelection: source.agentSelection === true,
  };
}

function contractProblem(capabilities) {
  if (!capabilities.contractVersion) return "the SDK did not declare a contract version";
  if (!SUPPORTED_SDK_CONTRACTS.includes(capabilities.contractVersion)) {
    return `unsupported SDK contract ${capabilities.contractVersion}; expected ${SUPPORTED_SDK_CONTRACTS.join(" or ")}`;
  }
  if (!capabilities.stream) return "the SDK does not declare streaming support";
  if (!capabilities.contractVerified) return "the SDK contract has not been verified by the integration owner";
  return null;
}

function createCanonicalTransport({ client, capabilities }) {
  return {
    kind: "canonical",
    capabilities: { ...capabilities },

    async stream(options = {}) {
      if (typeof client.streamMessage !== "function") {
        throw new CoderaxError("SDK_CONTRACT_MISMATCH", "canonical SDK has no streamMessage()");
      }
      const result = await client.streamMessage({
        mode: options.mode,
        text: options.text,
        model: options.model || undefined,
        agent: options.agent || undefined,
        conversationId: options.conversationId || undefined,
        attachments: options.attachments?.length ? options.attachments : undefined,
        signal: options.signal,
        onEvent: (event) => {
          if (!event || typeof event !== "object") return;
          if (event.type === "permission" || event.type === "permission_request") {
            const request = event.request ?? event.permissionRequest ?? null;
            options.onEvent?.({
              type: "permission",
              channelVerified: capabilities.verifiedPermissions,
              request: request !== null && typeof request === "object"
                ? { ...request, serverIssued: request.serverIssued === true }
                : request,
            });
            return;
          }
          options.onEvent?.(event);
        },
      });
      if (typeof result === "string") return { text: result, conversationId: options.conversationId ?? null };
      if (result === null || typeof result !== "object") {
        throw new CoderaxError("SDK_CONTRACT_MISMATCH", "canonical SDK returned an invalid stream result");
      }
      return {
        text: typeof result.text === "string" ? result.text : "",
        conversationId: typeof result.conversationId === "string" ? result.conversationId : options.conversationId ?? null,
      };
    },

    async respondPermission(payload) {
      if (typeof client.respondPermission !== "function") {
        throw new CoderaxError(
          "PERMISSION_CHANNEL_UNAVAILABLE",
          "canonical SDK does not implement respondPermission()",
        );
      }
      await client.respondPermission(payload);
    },

    async listModels() {
      if (capabilities.models !== true || typeof client.listModels !== "function") return [];
      return client.listModels();
    },

    async listAgents() {
      if (capabilities.agents !== true || typeof client.listAgents !== "function") return [];
      return client.listAgents();
    },

    async listConversations() {
      if (capabilities.conversations !== true || typeof client.listConversations !== "function") return [];
      return client.listConversations();
    },

    async close() {
      await client.close?.();
    },
  };
}

function legacyDescription(transport, reason = null) {
  return {
    kind: "legacy",
    contractVersion: transport.capabilities.contractVersion,
    contractVerified: false,
    reason,
    capabilities: { ...transport.capabilities },
  };
}

/**
 * Create the transport used by both the interactive terminal and non-interactive
 * commands. Settings are passed through unchanged; the facade never chooses a
 * model or a workflow itself.
 */
export async function createTransport({
  settings = {},
  env = process.env,
  loadModule = defaultLoadModule,
  legacyFactory = createLegacyTransport,
} = {}) {
  const requested = String(env.CODERAX_SDK ?? "workflow").trim().toLowerCase() || "workflow";
  if (!SDK_MODES.includes(requested)) {
    throw new CoderaxError(
      "SDK_MODE_INVALID",
      `CODERAX_SDK must be one of ${SDK_MODES.join(", ")} (received ${requested})`,
    );
  }

  const buildWorkflow = (reason = null) => {
    const transport = createWorkflowTransport({
      settings: { ...settings, fetchImpl: settings.fetchImpl },
    });
    return {
      transport,
      description: {
        kind: "workflow-sdk",
        contractVersion: "workflow-sdk/1",
        contractVerified: true,
        reason,
        capabilities: { ...transport.capabilities },
      },
    };
  };

  const buildLegacy = (reason = null) => {
    const transport = legacyFactory({
      baseUrl: settings.baseUrl,
      token: settings.token,
      timeoutMs: settings.timeoutMs,
      chatPath: settings.chatPath,
      endpoint: settings.endpoint,
      fetchImpl: settings.fetchImpl,
    });
    return { transport, description: legacyDescription(transport, reason) };
  };

  const buildV1 = () => {
    const transport = createV1Transport({
      settings: { ...settings, fetchImpl: settings.fetchImpl },
      // A real submission needs a durable key; without a deployment URL there
      // is nothing to scope it to, so the in-memory ledger is the honest default
      // for tests and `--dry-run` only.
      ledger: settings.ledger ?? (settings.baseUrl ? createSubmissionLedger({ baseUrl: settings.baseUrl }) : null),
      onDiagnostic: settings.onDiagnostic ?? (() => {}),
    });
    return {
      transport,
      description: {
        kind: "workflow-v1",
        // The transport validates every payload against the mirrored contract
        // before returning it, so the contract is verified by construction.
        contractVersion: transport.capabilities.contractVersion,
        contractVerified: true,
        reason: null,
        capabilities: { ...transport.capabilities },
      },
    };
  };

  // `v1` is the authoritative WorkflowEngine transport and fails closed: a
  // deployment that does not serve `/v1` produces CONTRACT_UNSUPPORTED rather
  // than a silent fallback to an older endpoint. `legacy` and `workflow` remain
  // as explicit migration modes.
  if (requested === "v1") return buildV1();
  if (requested === "workflow") return buildWorkflow();
  if (requested === "legacy") return buildLegacy();

  let module;
  try {
    module = await loadModule();
  } catch (error) {
    if (requested === "auto") return buildWorkflow(`canonical SDK unavailable (${error?.code ?? "not installed"})`);
    throw new CoderaxError(
      "SDK_UNAVAILABLE",
      "CODERAX_SDK=canonical was requested but @coderax/sdk could not be loaded",
    );
  }

  const factory = module?.createClient ?? module?.default?.createClient;
  if (typeof factory !== "function") {
    if (requested === "auto") return buildWorkflow("canonical SDK has no createClient()");
    throw new CoderaxError("SDK_CONTRACT_MISMATCH", "canonical SDK does not export createClient()");
  }

  let client;
  try {
    client = await factory({
      baseUrl: settings.baseUrl,
      token: settings.token,
      timeoutMs: settings.timeoutMs,
      fetchImpl: settings.fetchImpl,
    });
  } catch (error) {
    if (requested === "auto") return buildWorkflow(`canonical SDK failed to initialise (${error?.code ?? "error"})`);
    throw new CoderaxError("SDK_UNAVAILABLE", "could not initialise the canonical Coderax SDK");
  }

  let capabilities;
  try {
    capabilities = normalizeCapabilities(await client.getCapabilities?.());
  } catch {
    capabilities = normalizeCapabilities(null);
  }
  const problem = contractProblem(capabilities);
  if (problem) {
    if (requested === "auto") return buildWorkflow(problem);
    throw new CoderaxError("SDK_CONTRACT_MISMATCH", problem);
  }

  const transport = createCanonicalTransport({ client, capabilities });
  return {
    transport,
    description: {
      kind: "canonical",
      contractVersion: capabilities.contractVersion,
      contractVerified: true,
      reason: null,
      capabilities: { ...capabilities },
    },
  };
}
