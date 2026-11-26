import {
  CAPABILITY_CATALOG,
  CAPABILITY_STATUSES,
  MAX_UPLOAD_BYTES,
  RESERVED_OPTIONS,
} from "./capability-catalog.js";
import { CoderaxError } from "./client.js";
import { singleLine } from "./format.js";

/**
 * The engine contract this CLI speaks. It mirrors WorkflowEngine's
 * `CONTRACT_VERSION` (`packages/contracts/src/primitives.ts`). A registry from
 * another major version is refused instead of being interpreted optimistically.
 */
export const CAPABILITY_CONTRACT_VERSION = "1.0.0";

const INPUT_TYPES = new Set(["file", "text", "string", "number", "boolean", "enum"]);
const ID_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;
const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const OPTION_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

const MAX_DETAIL = 1000;

function registryError(message) {
  return new CoderaxError("CAPABILITY_REGISTRY_INVALID", message);
}

function cleanText(value, limit = MAX_DETAIL) {
  return singleLine(value, limit);
}

function cleanArray(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim())
    .slice(0, limit);
}

function normalizeStatus(value) {
  return CAPABILITY_STATUSES.includes(value) ? value : "unverified";
}

function normalizeInput(raw, capabilityId) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw registryError(`capability ${capabilityId} declares an input that is not an object`);
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!OPTION_PATTERN.test(name) || RESERVED_OPTIONS.includes(name)) {
    throw registryError(`capability ${capabilityId} declares an invalid or reserved input name: ${name || "(empty)"}`);
  }
  const type = INPUT_TYPES.has(raw.type) ? raw.type : null;
  if (type === null) {
    throw registryError(`capability ${capabilityId} input ${name} has an unsupported type`);
  }
  const normalized = {
    name,
    type,
    required: raw.required === true,
    description: cleanText(raw.description, 300),
  };
  if (type === "enum") {
    const values = cleanArray(raw.values);
    if (values.length === 0) {
      throw registryError(`capability ${capabilityId} input ${name} is an enum without values`);
    }
    normalized.values = values;
  }
  if (type === "number") {
    if (Number.isFinite(raw.min)) normalized.min = Number(raw.min);
    if (Number.isFinite(raw.max)) normalized.max = Number(raw.max);
    if (raw.integer === true) normalized.integer = true;
  }
  if (type === "file") {
    const mimeTypes = cleanArray(raw.mimeTypes);
    if (mimeTypes.length > 0) normalized.mimeTypes = mimeTypes;
    const maxBytes = Number(raw.maxBytes);
    normalized.maxBytes =
      Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, MAX_UPLOAD_BYTES) : MAX_UPLOAD_BYTES;
  }
  if (raw.default !== undefined) {
    const fallback = raw.default;
    if (typeof fallback === "string" || typeof fallback === "number" || typeof fallback === "boolean") {
      normalized.default = fallback;
    }
  }
  return normalized;
}

function normalizeInputs(raw, capabilityId) {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw registryError(`capability ${capabilityId} must declare inputs as an array`);
  }
  const seen = new Set();
  return raw.map((item) => {
    const normalized = normalizeInput(item, capabilityId);
    if (seen.has(normalized.name)) {
      throw registryError(`capability ${capabilityId} declares input ${normalized.name} twice`);
    }
    seen.add(normalized.name);
    return normalized;
  });
}

function syntheticEntry(capability, detail, reason) {
  return {
    ...capability,
    status: "blocked",
    reason,
    detail: cleanText(detail),
    inputs: capability.inputs.map((item) => ({ ...item, mimeTypes: item.mimeTypes ? [...item.mimeTypes] : undefined })),
    source: "catalog",
  };
}

/**
 * An engine that publishes no capability registry at all is still reported
 * truthfully: every proposed command exists in the CLI but is blocked.
 */
export function unpublishedRegistry(detail, reason = "capability_registry_missing") {
  const registry = {
    contractVersion: CAPABILITY_CONTRACT_VERSION,
    registryVersion: null,
    source: "unpublished",
    published: false,
    capabilities: CAPABILITY_CATALOG.map((capability) =>
      syntheticEntry(capability, detail, reason),
    ),
    artifacts: {
      status: "blocked",
      reason,
      detail: cleanText(detail),
      digestRequired: true,
    },
  };
  return indexRegistry(registry);
}

function normalizeCapability(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw registryError("a capability entry is not an object");
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ID_PATTERN.test(id)) {
    throw registryError(`invalid capability id: ${id || "(empty)"}`);
  }
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!COMMAND_PATTERN.test(command)) {
    throw registryError(`capability ${id} has an invalid command name`);
  }
  const status = normalizeStatus(raw.status);
  const inputs = normalizeInputs(raw.inputs, id);
  return {
    id,
    command,
    title: cleanText(raw.title, 120) || command,
    summary: cleanText(raw.summary ?? raw.description, 500),
    status,
    reason: cleanText(raw.reason, 120) || (status === "available" ? "ready" : "not_ready"),
    detail: cleanText(raw.detail),
    inputs,
    source: "registry",
  };
}

