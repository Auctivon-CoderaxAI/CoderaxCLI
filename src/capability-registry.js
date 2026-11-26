import {
  SDK_CONTRACT_VERSION,
  SDK_OPERATION_COVERAGE,
  SDK_VERSION,
  checkCompatibility,
} from "@coderax/sdk";
import {
  CAPABILITY_FAMILIES,
  CAPABILITY_STATES,
  EXECUTABLE_STATE,
} from "./capability-catalog.js";
import { CoderaxError } from "./client.js";

/**
 * Resolve capability families against the authoritative engine handshake.
 *
 * There is no capability registry route and no client-side registry of backend
 * features: `/v1/handshake` publishes the contract version, the capability
 * flags the engine derives from its own route table, and the exact operations
 * it implements. A family is executable only when its own flag is true, every
 * prerequisite flag is true and every operation it needs is both published and
 * covered by a method on the canonical SDK.
 *
 * The mapping from a family to handshake keys is deliberate client metadata.
 * What the keys say is the engine's claim, and it is never upgraded here: an
 * unsupported capability is never presented as available because the client
 * has a command for it.
 */

export const EXPECTED_CONTRACT_VERSION = SDK_CONTRACT_VERSION;
export const CLIENT_SDK_VERSION = SDK_VERSION;

function flags(handshake) {
  const value = handshake?.capabilities;
  if (value === null || typeof value !== "object") return new Map();
  return new Map(Object.entries(value).filter(([, state]) => typeof state === "boolean"));
}

function operationIndex(handshake) {
  const map = new Map();
  const list = Array.isArray(handshake?.operations) ? handshake.operations : [];
  for (const operation of list) {
    if (operation === null || typeof operation !== "object") continue;
    if (typeof operation.operationId !== "string") continue;
    map.set(operation.operationId, {
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      tags: Array.isArray(operation.tags) ? operation.tags : [],
      auth: operation.auth,
      stream: operation.stream === true,
    });
  }
  return map;
}

function matchesDiscovery(discover, operations) {
  const tags = Array.isArray(discover?.tags) ? discover.tags : [];
  const prefix = typeof discover?.pathPrefix === "string" ? discover.pathPrefix : null;
  for (const operation of operations.values()) {
    const byTag = tags.some((tag) => operation.tags.includes(tag));
    const byPath = prefix !== null && operation.path.startsWith(prefix);
    if (byTag || byPath) return operation;
  }
  return null;
}

function describeFlag(key, value) {
  return value
    ? `${key}: available`
    : `${key}: the engine reports this capability as disabled or unavailable`;
}

/**
 * One family's truthful state. Precedence is fixed and documented so a client
 * can explain exactly why something cannot run:
 *   incompatible contract -> unverified
 *   no published operation for a dedicated backend -> not_implemented
 *   published operation with no canonical SDK method -> unverified
 *   missing required operation -> unverified (the deployment drifted)
 *   own flag false -> unavailable
 *   own flag absent -> unverified (the deployment makes no claim)
 *   prerequisite flag false -> blocked (with the key named)
 *   prerequisite flag absent -> unverified
 *   otherwise -> available
 */
