/**
 * Deployment compatibility policy.
 *
 * The previous release hardcoded `>=0.8.0 <1.0.0` and called it the
 * WorkflowEngine range. That number was not derived from anything: the
 * reference deployment reports `v0.8.8`, the separate
 * `Coderax-WorkflowEngine` repository is at `0.1.0`, and the deployment's
 * `/health` endpoint returns plain text `OK` with no version at all. A range
 * invented for a service that never reports a version is not a compatibility
 * check; it is a guess that reads like one.
 *
 * The authoritative signals are:
 *
 * 1. The API-version handshake implemented by the shared SDK
 *    (`packages/workflow-sdk`). The client sends `x-coderax-api-version: 1`
 *    and accepts a server-reported version from `/api/meta`, a well-known
 *    metadata document, or a response header. This is the contract the CLI is
 *    actually written against.
 * 2. The deployment's published version from its OpenAPI document
 *    (`info.version`), which is the only version the deployment actually
 *    advertises.
 *
 * Both are reported separately. Either can be unknown, and unknown is never
 * reported as compatible. The deployment-version floor is the release this CLI
 * was validated against (`0.8.8`); the ceiling is the next major line.
 */
import { API_MAJOR, API_VERSION, SdkError, WorkflowClient } from "../packages/workflow-sdk/src/index.js";
import { discoverOpenApi } from "./discover.js";
import { VERSION } from "./version.js";

/** The API contract this CLI implements, from the shared SDK. */
export const SUPPORTED_API_VERSION = API_VERSION;
export const SUPPORTED_API_MAJOR = API_MAJOR;

/**
 * Deployment versions the CLI has evidence for. The floor is the reference
 * deployment release (`package.json` in Auctivon-CoderaxAI/Coderax, `v0.8.8`)
 * that the contract in `packages/workflow-sdk/src/contract.js` was read from.
 */
export const SUPPORTED_DEPLOYMENT_RANGE = ">=0.8.8 <1.0.0";

/** Basis string shown by `version --json`, `compat`, and `doctor`. */
export const COMPATIBILITY_BASIS =
  "x-coderax-api-version handshake (shared SDK) + OpenAPI info.version";

const MINIMUM = Object.freeze({ major: 0, minor: 8, patch: 8, prerelease: [] });
const MAXIMUM_EXCLUSIVE = Object.freeze({ major: 1, minor: 0, patch: 0, prerelease: [] });

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parse a semantic version. Returns null for anything that is not a full
 * `major.minor.patch` version, because a partial version makes the answer
 * unknowable and "unknown" must never look like "ok".
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

/** Normalize `v0.8.8` and `0.8.8` to the same parsed version. */
export function normalizeVersion(raw) {
  const parsed = parseSemver(raw);
  return parsed === null ? null : parsed.raw.replace(/^v/i, "");
}

/**
 * Evaluate a deployment version against the validated range.
 * `supported` is tri-state: `null` means unknown, never "fine".
 */
export function isSupportedDeploymentVersion(raw) {
  const parsed = parseSemver(raw);
  if (parsed === null) {
    return {
      supported: null,
      version: null,
      reason: `"${String(raw ?? "")}" is not a semantic version, so compatibility is unknown`,
    };
  }
  // Prereleases are opt-in experiments whose API may change without notice.
  const prerelease = parsed.prerelease.length > 0;
  const atLeastMinimum = compareSemver(parsed, MINIMUM) >= 0;
  const belowMaximum = compareSemver(parsed, MAXIMUM_EXCLUSIVE) < 0;
  const supported = !prerelease && atLeastMinimum && belowMaximum;
  return {
    supported,
    version: normalizeVersion(parsed.raw),
    reason: supported
      ? `within the validated range ${SUPPORTED_DEPLOYMENT_RANGE}`
      : prerelease
        ? `a prerelease; stable CLI releases support ${SUPPORTED_DEPLOYMENT_RANGE}`
        : atLeastMinimum
          ? `newer than the validated range ${SUPPORTED_DEPLOYMENT_RANGE}`
          : `older than the validated range ${SUPPORTED_DEPLOYMENT_RANGE}`,
  };
}

