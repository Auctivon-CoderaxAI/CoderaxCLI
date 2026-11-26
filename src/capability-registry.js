import { checkCompatibility, SDK_CONTRACT_VERSION, SDK_COVERAGE, SDK_VERSION } from "@coderax/sdk";
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
 * features: `/v1/handshake` publishes the contract version, the state of every
 * capability the engine knows about and the exact operations it implements. A
 * family is executable only when its own capability is available, every
 * prerequisite is available and every operation it needs is published.
 *
 * The mapping from a family to handshake keys is deliberate client metadata.
 * What the keys say is the engine's claim, and it is never upgraded here: an
 * `unsupported` capability is never presented as available because the client
 * has a command for it.
 */

export const EXPECTED_CONTRACT_VERSION = SDK_CONTRACT_VERSION;
export const CLIENT_SDK_VERSION = SDK_VERSION;

function states(handshake) {
  const map = new Map();
  const capabilities = handshake?.capabilities;
  if (capabilities === null || typeof capabilities !== "object") return map;
  for (const [key, value] of Object.entries(capabilities)) {
    if (value === null || typeof value !== "object") continue;
    map.set(key, {
      state: typeof value.state === "string" ? value.state : "unverified",
      detail: typeof value.detail === "string" ? value.detail : "",
    });
  }
  return map;
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

function capabilityOf(handshakeState, key) {
  return handshakeState.get(key) ?? null;
}

function describeRequirement(key, status) {
  const detail = status.detail.trim();
  return detail === "" ? key : `${key}: ${detail}`;
}

/**
 * One family's truthful state. Precedence is fixed and documented so a client
 * can explain exactly why something cannot run:
 *   incompatible contract -> unverified
 *   no published operation for a dedicated backend -> not_implemented
 *   missing required operation -> unverified (the deployment drifted)
 *   own capability unsupported -> unavailable
 *   own capability unconfigured -> unconfigured
 *   prerequisite unsupported/unconfigured -> blocked (with the key named)
 *   anything not explicitly available -> unverified
 *   otherwise -> available
 */
export function resolveFamily(entry, context) {
  const { handshake, operations, compatible, problems } = context;

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
  }

  const missing = entry.operations.filter(
    (id) => !operations.has(id) || !Object.hasOwn(SDK_COVERAGE, id),
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
  const ownStatus = capabilityOf(context.capabilities, own);
  if (ownStatus === null) {
    return {
      ...entry,
      status: CAPABILITY_STATES.unverified,
      detail: `the handshake does not report the ${own} capability`,
      blockedBy: own,
      published: [],
    };
  }
  if (ownStatus.state === "unsupported") {
    return {
      ...entry,
      status: CAPABILITY_STATES.unavailable,
      detail: describeRequirement(own, ownStatus),
      blockedBy: own,
      published: [],
    };
  }
  if (ownStatus.state === "unconfigured") {
    return {
      ...entry,
      status: CAPABILITY_STATES.unconfigured,
      detail: describeRequirement(own, ownStatus),
      blockedBy: own,
      published: [],
    };
  }
  if (ownStatus.state !== "available") {
    return {
      ...entry,
      status: CAPABILITY_STATES.unverified,
      detail: `the engine reports ${own} as ${ownStatus.state}`,
      blockedBy: own,
      published: [],
    };
  }

  for (const key of entry.requires.slice(1)) {
    const status = capabilityOf(context.capabilities, key);
    if (status === null) {
      return {
        ...entry,
        status: CAPABILITY_STATES.unverified,
        detail: `the handshake does not report the required ${key} capability`,
        blockedBy: key,
        published: [],
      };
    }
    if (status.state === "unsupported" || status.state === "unconfigured") {
      return {
        ...entry,
        status: CAPABILITY_STATES.blocked,
        detail: `requires ${describeRequirement(key, status)}`,
        blockedBy: key,
        published: [],
      };
    }
    if (status.state !== "available") {
      return {
        ...entry,
        status: CAPABILITY_STATES.unverified,
        detail: `the engine reports ${key} as ${status.state}`,
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
 * deployment may report `agents` unconfigured, which is not a failure.
 */
export function resolveRegistry(handshake, { agents = null } = {}) {
  const report = checkCompatibility(handshake);
  const context = {
    handshake,
    operations: operationIndex(handshake),
    capabilities: states(handshake),
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
      engineName: handshake.engineName,
      engineVersion: handshake.engineVersion,
      contractVersion: handshake.contractVersion,
      eventSchemaVersion: handshake.eventSchemaVersion,
      minSdkVersion: handshake.minSdkVersion,
      sdkVersion: handshake.sdkVersion,
      apiPrefix: handshake.apiPrefix,
      compatible: report.compatible,
      problems: report.problems,
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
