import { CoderaxError, redactValue, request } from "./client.js";

/**
 * Candidate locations for the deployment's OpenAPI document. The CLI resolves
 * paths from this document rather than hardcoding endpoints, so a deployment
 * that moves a route does not silently break commands.
 */
export const OPENAPI_CANDIDATES = ["/openapi.json", "/api/openapi.json", "/.well-known/openapi.json"];

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** Only a relative server URL is safe to prepend to discovered operation paths. */
function serverPathPrefix(document) {
  const server = document?.servers?.[0];
  const url = server?.url;
  if (typeof url !== "string") return "";
  const expanded = url.replace(/\{([^}]+)\}/g, (placeholder, name) => {
    const value = server?.variables?.[name]?.default;
    return typeof value === "string" ? value : placeholder;
  });
  if (!expanded.startsWith("/") || expanded.startsWith("//")) return "";
  return expanded.replace(/\/+$/, "");
}

function mergeParameters(pathItem, operation) {
  const merged = [
    ...(Array.isArray(pathItem?.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation?.parameters) ? operation.parameters : []),
  ];
  const byKey = new Map();
  for (const parameter of merged) {
    if (!parameter || typeof parameter !== "object") continue;
    if (typeof parameter.name !== "string" || typeof parameter.in !== "string") continue;
    byKey.set(`${parameter.in}:${parameter.name}`, {
      name: parameter.name,
      in: parameter.in,
      required: parameter.required === true,
      schema: parameter.schema && typeof parameter.schema === "object" ? parameter.schema : null,
    });
  }
  return [...byKey.values()];
}

/**
 * Summarize a request body without resolving $ref. Deployments that describe
 * bodies inline get field and enum validation; $ref bodies fall back to the
 * command's own required-field contract.
 */
function summarizeRequestBody(operation) {
  const body = operation?.requestBody;
  if (!body || typeof body !== "object") return null;
  const content = body.content && typeof body.content === "object" ? body.content : {};
  const contentTypes = Object.keys(content);
  const mediaType = contentTypes[0] ?? null;
  const media = mediaType ? content[mediaType] : null;
  const schema = media?.schema && typeof media.schema === "object" ? media.schema : null;
  return {
    required: body.required === true,
    mediaType,
    contentTypes,
    schema: schema
      ? {
          type: schema.type ?? "object",
          required: Array.isArray(schema.required) ? schema.required : [],
          properties: schema.properties && typeof schema.properties === "object" ? schema.properties : {},
          additionalProperties: schema.additionalProperties,
        }
      : null,
  };
}

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
        parameters: mergeParameters(methods, operation),
        requestBody: summarizeRequestBody(operation),
      });
    }
  }
  return operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export async function discoverOpenApi({ baseUrl, token, timeoutMs, fetchImpl } = {}) {
  const attempts = [];
  for (const path of OPENAPI_CANDIDATES) {
    try {
      const { rawJson } = await request({ baseUrl, token, path, timeoutMs, fetchImpl, includeRaw: true });
      const document = rawJson;
      if (document === null || typeof document !== "object" || Array.isArray(document)) {
        attempts.push(`${path}: response is not a JSON object`);
        continue;
      }
      const version = String(document.openapi ?? "");
      if (!version.startsWith("3.")) {
        attempts.push(`${path}: not an OpenAPI 3.x document`);
        continue;
      }
      if (document.paths === null || typeof document.paths !== "object") {
        attempts.push(`${path}: document has no paths`);
        continue;
      }
      const prefix = serverPathPrefix(document);
      const operations = summarizeOperations(document).map((operation) => ({
        ...operation,
        path: prefix
          ? `${prefix}${operation.path.startsWith("/") ? "" : "/"}${operation.path}`
          : operation.path,
      }));
      if (operations.length === 0) {
        attempts.push(`${path}: document lists no operations`);
        continue;
      }
      return { document, sourcePath: path, operations, displayOperations: redactValue(operations, token) };
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
  const matches = operations.filter(
    (operation) => operation.method === "GET" && !operation.path.includes("{") && matcher.test(operation.path),
  );
  matches.sort((a, b) => a.path.length - b.path.length);
  return matches[0] ?? null;
}