/**
 * Ask the deployment for its API version through the shared SDK handshake.
 * A different major is a definitive incompatibility; an unreported version is
 * recorded as unverified rather than guessed.
 */
export async function detectApiVersion({ baseUrl, token, timeoutMs, fetchImpl, signal } = {}) {
  const client = new WorkflowClient({
    baseUrl,
    token,
    timeoutMs,
    fetchImpl,
    clientVersion: VERSION,
    signal,
    strict: false,
  });
  try {
    const state = await client.negotiate();
    return {
      apiVersion: state.apiVersion,
      source: state.metaPath ?? "response header",
      capabilities: [...state.capabilities].sort(),
      unsupported: null,
    };
  } catch (error) {
    if (error instanceof SdkError && error.code === "API_VERSION_UNSUPPORTED") {
      return { apiVersion: null, source: null, capabilities: [], unsupported: error };
    }
    throw error;
  }
}

/** Read the deployment's advertised version from its OpenAPI document. */
export async function detectDeploymentVersion({ baseUrl, token, timeoutMs, fetchImpl } = {}) {
  try {
    const discovery = await discoverOpenApi({ baseUrl, token, timeoutMs, fetchImpl });
    const raw = discovery.document?.info?.version;
    const version = normalizeVersion(raw);
    return version === null ? null : { version, source: `openapi ${discovery.sourcePath}` };
  } catch (error) {
    // A missing document means "unknown". Authentication and timeout failures
    // are the real reason and must surface rather than look like no document.
    if (["HTTP_401", "HTTP_403", "REQUEST_TIMEOUT", "REQUEST_FAILED"].includes(error.code)) throw error;
    return null;
  }
}

/**
 * Full compatibility verdict for one deployment.
 *
 * `supported` is true, false, or null (unknown). A false on either axis wins;
 * true requires both axes to be affirmatively inside their supported range.
 */
export async function checkCompatibility({ baseUrl, token, timeoutMs, fetchImpl, signal } = {}) {
  const api = await detectApiVersion({ baseUrl, token, timeoutMs, fetchImpl, signal });
  const deployment = await detectDeploymentVersion({ baseUrl, token, timeoutMs, fetchImpl });

  const apiVerdict = api.unsupported
    ? { supported: false, reason: api.unsupported.message }
    : api.apiVersion === null
      ? { supported: null, reason: "the deployment did not report an API version" }
      : Number.parseInt(String(api.apiVersion).split(".")[0], 10) === SUPPORTED_API_MAJOR
        ? { supported: true, reason: `implements API version ${api.apiVersion} (CLI implements ${SUPPORTED_API_VERSION}.x)` }
        : {
            supported: false,
            reason: `the deployment reports API version ${api.apiVersion}; this CLI implements ${SUPPORTED_API_VERSION}.x`,
          };

  const deploymentVerdict = deployment === null
    ? { supported: null, reason: "the deployment did not publish an OpenAPI version" }
    : isSupportedDeploymentVersion(deployment.version);

  let supported;
  if (apiVerdict.supported === false || deploymentVerdict.supported === false) supported = false;
  else if (apiVerdict.supported === true && deploymentVerdict.supported === true) supported = true;
  else supported = null;

  const reasons = [apiVerdict.reason, deploymentVerdict.reason];
  return {
    apiVersion: api.apiVersion,
    apiSource: api.source,
    apiSupported: apiVerdict.supported,
    deploymentVersion: deployment?.version ?? null,
    deploymentSource: deployment?.source ?? null,
    deploymentSupported: deploymentVerdict.supported,
    capabilities: api.capabilities,
    range: SUPPORTED_DEPLOYMENT_RANGE,
    apiRange: `${SUPPORTED_API_VERSION}.x`,
    basis: COMPATIBILITY_BASIS,
    supported,
    reason: reasons.join("; "),
  };
}

/** Backwards-compatible name used by earlier release notes. */
export const checkEngineCompatibility = checkCompatibility;
