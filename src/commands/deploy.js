import { CoderaxError, EXIT, UsageError } from "../errors.js";
import { discoverOpenApi, findOperation } from "../discover.js";
import { request } from "../client.js";
import { probeHealth } from "../product-commands.js";
import { renderTable } from "../ui/tables.js";

async function deploymentContext(runtime) {
  if (!runtime.baseUrl) {
    throw new CoderaxError(
      "BASE_URL_REQUIRED",
      "no deployment URL is configured; run `coderax config set --base-url <url>` or set CODERAX_BASE_URL",
    );
  }
  return {
    baseUrl: runtime.baseUrl,
    token: await runtime.getToken().catch(() => null),
    timeoutMs: runtime.config.timeoutMs,
    fetchImpl: runtime.fetchImpl,
    signal: runtime.signal ?? undefined,
    includeRaw: true,
  };
}

export async function deployHealth(runtime) {
  const context = await deploymentContext(runtime);
  const { path, response } = await probeHealth(context);
  runtime.emit("deploy.health", {
    endpoint: path,
    status: response.status,
    body: response.json ?? response.text,
  }, () => {
    runtime.write(`${runtime.style.green("\u2713")} deployment ${runtime.baseUrl}`);
    runtime.write(`  GET ${path} HTTP ${response.status}`);
    if (response.json) runtime.write(runtime.style.dim(JSON.stringify(response.json, null, 2)));
  });
  return EXIT.OK;
}

export async function deployOpenapi(runtime) {
  const context = await deploymentContext(runtime);
  const discovery = await discoverOpenApi(context);
  const operations = runtime.redactValue(discovery.operations);
  runtime.emit("deploy.openapi", {
    sourcePath: discovery.sourcePath,
    operationCount: operations.length,
    operations,
  }, () => {
    runtime.write(`${runtime.style.bold("contract")} ${discovery.sourcePath} (${operations.length} operations)`);
    runtime.write(renderTable({
      headers: ["METHOD", "PATH", "OPERATION", "SUMMARY"],
      rows: operations.slice(0, 100).map((operation) => [
        operation.method,
        operation.path,
        operation.operationId ?? "",
        operation.summary ?? "",
      ]),
      style: runtime.style,
      width: runtime.width,
      maxColumnWidth: 52,
    }));
  });
  return EXIT.OK;
}

export async function deployResource(runtime, kind) {
  const context = await deploymentContext(runtime);
  const discovery = await discoverOpenApi(context);
  const matcher = kind === "agents" ? /\/agents\/?$/i : /\/models\/?$/i;
  const operation = findOperation(discovery.operations, matcher);
  if (!operation) {
    throw new CoderaxError(
      "OPERATION_NOT_FOUND",
      `the deployment's OpenAPI document has no GET ${kind} operation; run \`coderax deploy openapi\` to list available paths`,
    );
  }
  const response = await request({ ...context, path: operation.path });
  const payload = response.rawJson !== undefined ? response.json : response.text;
  runtime.emit(`deploy.${kind}`, {
    method: operation.method,
    path: runtime.redact(operation.path),
    status: response.status,
    body: payload,
  }, () => {
    runtime.write(`${operation.method} ${runtime.redact(operation.path)} -> ${response.status}`);
    runtime.write(response.json ? JSON.stringify(response.json, null, 2) : response.text);
  });
  return EXIT.OK;
}

export async function deployCall(runtime, call) {
  const context = await deploymentContext(runtime);
  const response = await request({ ...context, path: call.path, method: call.method, body: call.body });
  const payload = response.rawJson !== undefined ? response.json : response.text;
  const path = runtime.redact(call.path);
  runtime.emit("deploy.call", { method: call.method, path, status: response.status, body: payload }, () => {
    runtime.write(`${call.method} ${path} -> ${response.status}`);
    runtime.write(response.rawJson !== undefined ? JSON.stringify(response.json, null, 2) : response.text);
  });
  return EXIT.OK;
}

export async function deployCommand(runtime, positionals, call) {
  const action = positionals[0] ?? "health";
  switch (action) {
    case "health": return deployHealth(runtime);
    case "openapi": return deployOpenapi(runtime);
    case "agents":
    case "models": return deployResource(runtime, action);
    case "call": {
      if (!call) throw new UsageError("deploy call requires <METHOD> <PATH>");
      return deployCall(runtime, call);
    }
    default:
      throw new UsageError(`unknown deploy action: ${action}`);
  }
}
