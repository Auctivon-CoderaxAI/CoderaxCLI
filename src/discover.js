import { CoderaxError, request } from "./client.js";

/**
 * Candidate locations for the deployment's OpenAPI document. The CLI resolves
 * paths from this document rather than hardcoding endpoints, so a deployment
 * that moves a route does not silently break commands.
 */
export const OPENAPI_CANDIDATES = ["/openapi.json", "/api/openapi.json", "/.well-known/openapi.json"];

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function summarizeOperations(document) {
  const operations = [];
  for (const [path, methods] of Object.entries(document?.paths ?? {})) {
    if (methods === null || typeof methods !== "object") continue;
    for (const [method, operation] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method)) continue;
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: typeof operation?.operationId === "string" ? operation.operationId : null,
        summary: typeof operation?.summary === "string" ? operation.summary : null,
      });
    }
  }
  return operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export async function discoverOpenApi({ baseUrl, token, timeoutMs, fetchImpl } = {}) {
  const attempts = [];
  for (const path of OPENAPI_CANDIDATES) {
    try {
      const { json } = await request({ baseUrl, token, path, timeoutMs, fetchImpl });
      if (json === null || typeof json !== "object" || Array.isArray(json)) {
        attempts.push(`${path}: response is not a JSON object`);
        continue;
      }
      const version = String(json.openapi ?? "");
      if (!version.startsWith("3.")) {
        attempts.push(`${path}: not an OpenAPI 3.x document`);
        continue;
      }
      if (json.paths === null || typeof json.paths !== "object") {
        attempts.push(`${path}: document has no paths`);
        continue;
      }
      const operations = summarizeOperations(json);
      if (operations.length === 0) {
        attempts.push(`${path}: document lists no operations`);
        continue;
      }
      return { document: json, sourcePath: path, operations };
    } catch (error) {
      if (error.code === "HTTP_401" || error.code === "HTTP_403" || error.code === "REQUEST_TIMEOUT") {
        throw error;
      }
      attempts.push(`${path}: ${error.code ?? "request failed"}`);
    }
  }
  throw new CoderaxError(
    "OPENAPI_NOT_FOUND",
    `no usable OpenAPI document found. Tried ${attempts.join("; ")}`,
  );
}

export function findOperation(operations, matcher) {
  return operations.find((operation) => operation.method === "GET" && matcher.test(operation.path)) ?? null;
}