function normalizeArtifacts(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      status: "blocked",
      reason: "artifacts_not_published",
      detail: "the capability registry does not publish artifact operations",
      digestRequired: true,
    };
  }
  const status = normalizeStatus(raw.status);
  return {
    status,
    reason: cleanText(raw.reason, 120) || (status === "available" ? "ready" : "not_ready"),
    detail: cleanText(raw.detail),
    digestRequired: raw.digestRequired !== false,
  };
}

function indexRegistry(registry) {
  const byCommand = new Map();
  const byId = new Map();
  for (const capability of registry.capabilities) {
    byCommand.set(capability.command, capability);
    byId.set(capability.id, capability);
  }
  return { ...registry, byCommand, byId };
}

/**
 * Merge the authoritative registry with the static catalog. A catalog command
 * the registry omits is blocked; a registry capability the catalog does not know
 * is kept and is still executable through `coderax capability run`.
 */
export function decodeRegistry(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw registryError("the capability registry response is not a JSON object");
  }
  const contractVersion = typeof payload.contractVersion === "string" ? payload.contractVersion.trim() : "";
  if (!/^1\./.test(contractVersion)) {
    throw new CoderaxError(
      "CAPABILITY_CONTRACT_INCOMPATIBLE",
      `the engine capability contract is ${contractVersion || "missing"}; this CLI requires 1.x (${CAPABILITY_CONTRACT_VERSION})`,
    );
  }
  if (!Array.isArray(payload.capabilities)) {
    throw registryError("the capability registry has no capabilities array");
  }

  const published = payload.capabilities.map(normalizeCapability);
  const publishedById = new Map(published.map((capability) => [capability.id, capability]));
  const publishedByCommand = new Map(published.map((capability) => [capability.command, capability]));
  const used = new Set();
  const capabilities = [];

  for (const catalogEntry of CAPABILITY_CATALOG) {
    const match = publishedById.get(catalogEntry.id) ?? publishedByCommand.get(catalogEntry.command);
    if (match === undefined) {
      capabilities.push(
        syntheticEntry(
          catalogEntry,
          "the engine capability registry does not publish this capability",
          "not_published",
        ),
      );
      continue;
    }
    used.add(match.id);
    const inputs =
      match.inputs === null
        ? catalogEntry.inputs.map((item) => ({ ...item, mimeTypes: item.mimeTypes ? [...item.mimeTypes] : undefined }))
        : match.inputs;
    // A registry command keeps the catalog's positional binding only when the
    // registry uses the catalog's command and still declares that input.
    const primary =
      match.command === catalogEntry.command && inputs.some((item) => item.name === catalogEntry.primary)
        ? catalogEntry.primary
        : null;
    capabilities.push({ ...match, title: match.title || catalogEntry.title, summary: match.summary || catalogEntry.summary, inputs, primary });
  }

  for (const capability of published) {
    if (used.has(capability.id)) continue;
    if (capabilities.some((item) => item.command === capability.command)) {
      throw registryError(`two capabilities publish the command ${capability.command}`);
    }
    // A registry-only capability has no catalog binding. Bind one positional to
    // its first required text input so `coderax capability run <id> "prompt"`
    // works without inventing a per-capability command.
    const positional = (capability.inputs ?? []).find(
      (item) => item.required && (item.type === "text" || item.type === "string"),
    );
    capabilities.push({ ...capability, primary: positional?.name ?? null });
  }

  const commandSet = new Set();
  for (const capability of capabilities) {
    if (commandSet.has(capability.command)) {
      throw registryError(`two capabilities publish the command ${capability.command}`);
    }
    commandSet.add(capability.command);
  }

  return indexRegistry({
    contractVersion,
    registryVersion:
      typeof payload.registryVersion === "string" ? cleanText(payload.registryVersion, 120) : null,
    source: "engine",
    published: true,
    capabilities,
    artifacts: normalizeArtifacts(payload.artifacts),
  });
}

export function findCapability(registry, commandOrId) {
  return registry.byCommand.get(commandOrId) ?? registry.byId.get(commandOrId) ?? null;
}

/**
 * A capability may only run when the engine says it is available. Every other
 * state carries the engine's reason so the CLI never has to guess.
 */
export function assertExecutable(capability) {
  if (capability.status === "available") return;
  const detail = capability.detail ? `: ${capability.detail}` : "";
  throw new CoderaxError(
    "CAPABILITY_NOT_AVAILABLE",
    `${capability.command} is ${capability.status} (${capability.reason})${detail}. Run \`coderax readiness\` for the current state.`,
  );
}

export function publicCapability(capability) {
  return {
    id: capability.id,
    command: capability.command,
    title: capability.title,
    summary: capability.summary,
    status: capability.status,
    reason: capability.reason,
    detail: capability.detail,
    primary: capability.primary,
    options: capability.inputs.map((item) => ({
      name: item.name,
      type: item.type,
      required: item.required,
      description: item.description,
      ...(item.values ? { values: item.values } : {}),
      ...(item.default !== undefined ? { default: item.default } : {}),
      ...(item.mimeTypes ? { mimeTypes: item.mimeTypes } : {}),
      ...(item.maxBytes ? { maxBytes: item.maxBytes } : {}),
    })),
  };
}