export function resolveFamily(entry, context) {
  const { operations, compatible, problems } = context;

  if (!compatible) {
    return {
      ...entry,
      status: CAPABILITY_STATES.unverified,
      detail: `the engine contract is not compatible with SDK ${CLIENT_SDK_VERSION}: ${problems.join("; ")}`,
      blockedBy: null,
      published: [],
    };
  }

  let discovered = null;
  if (entry.discover) {
    const found = matchesDiscovery(entry.discover, operations);
    discovered = found;
    if (found === null) {
      return {
        ...entry,
        status: CAPABILITY_STATES.notImplemented,
        detail:
          `this engine publishes no ${entry.title} operation ` +
          `(${entry.discover.pathPrefix} or tag ${entry.discover.tags.join("/")}); ` +
          "the implementation is not part of this deployment's handshake",
        blockedBy: entry.discover.pathPrefix,
        published: [],
      };
    }
    if (!Object.hasOwn(SDK_OPERATION_COVERAGE, found.operationId)) {
      return {
        ...entry,
        status: CAPABILITY_STATES.unverified,
        detail:
          `the engine publishes ${found.operationId}, but SDK ${CLIENT_SDK_VERSION} ` +
          "has no method for it; upgrade the vendored SDK before executing this capability",
        blockedBy: found.operationId,
        published: [found.operationId],
      };
    }
  }

  const missing = entry.operations.filter(
    (id) => !operations.has(id) || !Object.hasOwn(SDK_OPERATION_COVERAGE, id),
  );
  if (missing.length > 0) {
    return {
      ...entry,
      status: CAPABILITY_STATES.unverified,
      detail: `required operation${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ` +
        "is not both published by the engine and covered by the canonical SDK",
      blockedBy: missing[0],
      published: [],
    };
  }

  const own = entry.requires[0];
  const ownValue = context.capabilities.get(own);
  if (ownValue === undefined) {
    return {
      ...entry,
      status: CAPABILITY_STATES.unverified,
      detail: `the handshake does not report the ${own} capability; the deployment makes no claim about it`,
      blockedBy: own,
      published: [],
    };
  }
  if (ownValue !== true) {
    return {
      ...entry,
      status: CAPABILITY_STATES.unavailable,
      detail: describeFlag(own, ownValue),
      blockedBy: own,
      published: [],
    };
  }

  for (const key of entry.requires.slice(1)) {
    const value = context.capabilities.get(key);
    if (value === undefined) {
      return {
        ...entry,
        status: CAPABILITY_STATES.unverified,
        detail: `the handshake does not report the required ${key} capability; the deployment makes no claim about it`,
        blockedBy: key,
        published: [],
      };
    }
    if (value !== true) {
      return {
        ...entry,
        status: CAPABILITY_STATES.blocked,
        detail: `requires ${describeFlag(key, value)}`,
        blockedBy: key,
        published: [],
      };
    }
  }

  return {
    ...entry,
    status: CAPABILITY_STATES.available,
    detail:
      discovered === null
        ? "the engine reports every required capability and operation as available"
        : `the engine publishes ${discovered.operationId}; requests run as Work objectives the engine executes`,
    blockedBy: null,
    published: discovered === null ? [...entry.operations] : [...entry.operations, discovered.operationId],
  };
}

/**
 * Build the resolved registry once per invocation. Agents are optional: a
 * deployment may report them unconfigured, which is not a failure.
 */
export function resolveRegistry(handshake, { agents = null } = {}) {
  const report = checkCompatibility({ handshake });
  const context = {
    handshake,
    operations: operationIndex(handshake),
    capabilities: flags(handshake),
    compatible: report.compatible,
    problems: report.problems,
    agents,
  };
  const families = CAPABILITY_FAMILIES.map((entry) => resolveFamily(entry, context));
  const counts = Object.fromEntries(
    Object.values(CAPABILITY_STATES).map((state) => [
      state,
      families.filter((entry) => entry.status === state).length,
    ]),
  );
  return {
    contract: {
      engineName: handshake.server?.name ?? "Coderax WorkflowEngine",
      engineVersion: handshake.server?.version ?? "unknown",
      contractVersion: handshake.contractVersion,
      eventSchemaVersion: handshake.eventSchemaVersion,
      chatStreamVersion: handshake.chatStreamVersion,
      apiPrefix: handshake.apiPrefix,
      supportedContractVersions: handshake.supportedContractVersions,
      negotiatedContractVersion: handshake.negotiatedContractVersion,
      negotiation: handshake.negotiation,
      compatible: report.compatible,
      problems: report.problems,
      missingOperations: report.missingOperations,
      expectedContract: EXPECTED_CONTRACT_VERSION,
      clientSdk: CLIENT_SDK_VERSION,
    },
    capabilities: Object.fromEntries(context.capabilities),
    operations: [...context.operations.values()],
    agents,
    families,
    counts,
  };
}

export function findFamily(registry, commandOrId) {
  return registry.families.find(
    (entry) => entry.command === commandOrId || entry.id === commandOrId,
  ) ?? null;
}

export function assertExecutable(entry) {
  if (entry === null) {
    throw new CoderaxError("USAGE", "unknown capability; run `coderax capabilities`");
  }
  if (entry.status === EXECUTABLE_STATE) return entry;
  throw new CoderaxError(
    "CAPABILITY_NOT_AVAILABLE",
    `${entry.command} is ${entry.status}: ${entry.detail}. ` +
      "The CLI does not fall back to local execution or simulate the result.",
    { details: { capability: entry.id, status: entry.status, blockedBy: entry.blockedBy } },
  );
}

export function publicFamily(entry) {
  return {
    id: entry.id,
    command: entry.command,
    title: entry.title,
    summary: entry.summary,
    mode: entry.mode,
    status: entry.status,
    available: entry.status === EXECUTABLE_STATE,
    detail: entry.detail,
    blockedBy: entry.blockedBy,
    requires: entry.requires,
    operations: entry.published,
    attachment: entry.attachment === null ? null : {
      required: entry.attachment.required,
      mimeTypes: entry.attachment.mimeTypes,
      maxBytes: entry.attachment.maxBytes,
    },
    options: entry.options ?? [],
  };
}
