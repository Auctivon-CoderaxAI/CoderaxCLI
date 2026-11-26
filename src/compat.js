/**
 * WorkflowEngine compatibility policy.
 *
 * Coderax CLI is a thin HTTP/SSE client: it only needs the deployment's
 * OpenAPI document shape, bearer authentication, and the Work SSE endpoint.
 * That surface is stable within an engine major line, so a CLI release declares
 * exactly one supported engine range and reports it everywhere an operator
 * looks: `coderax version`, `coderax compat`, and `coderax doctor`.
 *
 * The range is declared policy, not a guess. Its boundaries are covered by
 * `test/compat.test.js` and exercised end to end by `scripts/install-test.mjs`
 * against stub engines immediately below, inside, and above the range.
 */
import { discoverOpenApi } from "./discover.js";
import { request } from "./client.js";

export const SUPPORTED_ENGINE_RANGE = ">=0.8.0 <1.0.0";

const MINIMUM = Object.freeze({ major: 0, minor: 8, patch: 0, prerelease: [] });
const MAXIMUM_EXCLUSIVE = Object.freeze({ major: 1, minor: 0, patch: 0, prerelease: [] });

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parse a semantic version. Returns null for anything that is not a full
 * `major.minor.patch` version, because a partial version makes the
 * compatibility answer unknowable and "unknown" must never look like "ok".
 */
export function parseSemver(raw) {
  if (typeof raw !== "string") return null;
  const match = SEMVER.exec(raw.trim());
  if (match === null) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    raw: raw.trim(),
  };
}

function comparePrerelease(left, right) {
  // A version without a prerelease outranks any prerelease of the same core.
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Standard semver ordering, including prerelease precedence. */
export function compareSemver(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease ?? [], right.prerelease ?? []);
}

/**
 * Evaluate one reported engine version against the supported range.
 *
 * `supported` is deliberately tri-state: `null` means the deployment did not
 * report a usable version. Callers must treat that as "unknown", not "fine".
 */
export function isSupportedEngineVersion(raw) {
  const parsed = parseSemver(raw);
  if (parsed === null) {
    return {
      supported: null,
      version: null,
      reason: `"${String(raw)}" is not a semantic version, so compatibility is unknown`,
    };
  }
  // A stable CLI supports stable engines. Prereleases are opt-in experiments
  // whose API may change without notice, so they are reported, never trusted.
  const prerelease = parsed.prerelease.length > 0;
  const atLeastMinimum = compareSemver(parsed, MINIMUM) >= 0;
  const belowMaximum = compareSemver(parsed, MAXIMUM_EXCLUSIVE) < 0;
  const supported = !prerelease && atLeastMinimum && belowMaximum;
  return {
    supported,
    version: parsed.raw,
    reason: supported
      ? `within the supported range ${SUPPORTED_ENGINE_RANGE}`
      : prerelease
        ? `a prerelease; stable CLI releases support ${SUPPORTED_ENGINE_RANGE}`
        : atLeastMinimum
          ? `newer than the supported range ${SUPPORTED_ENGINE_RANGE}`
          : `older than the supported range ${SUPPORTED_ENGINE_RANGE}`,
  };
}

/**
 * Pull a WorkflowEngine version out of a health payload or an OpenAPI document.
 *
 * A bare `version` field in a health response is ignored on purpose: deployments
 * commonly report the web service version there, and mistaking it for the
 * engine version would produce a confidently wrong compatibility answer.
 */
export function engineVersionFrom(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidates = [
    payload.workflowEngine?.version,
    payload.workflowEngineVersion,
    payload.engine?.version,
    payload.services?.workflowEngine?.version,
    payload.capabilities?.workflowEngine,
    payload.info?.version,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && parseSemver(candidate) !== null) return candidate;
  }
  return null;
}

export const ENGINE_HEALTH_PATHS = Object.freeze(["/health", "/api/health", "/healthz"]);

/**
 * Ask the deployment which WorkflowEngine it runs.
 *
 * Health first because it is the cheapest and usually public; the OpenAPI
 * document is the fallback because `info.version` is part of the published
 * contract. Returns null when nothing usable is reported.
 */
export async function detectEngineVersion({ baseUrl, token, timeoutMs, fetchImpl } = {}) {
  let blocking = null;
  for (const path of ENGINE_HEALTH_PATHS) {
    try {
      const response = await request({ baseUrl, token, path, timeoutMs, fetchImpl });
      const version = engineVersionFrom(response.json);
      if (version !== null) return { version, source: `health ${path}` };
    } catch (error) {
      if (error.code === "HTTP_404" || error.code === "HTTP_405") continue;
      // Authentication, timeout, or network failures: remember the reason, but
      // still try the OpenAPI document, which may be readable independently.
      blocking = error;
      break;
    }
  }

  try {
    const discovery = await discoverOpenApi({ baseUrl, token, timeoutMs, fetchImpl });
    const version = engineVersionFrom(discovery.document);
    if (version !== null) return { version, source: `openapi ${discovery.sourcePath}` };
  } catch (error) {
    // A missing document is "unknown". An auth or timeout failure is the real
    // reason and must be surfaced, not disguised as an unreported version.
    if (blocking === null && ["HTTP_401", "HTTP_403", "REQUEST_TIMEOUT", "REQUEST_FAILED"].includes(error.code)) {
      blocking = error;
    }
  }

  if (blocking !== null) throw blocking;
  return null;
}

/**
 * Full compatibility verdict for one deployment.
 * `supported` is true, false, or null (unknown) as described above.
 */
export async function checkEngineCompatibility({ baseUrl, token, timeoutMs, fetchImpl } = {}) {
  const detected = await detectEngineVersion({ baseUrl, token, timeoutMs, fetchImpl });
  if (detected === null) {
    return {
      engineVersion: null,
      engineSource: null,
      range: SUPPORTED_ENGINE_RANGE,
      supported: null,
      reason: "the deployment did not report a WorkflowEngine version",
    };
  }
  const evaluated = isSupportedEngineVersion(detected.version);
  return {
    engineVersion: detected.version,
    engineSource: detected.source,
    range: SUPPORTED_ENGINE_RANGE,
    supported: evaluated.supported,
    reason: evaluated.reason,
  };
}
